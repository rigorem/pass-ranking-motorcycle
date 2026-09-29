import { guard } from '../_lib/auth.js';
import { getPass, patchPass, listPasses, getRev, redis } from '../_lib/store.js';
import { locKey, isVideoId } from '../_lib/photos.js';
import { routeFor, encodePolyline, decodePolyline } from '../_lib/route.js';
import { renderMap } from '../_lib/tilemap.js';
import { put, get as getBlob, del as deleteBlob } from '@vercel/blob';

// Das Kartenbild eines Passes: die Passstraße mit ihren Kehren, aus
// OpenStreetMap geholt und über eine Karte gelegt. Beides – Straßenverlauf und
// fertiges Bild – wird genau einmal besorgt und dann gespeichert; danach
// kostet ein Aufruf nichts mehr bei den fremden Diensten.
// Beim Einfügen ins Dashboard rutscht leicht ein Leerzeichen oder Zeilenumbruch
// mit; kodiert landet der dann als %20 im Schlüssel und der Dienst lehnt ab.
const KEY = () => (process.env.MAPTILER_KEY || '').trim();
const STYLE = (process.env.MAPTILER_STYLE || 'streets-v4').trim();
const STROKE = '#C94F83';

// Die Kachel in der Liste ist quadratisch – quadratisch rendern, sonst
// schneidet der Ausschnitt die Strecke an den Seiten ab.
const SIZES = {
  thumb: [280, 280],
  large: [720, 540],
  // Die Übersicht über alle Pässe braucht mehr Fläche als eine einzelne Strecke.
  all: [900, 700]
};

const blobKey = (id, size) => `map:${id}:${size}`;
const routeKey = id => 'route:' + id;

async function send(res, path) {
  const found = await getBlob(String(path), { access: 'private' });
  if (!found || found.statusCode !== 200) return false;
  const body = Buffer.from(await new Response(found.stream).arrayBuffer());
  res.setHeader('Content-Type', found.blob.contentType || 'image/svg+xml');
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
    if (cached) {
      const v = typeof cached === 'string' ? JSON.parse(cached) : cached;
      return { enc: v.enc, settled: true };
    }
  } catch { /* ohne Cache halt frisch */ }

  try {
    const route = await routeFor(pass.lat, pass.lon);
    const enc = route && route.points.length > 3 ? encodePolyline(route.points) : null;
    if (!enc) {
      // Keine Straße gefunden ist eine Antwort und bleibt gespeichert.
      try { await redis.set(routeKey(id), 'none'); } catch { /* egal */ }
      return { enc: null, settled: true };
    }
    try { await redis.set(routeKey(id), JSON.stringify({ enc, stats: route.stats })); } catch { /* egal */ }
    // Die Kennzahlen an den Pass schreiben, damit die Liste sie ohne
    // zusätzliche Abfrage anzeigen kann.
    try { await patchPass(id, route.stats); } catch { /* dann eben ohne */ }
    return { enc, settled: true };
  } catch {
    // Zeitüberschreitung oder Overpass überlastet: in einer Stunde nochmal.
    try { await redis.set(routeKey(id), 'none', { ex: 60 * 60 }); } catch { /* egal */ }
    return { enc: null, settled: false };
  }
}

// Kachel-URL. Die Static-Maps-API von MapTiler kostet extra, Kacheln sind im
// freien Kontingent enthalten – deshalb wird das Bild selbst zusammengesetzt.
// Ausdrücklich die 256er-Kacheln: ohne die Angabe kommen 512er zurück, die
// hier ohnehin heruntergerechnet würden – bei viermal so vielen Bytes, und die
// stecken als base64 im ausgelieferten Bild.
const tileUrl = (z, x, y) =>
  `https://api.maptiler.com/maps/${encodeURIComponent(STYLE)}/256/${z}/${x}/${y}.png?key=${encodeURIComponent(KEY())}`;

