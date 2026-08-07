import Redis from 'ioredis';

// Reutilizamos la conexión entre invocaciones dentro de la misma instancia
// (evita abrir una conexión nueva a Redis en cada request).
let client = null;

export function getRedis() {
  if (!client) {
    if (!process.env.REDIS_URL) {
      throw new Error('Falta la variable de entorno REDIS_URL');
    }
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3
    });
  }
  return client;
}
