import { checkPassword, sessionCookie, clearCookie } from './_lib/auth.js';
import { redis } from './_lib/store.js';

const MAX_TRIES = 10;
const WINDOW = 15 * 60; // Sekunden

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim() || 'unknown';
}

// Bremst Rateversuche aus. Fällt Redis aus, wird der Login nicht blockiert –
// lieber anmeldbar als ausgesperrt, das Passwort schützt weiterhin.
async function tooManyTries(ip) {
  try {
    const k = `login:fail:${ip}`;
    const n = await redis.get(k);
    return Number(n || 0) >= MAX_TRIES;
  } catch { return false; }
}

async function noteFailure(ip) {
  try {
    const k = `login:fail:${ip}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, WINDOW);
  } catch { /* egal */ }
}

async function clearFailures(ip) {
  try { await redis.del(`login:fail:${ip}`); } catch { /* egal */ }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ authed: false });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.APP_PASSWORD) {
    return res.status(500).json({ error: 'not_configured' });
  }

  const ip = clientIp(req);
  if (await tooManyTries(ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  if (!checkPassword(body.password)) {
    await noteFailure(ip);
    return res.status(401).json({ error: 'wrong_password' });
  }

  await clearFailures(ip);
  res.setHeader('Set-Cookie', sessionCookie());
  res.status(200).json({ authed: true });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
