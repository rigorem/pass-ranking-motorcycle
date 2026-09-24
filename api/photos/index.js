import { guard, guardWrite } from '../_lib/auth.js';
import { ALLOWED, readBody, contentType, storePhoto } from '../_lib/photos.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!guardWrite(req, res)) return;

  const type = contentType(req);
  if (!ALLOWED.has(type)) return res.status(415).json({ error: 'unsupported_type' });

  try {
    const data = await readBody(req);
    if (!data.length) return res.status(400).json({ error: 'empty_body' });
    return res.status(201).json({ id: await storePhoto(data, type) });
  } catch (e) {
    return res.status(500).json({ error: 'upload_failed', detail: String(e.message || e) });
  }
}
