import { getRedis } from './_redis.js';

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TIER_CONTENT_ID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function rankImageFromTier(tierId) {
  if (!tierId) return '';
  return `https://media.valorant-api.com/competitivetiers/${TIER_CONTENT_ID}/${tierId}/smallicon.png`;
}

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
 * 2. `v3/mmr`      -> trae, por temporada, el conteo oficial `{ wins, games }`
 *    que mantiene Riot. Buscamos ahí la entrada cuyo `season.id` coincide
 *    con el paso 1 y esos son los V/D reales del acto en curso.
 *
 * Esto evita adivinar victoria/derrota por el signo del cambio de RR (poco
 * fiable) y evita sumar partidas de temporadas viejas (el array `seasonal`
 * trae el historial completo, no solo el acto actual).
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

  return {
    tier: mmr.current?.tier?.id ?? null,
    rank: mmr.current?.tier?.name ?? null,
    rr: mmr.current?.rr ?? null,
    wins: currentSeasonEntry?.wins ?? 0,
    games: currentSeasonEntry?.games ?? 0,
  };
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

    // Fallbacks por si esta corrida falla (mantenemos el último dato bueno).
    let rank = prevData.rank || 'Sin Clasificar';
    let rr = prevData.rr || 0;
    let tier = prevData.tier || 0;
    let rankImage = prevData.rankImage || '';
    let wins = prevData.stats?.wins || 0;
    let losses = prevData.stats?.losses || 0;

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
        losses = Math.max(0, current.games - current.wins);
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
