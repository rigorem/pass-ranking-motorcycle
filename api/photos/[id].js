import { guard, guardWrite } from '../_lib/auth.js';
import { redis, photoKey } from '../_lib/store.js';
import { sendFile, deleteFile } from '../_lib/files.js';

export default async function handler(req, res) {
  // Der Wächter steht bewusst auch vor GET: nur wer das Passwort kennt,
  // bekommt die Bilder zu sehen.
  if (!guard(req, res)) return;

  const id = String(req.query.id || '').replace(/\.[a-z0-9]+$/i, '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  let path;
  try {
    path = await redis.get(photoKey(id));
  } catch (e) {
    return res.status(500).json({ error: 'store_unavailable' });
  }
  if (!path) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'not_found' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    // Gestreamt und mit Range-Anfragen – Videos wären sonst ganz im Speicher,
    // und Safari spielt sie ohne Teilstücke gar nicht erst ab.
    // private: Fotos dürfen im Browser liegen, aber in keinem geteilten Cache.
    const sent = await sendFile(req, res, String(path), { cacheControl: 'private, max-age=31536000, immutable' });
    if (!sent) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'file_missing' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    res.setHeader('Cache-Control', 'no-store');
    if (!guardWrite(req, res)) return;
    try {
      await deleteFile(String(path));
      await redis.del(photoKey(id));
      return res.status(200).json({ deleted: id });
    } catch (e) {
      return res.status(500).json({ error: 'delete_failed', detail: String(e.message || e) });
    }
  }

  res.setHeader('Allow', 'GET, HEAD, DELETE');
  res.status(405).json({ error: 'method_not_allowed' });
}
