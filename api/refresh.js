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

async function buildStats(API_KEY, previousStats) {
  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' },
    { name: 'Focus', tag: 'DM7', region: 'latam' },
  ];

  // Mapeamos los datos previos guardados en Redis para no perder el acumulado
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

    // Cargar historial previo de Redis
    let processedMatchIds = new Set(prevData.processedMatchIds || []);
    let wins = prevData.stats?.wins || 0;
    let losses = prevData.stats?.losses || 0;

    if (index > 0) await sleep(3000);

    let rank = prevData.rank || 'Sin Clasificar';
    let rr = prevData.rr || 0;
    let tier = prevData.tier || 0;
    let rankImage = prevData.rankImage || '';

    try {
      // Consultar partidas recientes
      const mmrHistoryUrl = `https://api.henrikdev.xyz/valorant/v1/mmr-history/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
      const mmrHistRes = await fetchWithRetry(mmrHistoryUrl, reqHeaders);

      if (mmrHistRes && mmrHistRes.ok) {
        const histData = await mmrHistRes.json();
        const matchesList = histData.data || [];

        if (matchesList.length > 0) {
          // El rango actual siempre se actualiza a la partida más reciente
          const latest = matchesList[0];
          rank = latest.currenttierpatched || rank;
          rr = latest.ranking_in_tier ?? rr;
          tier = latest.currenttier ?? tier;
          rankImage = rankImageFromTier(tier);

          // Procesar partidas de la API y SUMAR SOLO LAS NUEVAS
          // Se invierte la lista para procesar de la más antigua a la más nueva
          [...matchesList].reverse().forEach(m => {
            const matchId = m.match_id;
            
            // Si la partida NO ha sido contada antes en Redis, la registramos
            if (matchId && !processedMatchIds.has(matchId)) {
              processedMatchIds.add(matchId);
              
              const change = m.mmr_change_to_last_game ?? 0;
              if (change > 0) wins++;
              else if (change < 0) losses++;
            }
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
      processedMatchIds: Array.from(processedMatchIds), // Guardamos los IDs acumulados
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
    
    // 1. Leemos lo que ya teníamos guardado en Redis previamente
    const rawPrevious = await redis.get('valorant:stats');
    let previousData = null;
    if (rawPrevious) {
      previousData = typeof rawPrevious === 'string' ? JSON.parse(rawPrevious) : rawPrevious;
    }

    // 2. Construimos las estadísticas sumando lo nuevo a lo anterior
    const data = await buildStats(API_KEY, previousData);

    // 3. Sobreescribimos Redis con el nuevo acumulado
    await redis.set('valorant:stats', JSON.stringify(data));

    return res.status(200).json({ ok: true, updatedAt: data.updatedAt });
  } catch (err) {
    console.error('Error en refresh:', err);
    return res.status(500).json({ error: 'Error al actualizar las estadísticas' });
  }
}
