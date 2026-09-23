import { isAuthed } from './_lib/auth.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.APP_PASSWORD) {
    return res.status(200).json({ authed: false, configured: false });
  }
  res.status(200).json({ authed: isAuthed(req), configured: true });
}
