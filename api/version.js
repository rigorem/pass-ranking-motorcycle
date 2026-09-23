import { guard } from './_lib/auth.js';
import { getRev } from './_lib/store.js';

// Die kleinste Antwort der App. Die Clients fragen sie im Sekundentakt ab,
// um mitzubekommen, wenn der andere etwas bewertet hat.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!guard(req, res)) return;
  try {
    res.status(200).json({ rev: await getRev() });
  } catch (e) {
    res.status(500).json({ error: 'store_unavailable' });
  }
}
