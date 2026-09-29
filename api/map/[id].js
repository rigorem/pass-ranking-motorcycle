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
// Die große Ansicht zeichnet inzwischen der Browser selbst (map.js).
const SIZES = {
  thumb: [280, 280]
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
  if (String(req.query.id || '') === 'tile') return tile(req, res);
  if (!guard(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'id_required' });

  if (id === 'all') return overview(req, res);
  if (req.query.route === '1') return routeOnly(req, res, id);

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

// ---------------------------------------------------------------- Kacheln --

// Die Übersicht zeichnet der Browser selbst. Die Kacheln dafür laufen über
// diese Route, damit der MapTiler-Schlüssel auf dem Server bleibt – aber ohne
// Anmeldung und mit langem öffentlichen Zwischenspeicher: dann liefert das
// Vercel-CDN jede Kachel nach dem ersten Abruf selbst aus, ohne dass eine
// Funktion anläuft. Genau das macht die Karte schnell.
//
// Damit daraus kein allgemeiner Gratis-Kacheldienst wird, gibt es nur den
// Alpenbogen und nur sinnvolle Zoomstufen.
const TILE_Z = { min: 5, max: 16 };
const ALPS = { s: 43.0, n: 49.0, w: 4.0, e: 17.5 };

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) * 180 / Math.PI;
  return { w: x / n * 360 - 180, e: (x + 1) / n * 360 - 180, n: lat(y), s: lat(y + 1) };
}

async function tile(req, res) {
  const z = Number(req.query.z), x = Number(req.query.x), y = Number(req.query.y);
  const bad = code => { res.setHeader('Cache-Control', 'no-store'); return res.status(code).end(); };

  if (![z, x, y].every(Number.isInteger)) return bad(400);
  if (z < TILE_Z.min || z > TILE_Z.max) return bad(404);
  const span = 2 ** z;
  if (x < 0 || y < 0 || x >= span || y >= span) return bad(404);

  const b = tileBounds(z, x, y);
  if (b.e < ALPS.w || b.w > ALPS.e || b.n < ALPS.s || b.s > ALPS.n) return bad(404);
  if (!KEY()) return bad(501);

  try {
    // MapTilers 512er-Kacheln als WebP – etwa ein Viertel der Bytes der
    // PNG-Variante. Doppelt aufgelöst nur für Displays, die das zeigen können.
    const hi = req.query.r === '2' ? '@2x' : '';
    const r = await fetch(
      `https://api.maptiler.com/maps/${encodeURIComponent(STYLE)}/${z}/${x}/${y}${hi}.webp?key=${encodeURIComponent(KEY())}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return bad(502);
    const body = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Content-Length', String(body.length));
    // Eine Woche im Browser, einen Monat am CDN. Kartenbilder ändern sich kaum.
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=2592000, immutable');
    return res.status(200).end(body);
  } catch {
    return bad(502);
  }
}

// ------------------------------------------------------------- Übersicht --

// Statt eines fertigen Bildes nur die Daten: Koordinaten und Straßenverläufe
// als kodierte Polylinien – ein paar hundert Byte je Pass. Gezeichnet wird im
// Browser, als Vektor, scharf auf jeder Zoomstufe.
//
// Gebaut wird nur aus dem, was schon gespeichert ist; für zwanzig Pässe
// Overpass zu befragen würde jede Laufzeit sprengen. Fehlt ein Verlauf noch,
// holt ihn die Karte für den einzelnen Pass nach (siehe ?route=1 unten).
async function overview(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let passes;
  try { passes = (await listPasses()).filter(p => typeof p.lat === 'number' && typeof p.lon === 'number'); }
  catch (e) { return res.status(500).json({ error: 'store_unavailable' }); }
  if (!passes.length) return res.status(200).json({ passes: [], photos: [] });

  // Zwei gesammelte Abfragen statt einer pro Pass und pro Foto – bei ein paar
  // hundert Fotos macht das aus Sekunden Millisekunden.
  const parse = raw => {
    if (!raw || raw === 'none') return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  };
  const photoRefs = passes.flatMap(p => (p.photos || [])
    .filter(id => !isVideoId(id))
    .map(id => ({ id, pass: p.id })));

  let routes = [], locs = [];
  try {
    [routes, locs] = await Promise.all([
      redis.mget(...passes.map(p => routeKey(p.id))),
      photoRefs.length ? redis.mget(...photoRefs.map(r => locKey(r.id))) : []
    ]);
  } catch { /* dann eben ohne Linien und Fotos */ }

  const outPasses = passes.map((p, i) => ({
    id: p.id, de: p.de, alt: p.alt, lat: p.lat, lon: p.lon,
    fun: p.fun, amb: p.amb, enc: parse(routes[i])?.enc || null
  }));
  const outPhotos = [];
  photoRefs.forEach((r, i) => {
    const v = parse(locs[i]);
    if (v && typeof v.lat === 'number' && typeof v.lon === 'number') {
      outPhotos.push({ id: r.id, pass: r.pass, lat: v.lat, lon: v.lon });
    }
  });

  return res.status(200).json({ passes: outPasses, photos: outPhotos });
}

// Den Straßenverlauf eines einzelnen Passes nachholen, wenn er noch fehlt.
// Die Karte zeigt sich sofort und zeichnet die Straße nach, sobald sie da ist.
async function routeOnly(req, res, id) {
  res.setHeader('Cache-Control', 'no-store');
  let pass;
  try { pass = await getPass(id); } catch { return res.status(500).json({ error: 'store_unavailable' }); }
  if (!pass) return res.status(404).json({ error: 'not_found' });
  if (typeof pass.lat !== 'number') return res.status(404).json({ error: 'no_coordinates' });
  const { enc } = await polylineFor(id, pass);
  return res.status(200).json({ id, enc: enc || null });
}
