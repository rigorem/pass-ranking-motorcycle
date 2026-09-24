import { guardWrite } from './_lib/auth.js';
import { redis, photoKey, appendPhotos } from './_lib/store.js';
import { VIDEO_TYPES, VIDEO_EXT, MAX_VIDEO_BYTES, VIDEO_PREFIX } from './_lib/photos.js';
import { inboxKey, bumpInboxRev } from './_lib/inbox.js';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import crypto from 'node:crypto';

// Videos in zwei Schritten, beide hier: Vercel zählt jede Datei unter api/ als
// eigene Funktion, und davon gibt es nur eine begrenzte Zahl.
//
//   { step: 'token',    contentType, size }        -> befristeter Schlüssel
//   { step: 'register', pathname, contentType, passId? } -> Eintrag anlegen
//
// Dazwischen lädt der Browser die Datei selbst in den Blob-Store: der Rumpf
// einer Funktion endet bei 4,5 MB, ein Handyvideo ist ein Vielfaches davon.
// Der eigentliche BLOB_READ_WRITE_TOKEN bleibt dabei auf dem Server.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guardWrite(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = typeof req.body === 'string' ? safe(req.body) : (req.body || {});
  const type = String(body.contentType || '').split(';')[0].trim();
  if (!VIDEO_TYPES.has(type)) return res.status(415).json({ error: 'unsupported_type' });

  return body.step === 'register'
    ? register(req, res, body, type)
    : token(res, body, type);
}

// Schritt 1: ein Schlüssel für genau einen Pfad, einen Medientyp, eine Größe.
async function token(res, body, type) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(501).json({ error: 'blob_not_configured' });
  }
  const size = Number(body.size || 0);
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'size_required' });
  if (size > MAX_VIDEO_BYTES) {
    return res.status(413).json({ error: 'too_large', maxBytes: MAX_VIDEO_BYTES });
  }

  const pathname = `videos/${crypto.randomUUID()}.${VIDEO_EXT[type]}`;
  try {
    const clientToken = await generateClientTokenFromReadWriteToken({
      pathname,
      access: 'private',
      addRandomSuffix: true,
      allowedContentTypes: [type],
      maximumSizeInBytes: MAX_VIDEO_BYTES,
      validUntil: Date.now() + 60 * 60 * 1000
    });
    return res.status(200).json({ token: clientToken, pathname });
  } catch (e) {
    return res.status(500).json({ error: 'token_failed', detail: String(e.message || e) });
  }
}

// Schritt 2: die Bytes liegen schon im Blob-Store, hier entsteht der Verweis.
async function register(req, res, body, type) {
  const pathname = String(body.pathname || '');
  const passId = body.passId ? String(body.passId) : '';

  // Nur Pfade aus unserem eigenen Videoordner – sonst ließe sich hier ein
  // beliebiges fremdes Blob eintragen.
  if (!/^videos\/[A-Za-z0-9._-]+$/.test(pathname)) {
    return res.status(400).json({ error: 'bad_pathname' });
  }

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
