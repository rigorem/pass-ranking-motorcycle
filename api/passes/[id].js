import { guard, guardWrite } from '../_lib/auth.js';
import { patchPass, deletePass, redis, photoKey } from '../_lib/store.js';
import { del as deleteBlob } from '@vercel/blob';

const NUM = new Set(['fun', 'amb', 'alt', 'lat', 'lon']);

// Das gerenderte Kartenbild wegräumen. Es baut sich beim nächsten Abruf neu auf.
async function dropMap(id) {
  try {
    for (const key of [`map:${id}:thumb`, `map:${id}:large`]) {
      const path = await redis.get(key);
      if (path) await deleteBlob(String(path));
      await redis.del(key);
    }
    await redis.del('route:' + id);
  } catch { /* ein übrig gebliebenes Kartenbild ist kein Drama */ }
}
const TEXT = new Set(['de', 'intl', 'lad', 'region', 'note']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  if (req.method === 'PATCH' || req.method === 'PUT') {
    if (!guardWrite(req, res)) return;
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const patch = {};
    for (const [k, v] of Object.entries(body)) {
      if (TEXT.has(k)) patch[k] = String(v ?? '').trim();
      else if (NUM.has(k)) patch[k] = v === null || v === '' ? null : Number(v);
      else if (k === 'photos' && Array.isArray(v)) patch[k] = v.map(String);
      else if (k === 'order') patch[k] = Number(v) || 0;
    }
    if ('de' in patch && !patch.de) return res.status(400).json({ error: 'name_required' });
    // Anderer Ort, anderes Kartenbild – das alte muss weg.
    if ('lat' in patch || 'lon' in patch) await dropMap(id);
    try {
      const pass = await patchPass(id, patch);
      if (!pass) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ pass });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    if (!guardWrite(req, res)) return;
    try {
      const pass = await deletePass(id);
      if (!pass) return res.status(404).json({ error: 'not_found' });
      await dropMap(id);
      // Die Fotos des Passes mit aufräumen, sonst bleiben sie für immer im Blob-Store.
      for (const photoId of pass.photos || []) {
        try {
          const url = await redis.get(photoKey(photoId));
          if (url) await deleteBlob(String(url));
          await redis.del(photoKey(photoId));
        } catch { /* ein verwaistes Foto ist kein Grund, das Löschen abzubrechen */ }
      }
      return res.status(200).json({ deleted: id });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
    }
  }

  res.setHeader('Allow', 'PATCH, DELETE');
  res.status(405).json({ error: 'method_not_allowed' });
}
