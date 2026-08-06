let globalCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutos de caché para proteger tu cuota

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, headers, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, { headers });
    if (res.status !== 429) return res;
    // Si da 429, esperamos 3.5 segundos antes de reintentar
    await sleep(3500);
  }
  return null;
}

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY' });
  }

  const now = Date.now();
  if (globalCache && (now - lastFetchTime < CACHE_DURATION_MS)) {
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(globalCache);
  }

  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' }
  ];

  const results = [];
  const reqHeaders = { 'Authorization': API_KEY, 'User-Agent': 'SoloQChallenge/1.0' };

  for (const p of players) {
    let rank = 'Sin Clasificar';
    let rr = 0;
    let tier = 0;
    let rankImage = '';

    let wins = 0;
    let losses = 0;
    let totalKills = 0;
    let totalDeaths = 0;
    let totalHeadshots = 0;
    let totalBodyshots = 0;
    let totalLegshots = 0;
    let matchesHistory = [];

    try {
      // 1. Obtener MMR (Rango y RR)
      await sleep(2200);
      const mmrRes = await fetchWithRetry(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`,
        reqHeaders
      );

      if (mmrRes && mmrRes.ok) {
        const mmrData = await mmrRes.json();
        const currentData = mmrData.data?.current_data;
        rank = currentData?.currenttierpatched || 'Sin Clasificar';
        rr = currentData?.ranking_in_tier || 0;
        tier = currentData?.currenttier || 0;
        rankImage = currentData?.images?.small || '';
      }

      // 2. Obtener Historial de Partidas
      await sleep(2200);
      const matchesRes = await fetchWithRetry(
        `https://api.henrikdev.xyz/valorant/v3/matches/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?filter=competitive`,
        reqHeaders
      );

      if (matchesRes && matchesRes.ok) {
        const matchesData = await matchesRes.json();
        const rawMatches = matchesData.data || [];

        // Tomar las últimas 5 partidas y procesarlas
        const recentMatches = rawMatches.slice(0, 5).reverse();

        recentMatches.forEach((m) => {
          const playerObj = m.players?.all_players?.find(
            (pl) => pl.name.toLowerCase() === p.name.toLowerCase() && pl.tag.toLowerCase() === p.tag.toLowerCase()
          );

          if (playerObj) {
            const playerTeam = playerObj.team?.toLowerCase();
            const redWon = m.teams?.red?.has_won;
            const blueWon = m.teams?.blue?.has_won;

            const won = (playerTeam === 'red' && redWon) || (playerTeam === 'blue' && blueWon);

            if (won) wins++;
            else losses++;

            const k = playerObj.stats?.kills || 0;
            const d = playerObj.stats?.deaths || 0;
            const a = playerObj.stats?.assists || 0;

            totalKills += k;
            totalDeaths += d;
            totalHeadshots += playerObj.stats?.headshots || 0;
            totalBodyshots += playerObj.stats?.bodyshots || 0;
            totalLegshots += playerObj.stats?.legshots || 0;

            matchesHistory.push({
              map: m.metadata?.map || 'Competitivo',
              won: won,
              result: won ? 'Victoria' : 'Derrota',
              kda: `${k}/${d}/${a}`
            });
          }
        });
      }

    } catch (err) {
      console.error(`Error al procesar datos para ${p.name}:`, err);
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

  globalCache = { updatedAt: new Date().toISOString(), players: results };
  lastFetchTime = now;

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(globalCache);
}
