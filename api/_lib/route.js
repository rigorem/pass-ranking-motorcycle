// Holt den Straßenverlauf über einen Pass aus OpenStreetMap: die Kehren, so
// wie sie wirklich liegen. Das Ergebnis ist eine Polylinie, die als Pfad über
// das Kartenbild gelegt wird. Pro Pass passiert das genau einmal.

const ROAD = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$';
const RADIUS = 6000;      // Meter, in denen nach Straßen gesucht wird
const REACH = 7000;       // Meter, die ab dem Pass je Richtung mitgenommen werden
const MAX_POINTS = 380;

export function metersBetween(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la = a.lat * Math.PI / 180, lb = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Overpass ist ein freier Dienst und zeitweise überlastet. Deshalb zwei
// Server nacheinander, jeder mit knappem Zeitlimit – zusammen bleiben sie
// unter der Laufzeit, die die Funktion hat.
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

async function askOverpass(lat, lon) {
  const query = `[out:json][timeout:25];
way(around:${RADIUS},${lat},${lon})["highway"~"${ROAD}"];
out geom;`;

  let last = null;
  for (const endpoint of MIRRORS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'pass-ranking-motorcycle/1.0 (https://pass-ranking-motorcycle.vercel.app)'
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(12000)
      });
      if (!r.ok) { last = new Error('overpass ' + r.status); continue; }
      const d = await r.json();
      return (d.elements || []).filter(w => w.type === 'way' && w.geometry && w.geometry.length > 1);
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('overpass nicht erreichbar');
}

// Die Straße, auf der der Pass liegt: der Weg mit dem nächsten Punkt.
function seedWay(ways, lat, lon) {
  let best = null, bestDist = Infinity, bestIdx = 0;
  for (const w of ways) {
    w.geometry.forEach((g, i) => {
      const d = metersBetween(g, { lat, lon });
      if (d < bestDist) { bestDist = d; best = w; bestIdx = i; }
    });
  }
  return bestDist <= 120 ? { way: best, index: bestIdx } : null;
}

const endsOf = w => [w.nodes[0], w.nodes[w.nodes.length - 1]];
const sameRoad = (a, b) =>
  (a.tags?.ref && a.tags.ref === b.tags?.ref) ||
  (a.tags?.name && a.tags.name === b.tags?.name);

// Von der Passstraße aus nach beiden Seiten weiterlaufen, solange es
// zusammenhängt. Gleiche Straßennummer wird bevorzugt, damit an einer
// Kreuzung nicht in ein Seitental abgebogen wird.
function walk(ways, seed, fromNode, budget) {
  const byNode = new Map();
  for (const w of ways) {
    for (const end of endsOf(w)) {
      if (!byNode.has(end)) byNode.set(end, []);
      byNode.get(end).push(w);
    }
  }

  const out = [];
  const used = new Set([seed.id]);
  let current = seed, node = fromNode, left = budget;

  while (left > 0) {
    const options = (byNode.get(node) || []).filter(w => !used.has(w.id));
    if (!options.length) break;
    options.sort((a, b) => (sameRoad(current, b) ? 1 : 0) - (sameRoad(current, a) ? 1 : 0));
    const next = options[0];
    used.add(next.id);

    let geom = next.geometry.slice();
    if (next.nodes[0] !== node) geom.reverse();
    let run = 0;
    for (let i = 1; i < geom.length; i++) run += metersBetween(geom[i - 1], geom[i]);

    out.push(geom);
    left -= run;
    node = next.nodes[0] === node ? next.nodes[next.nodes.length - 1] : next.nodes[0];
    current = next;
  }
  return out;
}

// Grad sind keine Meter: ein Längengrad ist auf 46° Breite nur rund zwei
// Drittel so lang wie ein Breitengrad. Ohne diese Umrechnung wird die Strecke
// in die Breite gezogen und die Vereinfachung frisst genau die engen Kehren,
// auf die es ankommt.
function project(points) {
  const lat0 = points[0].lat * Math.PI / 180;
  const mPerDegLat = 111132;
  const mPerDegLon = 111320 * Math.cos(lat0);
  return points.map(p => ({ x: p.lon * mPerDegLon, y: p.lat * mPerDegLat }));
}

