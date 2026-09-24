import { guard } from './_lib/auth.js';
import { getRev } from './_lib/store.js';
import { inboxCount } from './_lib/inbox.js';

// Die kleinste Antwort der App. Die Clients fragen sie im Sekundentakt ab,
// um mitzubekommen, wenn der andere etwas bewertet hat.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const role = guard(req, res);
  if (!role) return;
  try {
    // Gäste sehen den Eingang nicht, also brauchen sie die Zahl auch nicht.
    const [rev, inbox] = await Promise.all([getRev(), role === 'edit' ? inboxCount() : 0]);
    res.status(200).json({ rev, inbox });
  } catch (e) {
    res.status(500).json({ error: 'store_unavailable' });
  }
}
