import { guard, sessionRole } from './_lib/auth.js';
import { getRev } from './_lib/store.js';
import { inboxCount } from './_lib/inbox.js';

// Zwei Aufgaben in einer Route, weil Vercel jede Datei unter api/ als eigene
// Funktion zählt:
//
//   GET /api/session          -> wer bin ich
//   GET /api/session?poll=1   -> dazu der Änderungszähler für den Abgleich
//
// Der Abgleich fragt das im Sekundentakt ab, deshalb bleibt die Antwort klein.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.query.poll === '1') {
    const role = guard(req, res);
    if (!role) return;
    try {
      // Gäste sehen den Eingang nicht, also brauchen sie die Zahl auch nicht.
      const [rev, inbox] = await Promise.all([getRev(), role === 'edit' ? inboxCount() : 0]);
      return res.status(200).json({ rev, inbox });
    } catch (e) {
      return res.status(500).json({ error: 'store_unavailable' });
    }
  }

  if (!process.env.APP_PASSWORD) {
    return res.status(200).json({ authed: false, configured: false });
  }
  const role = sessionRole(req);
  res.status(200).json({ authed: role !== null, role, configured: true });
}
