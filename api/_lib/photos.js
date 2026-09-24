// Ein Bild ablegen – der einzige Weg ins Blob. Sowohl der Upload aus dem
// Browser als auch der Import vom Handy laufen hier durch, damit es nicht
// zwei Wahrheiten darüber gibt, wo ein Foto liegt.

import { redis, photoKey } from './store.js';
import { put } from '@vercel/blob';
import crypto from 'node:crypto';

// Vercel deckelt den Request-Body bei 4,5 MB. Browser und Kurzbefehl rechnen
// Bilder vorher auf 1800 px herunter, damit bleibt jedes Foto darunter.
export const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']);

const EXT = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic'
};

// Vercel liefert den Body je nach Content-Type schon fertig geparst. Bei
// Binärdaten kann das ein Buffer sein – sonst den Stream selbst einsammeln.
export async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export function contentType(req) {
  return String(req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
}

// Fingerabdruck der Bytes. Damit lässt sich erkennen, ob dasselbe Foto schon
// einmal ankam – der Kurzbefehl weiß das von sich aus nicht.
export const hashKey = sha => 'photohash:' + sha;

export function fingerprint(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Privater Store: das Blob ist ohne Token von außen gar nicht abrufbar. In
// Redis liegt nur der Pfad, ausgeliefert wird über /api/photos/<id>, und das
// prüft vorher die Session.
export async function storePhoto(data, type) {
  const id = crypto.randomUUID();
  const blob = await put(`photos/${id}.${EXT[type] || 'jpg'}`, data, {
    access: 'private',
    addRandomSuffix: true,
    contentType: type
  });
  await redis.set(photoKey(id), blob.pathname);
  return id;
}
