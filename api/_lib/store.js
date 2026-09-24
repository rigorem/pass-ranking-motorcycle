import { redis } from './redis.js';

export { redis };

const IDS = 'passes:ids';
const REV = 'passes:rev';
const key = id => 'pass:' + id;
const FIELDS = ['de', 'intl', 'lad', 'alt', 'region', 'fun', 'amb', 'note', 'photos', 'order', 'lat', 'lon',
  // Aus dem Straßenverlauf abgeleitet, nicht von Hand gepflegt.
  'km', 'curves', 'hairpins', 'ref'];

// Redis gibt Hash-Felder locker typisiert zurück, deshalb hier einmal zentral
// in die Form bringen, die das Frontend erwartet.
function shape(id, raw) {
  if (!raw || !raw.de) return null;
  const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
  const photos = Array.isArray(raw.photos)
    ? raw.photos
    : (typeof raw.photos === 'string' && raw.photos ? JSON.parse(raw.photos) : []);
  return {
    id,
    de: String(raw.de),
    intl: raw.intl ? String(raw.intl) : '',
    lad: raw.lad ? String(raw.lad) : '',
    alt: num(raw.alt),
    region: raw.region ? String(raw.region) : '',
    fun: num(raw.fun),
    amb: num(raw.amb),
    note: raw.note ? String(raw.note) : '',
    photos,
    order: num(raw.order) ?? 0,
    lat: num(raw.lat),
    lon: num(raw.lon),
    km: num(raw.km),
    curves: num(raw.curves),
    hairpins: num(raw.hairpins),
    ref: raw.ref ? String(raw.ref) : ''
  };
}

// Redis kennt kein null im Hash, deshalb wird "nicht bewertet" als "" abgelegt.
function encode(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!FIELDS.includes(k)) continue;
    if (v === null || v === undefined) out[k] = '';
    else if (Array.isArray(v)) out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

// Ein Zähler, der bei jeder Änderung hochgeht. Die Clients fragen nur ihn ab
// und holen die Liste erst, wenn er sich bewegt hat.
export async function getRev() {
  const v = await redis.get(REV);
  return Number(v || 0);
}

async function bumpRev() {
  try { return Number(await redis.incr(REV)); } catch { return null; }
}

export async function listPasses() {
  const ids = await redis.smembers(IDS);
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map(id => redis.hgetall(key(id))));
  return ids.map((id, i) => shape(id, rows[i])).filter(Boolean).sort((a, b) => a.order - b.order);
}

export async function getPass(id) {
  return shape(id, await redis.hgetall(key(id)));
}

export async function putPass(id, pass) {
  await redis.hset(key(id), encode(pass));
  await redis.sadd(IDS, id);
  await bumpRev();
  return getPass(id);
}

// Schreibt nur die übergebenen Felder. Zwei Leute, die gleichzeitig
// verschiedene Pässe oder Achsen bewerten, kommen sich damit nicht ins Gehege.
export async function patchPass(id, patch) {
  const fields = encode(patch);
  if (!Object.keys(fields).length) return getPass(id);
  if (!(await redis.exists(key(id)))) return null;
  await redis.hset(key(id), fields);
  await bumpRev();
  return getPass(id);
}

export async function deletePass(id) {
  const pass = await getPass(id);
  await redis.del(key(id));
  await redis.srem(IDS, id);
  await bumpRev();
  return pass;
}

// Fotos anhängen, ohne die Liste des anderen zu überschreiben.
//
// patchPass schreibt `photos` als Ganzes. Lesen-Ändern-Schreiben von zwei
// Geräten gleichzeitig verliert deshalb Fotos. Eine kurze Sperre macht das
// Fenster klein, und das Zusammenführen über ein Set macht den Aufruf
// wiederholbar: derselbe Import zweimal trägt nichts doppelt ein.
export async function appendPhotos(id, photoIds) {
  const ids = (Array.isArray(photoIds) ? photoIds : [photoIds]).map(String).filter(Boolean);
  if (!ids.length) return getPass(id);

  const lock = `pass:${id}:photolock`;
  let held = false;
  for (let tries = 0; tries < 2 && !held; tries++) {
    try {
      held = Boolean(await redis.set(lock, '1', { nx: true, ex: 5 }));
    } catch { held = true; }          // ohne Sperre lieber schreiben als verlieren
    if (!held) await new Promise(r => setTimeout(r, 250));
  }

  try {
    const pass = await getPass(id);
    if (!pass) return null;
    const merged = [...new Set([...(pass.photos || []), ...ids])];
    if (merged.length === (pass.photos || []).length) return pass;
    return await patchPass(id, { photos: merged });
  } finally {
    if (held) { try { await redis.del(lock); } catch { /* läuft ohnehin ab */ } }
  }
}

export async function nextOrder() {
  const all = await listPasses();
  return all.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1;
}

// Aus dem Namen einen lesbaren, eindeutigen Schlüssel machen.
export async function makeId(name) {
  const base = String(name).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pass';
  let id = base;
  for (let n = 2; await redis.exists(key(id)); n++) id = `${base}-${n}`;
  return id;
}

// id -> Blob-URL. Die URL verlässt den Server nie, Fotos laufen über /api/photos.
export const photoKey = id => 'photo:' + id;
