import { guard } from '../_lib/auth.js';
import { getPass, patchPass, redis } from '../_lib/store.js';
import { routeFor, encodePolyline, decodePolyline } from '../_lib/route.js';
import { renderMap } from '../_lib/tilemap.js';
import { putFile, sendFile, deleteFile } from '../_lib/files.js';

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
  large: [720, 540]
};

const blobKey = (id, size) => `map:${id}:${size}`;
const routeKey = id => 'route:' + id;

function send(req, res, path) {
  return sendFile(req, res, String(path), { cacheControl: 'private, max-age=604800' });
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
  const size = SIZES[req.query.size] ? String(req.query.size) : 'thumb';
  const [W, H] = SIZES[size];

  // ?refresh=1 wirft nur das fertige Bild weg, nicht den Straßenverlauf –
  // nach einer Stil- oder Darstellungsänderung baut es sich so neu auf, ohne
  // dass Overpass erneut befragt werden muss.
  const refresh = req.query.refresh === '1';
  if (refresh) {
    try {
      const old = await redis.get(blobKey(id, size));
      if (old) await deleteFile(String(old));
      await redis.del(blobKey(id, size));
    } catch { /* dann wird es eben überschrieben */ }
  } else {
    try {
      const cached = await redis.get(blobKey(id, size));
      if (cached && await send(req, res, cached)) return;
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
    svg = await renderMap({
      points,
      centre: { lat: pass.lat, lon: pass.lon },
      width: W, height: H,
      tileUrl,
      stroke: STROKE
    });
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
      const blob = await putFile(`maps/${id}-${size}.svg`, data, { addRandomSuffix: true });
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