export default async function handler(req, res) {
  if (!guard(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  if (id === 'all') return overview(req, res);

  const size = SIZES[req.query.size] ? String(req.query.size) : 'thumb';
  const [W, H] = SIZES[size];

  // ?refresh=1 wirft nur das fertige Bild weg, nicht den Straßenverlauf –
  // nach einer Stil- oder Darstellungsänderung baut es sich so neu auf, ohne
  // dass Overpass erneut befragt werden muss.
  const refresh = req.query.refresh === '1';
  if (refresh) {
    try {
      const old = await redis.get(blobKey(id, size));
      if (old) await deleteBlob(String(old));
      await redis.del(blobKey(id, size));
    } catch { /* dann wird es eben überschrieben */ }
  } else {
    try {
      const cached = await redis.get(blobKey(id, size));
      if (cached && await send(res, cached)) return;
    } catch { /* weiter, dann eben neu rendern */ }
  }

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

  const { enc, settled } = await polylineFor(id, pass);
  const points = enc ? decodePolyline(enc) : [];

  let svg;
  try {
    ({ svg } = await renderMap({
      points,
      centre: { lat: pass.lat, lon: pass.lon },
      width: W, height: H,
      tileUrl,
      stroke: STROKE
    }));
  } catch (e) {
    return fail(502, {
      error: 'map_unavailable',
      reason: String(e.message || e),
      style: STYLE,
      keyLength: KEY().length          // nur die Länge, nie der Schlüssel selbst
    });
  }
  const data = Buffer.from(svg, 'utf8');
  const used = points.length ? 'route' : 'centred';

  // Nur behalten, wenn das Bild den endgültigen Stand zeigt. Ein Notbehelf
  // ohne Straßenverlauf würde sonst für immer hängenbleiben.
  if (settled && !(enc && !String(used).startsWith('route'))) {
    try {
      const blob = await put(`maps/${id}-${size}.svg`, data, {
        access: 'private', addRandomSuffix: true, contentType: 'image/svg+xml', allowOverwrite: true
      });
      await redis.set(blobKey(id, size), blob.pathname);
    } catch { /* dann eben beim nächsten Mal wieder rendern */ }
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('X-Map-Kind', used);
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.status(200).end(data);
}

// Alle gefahrenen Pässe auf einer Karte: jede bekannte Strecke als Linie, jeder
// Pass als Punkt, dazu jedes Foto an der Stelle, an der es aufgenommen wurde.
//
// Gebaut wird nur aus dem, was schon im Speicher liegt. Für zwanzig Pässe
// Overpass zu befragen würde jede Zeitgrenze sprengen – wessen Straßenverlauf
// noch fehlt, erscheint vorerst als Punkt und ergänzt sich, sobald jemand die
// Einzelansicht dieses Passes geöffnet hat.
const ALL_KEY = size => `map:all:${size}`;

async function overview(req, res) {
  const [W, H] = SIZES.all;
  const wantMeta = req.query.meta === '1';

  let rev = 0;
  try { rev = await getRev(); } catch { /* dann eben ohne Vergleich */ }

  // Zwischenspeicher gilt nur, solange sich an den Pässen nichts geändert hat.
  try {
    const raw = await redis.get(ALL_KEY('all'));
    const cached = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (cached && cached.rev === rev && cached.path) {
      if (wantMeta) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ w: W, h: H, marks: cached.marks || [] });
      }
      if (await send(res, cached.path)) return;
    }
  } catch { /* neu bauen */ }

  const fail = (code, body) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(code).json(body);
  };
  if (!KEY()) return fail(501, { error: 'maps_not_configured' });

  let passes;
  try { passes = await listPasses(); }
  catch (e) { return fail(500, { error: 'store_unavailable', detail: String(e.message || e) }); }

  const located = passes.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number');
  if (!located.length) return fail(404, { error: 'nothing_to_show' });

  const routes = [];
  const markers = [];

  for (const p of located) {
    markers.push({ lat: p.lat, lon: p.lon, kind: 'pass', id: p.id, name: p.de });
    try {
      const raw = await redis.get(routeKey(p.id));
      if (raw && raw !== 'none') {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (v.enc) routes.push(decodePolyline(v.enc));
      }
    } catch { /* ohne Linie halt nur der Punkt */ }
  }

  // Fotos an ihren Aufnahmeort setzen. Videos haben keinen.
  for (const p of passes) {
    for (const photoId of p.photos || []) {
      if (isVideoId(photoId)) continue;
      try {
        const raw = await redis.get(locKey(photoId));
        if (!raw) continue;
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof v.lat === 'number' && typeof v.lon === 'number') {
          markers.push({ lat: v.lat, lon: v.lon, kind: 'photo', id: photoId, pass: p.id, name: p.de });
        }
      } catch { /* dieses Foto eben ohne Punkt */ }
    }
  }

  let built;
  try {
    built = await renderMap({ routes, markers, width: W, height: H, tileUrl, stroke: STROKE });
  } catch (e) {
    return fail(502, { error: 'map_unavailable', detail: String(e.message || e) });
  }

  const data = Buffer.from(built.svg, 'utf8');
  try {
    const blob = await put(`maps/all.svg`, data, {
      access: 'private', addRandomSuffix: true, contentType: 'image/svg+xml', allowOverwrite: true
    });
    const old = await redis.get(ALL_KEY('all'));
    await redis.set(ALL_KEY('all'), JSON.stringify({ rev, path: blob.pathname, marks: built.marks }));
    // Das vorherige Bild wegräumen, sonst sammeln sich die alten Stände an.
    try {
      const prev = typeof old === 'string' ? JSON.parse(old) : old;
      if (prev && prev.path && prev.path !== blob.pathname) await deleteBlob(String(prev.path));
    } catch { /* egal */ }
  } catch { /* dann eben beim nächsten Mal wieder bauen */ }

  if (wantMeta) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ w: W, h: H, marks: built.marks });
  }
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).end(data);
}
