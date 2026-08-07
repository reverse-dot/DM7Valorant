// Extiende el timeout de la función en Vercel (si tu plan lo permite) para que no la maten a mitad de camino
export const config = { maxDuration: 60 };

let globalCache = null;       // Último resultado bueno (se sirve aunque esté algo vencido)
let lastFetchTime = 0;
let inFlightPromise = null;   // Candado: evita que la MISMA instancia dispare 2 refrescos a la vez

const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 min: dentro de esta ventana, se sirve el caché sin tocar la API
const MAX_STALE_MS = 2 * 60 * 60 * 1000;  // Hasta 2h de caché vencido se sigue mostrando ante error/reintento

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Espera entre cada llamada individual a Henrik, para no saturar aunque sea 1 sola persona
const DELAY_BETWEEN_CALLS_MS = 3000;

// Icono de rango: se arma directo con la URL pública de valorant-api.com, sin gastar
// una llamada extra a Henrik solo para traer la imagen.
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

      // Backoff exponencial ante 429: 5s, 10s, 20s, 40s...
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

// Hace TODO el trabajo pesado: recorre jugadores UNO POR UNO, con pausas entre cada llamada.
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
      // 1. MMR v3: Rango, RR y récord del ACTO ACTUAL (wins/games totales, no solo las últimas 5)
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
        rankImage = rankImageFromTier(tier); // sin llamada extra a Henrik

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

      // 2. Historial de partidas (para el sparkline / últimas partidas, no para el V/D total)
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

// Dispara un refresh en segundo plano, protegido por el candado de esta instancia.
// No hay que esperarlo: el usuario ya recibió una respuesta (caché fresco o vencido).
function triggerBackgroundRefresh(API_KEY) {
  if (inFlightPromise) return; // ya hay uno corriendo en esta instancia, no dupliques

  inFlightPromise = buildStats(API_KEY)
    .then((data) => {
      globalCache = data;
      lastFetchTime = Date.now();
    })
    .catch((err) => {
      console.error('Fallo el refresh en background:', err);
    })
    .finally(() => {
      inFlightPromise = null;
    });
}

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY' });
  }

  const now = Date.now();

  // 1. Caché fresco (< 15 min): se devuelve al toque.
  if (globalCache && (now - lastFetchTime < CACHE_DURATION_MS)) {
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(globalCache);
  }

  // 2. Caché vencido pero existe: se devuelve YA MISMO (el usuario no espera nada),
  //    y se dispara un refresh en segundo plano para la próxima visita.
  //    Esto es clave: nadie tiene que esperar ~40s ni recargar la página por impaciencia,
  //    que era justo lo que generaba pedidos duplicados y saturaba la API.
  if (globalCache) {
    triggerBackgroundRefresh(API_KEY);
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(globalCache);
  }

  // 3. No hay NINGÚN caché todavía (primera vez tras un deploy): acá sí hay que esperar,
  //    porque no hay nada que mostrar. Si ya hay un refresh en curso en esta instancia,
  //    nos enganchamos a esa misma promesa en vez de disparar uno nuevo.
  if (!inFlightPromise) {
    inFlightPromise = buildStats(API_KEY)
      .then((data) => {
        globalCache = data;
        lastFetchTime = Date.now();
        return data;
      })
      .finally(() => {
        inFlightPromise = null;
      });
  }

  try {
    const freshData = await inFlightPromise;
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    return res.status(200).json(freshData || globalCache);
  } catch (err) {
    console.error('Fallo total al construir stats:', err);
    if (globalCache && (Date.now() - lastFetchTime < MAX_STALE_MS)) {
      return res.status(200).json(globalCache);
    }
    return res.status(502).json({ error: 'No se pudo obtener datos de Henrik API. Probá de nuevo en un minuto.' });
  }
}
