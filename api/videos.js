import { guardWrite } from './_lib/auth.js';
import { redis, photoKey, appendPhotos } from './_lib/store.js';
import { VIDEO_TYPES, VIDEO_PREFIX } from './_lib/photos.js';
import { inboxKey, bumpInboxRev } from './_lib/inbox.js';
import crypto from 'node:crypto';

// Trägt ein fertig hochgeladenes Video in die App ein. Die Bytes liegen zu
// diesem Zeitpunkt schon im Blob-Store – hier entsteht nur der Verweis.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guardWrite(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = typeof req.body === 'string' ? safe(req.body) : (req.body || {});
  const pathname = String(body.pathname || '');
  const type = String(body.contentType || '').split(';')[0].trim();
  const passId = body.passId ? String(body.passId) : '';

  // Nur Pfade aus unserem eigenen Videoordner – sonst ließe sich hier ein
  // beliebiges fremdes Blob eintragen.
  if (!/^videos\/[A-Za-z0-9._-]+$/.test(pathname)) {
    return res.status(400).json({ error: 'bad_pathname' });
  }
  if (!VIDEO_TYPES.has(type)) return res.status(415).json({ error: 'unsupported_type' });

  const id = VIDEO_PREFIX + crypto.randomUUID();
  try {
    await redis.set(photoKey(id), pathname);

    if (passId) {
      const pass = await appendPhotos(passId, [id]);
      if (!pass) return res.status(404).json({ error: 'not_found' });
      return res.status(201).json({ id, passId });
    }

    await redis.hset(inboxKey(), { [id]: JSON.stringify({ taken: String(body.taken || ''), lat: null, lon: null }) });
    await bumpInboxRev();
    return res.status(201).json({ id, inbox: true });
  } catch (e) {
    return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
  }
}

function safe(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