// Douglas–Peucker in Metern, damit aus tausenden Stützpunkten eine kurze Linie
// wird, ohne dass die Kehren verschwinden.
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const flat = project(points);
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0, index = 0;
    const a = flat[first], b = flat[last];
    for (let i = first + 1; i < last; i++) {
      const p = flat[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      let t = dx || dy ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy) : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y;
      const sq = ex * ex + ey * ey;
      if (sq > maxSq) { maxSq = sq; index = i; }
    }
    if (maxSq > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Länge der Linie in Metern.
function lengthOf(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += metersBetween(points[i - 1], points[i]);
  return m;
}

// Kurven zählen. Aus jedem Punktepaar wird eine Fahrtrichtung, aus je zwei
// Richtungen eine Änderung. Aufeinanderfolgende Änderungen mit demselben
// Vorzeichen gehören zur selben Kurve und werden aufsummiert – sonst zählt
// eine lange Kehre als zwanzig kleine Knicke.
function curvesIn(points) {
  const flat = project(points);
  const headings = [];
  for (let i = 1; i < flat.length; i++) {
    const dx = flat[i].x - flat[i - 1].x, dy = flat[i].y - flat[i - 1].y;
    if (dx || dy) headings.push(Math.atan2(dy, dx) * 180 / Math.PI);
  }

  const runs = [];
  let sum = 0, sign = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = headings[i] - headings[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    const s = Math.sign(d);
    // Fast geradeaus: die laufende Kurve ist zu Ende.
    if (Math.abs(d) < 3) { if (sum) runs.push(sum); sum = 0; sign = 0; continue; }
    if (s !== sign && sum) { runs.push(sum); sum = 0; }
    sign = s;
    sum += Math.abs(d);
  }
  if (sum) runs.push(sum);

  return {
    curves: runs.filter(v => v >= 35).length,
    hairpins: runs.filter(v => v >= 120).length
  };
}

// Google-Polyline, Genauigkeit 5 – das Format, das die Kartendienste verstehen.
export function encodePolyline(points) {
  let lastLat = 0, lastLon = 0, out = '';
  const chunk = v => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lon = Math.round(p.lon * 1e5);
    out += chunk(lat - lastLat) + chunk(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return out;
}

// Gegenstück zu encodePolyline.
export function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return out;
}

// Liefert die Passstraße samt Kennzahlen, vom einen Talende bis zum anderen.
export async function routeFor(lat, lon) {
  return buildFromWays(await askOverpass(lat, lon), lat, lon);
}

export function buildFromWays(ways, lat, lon) {
  if (!ways || !ways.length) return null;

  const seed = seedWay(ways, lat, lon);
  if (!seed) return null;

  const w = seed.way;
  const head = w.geometry.slice(0, seed.index + 1);   // Anfang -> Pass
  const tail = w.geometry.slice(seed.index);          // Pass -> Ende

  const before = walk(ways, w, w.nodes[0], REACH).reverse().map(g => g.slice().reverse());
  const after = walk(ways, w, w.nodes[w.nodes.length - 1], REACH);

  const points = [...before.flat(), ...head, ...tail.slice(1), ...after.flat()];
  if (points.length < 4) return null;

  // Toleranz in Metern. 6 m lässt jede Spitzkehre stehen; erst wenn die Linie
  // dadurch zu lang für eine Karten-URL würde, wird gröber vereinfacht.
  let tol = 6;
  let simplified = simplify(points, tol);
  while (simplified.length > MAX_POINTS && tol < 120) {
    tol *= 1.5;
    simplified = simplify(points, tol);
  }

  // Gezählt wird auf einer fein, aber rauschfrei vereinfachten Linie: die
  // rohen OSM-Stützpunkte wackeln genug, um Kurven zu erfinden.
  const forCounting = simplify(points, 4);
  const { curves, hairpins } = curvesIn(forCounting);
  const metres = lengthOf(points);

  return {
    points: simplified,
    stats: {
      km: Math.round(metres / 100) / 10,
      curves,
      hairpins,
      ref: w.tags?.ref || '',
      road: w.tags?.name || ''
    }
  };
}
