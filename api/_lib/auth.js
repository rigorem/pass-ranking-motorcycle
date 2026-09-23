import crypto from 'node:crypto';

const COOKIE = 'pr_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 Tage

// Der Signaturschlüssel. Ohne SESSION_SECRET wird er aus dem Passwort
// abgeleitet, damit die App mit einer einzigen Variable auskommt – ein
// Passwortwechsel macht dann alle bestehenden Sessions ungültig.
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  return crypto.createHash('sha256').update('pr:' + pw).digest('hex');
}

function sign(payload, key) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

// Vergleicht zwei Strings ohne Längen- oder Zeitleck.
function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPassword(input) {
  const pw = process.env.APP_PASSWORD;
  if (!pw || typeof input !== 'string' || !input) return false;
  return same(input, pw);
}

export function sessionCookie() {
  const key = secret();
  const exp = Date.now() + MAX_AGE * 1000;
  const token = `${exp}.${sign(String(exp), key)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function isAuthed(req) {
  const key = secret();
  if (!key) return false;
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!hit) return false;
  const [exp, sig] = decodeURIComponent(hit.slice(COOKIE.length + 1)).split('.');
  if (!exp || !sig || !Number(exp) || Number(exp) < Date.now()) return false;
  const want = sign(exp, key);
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

// Wacht vor jeder Route, die Daten oder Fotos herausgibt. Gibt false zurück
// und beantwortet die Anfrage bereits, wenn nicht eingeloggt.
export function guard(req, res) {
  if (!process.env.APP_PASSWORD) {
    res.status(500).json({ error: 'not_configured' });
    return false;
  }
  if (!isAuthed(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
