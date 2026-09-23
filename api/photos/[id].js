import { guard } from '../_lib/auth.js';
import { redis, photoKey } from '../_lib/store.js';
import { del as deleteBlob } from '@vercel/blob';

export default async function handler(req, res) {
  // Der Wächter steht bewusst auch vor GET: nur wer das Passwort kennt,
  // bekommt die Bilder zu sehen.
  if (!guard(req, res)) return;

  const id = String(req.query.id || '').replace(/\.[a-z0-9]+$/i, '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  let url;
  try {
    url = await redis.get(photoKey(id));
  } catch (e) {
    return res.status(500).json({ error: 'store_unavailable' });
  }
  if (!url) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'not_found' });
  }

  if (req.method === 'GET') {
    try {
      const upstream = await fetch(String(url));
      if (!upstream.ok) return res.status(502).json({ error: 'blob_unavailable' });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Content-Length', String(body.length));
      // private: Fotos dürfen im Browser liegen, aber in keinem geteilten Cache.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      return res.status(200).end(body);
    } catch (e) {
      return res.status(502).json({ error: 'blob_unavailable' });
    }
  }

  if (req.method === 'DELETE') {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await deleteBlob(String(url));
      await redis.del(photoKey(id));
      return res.status(200).json({ deleted: id });
    } catch (e) {
      return res.status(500).json({ error: 'delete_failed', detail: String(e.message || e) });
    }
  }

  res.setHeader('Allow', 'GET, DELETE');
  res.status(405).json({ error: 'method_not_allowed' });
}
