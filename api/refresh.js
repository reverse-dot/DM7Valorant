import { getRedis } from './_redis.js';

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TIER_CONTENT_ID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function rankImageFromTier(tierId) {
  if (!tierId) return '';
  return `https://media.valorant-api.com/competitivetiers/${TIER_CONTENT_ID}/${tierId}/smallicon.png`;
}

async function fetchWithRetry(url, headers, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") || 6);
        console.warn(`429 Límite alcanzado. Esperando ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      return res;
    } catch (err) {
      console.error("Error de red:", err.message);
    }
  }
  return null;
}

async function buildStats(API_KEY) {
  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' },
    { name: 'Focus', tag: 'DM7', region: 'latam' },
  ];

  const results = [];
  const reqHeaders = {
    'Authorization': API_KEY,
    'User-Agent': 'SoloQChallenge/1.0'
  };

  for (let index = 0; index < players.length; index++) {
    const p = players[index];
    
    // Pausa de 3.5 segundos entre jugadores para asegurar CERO 429
    if (index > 0) await sleep(3500);

    let rank = 'Sin Clasificar';
    let rr = 0;
    let tier = 0;
    let rankImage = '';
    let currentActShort = '';

    let wins = 0;
    let losses = 0;

    try {
      const mmrUrl = `https://api.henrikdev.xyz/valorant/v3/mmr/${p.region}/pc/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
      const mmrRes = await fetchWithRetry(mmrUrl, reqHeaders);

      if (mmrRes && mmrRes.ok) {
        const mmrData = await mmrRes.json();
        const currentData = mmrData.data?.current;

        // 1. Datos de Rango y RR
        if (currentData) {
          rank = currentData.tier?.name || 'Sin Clasificar';
          rr = currentData.rr || 0;
          tier = currentData.tier?.id || 0;
          rankImage = rankImageFromTier(tier);
        }

        // 2. Extraer datos de la temporada
        const seasonal = mmrData.data?.seasonal || [];
        if (seasonal.length > 0) {
          // Buscamos el elemento de la temporada actual que tenga datos
          const activeSeason = seasonal.findLast(s => (s.number_of_games ?? 0) > 0 || (s.wins ?? 0) > 0) || seasonal[seasonal.length - 1];

          if (activeSeason) {
            wins = Number(activeSeason.wins ?? 0);
            const totalGames = Number(activeSeason.number_of_games ?? 0);

            // Si number_of_games viene presente en la respuesta
            if (totalGames > 0 && totalGames >= wins) {
              losses = totalGames - wins;
            } else {
              // Si no viene totalGames en esta versión de API, calculamos con un fallback dinámico
              losses = activeSeason.losses ? Number(activeSeason.losses) : 0;
            }

            if (activeSeason.season?.short) {
              currentActShort = activeSeason.season.short;
            }
          }
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
      act: currentActShort,
      stats: {
        wins,
        losses,
        hasRealLosses: losses > 0,
        totalMatches,
        winrate: winRate,
        kd: '0.00',
        headshotPct: 0,
        hs: 0
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
    const data = await buildStats(API_KEY);
    const redis = getRedis();
    await redis.set('valorant:stats', JSON.stringify(data));

    return res.status(200).json({ ok: true, updatedAt: data.updatedAt });
  } catch (err) {
    console.error('Error en refresh:', err);
    return res.status(500).json({ error: 'Error al actualizar las estadísticas' });
  }
}
