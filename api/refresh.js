import { getRedis } from './_redis.js';

export const config = { maxDuration: 60 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Espera entre cada llamada individual a Henrik, para no saturar.
// Como esto ahora corre solo cada N minutos via cron (no por cada visita),
// se puede bajar bastante sin riesgo.
const DELAY_BETWEEN_CALLS_MS = 3000;

const TIER_CONTENT_ID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function rankImageFromTier(tierId) {
  if (!tierId) return '';
  return `https://media.valorant-api.com/competitivetiers/${TIER_CONTENT_ID}/${tierId}/smallicon.png`;
}

async function fetchWithRetry(url, headers, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status !== 429) return res;

      const wait = 5000 * Math.pow(2, i);
      console.warn(`429 recibido en ${url}, reintentando en ${wait}ms (intento ${i + 1}/${retries + 1})`);
      await sleep(wait);
    } catch (err) {
      console.error('Error de red al llamar a Henrik:', err.message);
      await sleep(2000);
    }
  }
  return null;
}

const players = [
 { name: 'X1no', tag: 'DM7', region: 'latam', cardImage: 'https://www.reddit.com/media?url=https%3A%2F%2Fpreview.redd.it%2Fbro-i-hope-so-much-we-will-get-a-kunigami-episode-v0-s2oinv2dwcae1.png%3Fwidth%3D1080%26crop%3Dsmart%26auto%3Dwebp%26s%3Dfc3fdfb2f3d174d1731dc2a9897f8f934a823a76' },
  { name: 'Xrosfire', tag: '4884', region: 'latam', cardImage: 'https://cdn.discordapp.com/avatars/346136099027943434/f907376d139f25ff98003dc14e6930a3.webp?size=160' },
  { name: 'zingCL', tag: 'DM7', region: 'latam', cardImage: 'https://cdn.discordapp.com/avatars/168554778283081729/beecf04af89b8067a927a2a18d66ac6e.webp?size=160' },
  { name: 'pavliuchenko', tag: '7144', region: 'latam', cardImage: 'https://cdn.discordapp.com/avatars/309201004979683328/0996872fe3e066a0cdc5904c184b9a3a.webp?size=160' },
  { name: 'sayaplayer', tag: '9243', region: 'latam', cardImage: 'https://cdn.discordapp.com/avatars/205443962993901568/a88cc31d04ba149be3ac8c0cff146307.webp?size=160' },
  { name: 'Focus', tag: 'DM7', region: 'latam', cardImage: 'https://cdn.discordapp.com/avatars/161309819809169411/f1cdfc36cff46a0265f72e59442cc4f5.webp?size=160' }
];

async function buildStats(API_KEY) {
  const results = [];
  const reqHeaders = { 'Authorization': API_KEY, 'User-Agent': 'SoloQChallenge/1.0' };

  for (const p of players) {
    let rank = 'Sin Clasificar';
    let rr = 0;
    let tier = 0;
    let rankImage = '';

    let wins = 0;
    let losses = 0;
    let totalActGames = 0;
    let currentActShort = '';
    let totalKills = 0;
    let totalDeaths = 0;
    let totalHeadshots = 0;
    let totalBodyshots = 0;
    let totalLegshots = 0;
    let matchesHistory = [];

    try {
      await sleep(DELAY_BETWEEN_CALLS_MS);
      const mmrRes = await fetchWithRetry(
        `https://api.henrikdev.xyz/valorant/v3/mmr/${p.region}/pc/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`,
        reqHeaders
      );

      if (mmrRes && mmrRes.ok) {
        const mmrData = await mmrRes.json();
        const currentData = mmrData.data?.current;
        rank = currentData?.tier?.name || 'Sin Clasificar';
        rr = currentData?.rr || 0;
        tier = currentData?.tier?.id || 0;
        rankImage = rankImageFromTier(tier);

        const seasonal = mmrData.data?.seasonal || [];
        const currentAct = seasonal[seasonal.length - 1];

        if (currentAct) {
          wins = currentAct.wins || 0;
          totalActGames = currentAct.games || 0;
          losses = totalActGames - wins;
          currentActShort = currentAct.season?.short || '';
        }
      } else {
        console.error(`MMR v3 falló para ${p.name} (status ${mmrRes?.status})`);
      }

      await sleep(DELAY_BETWEEN_CALLS_MS);
      const matchesRes = await fetchWithRetry(
        `https://api.henrikdev.xyz/valorant/v3/matches/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}?filter=competitive`,
        reqHeaders
      );

      if (matchesRes && matchesRes.ok) {
        const matchesData = await matchesRes.json();
        const rawMatches = matchesData.data || [];
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

    const totalMatches = totalActGames;
    const winRate = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : 0;
    const kd = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : (totalKills > 0 ? totalKills.toFixed(2) : '0.00');

    const totalShots = totalHeadshots + totalBodyshots + totalLegshots;
    const headshotPct = totalShots > 0 ? Math.round((totalHeadshots / totalShots) * 100) : 0;

    const elo = (tier * 100) + rr;

    results.push({
      name: p.name,
      tag: p.tag,
      cardImage: p.cardImage || '',
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
  // Protección: solo el cron (que manda este secret) puede disparar un refresh.
  // Evita que cualquiera pegándole a esta URL gaste tu cupo de la API.
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

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
    console.error('Fallo al refrescar stats:', err);
    return res.status(502).json({ error: 'No se pudo refrescar' });
  }
}
