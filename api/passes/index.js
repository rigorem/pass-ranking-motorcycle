import { guard } from '../_lib/auth.js';
import { listPasses, putPass, makeId, nextOrder } from '../_lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ passes: await listPasses() });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
    }
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const de = String(body.de || '').trim();
    if (!de) return res.status(400).json({ error: 'name_required' });
    try {
      const id = await makeId(de);
      const pass = await putPass(id, {
        de,
        intl: String(body.intl || '').trim(),
        lad: String(body.lad || '').trim(),
        alt: body.alt === null || body.alt === undefined || body.alt === '' ? null : Number(body.alt),
        region: String(body.region || '').trim(),
        fun: null, amb: null, note: '', photos: [],
        order: await nextOrder()
      });
      return res.status(201).json({ pass });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable', detail: String(e.message || e) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({ error: 'method_not_allowed' });
}
