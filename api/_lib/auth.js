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

// Zwei Passwörter, zwei Rollen: 'edit' darf alles, 'guest' darf zusehen.
// Welche gilt, steht mitsigniert im Cookie – raten lässt sie sich nicht.
export function roleFor(input) {
  if (typeof input !== 'string' || !input) return null;
  const full = process.env.APP_PASSWORD;
  const guest = process.env.GUEST_PASSWORD;
  if (full && same(input, full)) return 'edit';
  if (guest && same(input, guest)) return 'guest';
  return null;
}

export function sessionCookie(role) {
  const key = secret();
  const exp = Date.now() + MAX_AGE * 1000;
  const payload = `${role}.${exp}`;
  const token = `${payload}.${sign(payload, key)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Gibt die Rolle aus dem Cookie zurück, oder null.
export function sessionRole(req) {
  const key = secret();
  if (!key) return null;
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!hit) return null;

  const [role, exp, sig] = decodeURIComponent(hit.slice(COOKIE.length + 1)).split('.');
  if (!role || !exp || !sig) return null;
  if (role !== 'edit' && role !== 'guest') return null;
  if (!Number(exp) || Number(exp) < Date.now()) return null;

  const want = sign(`${role}.${exp}`, key);
  if (want.length !== sig.length) return null;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? role : null;
}

export function isAuthed(req) {
  return sessionRole(req) !== null;
}

// Wacht vor jeder Route, die Daten oder Fotos herausgibt. Gibt die Rolle
// zurück, oder false – dann ist die Anfrage schon beantwortet.
export function guard(req, res) {
  if (!process.env.APP_PASSWORD) {
    res.status(500).json({ error: 'not_configured' });
    return false;
  }
  const role = sessionRole(req);
  if (!role) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return role;
}

// Zusätzlich vor alles, was etwas verändert. Die Gastansicht blendet diese
// Knöpfe zwar aus, aber verlassen kann man sich nur auf diese Prüfung hier.
export function guardWrite(req, res) {
  const role = guard(req, res);
  if (!role) return false;
  if (role !== 'edit') {
    res.status(403).json({ error: 'read_only' });
    return false;
  }
  return true;
}
