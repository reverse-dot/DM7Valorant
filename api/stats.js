let globalCache = null;
let lastFetchTime = 0;
// Aumentamos a 20 minutos de caché para proteger aún más la cuota de la API
const CACHE_DURATION_MS = 20 * 60 * 1000; 

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY en las variables de entorno de Vercel' });
  }

  const now = Date.now();
  if (globalCache && (now - lastFetchTime < CACHE_DURATION_MS)) {
    res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
    return res.status(200).json(globalCache);
  }

  // LISTA DE 10 JUGADORES (Agrega aquí a los nuevos 5 cuando los tengas)
  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' },
    // --- Próximos Integrantes ---
    // { name: 'Jugador6', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador7', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador8', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador9', tag: 'TAG', region: 'latam' },
    // { name: 'Jugador10', tag: 'TAG', region: 'latam' }
  ];

  const results = [];

  for (const p of players) {
    let rank = 'Sin Clasificar';
    let rr = 0;
    let rankImage = '';
    
    let wins = 0;
    let losses = 0;
    let totalKills = 0;
    let totalDeaths = 0;
    let totalHeadshots = 0;
    let totalShots = 0;
    let matchesHistory = [];

    try {
      // 1. Obtener MMR / Rango
      await sleep(1500);
      const mmrResponse = await fetch(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`,
        { 
          headers: { 
            'Authorization': API_KEY,
            'User-Agent': 'SoloQChallenge/1.0'
          } 
        }
      );

      if (mmrResponse.ok) {
        const mmrData = await mmrResponse.json();
        const currentData = mmrData.data?.current_data;

        rank = currentData?.currenttierpatched || 'Sin Clasificar';
        rr = currentData?.ranking_in_tier || 0;
        rankImage = currentData?.images?.small || '';
      }

      // 2. Obtener Historial de Partidas
      await sleep(1500);
      const matchesResponse = await fetch(
        `https://api.henrikdev.xyz/valorant/v3/matches/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?filter=competitive&size=5`,
        { 
          headers: { 
            'Authorization': API_KEY,
            'User-Agent': 'SoloQChallenge/1.0'
          } 
        }
      );

      if (matchesResponse.ok) {
        const matchesData = await matchesResponse.json();
        const matchesList = matchesData.data || [];

        matchesList.forEach(m => {
          const allPlayers = m.players?.all_players || [];
          const playerStats = allPlayers.find(
            pl => pl.name?.toLowerCase() === p.name.toLowerCase() && pl.tag?.toLowerCase() === p.tag.toLowerCase()
          );

          if (playerStats) {
            const teamColor = playerStats.team?.toLowerCase();
            const myTeam = m.teams?.[teamColor];
            const hasWon = myTeam?.has_won || false;

            if (hasWon) wins++;
            else losses++;

            const st = playerStats.stats || {};
            const k = st.kills || 0;
            const d = st.deaths || 0;
            const a = st.assists || 0;
            const hs = st.headshots || 0;
            const bs = st.bodyshots || 0;
            const ls = st.legshots || 0;

            totalKills += k;
            totalDeaths += d;
            totalHeadshots += hs;
            totalShots += (hs + bs + ls);

            const matchKda = d > 0 ? ((k + a) / d).toFixed(2) : (k + a).toFixed(2);

            matchesHistory.push({
              result: hasWon ? 'Victoria' : 'Derrota',
              won: hasWon,
              map: m.metadata?.map || 'Competitivo',
              kda: matchKda
            });
          }
        });
      }

    } catch (err) {
      console.error(`Error procesando a ${p.name}:`, err);
    }

    const totalMatches = wins + losses;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
    const kdRatio = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
    const headshotPct = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;

    results.push({
      name: p.name,
      tag: p.tag,
      rank,
      rr,
      rankImage,
      stats: { 
        wins, 
        losses, 
        totalMatches, 
        winRate, 
        kd: kdRatio, 
        headshotPct 
      },
      matches: matchesHistory.reverse()
    });
  }

  globalCache = { updatedAt: new Date().toISOString(), players: results };
  lastFetchTime = now;

  res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');
  return res.status(200).json(globalCache);
}
