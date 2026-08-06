// Función para forzar pausa entre peticiones
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY' });
  }

  const players = [
    { name: 'X1no', tag: 'DM7', region: 'latam' },
    { name: 'Xrosfire', tag: '4884', region: 'latam' },
    { name: 'zingCL', tag: 'DM7', region: 'latam' },
    { name: 'pavliuchenko', tag: '7144', region: 'latam' },
    { name: 'sayaplayer', tag: '9243', region: 'latam' }
  ];

  const results = [];

  // Usamos for...of secuencial estricto
  for (const p of players) {
    let rank = 'Sin Clasificar';
    let rr = 0;
    let rankImage = '';
    let wins = 0, losses = 0, kills = 0, deaths = 0, headshots = 0, bodyshots = 0, legshots = 0;
    let matchesList = [];

    try {
      // 1. Obtener MMR / Rango
      const mmrRes = await fetch(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`,
        { headers: { 'Authorization': API_KEY } }
      );

      if (mmrRes.ok) {
        const mmrData = await mmrRes.json();
        rank = mmrData.data?.current_data?.currenttierpatched || 'Sin Clasificar';
        rr = mmrData.data?.current_data?.ranking_in_tier || 0;
        rankImage = mmrData.data?.current_data?.images?.small || '';
      }

      // Esperamos 1 segundo completo antes de la siguiente petición
      await sleep(1000);

      // 2. Obtener Historial
      const matchesRes = await fetch(
        `https://api.henrikdev.xyz/valorant/v3/matches/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?filter=competitive`,
        { headers: { 'Authorization': API_KEY } }
      );

      if (matchesRes.ok) {
        const matchesData = await matchesRes.json();
        const matches = matchesData.data || [];

        matches.forEach((m) => {
          const playerStats = m.players?.all_players?.find(
            (player) => player.name.toLowerCase() === p.name.toLowerCase()
          );

          if (playerStats) {
            const teamColor = playerStats.team.toLowerCase();
            const redWon = m.teams?.red?.has_won;
            const blueWon = m.teams?.blue?.has_won;
            const isWin = (teamColor === 'red' && redWon) || (teamColor === 'blue' && blueWon);

            if (isWin) wins++; else losses++;

            kills += playerStats.stats?.kills || 0;
            deaths += playerStats.stats?.deaths || 0;
            headshots += playerStats.stats?.headshots || 0;
            bodyshots += playerStats.stats?.bodyshots || 0;
            legshots += playerStats.stats?.legshots || 0;

            matchesList.push({ result: isWin ? 'Victoria' : 'Derrota' });
          }
        });
      }

    } catch (err) {
      console.error(`Error consultando a ${p.name}:`, err);
    }

    const totalMatches = wins + losses;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
    const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
    const totalShots = headshots + bodyshots + legshots;
    const headshotPct = totalShots > 0 ? Math.round((headshots / totalShots) * 100) : 0;

    results.push({
      name: p.name,
      tag: p.tag,
      rank,
      rr,
      rankImage,
      stats: { wins, losses, totalMatches, winRate, kd, headshotPct },
      matches: matchesList
    });

    // Esperamos 1 segundo antes de pasar al SIGUIENTE JUGADOR
    await sleep(1000);
  }

  // Guardamos en caché por 10 minutos para proteger tu API Key
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  return res.status(200).json({ updatedAt: new Date().toISOString(), players: results });
}
