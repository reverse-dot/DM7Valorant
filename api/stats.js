import { getRedis } from './_redis.js';

// Este endpoint es el que consume el frontend. NUNCA llama a Henrik:
// solo lee lo último que dejó /api/refresh guardado en Redis.
// Por eso responde siempre rápido y nunca puede generar un 429.
export default async function handler(req, res) {
  try {
    const redis = getRedis();
    const raw = await redis.get('valorant:stats');

    if (!raw) {
      // Todavía no corrió ningún refresh (ej. deploy recién hecho).
      return res.status(200).json({ updatedAt: null, players: [] });
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(JSON.parse(raw));
  } catch (err) {
    console.error('Error leyendo Redis:', err);
    return res.status(502).json({ error: 'No se pudo leer las estadísticas.' });
  }
}
