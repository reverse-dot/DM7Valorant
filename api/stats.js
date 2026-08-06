// Caché en memoria para evitar llamadas repetidas durante 10 minutos
let globalCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutos

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY' });
  }

  // 1. Si los datos en caché están vigentes, los entregamos inmediatamente
  const now = Date.now();
  if (globalCache && (now - lastFetchTime < CACHE_DURATION_MS)) {
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
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

  for (const p of players) {
    let rank = 'Sin Clasificar';
    let rr = 0;
    let rankImage = '';

    try {
      // Retardo de 1.2 segundos entre cada jugador para respetar los límites
      await sleep(1200);

      const mmrRes = await fetch(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`,
        { headers: { 'Authorization': API_KEY } }
      );

      if (mmrRes.ok) {
        const mmrData = await mmrRes.json();
        const currentData = mmrData.data?.current_data;

        rank = currentData?.currenttierpatched || 'Sin Clasificar';
        rr = currentData?.ranking_in_tier || 0;
        rankImage = currentData?.images?.small || '';
      }
    } catch (err) {
      console.error(`Error consultando a ${p.name}:`, err);
    }

    results.push({
      name: p.name,
      tag: p.tag,
      rank,
      rr,
      rankImage,
      stats: { wins: 0, losses: 0, totalMatches: 0, winRate: 0, kd: '0.00', headshotPct: 0 },
      matches: []
    });
  }

  // Verificar si obtuvimos al menos 1 resultado válido
  const hasData = results.some(p => p.rr > 0 || p.rank !== 'Sin Clasificar');

  if (hasData || !globalCache) {
    globalCache = { updatedAt: new Date().toISOString(), players: results };
    lastFetchTime = now;
  }

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  return res.status(200).json(globalCache);
}
