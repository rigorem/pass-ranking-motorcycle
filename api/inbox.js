import { guardWrite } from './_lib/auth.js';
import { redis, listPasses, appendPhotos, photoKey } from './_lib/store.js';
import { listInbox, dropInbox, bumpInboxRev } from './_lib/inbox.js';
import { nearestPass } from './import.js';
import { del as deleteBlob } from '@vercel/blob';

// Der Eingang: was der Kurzbefehl nicht sicher zuordnen konnte. Ein Bearbeiter
// räumt ihn mit einem Griff auf; im Normalfall ist er leer.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Der Eingang ist durchgehend Bearbeitersache – auch das Lesen. Er enthält
  // Fotos, über die noch niemand entschieden hat.
  if (!guardWrite(req, res)) return;

  if (req.method === 'GET') {
    try {
      const [items, passes] = await Promise.all([listInbox(), listPasses()]);
      // Zu jedem Foto den nächsten Pass nennen – auch wenn er weit weg ist.
      // Die Entscheidung trifft der Mensch, wir liefern nur den Anhaltspunkt.
      const withHint = items.map(it => {
        if (it.lat === null || it.lon === null) return { ...it, suggestion: null };
        const hit = nearestPass(passes, it.lat, it.lon);
        return {
          ...it,
          suggestion: hit ? { passId: hit.pass.id, name: hit.pass.de, distanceM: hit.distanceM } : null
        };
      });
      return res.status(200).json({ items: withHint });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
    }
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? safe(req.body) : (req.body || {});
    const ids = Array.isArray(body.photoIds) ? body.photoIds.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'photo_ids_required' });

    try {
      if (body.discard) {
        for (const id of ids) {
          // Genau wie DELETE /api/photos/<id>: erst das Blob, dann der Verweis.
          try {
            const path = await redis.get(photoKey(id));
            if (path) await deleteBlob(String(path));
            await redis.del(photoKey(id));
          } catch { /* ein übrig gebliebenes Blob ist kein Grund abzubrechen */ }
        }
        await dropInbox(ids);
        await bumpInboxRev();
        return res.status(200).json({ discarded: ids.length });
      }

      const passId = String(body.passId || '');
      if (!passId) return res.status(400).json({ error: 'pass_id_required' });
      const pass = await appendPhotos(passId, ids);
      if (!pass) return res.status(404).json({ error: 'not_found' });

      await dropInbox(ids);
      await bumpInboxRev();
      return res.status(200).json({ assigned: ids.length, passId });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'method_not_allowed' });
}

function safe(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
