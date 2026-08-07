import { getRedis } from './_redis.js';

// Establece el tiempo límite máximo de Vercel en 60 segundos
export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ID para consultar los iconos de rango en alta resolución
const TIER_CONTENT_ID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function rankImageFromTier(tierId) {
  if (!tierId) return '';
  return `https://media.valorant-api.com/competitivetiers/${TIER_CONTENT_ID}/${tierId}/smallicon.png`;
}

// Función con reintento automático si la API responde 429
async function fetchWithRetry(url, headers, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status !== 429) return res;

      console.warn(`429 en ${url}, reintentando en 3s (intento ${i + 1}/${retries + 1})`);
      await sleep(3000);
    } catch (err) {
      console.error('Error de red:', err.message);
    }
  }
  return null;
}

async function buildStats(API_KEY) {
  // Configura aquí tus 10 jugadores
  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' },
    // Agrega aquí los 5 jugadores restantes:
    // { name: 'Jugador6', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador7', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador8', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador9', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador10', tag: 'TAG', region: 'latam' }
  ];

  const results = [];
  const reqHeaders = {
    'Authorization': API_KEY,
    'User-Agent': 'SoloQChallenge/1.0'
  };

  for (let index = 0; index < players.length; index++) {
    const p = players[index];
    
    // Pausa estratégica de 1.5s entre jugadores para mantenerse en el margen seguro (20 req / min < 30 req / min)
    if (index > 0) await sleep(1500);

    let rank = 'Sin Clasificar';
    let rr = 0;
    let tier = 0;
    let rankImage = '';
    let currentActShort = '';

    let wins = 0;
    let losses = 0;
    let totalKills = 0;
    let totalDeaths = 0;
    let totalHeadshots = 0;
    let totalBodyshots = 0;
    let totalLegshots = 0;
    let matchesHistory = [];

    try {
      const mmrUrl = `https://api.henrikdev.xyz/valorant/v3/mmr/${p.region}/pc/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
      const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?mode=competitive&size=5`;

      // Se realizan las dos llamadas en paralelo para reducir el tiempo total a la mitad
      const [mmrRes, matchesRes] = await Promise.all([
        fetchWithRetry(mmrUrl, reqHeaders),
        fetchWithRetry(matchesUrl, reqHeaders)
      ]);

      // 1. Procesar datos de MMR
      if (mmrRes && mmrRes.ok) {
        const mmrData = await mmrRes.json();
        const currentData = mmrData.data?.current;

        if (currentData) {
          rank = currentData.tier?.name || 'Sin Clasificar';
          rr = currentData.rr || 0;
          tier = currentData.tier?.id || 0;
          rankImage = rankImageFromTier(tier);
        }

        const seasonal = mmrData.data?.seasonal || [];
        if (seasonal.length > 0) {
          const currentSeason = seasonal[seasonal.length - 1];
          wins = currentSeason.wins || 0;
          losses = currentSeason.number_of_games ? Math.max(0, currentSeason.number_of_games - wins) : 0;
          if (currentSeason.season?.short) currentActShort = currentSeason.season.short;
        }
      }

      // 2. Procesar datos de Partidas
      if (matchesRes && matchesRes.ok) {
        const matchesData = await matchesRes.json();
        const rawMatches = matchesData.data || [];

        rawMatches.forEach((m) => {
          const allPlayers = m.players?.all_players || [];
          const playerObj = allPlayers.find(
            (pl) => pl.name?.toLowerCase() === p.name.toLowerCase() && pl.tag?.toLowerCase() === p.tag.toLowerCase()
          );

          if (playerObj) {
            const playerTeam = playerObj.team?.toLowerCase();
            const redWon = m.teams?.red?.has_won;
            const blueWon = m.teams?.blue?.has_won;
            const won = (playerTeam === 'red' && redWon) || (playerTeam === 'blue' && blueWon);

            const k = playerObj.stats?.kills || 0;
            const d = playerObj.stats?.deaths || 0;
            const a = playerObj.stats?.assists || 0;

            totalKills += k;
            totalDeaths += d;
            totalHeadshots += playerObj.stats?.headshots || 0;
            totalBodyshots += playerObj.stats?.bodyshots || 0;
            totalLegshots += playerObj.stats?.legshots || 0;

            matchesHistory.push({
              map: m.metadata?.map?.name || 'Competitivo',
              won: won,
              result: won ? 'Victoria' : 'Derrota',
              kda: `${k}/${d}/${a}`
            });
          }
        });
      }

    } catch (err) {
      console.error(`Error procesando a ${p.name}:`, err);
    }

    const totalMatches = wins + losses;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
    const kd = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : (totalKills > 0 ? totalKills.toFixed(2) : '0.00');

    const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
    const headshotPct = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;
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
        totalMatches,
        winrate: winRate,
        winRate: winRate,
        kd,
        headshotPct,
        hs: headshotPct
      },
      matches: matchesHistory
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
