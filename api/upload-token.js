import { guardWrite } from './_lib/auth.js';
import { VIDEO_TYPES, VIDEO_EXT, MAX_VIDEO_BYTES } from './_lib/photos.js';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import crypto from 'node:crypto';

// Gibt dem Browser einen befristeten, eng zugeschnittenen Schlüssel, mit dem er
// ein Video direkt in den Blob-Store laden darf. Der eigentliche
// BLOB_READ_WRITE_TOKEN bleibt dabei auf dem Server.
//
// Der Schlüssel gilt für genau einen Pfad, genau einen Medientyp und eine
// Höchstgröße – mehr lässt sich damit nicht anstellen.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guardWrite(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(501).json({ error: 'blob_not_configured' });
  }

  const body = typeof req.body === 'string' ? safe(req.body) : (req.body || {});
  const type = String(body.contentType || '').split(';')[0].trim();
  const size = Number(body.size || 0);

  if (!VIDEO_TYPES.has(type)) return res.status(415).json({ error: 'unsupported_type' });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'size_required' });
  if (size > MAX_VIDEO_BYTES) {
    return res.status(413).json({ error: 'too_large', maxBytes: MAX_VIDEO_BYTES });
  }

  const pathname = `videos/${crypto.randomUUID()}.${VIDEO_EXT[type]}`;
  try {
    const token = await generateClientTokenFromReadWriteToken({
      pathname,
      access: 'private',
      addRandomSuffix: true,
      allowedContentTypes: [type],
      maximumSizeInBytes: MAX_VIDEO_BYTES,
      validUntil: Date.now() + 60 * 60 * 1000
    });
    return res.status(200).json({ token, pathname });
  } catch (e) {
    return res.status(500).json({ error: 'token_failed', detail: String(e.message || e) });
  }
}

function safe(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
