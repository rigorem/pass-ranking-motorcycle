import { guardWrite } from './_lib/auth.js';
import { redis, photoKey, appendPhotos } from './_lib/store.js';
import { VIDEO_TYPES, VIDEO_EXT, MAX_VIDEO_BYTES, VIDEO_PREFIX, contentType } from './_lib/photos.js';
import { inboxKey, bumpInboxRev } from './_lib/inbox.js';
import { putStream, deleteFile, TooLarge } from './_lib/files.js';
import crypto from 'node:crypto';

// Ein Video hochladen, in einem Schritt:
//
//   POST /api/videos?passId=<id>&taken=<iso>
//   Content-Type: video/mp4 | video/quicktime | video/webm
//   <die Datei als Rumpf>
//
// Ohne passId landet das Video im Eingang. Der Rumpf geht direkt auf die
// Platte und wird nie ganz in den Speicher geholt – Handyvideos sind schnell
// ein paar hundert MB.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guardWrite(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const type = contentType(req);
  if (!VIDEO_TYPES.has(type)) return res.status(415).json({ error: 'unsupported_type' });

  // Was angekündigt zu groß ist, gar nicht erst annehmen.
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_VIDEO_BYTES) {
    return res.status(413).json({ error: 'too_large', maxBytes: MAX_VIDEO_BYTES });
  }

  let pathname;
  try {
    ({ pathname } = await putStream(`videos/${crypto.randomUUID()}.${VIDEO_EXT[type]}`, req, {
      maxBytes: MAX_VIDEO_BYTES,
      addRandomSuffix: true
    }));
  } catch (e) {
    if (e instanceof TooLarge) return res.status(413).json({ error: 'too_large', maxBytes: MAX_VIDEO_BYTES });
    return res.status(500).json({ error: 'upload_failed' });
  }

  const passId = String(req.query.passId || '');
  const id = VIDEO_PREFIX + crypto.randomUUID();
  try {
    await redis.set(photoKey(id), pathname);

    if (passId) {
      const pass = await appendPhotos(passId, [id]);
      if (!pass) {
        // Den Pass gibt es nicht mehr: das Video nicht verwaist liegen lassen.
        await redis.del(photoKey(id));
        await deleteFile(pathname);
        return res.status(404).json({ error: 'not_found' });
      }
      return res.status(201).json({ id, passId });
    }

    await redis.hset(inboxKey(), { [id]: JSON.stringify({ taken: String(req.query.taken || ''), lat: null, lon: null }) });
    await bumpInboxRev();
    return res.status(201).json({ id, inbox: true });
  } catch (e) {
    return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
  }
}
