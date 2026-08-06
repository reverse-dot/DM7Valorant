
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

export default async function handler(req, res) {
  // Configuración de cabeceras para CORS y caché (10 minutos)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');

  const API_KEY = process.env.HENRIK_API_KEY;

  try {
    const playersPath = path.join(process.cwd(), 'players.json');
    if (!fs.existsSync(playersPath)) {
      return res.status(500).json({ error: 'No se encontró el archivo players.json' });
    }

    const rawPlayers = fs.readFileSync(playersPath, 'utf-8');
    const players = JSON.parse(rawPlayers);
    const results = [];

    const headers = {};
    if (API_KEY) {
      headers['Authorization'] = API_KEY;
    }

    for (const player of players) {
      const encodedName = encodeURIComponent(player.name);
      const encodedTag = encodeURIComponent(player.tag);

      // 1. Datos de Cuenta
      const accountUrl = `https://api.henrikdev.xyz/valorant/v1/account/${encodedName}/${encodedTag}`;
      const accountRes = await fetch(accountUrl, { headers });
      if (!accountRes.ok) continue;
      const accountData = await accountRes.json();
      if (!accountData.data) continue;

      const account = accountData.data;
      const region = account.region || 'na';

      // 2. MMR / Rango
      const mmrUrl = `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${region}/${account.puuid}`;
      const mmrRes = await fetch(mmrUrl, { headers });
      const mmrData = mmrRes.ok ? await mmrRes.json() : null;

      // 3. Historial de Partidas
      const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${region}/${account.puuid}?mode=competitive&size=5`;
      const matchesRes = await fetch(matchesUrl, { headers });
      const matchesData = matchesRes.ok ? await matchesRes.json() : null;

      const currentData = mmrData?.data?.current_data || {};
      const currentRank = currentData.currenttierpatched || 'Sin Clasificar';
      const currentRR = currentData.ranking_in_tier ?? 0;
      const rankImage = currentData.images?.small || currentData.images?.large || '';

      const rawMatches = matchesData?.data || [];
      let totalKills = 0, totalDeaths = 0, totalAssists = 0, totalScore = 0, totalDamage = 0, totalRounds = 0;
      let totalHeadshots = 0, totalBodyshots = 0, totalLegshots = 0;
      let wins = 0, losses = 0;

      const matchesHistory = rawMatches.map((m) => {
        const playerStats = m.players?.all_players?.find((p) => p.puuid === account.puuid);
        const playerTeam = playerStats?.team?.toLowerCase();
        const redScore = m.teams?.red?.rounds_won ?? 0;
        const blueScore = m.teams?.blue?.rounds_won ?? 0;

        let result = 'No disponible';
        let won = false;

        if (playerTeam === 'red') won = redScore > blueScore;
        else if (playerTeam === 'blue') won = blueScore > redScore;

        if (won) { wins++; result = 'Victoria'; }
        else if (redScore === blueScore) { result = 'Empate'; }
        else { losses++; result = 'Derrota'; }

        const kills = playerStats?.stats?.kills || 0;
        const deaths = playerStats?.stats?.deaths || 0;
        const assists = playerStats?.stats?.assists || 0;
        const score = playerStats?.stats?.score || 0;
        const headshots = playerStats?.stats?.headshots || 0;
        const bodyshots = playerStats?.stats?.bodyshots || 0;
        const legshots = playerStats?.stats?.legshots || 0;
        const damage = playerStats?.damage_made || 0;
        const roundsPlayed = m.metadata?.rounds_played || 1;

        totalKills += kills; totalDeaths += deaths; totalAssists += assists;
        totalScore += score; totalDamage += damage; totalRounds += roundsPlayed;
        totalHeadshots += headshots; totalBodyshots += bodyshots; totalLegshots += legshots;

        let isMVP = false;
        if (m.players?.all_players) {
          const topScorer = [...m.players.all_players].sort((a, b) => (b.stats?.score || 0) - (a.stats?.score || 0))[0];
          if (topScorer && topScorer.puuid === account.puuid) isMVP = true;
        }

        return {
          date: m.metadata?.game_start_patched || 'No disponible',
          map: m.metadata?.map || 'Desconocido',
          agent: playerStats?.character || 'Agente',
          result, kills, deaths, assists, isMVP
        };
      });

      const totalMatches = rawMatches.length;
      const kd = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
      const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
      const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
      const headshotPct = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;

      results.push({
        name: account.name,
        tag: account.tag,
        puuid: account.puuid,
        region: account.region || 'N/A',
        level: account.account_level || 0,
        cardImage: account.assets?.card?.small || '',
        rank: currentRank,
        rr: currentRR,
        rankImage: rankImage,
        stats: {
          kd: parseFloat(kd),
          winRate,
          headshotPct,
          totalMatches,
          wins,
          losses
        },
        matches: matchesHistory
      });
    }

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      totalPlayers: results.length,
      players: results
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
