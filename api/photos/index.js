import { guard } from '../_lib/auth.js';
import { redis, photoKey } from '../_lib/store.js';
import { put } from '@vercel/blob';
import crypto from 'node:crypto';

// Vercel deckelt den Request-Body bei 4,5 MB. Das Frontend rechnet Bilder
// vorher auf 1800 px herunter, damit bleibt jedes Foto deutlich darunter.
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']);

// Vercel liefert den Body je nach Content-Type schon fertig geparst. Bei
// Binärdaten kann das ein Buffer sein – sonst den Stream selbst einsammeln.
async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const type = String(req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
  if (!ALLOWED.has(type)) return res.status(415).json({ error: 'unsupported_type' });

  try {
    const data = await readBody(req);
    if (!data.length) return res.status(400).json({ error: 'empty_body' });

    const id = crypto.randomUUID();
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp'
      : type === 'image/gif' ? 'gif' : type === 'image/heic' ? 'heic' : 'jpg';

    // Privater Store: das Blob ist ohne Token von außen gar nicht abrufbar.
    // In Redis liegt nur der Pfad, ausgeliefert wird über /api/photos/<id>,
    // und das prüft vorher die Session.
    const blob = await put(`photos/${id}.${ext}`, data, {
      access: 'private',
      addRandomSuffix: true,
      contentType: type
    });

    await redis.set(photoKey(id), blob.pathname);
    return res.status(201).json({ id });
  } catch (e) {
    return res.status(500).json({ error: 'upload_failed', detail: String(e.message || e) });
  }
}
