let globalCache = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutos de caché interno

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  const API_KEY = process.env.HENRIK_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Falta HENRIK_API_KEY en variables de entorno' });
  }

  const now = Date.now();
  // 1. Si existe caché en la memoria local del Serverless, responder de inmediato
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
    let tier = 0;
    let rankImage = '';

    try {
      // Pausa de 1.5 segundos entre consultas para respetar cuotas
      await sleep(1500);

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
        tier = currentData?.currenttier || 0; // Ejemplo: Platino 3 = 17, Diamante 3 = 20, Ascendente 1 = 21
        rankImage = currentData?.images?.small || '';
      }
    } catch (err) {
      console.error(`Error obteniendo datos para ${p.name}:`, err);
    }

    // Calculamos el ELO real: (Tier * 100) + RR
    const elo = (tier * 100) + rr;

    results.push({
      name: p.name,
      tag: p.tag,
      rank,
      rr,
      tier,
      elo,
      rankImage,
      stats: { wins: 0, losses: 0, totalMatches: 0, winRate: 0, kd: '0.00', headshotPct: 0 },
      matches: []
    });
  }

  // Guardar respuesta en caché
  globalCache = { updatedAt: new Date().toISOString(), players: results };
  lastFetchTime = now;

  // Header de caché para que la CDN Edge de Vercel tampoco sature la API
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json(globalCache);
}
