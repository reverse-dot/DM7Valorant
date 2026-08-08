import { getRedis } from './_redis.js';

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TIER_CONTENT_ID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function rankImageFromTier(tierId) {
  if (!tierId) return '';
  return `https://media.valorant-api.com/competitivetiers/${TIER_CONTENT_ID}/${tierId}/smallicon.png`;
}

// El id viene en players[].customization.card del matchlist v4.
// Es "smallart.png": "small.png" devuelve 404 (verificado 2026-08-07).
function cardImageFromId(cardId) {
  if (!cardId) return '';
  return `https://media.valorant-api.com/playercards/${cardId}/smallart.png`;
}

// ---------------------------------------------------------------------------
// PRESUPUESTO DE RATE LIMIT
//
// El plan de la API da 30 peticiones por ventana de 60s, y desde v4 cada
// llamada cuesta 1 por la API + 1 por cada partida que HenrikDev pide a Riot
// por detrás. Un matchlist size=10 cuesta 11, no 1 (medido 2026-08-07).
//
//   base: 2 llamadas x 6 jugadores (mmr-history + v3/mmr) = 12
//   matchlist size=10                                     = 11 por jugador
//
//   6 jugadores -> 12 + 66 = 78   NO CABE
//   2 jugadores -> 12 + 22 = 34   NO CABE
//   1 jugador   -> 12 + 11 = 23   cabe, con margen
//
// Por eso el matchlist rota: cada corrida lo pide para MATCHLIST_PER_RUN
// jugadores y el resto conserva sus valores anteriores. Con el refresh
// corriendo cada ~15 min, los 6 se renuevan cada ~90 min. Subir esta
// constante hace que la corrida se coma el rate limit y devuelva 429.
// ---------------------------------------------------------------------------
const MATCH_PAGE_SIZE = 10;
const MATCHLIST_PER_RUN = 1;
const CURSOR_KEY = 'valorant:matchlist-cursor';

// Respeta Retry-After si HenrikDev nos tira 429, y si no viene, hace
// backoff incremental con jitter para no pegarle todos los reintentos juntos.
async function fetchWithRetry(url, headers, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });

      if (res.status === 429) {
        const retryAfterHeader = Number(res.headers.get('Retry-After'));
        const backoff = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader
          : 5 * (i + 1);
        const jitter = Math.random() * 1000;
        console.warn(`429 en ${url}. Esperando ${backoff}s (intento ${i + 1}/${retries + 1})...`);
        await sleep(backoff * 1000 + jitter);
        continue;
      }

      return res;
    } catch (err) {
      console.error(`Error de red en ${url}:`, err.message);
      await sleep(1500);
    }
  }
  return null;
}

/**
 * Trae los datos de un jugador para la temporada (acto) ACTUAL, usando datos
 * oficiales de Riot (no inferidos por cambios de RR):
 *
 * 1. `mmr-history` -> nos da el `season_id` de la partida competitiva más
 *    reciente que jugó. Ese es el acto "actual" para ese jugador.
 * 2. `v3/mmr`      -> trae, por temporada, el conteo que mantiene Riot.
 *    Buscamos la entrada cuyo `season.id` coincide con el paso 1.
 */
async function fetchCurrentSeasonStats(p, headers) {
  const platform = 'pc';

  const historyUrl = `https://api.henrikdev.xyz/valorant/v1/mmr-history/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
  const historyRes = await fetchWithRetry(historyUrl, headers);
  if (!historyRes || !historyRes.ok) {
    if (historyRes) console.error(`mmr-history para ${p.name}#${p.tag} devolvió ${historyRes.status}`);
    return null;
  }
  const historyJson = await historyRes.json();
  const historyList = historyJson?.data || [];
  if (historyList.length === 0) return null;

  const latestMatch = historyList[0];
  const currentSeasonId = latestMatch.season_id || latestMatch.season?.id;

  await sleep(400);

  const mmrUrl = `https://api.henrikdev.xyz/valorant/v3/mmr/${p.region}/${platform}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
  const mmrRes = await fetchWithRetry(mmrUrl, headers);
  if (!mmrRes || !mmrRes.ok) {
    if (mmrRes) console.error(`v3/mmr para ${p.name}#${p.tag} devolvió ${mmrRes.status}`);
    return null;
  }
  const mmrJson = await mmrRes.json();
  const mmr = mmrJson?.data;
  if (!mmr) return null;

  const seasonal = Array.isArray(mmr.seasonal) ? mmr.seasonal : [];
  const currentSeasonEntry = seasonal.find(s => s.season?.id === currentSeasonId);

  // -------------------------------------------------------------------------
  // NO USAR `currentSeasonEntry.wins`. Parece el campo correcto y no lo es.
  //
  // Riot solo cuenta en `wins` las victorias que tenían rango asignado; las
  // que quedaron como "Unrated" no suman. `act_wins` en cambio es un array con
  // UNA ENTRADA POR VICTORIA REAL, así que su largo sí es el conteo correcto.
  //
  // Medido el 2026-08-07 paginando el acto completo de 4 jugadores:
  //
  //   jugador      wins   act_wins   victorias reales del matchlist
  //   X1no            5          7          7
  //   sayaplayer      6          7          7
  //   Focus           9         10         10
  //   zingCL          6          9          9
  //
  // `act_wins.length` coincidió con el matchlist en los 4 casos; `wins` en
  // ninguno. Usando `wins`, zingCL se mostraba con 29% de winrate cuando el
  // real es 43%, porque las victorias faltantes se contaban como derrotas.
  //
  // Si alguien "arregla" esto volviendo a `wins`, reintroduce ese bug.
  // -------------------------------------------------------------------------
  const wins = Array.isArray(currentSeasonEntry?.act_wins)
    ? currentSeasonEntry.act_wins.length
    : (currentSeasonEntry?.wins ?? 0);

  return {
    tier: mmr.current?.tier?.id ?? null,
    rank: mmr.current?.tier?.name ?? null,
    rr: mmr.current?.rr ?? null,
    wins,
    games: currentSeasonEntry?.games ?? 0,
  };
}

