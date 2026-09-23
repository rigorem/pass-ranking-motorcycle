// Baut das Kartenbild selbst: Rasterkacheln nebeneinandersetzen, den
// Straßenverlauf darüberzeichnen, fertig als SVG. Die Static-Maps-API von
// MapTiler ist kostenpflichtig, Kacheln sind es nicht – und der Schlüssel
// bleibt dabei auf dem Server, weil die Kacheln eingebettet werden.

const TILE = 256;
const MAX_TILES = 24;

// Web-Mercator: Längen- und Breitengrad zu Bildpunkten auf einer Zoomstufe.
function project(lat, lon, z) {
  const n = TILE * 2 ** z;
  const s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
  return {
    x: (lon + 180) / 360 * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n
  };
}

// Die größte Stufe wählen, auf der die ganze Strecke noch ins Bild passt.
function fitZoom(points, w, h, padding) {
  const usableW = w * (1 - 2 * padding);
  const usableH = h * (1 - 2 * padding);
  for (let z = 16; z >= 3; z--) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      const q = project(p.lat, p.lon, z);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    if (maxX - minX <= usableW && maxY - minY <= usableH) return z;
  }
  return 3;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param points  Punkte der Passstraße (leer erlaubt)
 * @param centre  {lat, lon} des Passes, für Marker und als Rückfall
 * @param tileUrl (z, x, y) => URL der Kachel
 * @param stroke  Farbe der Linie
 */
export async function renderMap({ points, centre, width, height, tileUrl, stroke = '#C94F83' }) {
  const hasRoute = Array.isArray(points) && points.length > 1;
  const frame = hasRoute ? points : [centre];
  const zoom = hasRoute ? fitZoom(frame, width, height, 0.08) : 12;

  // Bildausschnitt um die Mitte der Strecke legen.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of frame) {
    const q = project(p.lat, p.lon, zoom);
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  const originX = (minX + maxX) / 2 - width / 2;
  const originY = (minY + maxY) / 2 - height / 2;

  const span = 2 ** zoom;
  const firstX = Math.floor(originX / TILE), lastX = Math.floor((originX + width) / TILE);
  const firstY = Math.floor(originY / TILE), lastY = Math.floor((originY + height) / TILE);

  const wanted = [];
  for (let tx = firstX; tx <= lastX; tx++) {
    for (let ty = firstY; ty <= lastY; ty++) {
      if (ty < 0 || ty >= span) continue;                 // oberhalb/unterhalb der Welt
      const wrapped = ((tx % span) + span) % span;         // Datumsgrenze
      wanted.push({ tx, ty, url: tileUrl(zoom, wrapped, ty) });
      if (wanted.length >= MAX_TILES) break;
    }
    if (wanted.length >= MAX_TILES) break;
  }

  const loaded = await Promise.all(wanted.map(async t => {
    try {
      const r = await fetch(t.url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const type = r.headers.get('content-type') || 'image/png';
      const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
      return { ...t, href: `data:${type};base64,${b64}` };
    } catch { return null; }
  }));

  const tiles = loaded.filter(Boolean);
  if (!tiles.length) throw new Error('keine Kachel geladen');

  // xlink:href statt href: ein als <img> eingebundenes SVG wird in einem
  // eingeschränkten Modus gezeichnet, in dem nicht jeder Browser die neuere
  // Schreibweise auflöst. Beide zu setzen würde die Daten verdoppeln.
  const images = tiles.map(t =>
    `<image xlink:href="${t.href}" x="${(t.tx * TILE - originX).toFixed(2)}" y="${(t.ty * TILE - originY).toFixed(2)}" width="${TILE}" height="${TILE}"/>`
  ).join('');

  let route = '';
  if (hasRoute) {
    const d = points.map((p, i) => {
      const q = project(p.lat, p.lon, zoom);
      return `${i ? 'L' : 'M'}${(q.x - originX).toFixed(1)},${(q.y - originY).toFixed(1)}`;
    }).join('');
    // Weiße Fassung darunter, sonst verschwindet die Linie über einer Straße
    // derselben Farbe.
    route = `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-opacity=".85" stroke-linejoin="round" stroke-linecap="round"/>`
      + `<path d="${d}" fill="none" stroke="${esc(stroke)}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  const c = project(centre.lat, centre.lon, zoom);
  const marker = `<circle cx="${(c.x - originX).toFixed(1)}" cy="${(c.y - originY).toFixed(1)}" r="5.5" fill="${esc(stroke)}" stroke="#FFFFFF" stroke-width="2.5"/>`;

  const credit = '© MapTiler © OpenStreetMap';
  const creditWidth = credit.length * 5.4 + 10;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="#E4E9EE"/>`
    + images + route + marker
    + `<g><rect x="${width - creditWidth - 3}" y="${height - 16}" width="${creditWidth}" height="13" rx="3" fill="#FFFFFF" fill-opacity=".72"/>`
    + `<text x="${width - 8}" y="${height - 6}" text-anchor="end" font-family="system-ui,sans-serif" font-size="9" fill="#33414F">${credit}</text></g>`
    + `</svg>`;
}
