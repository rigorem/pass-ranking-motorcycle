// Ein Bild ablegen – der einzige Weg in den Dateispeicher. Sowohl der Upload aus dem
// Browser als auch der Import vom Handy laufen hier durch, damit es nicht
// zwei Wahrheiten darüber gibt, wo ein Foto liegt.

import { redis, photoKey } from './store.js';
import { putFile } from './files.js';
import crypto from 'node:crypto';

// Browser und Kurzbefehl rechnen Bilder vorher auf 1800 px herunter: spart
// Platz und lädt am Berg schneller. Caddy lässt für Fotos höchstens 25 MB durch.
export const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']);

// Videos werden nicht verkleinert und gehen deshalb über eine eigene Route,
// die sie direkt auf die Platte schreibt, statt sie im Speicher zu sammeln.
// Siehe api/videos.js.
export const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
export const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

// Videos tragen ihre Art in der Id. Das ist bewusst schlicht: so bleiben
// pass.photos, der Eingang und das Löschen unverändert – sie reichen Ids
// ohnehin nur durch – und der Browser weiß trotzdem, was er anzeigen muss.
export const VIDEO_PREFIX = 'v-';
export const isVideoId = id => String(id).startsWith(VIDEO_PREFIX);

const EXT = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic'
};

// server.mjs liefert den Body je nach Content-Type schon geparst (so wie es
// früher Vercel tat). Bei
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
export const hashKey = sha => 'photohash:' + sha;   // Bytes -> Foto-Id
export const shaKey = id => 'photosha:' + id;       // Foto-Id -> Bytes

export function fingerprint(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Die Datei ist von außen nicht erreichbar. In Redis liegt nur der Pfad,
// ausgeliefert wird über /api/photos/<id>, und das prüft vorher die Session.
export async function storePhoto(data, type, sha) {
  const id = crypto.randomUUID();
  const blob = await putFile(`photos/${id}.${EXT[type] || 'jpg'}`, data, { addRandomSuffix: true });
  await redis.set(photoKey(id), blob.pathname);
  // Beide Richtungen merken: die eine erkennt dasselbe Bild beim nächsten
  // Hochladen, die andere erspart dem Aufräumen das erneute Herunterladen.
  const digest = sha || fingerprint(data);
  try {
    await redis.set(hashKey(digest), id);
    await redis.set(shaKey(id), digest);
  } catch { /* ohne Merker läuft es auch, nur doppelt */ }
  return id;
}

// Schon einmal dagewesen? Dann die vorhandene Id, sonst null.
export async function knownPhoto(sha) {
  try {
    const id = await redis.get(hashKey(sha));
    if (!id) return null;
    // Nur melden, wenn das Foto auch wirklich noch existiert.
    return (await redis.get(photoKey(String(id)))) ? String(id) : null;
  } catch { return null; }
}