/**
 * Estadísticas derivadas del historial de partidas (una sola página).
 *
 * ALCANCE: todo lo que sale de acá (draws, kd, headshotPct, matches) mira
 * SOLO las últimas MATCH_PAGE_SIZE partidas, mientras que wins/losses vienen
 * del acto completo vía v3/mmr. Son dos ventanas distintas y no coinciden:
 * un jugador con 175 partidas en el acto muestra un K/D calculado sobre 10.
 * Es intencional por ahora — cubrir el acto entero exige paginar y no entra
 * en el presupuesto de rate limit ni en los 60s de maxDuration.
 */
async function fetchMatchStats(p, headers) {
  const url = `https://api.henrikdev.xyz/valorant/v4/matches/${p.region}/pc/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?mode=competitive&size=${MATCH_PAGE_SIZE}`;
  const res = await fetchWithRetry(url, headers);
  if (!res || !res.ok) {
    if (res) console.error(`v4/matches para ${p.name}#${p.tag} devolvió ${res.status}`);
    return null;
  }

  const json = await res.json();
  const list = Array.isArray(json?.data) ? json.data : [];
  if (list.length === 0) return null;

  let kills = 0, deaths = 0, headshots = 0, bodyshots = 0, legshots = 0;
  let draws = 0;
  let cardImage = '';
  const matches = [];

  for (const m of list) {
    // Los remakes no son partidas jugadas: no cuentan para nada.
    if (m?.metadata?.is_completed === false) continue;

    const teams = Array.isArray(m.teams) ? m.teams : [];
    const me = (m.players || []).find(
      (x) => (x.name || '').toLowerCase() === p.name.toLowerCase()
        && (x.tag || '').toLowerCase() === p.tag.toLowerCase()
    );
    if (!me) continue;

    const myTeam = teams.find((t) => t.team_id === me.team_id);
    const rival = teams.find((t) => t !== myTeam);
    const roundsWon = myTeam?.rounds?.won;
    const roundsLost = rival?.rounds?.won;
    if (typeof roundsWon !== 'number' || typeof roundsLost !== 'number') continue;

    // -----------------------------------------------------------------------
    // El desenlace se decide comparando rondas, NUNCA con el flag `teams[].won`.
    // Verificado el 2026-08-07 sobre un empate real (match
    // 32ceefce-a5b8-48b5-ab11-a28d9bd784a0, 15-15): en un empate `won` viene
    // en `false` para LOS DOS equipos. Clasificar por ese flag convierte todo
    // empate en derrota, que es justo el bug que estamos corrigiendo.
    // -----------------------------------------------------------------------
    const outcome = roundsWon === roundsLost ? 'draw' : roundsWon > roundsLost ? 'win' : 'loss';
    if (outcome === 'draw') draws++;

    const s = me.stats || {};
    kills += s.kills || 0;
    deaths += s.deaths || 0;
    headshots += s.headshots || 0;
    bodyshots += s.bodyshots || 0;
    legshots += s.legshots || 0;

    if (!cardImage) cardImage = cardImageFromId(me.customization?.card);

    matches.push({
      outcome,
      map: m.metadata?.map?.name || 'Desconocido',
      agent: me.agent?.name || 'Agente',
      kills: s.kills || 0,
      deaths: s.deaths || 0,
      assists: s.assists || 0,
      roundsWon,
      roundsLost,
    });
  }

  if (matches.length === 0) return null;

  const shots = headshots + bodyshots + legshots;

  return {
    draws,
    // Sin muertes no se puede dividir: el K/D es el total de kills.
    kd: (deaths > 0 ? kills / deaths : kills).toFixed(2),
    headshotPct: shots > 0 ? Math.round((headshots / shots) * 100) : 0,
    matches: matches.slice(0, 10),
    cardImage,
    sample: matches.length,
  };
}

