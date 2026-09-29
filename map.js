// Eine kleine Karte zum Verschieben und Zoomen, ohne Bibliothek.
//
// Der Server liefert keine fertigen Kartenbilder mehr, sondern nur Daten: die
// Straßenverläufe als kodierte Polylinien und die Orte von Pässen und Fotos.
// Gezeichnet wird hier – die Straßen als Vektor, scharf auf jeder Zoomstufe,
// die Grundkarte aus Kacheln, die nach dem ersten Abruf vom CDN kommen.
//
// Jede Kachel positioniert sich nach ihrer eigenen Zoomstufe. Dadurch bleiben
// die alten Kacheln beim Zoomen stehen, bis die neuen geladen sind – es blitzt
// nichts weiß auf, und fließendes Zoomen zwischen den Stufen ergibt sich von
// selbst.

const TILE = 256;       // Rechengröße der Welt, wie bei Leaflet und OSM

// Web-Mercator auf beliebiger (auch gebrochener) Zoomstufe.
function project(lat, lon, z) {
  const n = TILE * 2 ** z;
  const s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
  return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

function unproject(x, y, z) {
  const n = TILE * 2 ** z;
  const lon = x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  return { lat, lon };
}

// Gegenstück zu encodePolyline auf dem Server.
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

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param root     Element, das die Karte ausfüllt
 * @param options  { tileUrl(z,x,y), tileSize, tileZoom: [min,max], minZoom, maxZoom, photoUrl(id) }
 *
 * `tileSize` ist die Kantenlänge, in der eine Kachel angezeigt wird. MapTiler
 * liefert 512er-Kacheln; so gezeigt braucht ein Bildschirm ein Viertel der
 * Abrufe von 256er-Kacheln, und die Schrift darauf hat die gedachte Größe.
 */
export function createMap(root, { tileUrl, photoUrl, tileSize = 256, tileZoom: tzRange = [0, 22],
  minZoom = 6, maxZoom = 16 } = {}) {
  root.classList.add('tm');
  root.innerHTML = `
    <div class="tm-tiles"></div>
    <svg class="tm-routes" aria-hidden="true"></svg>
    <div class="tm-marks"></div>`;
  const tilesEl = root.querySelector('.tm-tiles');
  const svg = root.querySelector('.tm-routes');
  const marksEl = root.querySelector('.tm-marks');

  let clat = 46.5, clon = 11.8, zoom = 9;
  let routes = [], passes = [], photos = [];
  let active = null;                   // hervorgehobener Pass
  const tiles = new Map();             // "z/x/y" -> { img, z, x, y }
  const handlers = { pass: [], photos: [], blank: [] };
  let frame = 0;

  const size = () => ({ w: root.clientWidth, h: root.clientHeight });
  const zoff = Math.log2(tileSize / TILE);
  const tileZoom = () => Math.max(tzRange[0], Math.min(tzRange[1], Math.round(zoom - zoff)));
  const tilePx = z => TILE * 2 ** (zoom - z);   // Kante einer Kachel der Stufe z, jetzt

  function origin() {
    const { w, h } = size();
    const c = project(clat, clon, zoom);
    return { ox: c.x - w / 2, oy: c.y - h / 2, w, h };
  }

  // ------------------------------------------------------------- Kacheln --

  function drawTiles(ox, oy, w, h) {
    const tz = tileZoom();
    const step = tilePx(tz);
    const span = 2 ** tz;

    // Was auf der aktuellen Stufe gebraucht wird, anlegen.
    const x0 = Math.floor(ox / step), x1 = Math.floor((ox + w) / step);
    const y0 = Math.floor(oy / step), y1 = Math.floor((oy + h) / step);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= span) continue;
        const wx = ((x % span) + span) % span;
        const key = `${tz}/${x}/${y}`;
        if (tiles.has(key)) continue;
        const img = new Image();
        img.className = 'tm-tile';
        img.decoding = 'async';
        img.draggable = false;
        img.alt = '';
        // Ist die Kachel da, beim nächsten Bild prüfen, ob die Platzhalter weg können.
        img.onload = () => { img.classList.add('on'); schedule(); };
        // Außerhalb des Kartengebiets gibt es keine Kachel – dann nicht warten.
        img.onerror = () => { img.dataset.done = '1'; schedule(); };
        img.src = tileUrl(tz, wx, y);
        tilesEl.append(img);
        tiles.set(key, { img, z: tz, x, y });
      }
    }

    // Die Kacheln anderer Stufen bleiben als (unscharfer) Platzhalter liegen,
    // bis die aktuelle Stufe vollständig geladen ist – auch über große
    // Zoomsprünge hinweg sieht man so nie leere Fläche.
    const visible = t => {
      const s = tilePx(t.z), left = t.x * s - ox, top = t.y * s - oy;
      return !(left > w || top > h || left + s < 0 || top + s < 0);
    };
    let ready = true;
    for (const t of tiles.values()) {
      if (t.z === tz && visible(t) && !t.img.classList.contains('on') && !t.img.dataset.done) { ready = false; break; }
    }

    // Jede Kachel nach ihrer eigenen Stufe setzen; Überflüssiges wegräumen.
    for (const [key, t] of tiles) {
      // Mehr als vier Stufen entfernt wäre der Platzhalter nur noch Farbbrei.
      if (!visible(t) || (t.z !== tz && (ready || Math.abs(t.z - tz) > 4))) {
        t.img.remove();
        tiles.delete(key);
        continue;
      }
      const s = tilePx(t.z);
      t.img.style.transform = `translate3d(${t.x * s - ox}px,${t.y * s - oy}px,0)`;
      t.img.style.width = t.img.style.height = s + 'px';
      // Die aktuelle Stufe oben, die übrigen darunter – die nähere zuoberst.
      t.img.style.zIndex = t.z === tz ? 50 : 40 - Math.abs(t.z - tz);
    }
  }

  // ------------------------------------------------------------ Strecken --

  // Die Punkte werden einmal auf Zoomstufe 0 umgerechnet; pro Bild bleibt nur
  // eine Multiplikation. Strecken außerhalb des Ausschnitts fallen ganz weg.
  function prepare(r) {
    const pts = r.points.map(p => project(p.lat, p.lon, 0));
    const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
    return { id: r.id, pts, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  }

  function drawRoutes(ox, oy, w, h) {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const k = 2 ** zoom;
    // Mit dem Zoom etwas kräftiger, damit die Linie nah wie fern lesbar bleibt.
    const wide = Math.max(3.5, Math.min(6.5, zoom - 5.5));
    let casing = '', line = '', top = '';
    for (const r of routes) {
      const [x0, y0, x1, y1] = r.box;
      if (x1 * k - ox < -20 || x0 * k - ox > w + 20 || y1 * k - oy < -20 || y0 * k - oy > h + 20) continue;
      const d = r.pts.map((q, i) => `${i ? 'L' : 'M'}${(q.x * k - ox).toFixed(1)} ${(q.y * k - oy).toFixed(1)}`).join('');
      const dim = active && r.id !== active;
      const c = `<path d="${d}" class="tm-casing${dim ? ' dim' : ''}" stroke-width="${wide + 3}"/>`;
      const l = `<path d="${d}" class="tm-line${dim ? ' dim' : ''}${r.id === active ? ' hot' : ''}" stroke-width="${wide}"/>`;
      // Die hervorgehobene Strecke kommt zuletzt, damit keine andere sie kreuzt.
      if (r.id === active) top = c + l;
      else { casing += c; line += l; }
    }
    svg.innerHTML = casing + line + top;
  }

  // ------------------------------------------------------- Markierungen --

  // Fotos, die auf dem Schirm zu dicht liegen, fasst eine Marke zusammen.
  // Neu berechnet wird das nur, wenn sich der Zoom spürbar ändert – beim
  // bloßen Verschieben bleiben die Gruppen gleich.
  let groups = [], groupedAt = null;

  function regroup() {
    const RADIUS = 46;
    groups = [];
    for (const ph of photos) {
      const q = project(ph.lat, ph.lon, zoom);
      const g = groups.find(g => Math.hypot(g.x - q.x, g.y - q.y) < RADIUS);
      if (g) { g.items.push(ph); continue; }
      groups.push({ x: q.x, y: q.y, lat: ph.lat, lon: ph.lon, items: [ph], el: null });
    }
    groupedAt = zoom;
    buildMarks();
  }

  function buildMarks() {
    marksEl.innerHTML = '';
    for (const p of passes) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tm-pass' + (p.id === active ? ' hot' : '');
      el.dataset.pass = p.id;
      el.setAttribute('aria-label', p.label || p.id);
      el.innerHTML = `<span>${esc(p.rank ?? '')}</span>`;
      p.el = el;
      marksEl.append(el);
    }
    for (const g of groups) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tm-photo';
      el.setAttribute('aria-label', g.items.length === 1 ? 'Foto ansehen' : `${g.items.length} Fotos ansehen`);
      el.innerHTML = `<img src="${esc(photoUrl(g.items[0].id))}" alt="" loading="lazy" decoding="async">`
        + (g.items.length > 1 ? `<b>${g.items.length}</b>` : '');
      el.addEventListener('click', ev => { ev.stopPropagation(); emit('photos', g.items); });
      g.el = el;
      marksEl.append(el);
    }
  }

  function drawMarks(ox, oy) {
    for (const p of passes) {
      if (!p.el) continue;
      const q = project(p.lat, p.lon, zoom);
      p.el.style.transform = `translate3d(${(q.x - ox).toFixed(1)}px,${(q.y - oy).toFixed(1)}px,0)`;
    }
    for (const g of groups) {
      if (!g.el) continue;
      const q = project(g.lat, g.lon, zoom);
      g.el.style.transform = `translate3d(${(q.x - ox).toFixed(1)}px,${(q.y - oy).toFixed(1)}px,0)`;
    }
  }

  // ------------------------------------------------------------- Zeichnen --

  function render() {
    frame = 0;
    const { ox, oy, w, h } = origin();
    if (!w || !h) return;
    if (groupedAt === null || Math.abs(zoom - groupedAt) > 0.35) regroup();
    drawTiles(ox, oy, w, h);
    drawRoutes(ox, oy, w, h);
    drawMarks(ox, oy);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  // Um einen Bildschirmpunkt herum zoomen, damit er unter dem Finger bleibt.
  function zoomAround(next, sx, sy) {
    next = Math.max(minZoom, Math.min(maxZoom + 0.99, next));
    const { ox, oy, w, h } = origin();
    const geo = unproject(ox + sx, oy + sy, zoom);
    zoom = next;
    const q = project(geo.lat, geo.lon, zoom);
    const c = unproject(q.x - sx + w / 2, q.y - sy + h / 2, zoom);
    clat = c.lat; clon = c.lon;
    schedule();
  }

  function panBy(dx, dy) {
    const c = project(clat, clon, zoom);
    const g = unproject(c.x - dx, c.y - dy, zoom);
    clat = g.lat; clon = g.lon;
    schedule();
  }

  // Sanft an einen Ausschnitt heranfahren – kurz, damit es nicht aufhält.
  let tween = 0;
  function flyTo(lat, lon, z, ms = 420) {
    cancelAnimationFrame(tween);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || ms <= 0) { clat = lat; clon = lon; zoom = z; schedule(); return; }
    const a = { lat: clat, lon: clon, z: zoom }, t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), k = ease(t);
      clat = a.lat + (lat - a.lat) * k;
      clon = a.lon + (lon - a.lon) * k;
      zoom = a.z + (z - a.z) * k;
      render();
      if (t < 1) tween = requestAnimationFrame(step);
    };
    tween = requestAnimationFrame(step);
  }

  // `top`, `right` und `bottom` halten zusätzlich Platz frei – dort liegen
  // Kopfzeile, Zoomknöpfe und Infokarte, und die Strecke soll nicht darunter
  // verschwinden.
  function fit(points, { pad = 40, top = 0, right = 0, bottom = 0, maxZ = 14, animate = false } = {}) {
    const pts = points.filter(p => p && typeof p.lat === 'number');
    if (!pts.length) return;
    const { w, h } = size();
    const usableW = Math.max(40, w - 2 * pad - right), usableH = Math.max(40, h - 2 * pad - top - bottom);
    const extent = z => {
      const qs = pts.map(p => project(p.lat, p.lon, z));
      const xs = qs.map(q => q.x), ys = qs.map(q => q.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    let z = maxZ, e = extent(z);
    for (; z > minZoom; z -= 0.25) {
      e = extent(z);
      if (e.x1 - e.x0 <= usableW && e.y1 - e.y0 <= usableH) break;
    }
    // Den Mittelpunkt so verschieben, dass der Inhalt im freien Bereich sitzt.
    const cx = (e.x0 + e.x1) / 2 + right / 2;
    const cy = (e.y0 + e.y1) / 2 + (bottom - top) / 2;
    const c = unproject(cx, cy, z);
    if (animate) flyTo(c.lat, c.lon, z);
    else { clat = c.lat; clon = c.lon; zoom = z; groupedAt = null; schedule(); }
  }

  // --------------------------------------------------------------- Gesten --

  const pointers = new Map();
  let pinch = null, moved = false, downAt = null;

  root.addEventListener('pointerdown', e => {
    if (e.target.closest('.tm-photo, .tm-pass')) return;
    root.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    downAt = { x: e.clientX, y: e.clientY };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const r = root.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom,
        mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
    }
    root.classList.add('grab');
  });

  root.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (downAt && Math.hypot(cur.x - downAt.x, cur.y - downAt.y) > 4) moved = true;

    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d > 0) zoomAround(pinch.z + Math.log2(d / pinch.d), pinch.mx, pinch.my);
      return;
    }
    if (pointers.size === 1) panBy(cur.x - prev.x, cur.y - prev.y);
  });

  const lift = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) {
      root.classList.remove('grab');
      // Ein Tipp ins Leere hebt die Hervorhebung wieder auf.
      if (!moved && e.type === 'pointerup' && !e.target.closest('.tm-photo, .tm-pass')) emit('blank');
    }
  };
  root.addEventListener('pointerup', lift);
  root.addEventListener('pointercancel', lift);

  root.addEventListener('wheel', e => {
    e.preventDefault();
    const r = root.getBoundingClientRect();
    // Trackpad-Gesten kommen fein, Mausräder in groben Schritten – beides glätten.
    const delta = e.ctrlKey ? -e.deltaY * 0.02 : -e.deltaY * 0.0022;
    zoomAround(zoom + delta, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  root.addEventListener('dblclick', e => {
    if (e.target.closest('.tm-photo, .tm-pass')) return;
    const r = root.getBoundingClientRect();
    zoomAround(zoom + 1, e.clientX - r.left, e.clientY - r.top);
  });

  marksEl.addEventListener('click', e => {
    const el = e.target.closest('.tm-pass');
    if (el) { e.stopPropagation(); emit('pass', el.dataset.pass); }
  });

  const ro = new ResizeObserver(() => schedule());
  ro.observe(root);

  function emit(name, arg) { for (const fn of handlers[name] || []) fn(arg); }

  // --------------------------------------------------------- Schnittstelle --

  return {
    setRoutes(list) { routes = list.filter(r => r.points.length).map(prepare); schedule(); },
    setPasses(list) { passes = list; buildMarks(); schedule(); },
    setPhotos(list) { photos = list; groupedAt = null; schedule(); },
    setActive(id) {
      active = id;
      for (const p of passes) p.el && p.el.classList.toggle('hot', p.id === id);
      schedule();
    },
    fit, flyTo,
    zoomIn() { const { w, h } = size(); zoomAround(Math.round(zoom) + 1, w / 2, h / 2); },
    zoomOut() { const { w, h } = size(); zoomAround(Math.round(zoom) - 1, w / 2, h / 2); },
    on(name, fn) { (handlers[name] ||= []).push(fn); },
    refresh: schedule,
    destroy() { ro.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(tween); root.innerHTML = ''; }
  };
}
