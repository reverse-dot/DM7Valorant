import { getRedis } from './_redis.js';

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TIER_CONTENT_ID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function rankImageFromTier(tierId) {
  if (!tierId) return '';
  return `https://media.valorant-api.com/competitivetiers/${TIER_CONTENT_ID}/${tierId}/smallicon.png`;
}

// Pequeño helper para no martillar la API si nos da 429: respeta Retry-After
// y si no viene, hace backoff incremental con jitter.
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
 * Devuelve, para un jugador, wins/losses/rank reales usando el endpoint
 * v3/mmr de HenrikDev, que trae por temporada (`seasonal`) el conteo OFICIAL
 * de Riot: { wins, games }. Esto reemplaza la vieja lógica que adivinaba
 * victoria/derrota mirando si el RR subía o bajaba (poco fiable: deranks,
 * decay, cambios de RR en 0, etc. rompían el conteo), y que además dependía
 * de `mmr-history`, un endpoint que solo trae las últimas ~N partidas, así
 * que si el refresh no corría seguido se perdían partidas para siempre.
 *
 * Con v3/mmr solo hace falta 1 request por jugador (no hay paginado), y el
 * número de wins/games que devuelve es acumulado por Riot para todo el acto,
 * así que nunca se "cae" una partida por no haber refrescado a tiempo.
 */
async function fetchPlayerMMR(p, headers) {
  const platform = 'pc';
  const url = `https://api.henrikdev.xyz/valorant/v3/mmr/${p.region}/${platform}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
  const res = await fetchWithRetry(url, headers);
  if (!res || !res.ok) {
    if (res) console.error(`v3/mmr para ${p.name}#${p.tag} devolvió ${res.status}`);
    return null;
  }
  const json = await res.json();
  return json?.data || null;
}

async function buildStats(API_KEY, previousStats) {
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

  const results = [];
  const reqHeaders = {
    'Authorization': API_KEY,
    'User-Agent': 'SoloQChallenge/1.0'
  };

  for (let index = 0; index < players.length; index++) {
    const p = players[index];
    const playerKey = `${p.name}#${p.tag}`;
    const prevData = prevMap[playerKey] || {};

    // seasonBaselines guarda, por season.id, el último {wins, games}
    // oficial que vimos para ese jugador. Así calculamos el delta real
    // desde el último refresh en vez de re-contar todo desde cero.
    const seasonBaselines = { ...(prevData.seasonBaselines || {}) };
    const isMigratingFromOldSchema = !prevData.seasonBaselines;

    let wins = prevData.stats?.wins || 0;
    let losses = prevData.stats?.losses || 0;

    let rank = prevData.rank || 'Sin Clasificar';
    let rr = prevData.rr || 0;
    let tier = prevData.tier || 0;
    let rankImage = prevData.rankImage || '';

    if (index > 0) await sleep(1500);

    try {
      const mmr = await fetchPlayerMMR(p, reqHeaders);

      if (mmr) {
        if (mmr.current) {
          tier = mmr.current.tier?.id ?? tier;
          rank = mmr.current.tier?.name ?? rank;
          rr = mmr.current.rr ?? rr;
          rankImage = rankImageFromTier(tier);
        }

        const seasonal = Array.isArray(mmr.seasonal) ? mmr.seasonal : [];

        if (isMigratingFromOldSchema) {
          // Primer refresh con la lógica nueva: en vez de seguir arrastrando
          // un contador viejo calculado con el método impreciso, lo
          // "corregimos" tomando como línea base los números oficiales de
          // Riot para todas las temporadas que ya tenemos guardadas. A
          // partir de acá solo se suman deltas reales.
          let migratedWins = 0;
          let migratedLosses = 0;
          seasonal.forEach(s => {
            const seasonId = s.season?.id;
            if (!seasonId) return;
            const w = s.wins || 0;
            const g = s.games || 0;
            seasonBaselines[seasonId] = { wins: w, games: g };
            migratedWins += w;
            migratedLosses += Math.max(0, g - w);
          });
          wins = migratedWins;
          losses = migratedLosses;
        } else {
          seasonal.forEach(s => {
            const seasonId = s.season?.id;
            if (!seasonId) return;

            const officialWins = s.wins || 0;
            const officialGames = s.games || 0;
            const baseline = seasonBaselines[seasonId] || { wins: 0, games: 0 };

            const deltaGames = officialGames - baseline.games;
            const deltaWins = officialWins - baseline.wins;

            // Ignoramos deltas negativos (glitches puntuales de la API o de
            // Riot) en vez de restar partidas que ya contamos.
            if (deltaGames > 0) {
              const addedWins = Math.max(0, Math.min(deltaWins, deltaGames));
              const addedLosses = deltaGames - addedWins;
              wins += addedWins;
              losses += addedLosses;
            }

            seasonBaselines[seasonId] = { wins: officialWins, games: officialGames };
          });
        }
      }
    } catch (err) {
      console.error(`Error procesando a ${p.name}:`, err);
    }

    const totalMatches = wins + losses;
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
      seasonBaselines,
      stats: {
        wins,
        losses,
        totalMatches,
        winrate: winRate,
        kd: '0.00',
        headshotPct: 0
      },
      matches: []
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
      console.log('Redis reseteado con éxito.');
    }

    const rawPrevious = await redis.get('valorant:stats');
    let previousData = null;
    if (rawPrevious) {
      previousData = typeof rawPrevious === 'string' ? JSON.parse(rawPrevious) : rawPrevious;
    }

    const data = await buildStats(API_KEY, previousData);
    await redis.set('valorant:stats', JSON.stringify(data));

    return res.status(200).json({ ok: true, updatedAt: data.updatedAt });
  } catch (err) {
    console.error('Error en refresh:', err);
    return res.status(500).json({ error: 'Error al actualizar las estadísticas' });
  }
}