async function buildStats(API_KEY, previousStats, cursor) {
  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' },
    { name: 'Focus', tag: 'DM7', region: 'latam' },
  ];

  const prevMap = {};
  if (previousStats && Array.isArray(previousStats.players)) {
    previousStats.players.forEach(p => {
      prevMap[`${p.name}#${p.tag}`] = p;
    });
  }

  // Quiénes reciben matchlist en esta corrida (ver PRESUPUESTO arriba).
  const refreshMatches = new Set();
  for (let i = 0; i < Math.min(MATCHLIST_PER_RUN, players.length); i++) {
    const t = players[(cursor + i) % players.length];
    refreshMatches.add(`${t.name}#${t.tag}`);
  }

  const results = [];
  const reqHeaders = {
    'Authorization': API_KEY,
    'User-Agent': 'SoloQChallenge/1.0'
  };

  for (let index = 0; index < players.length; index++) {
    const p = players[index];
    const playerKey = `${p.name}#${p.tag}`;
    const prevData = prevMap[playerKey] || {};

    // Fallbacks por si esta corrida falla (mantenemos el último dato bueno).
    let rank = prevData.rank || 'Sin Clasificar';
    let rr = prevData.rr || 0;
    let tier = prevData.tier || 0;
    let rankImage = prevData.rankImage || '';
    let wins = prevData.stats?.wins || 0;
    let losses = prevData.stats?.losses || 0;
    let games = null;

    // Lo que sale del matchlist también conserva el valor anterior si la
    // llamada no se hace en esta corrida o falla: nunca se escriben ceros.
    let draws = prevData.stats?.draws ?? 0;
    let kd = prevData.stats?.kd || '0.00';
    let headshotPct = prevData.stats?.headshotPct || 0;
    let matches = Array.isArray(prevData.matches) ? prevData.matches : [];
    let cardImage = prevData.cardImage || '';

    if (index > 0) await sleep(1500);

    try {
      const current = await fetchCurrentSeasonStats(p, reqHeaders);

      if (current) {
        if (current.tier !== null) {
          tier = current.tier;
          rank = current.rank ?? rank;
          rr = current.rr ?? rr;
          rankImage = rankImageFromTier(tier);
        }
        wins = current.wins;
        games = current.games;
      }

      if (refreshMatches.has(playerKey)) {
        await sleep(600);
        const ms = await fetchMatchStats(p, reqHeaders);
        if (ms) {
          draws = ms.draws;
          kd = ms.kd;
          headshotPct = ms.headshotPct;
          matches = ms.matches;
          if (ms.cardImage) cardImage = ms.cardImage;
        }
      }
    } catch (err) {
      console.error(`Error procesando a ${p.name}:`, err);
    }

    // `games` es el total de partidas del acto y sí es fiable (coincidió con
    // el conteo del matchlist en los 4 jugadores medidos). Lo que no son
    // victorias ni empates, son derrotas. Se acota a >= 0 porque `draws` sale
    // de una ventana de 10 partidas y `games`/`wins` del acto completo: si el
    // jugador empató mucho hace poco, la resta podría pasarse.
    if (games !== null) {
      losses = Math.max(0, games - wins - draws);
    }

    const totalMatches = wins + draws + losses;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
    const elo = (tier * 100) + rr;

    results.push({
      name: p.name,
      tag: p.tag,
      rank,
      rr,
      tier,
      elo,
      rankImage,
      cardImage,
      stats: {
        wins,
        draws,
        losses,
        totalMatches,
        winrate: winRate,
        kd,
        headshotPct
      },
      matches
    });
  }

  return { updatedAt: new Date().toISOString(), players: results };
}

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY' });
  }

  try {
    const redis = getRedis();

    // Permite resetear Redis pasando ?reset=true en la URL
    if (req.query.reset === 'true') {
      await redis.del('valorant:stats');
      await redis.del(CURSOR_KEY);
      console.log('Redis reseteado con éxito.');
    }

    const rawPrevious = await redis.get('valorant:stats');
    let previousData = null;
    if (rawPrevious) {
      previousData = typeof rawPrevious === 'string' ? JSON.parse(rawPrevious) : rawPrevious;
    }

    // Cursor de rotación del matchlist: qué jugador le toca en esta corrida.
    const rawCursor = await redis.get(CURSOR_KEY);
    const cursor = Number.isFinite(Number(rawCursor)) ? Number(rawCursor) : 0;

    const data = await buildStats(API_KEY, previousData, cursor);
    await redis.set('valorant:stats', JSON.stringify(data));
    await redis.set(CURSOR_KEY, String((cursor + MATCHLIST_PER_RUN) % data.players.length));

    return res.status(200).json({ ok: true, updatedAt: data.updatedAt });
  } catch (err) {
    console.error('Error en refresh:', err);
    return res.status(500).json({ error: 'Error al actualizar las estadísticas' });
  }
}
