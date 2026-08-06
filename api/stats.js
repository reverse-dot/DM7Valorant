const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

// Función auxiliar para pausar la ejecución y evitar el Error 429
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=150');

  const API_KEY = process.env.HENRIK_API_KEY;

  try {
    const playersPath = path.join(process.cwd(), 'players.json');
    if (!fs.existsSync(playersPath)) {
      return res.status(500).json({ error: 'No se encontró players.json' });
    }

    const rawPlayers = fs.readFileSync(playersPath, 'utf-8');
    const players = JSON.parse(rawPlayers);
    const results = [];

    const headers = {};
    if (API_KEY) {
      headers['Authorization'] = API_KEY;
    }

    for (const player of players) {
      try {
        const encodedName = encodeURIComponent(player.name);
        const encodedTag = encodeURIComponent(player.tag);

        // 1. Datos de Cuenta
        const accountUrl = `https://api.henrikdev.xyz/valorant/v1/account/${encodedName}/${encodedTag}`;
        const accountRes = await fetch(accountUrl, { headers });
        await delay(250); // Pausa para no saturar la API

        if (!accountRes.ok) {
          results.push({
            name: player.name,
            tag: player.tag,
            rank: 'Sin Clasificar',
            rr: 0,
            stats: { kd: 0, winRate: 0, headshotPct: 0, totalMatches: 0, wins: 0, losses: 0 },
            matches: []
          });
          continue;
        }

        const accountData = await accountRes.json();
        const account = accountData.data;

        if (!account) continue;
        const region = account.region || 'na';

        // 2. MMR / Rango
        const mmrUrl = `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${region}/${account.puuid}`;
        const mmrRes = await fetch(mmrUrl, { headers });
        await delay(250);
        const mmrData = mmrRes.ok ? await mmrRes.json() : null;

        // 3. Partidas Recientes
        const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${region}/${account.puuid}?mode=competitive&size=5`;
        const matchesRes = await fetch(matchesUrl, { headers });
        await delay(250);
        const matchesData = matchesRes.ok ? await matchesRes.json() : null;

        const currentData = mmrData?.data?.current_data || {};
        const currentRank = currentData.currenttierpatched || 'Sin Clasificar';
        const currentRR = currentData.ranking_in_tier ?? 0;
        const rankImage = currentData.images?.small || currentData.images?.large || '';

        const rawMatches = matchesData?.data || [];
        let totalKills = 0, totalDeaths = 0, totalAssists = 0;
        let totalHeadshots = 0, totalBodyshots = 0, totalLegshots = 0;
        let wins = 0, losses = 0;

        const matchesHistory = rawMatches.map((m) => {
          const playerStats = m.players?.all_players?.find((p) => p.puuid === account.puuid);
          const playerTeam = playerStats?.team?.toLowerCase();
          const redScore = m.teams?.red?.rounds_won ?? 0;
          const blueScore = m.teams?.blue?.rounds_won ?? 0;

          let result = 'Derrota';
          let won = false;

          if (playerTeam === 'red') won = redScore > blueScore;
          else if (playerTeam === 'blue') won = blueScore > redScore;

          if (won) { wins++; result = 'Victoria'; }
          else if (redScore === blueScore) { result = 'Empate'; }
          else { losses++; }

          const kills = playerStats?.stats?.kills || 0;
          const deaths = playerStats?.stats?.deaths || 0;
          const assists = playerStats?.stats?.assists || 0;
          const headshots = playerStats?.stats?.headshots || 0;
          const bodyshots = playerStats?.stats?.bodyshots || 0;
          const legshots = playerStats?.stats?.legshots || 0;

          totalKills += kills; totalDeaths += deaths; totalAssists += assists;
          totalHeadshots += headshots; totalBodyshots += bodyshots; totalLegshots += legshots;

          return {
            date: m.metadata?.game_start_patched || '',
            map: m.metadata?.map || 'Desconocido',
            agent: playerStats?.character || 'Agente',
            result, kills, deaths, assists
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
      } catch (err) {
        results.push({
          name: player.name,
          tag: player.tag,
          rank: 'Sin Clasificar',
          rr: 0,
          stats: { kd: 0, winRate: 0, headshotPct: 0, totalMatches: 0, wins: 0, losses: 0 },
          matches: []
        });
      }
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
