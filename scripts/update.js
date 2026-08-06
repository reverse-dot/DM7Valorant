const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const API_KEY = process.env.HENRIK_API_KEY;
const PLAYERS_FILE = path.join(__dirname, '../players.json');
const OUTPUT_FILE = path.join(__dirname, '../stats.json');

async function fetchWithRetry(url, options = {}, retries = 3, backoff = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return await response.json();
      }
      if (response.status === 429) {
        console.warn(`Límite de peticiones alcanzado en ${url}. Reintentando en ${backoff}ms...`);
      } else {
        console.warn(`Error ${response.status} en ${url}. Reintentando...`);
      }
    } catch (err) {
      console.error(`Error de red al consultar ${url}: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff *= 1.5;
  }
  return null;
}

async function getPlayerData(player) {
  const headers = {};
  if (API_KEY) {
    headers['Authorization'] = API_KEY;
  }

  const encodedName = encodeURIComponent(player.name);
  const encodedTag = encodeURIComponent(player.tag);

  // 1. Obtener Cuenta Básica
  const accountUrl = `https://api.henrikdev.xyz/valorant/v1/account/${encodedName}/${encodedTag}`;
  const accountRes = await fetchWithRetry(accountUrl, { headers });

  if (!accountRes || accountRes.status !== 200 || !accountRes.data) {
    console.error(`No se pudo obtener la cuenta de ${player.name}#${player.tag}`);
    return null;
  }

  const account = accountRes.data;
  const region = account.region || 'na';

  // 2. Obtener Rango MMC
  const mmrUrl = `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${region}/${account.puuid}`;
  const mmrRes = await fetchWithRetry(mmrUrl, { headers });

  // 3. Obtener Historial de Partidas Recientes
  const matchesUrl = `https://api.henrikdev.xyz/valorant/v3/by-puuid/matches/${region}/${account.puuid}?mode=competitive&size=5`;
  const matchesRes = await fetchWithRetry(matchesUrl, { headers });

  // Procesar Rango
  const currentData = mmrRes?.data?.current_data || {};
  const currentRank = currentData.currenttierpatched || 'Sin Clasificar';
  const currentRR = currentData.ranking_in_tier ?? 0;
  const rankImage = currentData.images?.small || currentData.images?.large || '';

  // Procesar Partidas y Calcular Métricas
  const rawMatches = matchesRes?.data || [];
  let totalKills = 0;
  let totalDeaths = 0;
  let totalAssists = 0;
  let totalScore = 0;
  let totalDamage = 0;
  let totalRounds = 0;
  let totalHeadshots = 0;
  let totalBodyshots = 0;
  let totalLegshots = 0;
  let wins = 0;
  let losses = 0;

  const matchesHistory = rawMatches.map((m) => {
    const playerStats = m.players?.all_players?.find((p) => p.puuid === account.puuid);
    const playerTeam = playerStats?.team?.toLowerCase();
    const redScore = m.teams?.red?.rounds_won ?? 0;
    const blueScore = m.teams?.blue?.rounds_won ?? 0;

    let result = 'No disponible';
    let won = false;

    if (playerTeam === 'red') {
      won = redScore > blueScore;
    } else if (playerTeam === 'blue') {
      won = blueScore > redScore;
    }

    if (won) {
      wins++;
      result = 'Victoria';
    } else if (redScore === blueScore) {
      result = 'Empate';
    } else {
      losses++;
      result = 'Derrota';
    }

    const kills = playerStats?.stats?.kills || 0;
    const deaths = playerStats?.stats?.deaths || 0;
    const assists = playerStats?.stats?.assists || 0;
    const score = playerStats?.stats?.score || 0;
    const headshots = playerStats?.stats?.headshots || 0;
    const bodyshots = playerStats?.stats?.bodyshots || 0;
    const legshots = playerStats?.stats?.legshots || 0;
    const damage = playerStats?.damage_made || 0;
    const roundsPlayed = m.metadata?.rounds_played || 1;

    totalKills += kills;
    totalDeaths += deaths;
    totalAssists += assists;
    totalScore += score;
    totalDamage += damage;
    totalRounds += roundsPlayed;
    totalHeadshots += headshots;
    totalBodyshots += bodyshots;
    totalLegshots += legshots;

    // MVP Check
    let isMVP = false;
    if (m.players?.all_players) {
      const topScorer = [...m.players.all_players].sort(
        (a, b) => (b.stats?.score || 0) - (a.stats?.score || 0)
      )[0];
      if (topScorer && topScorer.puuid === account.puuid) {
        isMVP = true;
      }
    }

    return {
      date: m.metadata?.game_start_patched || 'No disponible',
      map: m.metadata?.map || 'Desconocido',
      agent: playerStats?.character || 'Agente',
      agentImage: playerStats?.assets?.agent?.small || '',
      result,
      kills,
      deaths,
      assists,
      isMVP
    };
  });

  const totalMatches = rawMatches.length;
  const kd = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
  const kda = totalDeaths > 0 ? ((totalKills + totalAssists) / totalDeaths).toFixed(2) : (totalKills + totalAssists).toFixed(2);
  const acs = totalRounds > 0 ? Math.round(totalScore / totalRounds) : 0;
  const adr = totalRounds > 0 ? Math.round(totalDamage / totalRounds) : 0;
  const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
  const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
  const headshotPct = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;

  return {
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
      kda: parseFloat(kda),
      acs: acs,
      adr: adr,
      winRate: winRate,
      headshotPct: headshotPct,
      totalMatches: totalMatches,
      wins: wins,
      losses: losses
    },
    matches: matchesHistory
  };
}

async function main() {
  console.log('Iniciando extracción de datos de Valorant...');
  
  if (!fs.existsSync(PLAYERS_FILE)) {
    console.error('El archivo players.json no existe.');
    process.exit(1);
  }

  const rawPlayers = fs.readFileSync(PLAYERS_FILE, 'utf-8');
  const players = JSON.parse(rawPlayers);
  const results = [];

  for (const player of players) {
    console.log(`Procesando a ${player.name}#${player.tag}...`);
    const data = await getPlayerData(player);
    if (data) {
      results.push(data);
    } else {
      console.warn(`No se pudieron procesar las estadísticas de ${player.name}#${player.tag}`);
    }
  }

  const outputData = {
    updatedAt: new Date().toISOString(),
    totalPlayers: results.length,
    players: results
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`stats.json generado con éxito. Jugadores actualizados: ${results.length}`);
}

main().catch((err) => {
  console.error('Error fatal al ejecutar el script de actualización:', err);
  process.exit(1);
});