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
      if (res.status !== 429) return res;

      console.warn(`429 en ${url}, reintentando en 3s...`);
      await sleep(3000);
    } catch (err) {
      console.error('Error de red:', err.message);
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
    // Agrega aquí a los próximos 5 jugadores cuando se unan
  ];

  const results = [];
  const reqHeaders = {
    'Authorization': API_KEY,
    'User-Agent': 'SoloQChallenge/1.0'
  };

  for (let index = 0; index < players.length; index++) {
    const p = players[index];
    
    if (index > 0) await sleep(1200);

    let rank = 'Sin Clasificar';
    let rr = 0;
    let tier = 0;
    let rankImage = '';
    let currentActShort = '';

    let actWins = 0;
    let actLosses = 0;

    let totalKills = 0;
    let totalDeaths = 0;
    let totalHeadshots = 0;
    let totalBodyshots = 0;
    let totalLegshots = 0;
    let matchesHistory = [];

    try {
      const mmrUrl = `https://api.henrikdev.xyz/valorant/v3/mmr/${p.region}/pc/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`;
      const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/matches/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?mode=competitive&size=10`;

      const [mmrRes, matchesRes] = await Promise.all([
        fetchWithRetry(mmrUrl, reqHeaders),
        fetchWithRetry(matchesUrl, reqHeaders)
      ]);

      // 1. MMR y Victorias del Acto
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
          actWins = currentSeason.wins || 0;
          
          const totalGames = currentSeason.number_of_games || currentSeason.games_played || 0;
          if (totalGames > actWins) {
            actLosses = totalGames - actWins;
          }

          if (currentSeason.season?.short) currentActShort = currentSeason.season.short;
        }
      }

      // 2. Partidas Recientes e Historial
      let historyWins = 0;
      let historyLosses = 0;

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

            if (won) historyWins++;
            else historyLosses++;

            const k = playerObj.stats?.kills || 0;
            const d = playerObj.stats?.deaths || 0;
            const a = playerObj.stats?.assists || 0;

            totalKills += k;
            totalDeaths += d;
            totalHeadshots += playerObj.stats?.headshots || 0;
            totalBodyshots += playerObj.stats?.bodyshots || 0;
            totalLegshots += playerObj.stats?.legshots || 0;

            if (matchesHistory.length < 5) {
              matchesHistory.push({
                map: m.metadata?.map?.name || 'Competitivo',
                won: won,
                result: won ? 'Victoria' : 'Derrota',
                kda: `${k}/${d}/${a}`
              });
            }
          }
        });
      }

      // 3. Estimación Proporcional de Derrotas
      if (actLosses === 0) {
        if (historyWins > 0 && historyLosses > 0) {
          const winrateProportion = historyWins / (historyWins + historyLosses);
          const estimatedTotal = Math.round(actWins / winrateProportion);
          actLosses = Math.max(0, estimatedTotal - actWins);
        } else {
          actLosses = historyLosses;
        }
      }

    } catch (err) {
      console.error(`Error procesando a ${p.name}:`, err);
    }

    const wins = actWins;
    const losses = actLosses;
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
      matches: matchesHistory.reverse()
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
