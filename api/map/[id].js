import { guard } from '../_lib/auth.js';
import { getPass, redis } from '../_lib/store.js';
import { routeFor, encodePolyline } from '../_lib/route.js';
import { put, get as getBlob } from '@vercel/blob';

// Das Kartenbild eines Passes: die Passstraße mit ihren Kehren, aus
// OpenStreetMap geholt und über eine Karte gelegt. Beides – Straßenverlauf und
// fertiges Bild – wird genau einmal besorgt und dann gespeichert; danach
// kostet ein Aufruf nichts mehr bei den fremden Diensten.
// Beim Einfügen ins Dashboard rutscht leicht ein Leerzeichen oder Zeilenumbruch
// mit; kodiert landet der dann als %20 im Schlüssel und der Dienst lehnt ab.
const KEY = () => (process.env.MAPTILER_KEY || '').trim();
const STYLE = (process.env.MAPTILER_STYLE || 'outdoor-v2').trim();
const STROKE = 'C94F83';

const SIZES = {
  thumb: [320, 240],
  large: [720, 540]
};

const blobKey = (id, size) => `map:${id}:${size}`;
const routeKey = id => 'route:' + id;

async function send(res, path) {
  const found = await getBlob(String(path), { access: 'private' });
  if (!found || found.statusCode !== 200) return false;
  const body = Buffer.from(await new Response(found.stream).arrayBuffer());
  res.setHeader('Content-Type', found.blob.contentType || 'image/png');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.status(200).end(body);
  return true;
}

// Den Straßenverlauf einmal besorgen. `settled` sagt, ob das Ergebnis
// endgültig ist: hat Overpass nur gerade nicht geantwortet, wird das Bild
// nicht gespeichert, damit der nächste Aufruf es erneut versucht.
async function polylineFor(id, pass) {
  try {
    const cached = await redis.get(routeKey(id));
    if (cached === 'none') return { enc: null, settled: true };
    if (cached) return { enc: String(cached), settled: true };
  } catch { /* ohne Cache halt frisch */ }

  try {
    const points = await routeFor(pass.lat, pass.lon);
    const enc = points && points.length > 3 ? encodePolyline(points) : null;
    // Keine Straße gefunden ist eine Antwort und bleibt gespeichert.
    try { await redis.set(routeKey(id), enc || 'none'); } catch { /* egal */ }
    return { enc, settled: true };
  } catch {
    // Zeitüberschreitung oder Overpass überlastet: in einer Stunde nochmal.
    try { await redis.set(routeKey(id), 'none', { ex: 60 * 60 }); } catch { /* egal */ }
    return { enc: null, settled: false };
  }
}

function withRoute(enc, w, h) {
  // Die Polylinie darf roh nicht in die URL: ihr Alphabet enthält unter
  // anderem "|" und "\\", also genau die Zeichen, an denen der Kartendienst
  // die Pfadangabe zerlegt. Die Trenner bleiben literal, der Rest wird kodiert.
  const path = `fill:none|stroke:%23${STROKE}|width:4|enc:${encodeURIComponent(enc)}`;
  return `https://api.maptiler.com/maps/${encodeURIComponent(STYLE)}/static/auto/${w}x${h}@2x.png`
    + `?path=${path}&padding=0.12&key=${encodeURIComponent(KEY())}&attribution=bottomright`;
}

// Ohne Marker: die Markierungssyntax ist bei jedem Kartendienst anders, und
// die eingezeichnete Straße ist ohnehin die Auskunft, um die es geht.
function centred(lat, lon, w, h) {
  return `https://api.maptiler.com/maps/${encodeURIComponent(STYLE)}/static/${lon},${lat},11/${w}x${h}@2x.png`
    + `?key=${encodeURIComponent(KEY())}&attribution=bottomright`;
}

export default async function handler(req, res) {
  if (!guard(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const size = SIZES[req.query.size] ? String(req.query.size) : 'thumb';
  const [W, H] = SIZES[size];

  try {
    const cached = await redis.get(blobKey(id, size));
    if (cached && await send(res, cached)) return;
  } catch { /* weiter, dann eben neu rendern */ }

  const fail = (code, body) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(code).json(body);
  };

  if (!KEY()) return fail(501, { error: 'maps_not_configured' });

  let pass;
  try { pass = await getPass(id); }
  catch { return fail(500, { error: 'store_unavailable' }); }
  if (!pass) return fail(404, { error: 'not_found' });
  if (typeof pass.lat !== 'number' || typeof pass.lon !== 'number') {
    return fail(404, { error: 'no_coordinates' });
  }

  const lat = pass.lat.toFixed(5), lon = pass.lon.toFixed(5);
  const { enc, settled } = await polylineFor(id, pass);

  // Erst mit Straßenverlauf versuchen, sonst schlicht auf den Pass zentriert.
  const attempts = enc
    ? [['route', withRoute(enc, W, H)], ['centred', centred(lat, lon, W, H)]]
    : [['centred', centred(lat, lon, W, H)]];

  // MapTiler-Schlüssel lassen sich auf bestimmte Herkünfte beschränken. Ein
  // Aufruf vom Server schickt von sich aus keinen Referer und fliegt dann mit
  // 403 raus – also die eigene Adresse mitgeben.
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const origin = host ? `https://${host}` : '';
  const headers = origin ? { Referer: origin + '/', Origin: origin } : {};

  let data = null, used = null;
  const tried = [];
  for (const [label, url] of attempts) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (r.ok) { data = Buffer.from(await r.arrayBuffer()); used = label; break; }
      // Sagen, woran es lag – sonst rät man beim nächsten Fehler wieder.
      // Bei Ablehnung kommt oft ein Fehlerbild zurück, kein Text.
      const type = r.headers.get('content-type') || '';
      const why = type.includes('image')
        ? '(Fehlerbild statt Text)'
        : (await r.text().catch(() => '')).slice(0, 200);
      tried.push({ attempt: label, status: r.status, message: why });
    } catch (e) {
      tried.push({ attempt: label, error: String(e.name || e.message || e) });
    }
  }
  if (!data) return fail(502, {
    error: 'map_unavailable', tried, style: STYLE,
    sentReferer: origin || null,
    keyLength: KEY().length          // nur die Länge, nie der Schlüssel selbst
  });

  // Nur behalten, wenn das Bild den endgültigen Stand zeigt. Ein Notbehelf
  // ohne Straßenverlauf würde sonst für immer hängenbleiben.
  if (settled && !(enc && used !== 'route')) {
    try {
      const blob = await put(`maps/${id}-${size}.png`, data, {
        access: 'private', addRandomSuffix: true, contentType: 'image/png', allowOverwrite: true
      });
      await redis.set(blobKey(id, size), blob.pathname);
    } catch { /* dann eben beim nächsten Mal wieder rendern */ }
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('X-Map-Kind', used);
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.status(200).end(data);
}
