let globalCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 15 * 60 * 1000; // Guardar en caché por 15 minutos

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY' });
  }

  const now = Date.now();
  // Si ya tenemos datos guardados de hace menos de 15 min, responder con eso de inmediato
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

  for (const p of players) {
    let rank = 'Sin Clasificar';
    let rr = 0;
    let rankImage = '';

    try {
      // 1.8 segundos de pausa estricta entre cada jugador
      await sleep(1800);

      const response = await fetch(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${p.region}/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`,
        { 
          headers: { 
            'Authorization': API_KEY,
            'User-Agent': 'SoloQChallenge/1.0'
          } 
        }
      );

      if (response.ok) {
        const mmrData = await response.json();
        const currentData = mmrData.data?.current_data;

        rank = currentData?.currenttierpatched || 'Sin Clasificar';
        rr = currentData?.ranking_in_tier || 0;
        rankImage = currentData?.images?.small || '';
      }
    } catch (err) {
      console.error(`Error procesando a ${p.name}:`, err);
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

  // Si se obtuvieron datos válidos, guardamos en la memoria global de Vercel
  globalCache = { updatedAt: new Date().toISOString(), players: results };
  lastFetchTime = now;

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(globalCache);
}
