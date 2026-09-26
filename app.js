// Pässeranking – Frontend. Spricht ausschließlich mit den eigenen /api-Routen.

import { readExif } from '/exif.js';
import { upload as blobUpload } from '/vendor/blob-client.js';

// Videos sind zu groß für den Rumpf einer Vercel-Funktion (4,5 MB). Sie gehen
// deshalb mit einem befristeten Schlüssel direkt vom Browser in den Blob-Store
// und werden danach nur noch angemeldet.
const VIDEO_PREFIX = 'v-';
const isVideo = id => String(id).startsWith(VIDEO_PREFIX);
const isVideoFile = f => String(f.type || '').startsWith('video/');

const $ = s => document.querySelector(s);
const list = $('#list');
const EMPTY = new Set();

// Kartenbilder werden im Browser eine Woche lang behalten. Ändert sich, wie
// sie gezeichnet werden, muss sich auch die Adresse ändern – sonst zeigt ein
// Gerät, das schon einmal geladen hat, für Tage das alte Bild.
const MAP_VERSION = 2;

let passes = [];
let pendingRender = false;
let uploadFor = null;
let editId = null;
let lb = null;          // {pass, id} des gezeigten Fotos
let lbList = [];        // alle Fotos des Passes, zum Blättern
let lbIndex = -1;
let authed = false;
let canWrite = true;    // Gastansicht: alles sichtbar, nichts veränderbar
let inboxCount = 0;     // Fotos, die noch keinem Pass gehören
let inboxItems = [];
let rev = 0;            // Änderungszähler des Servers, zuletzt gesehen
let inflight = 0;       // eigene Schreibvorgänge unterwegs
const queues = {};

/* ---------------------------------------------------------------- API --- */

class ApiError extends Error {
  constructor(status, code) { super(code || String(status)); this.status = status; this.code = code; }
}

async function req(path, { method = 'GET', body, type, headers } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...(headers || {}) } };
  if (body !== undefined) {
    if (body instanceof Blob) { opts.headers['Content-Type'] = type || body.type || 'image/jpeg'; opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new ApiError(0, 'offline'); }

  if (res.status === 401) { authed = false; throw new ApiError(401, 'unauthorized'); }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error);
  return data;
}

const api = {
  session: () => req('/api/session'),
  login: password => req('/api/auth', { method: 'POST', body: { password } }),
  logout: () => req('/api/auth', { method: 'DELETE' }),
  list: () => req('/api/passes'),
  version: () => req('/api/session?poll=1'),
  inbox: () => req('/api/inbox').then(d => d.items || []),
  assign: (photoIds, passId) => req('/api/inbox', { method: 'POST', body: { photoIds, passId } }),
  discard: photoIds => req('/api/inbox', { method: 'POST', body: { photoIds, discard: true } }),
  dedupe: apply => req('/api/dedupe', { method: 'POST', body: { apply } }),
  create: data => req('/api/passes', { method: 'POST', body: data }).then(d => d.pass),
  patch: (id, data) => req('/api/passes/' + encodeURIComponent(id), { method: 'PATCH', body: data }).then(d => d.pass),
  remove: id => req('/api/passes/' + encodeURIComponent(id), { method: 'DELETE' }),
  upload: blob => req('/api/photos', { method: 'POST', body: blob }).then(d => d.id),
  uploadToken: (contentType, size) => req('/api/videos', { method: 'POST', body: { step: 'token', contentType, size } }),
  registerVideo: data => req('/api/videos', { method: 'POST', body: { step: 'register', ...data } }),
  // Der Weg mit Ortsangabe: der Server sucht sich den Pass selbst.
  importPhoto: (blob, meta) => req('/api/import', {
    method: 'POST',
    body: blob,
    headers: {
      ...(meta.lat !== null && meta.lon !== null
        ? { 'X-Photo-Lat': String(meta.lat), 'X-Photo-Lon': String(meta.lon) }
        : {}),
      ...(meta.taken ? { 'X-Photo-Taken': meta.taken } : {})
    }
  }),
  removePhoto: id => req('/api/photos/' + encodeURIComponent(id), { method: 'DELETE' })
};

function message(err) {
  if (!(err instanceof ApiError)) return 'Etwas ist schiefgelaufen.';
  switch (err.code) {
    case 'offline': return 'Keine Verbindung. Änderung nicht gespeichert.';
    case 'unauthorized': return 'Sitzung abgelaufen. Bitte neu anmelden.';
    case 'not_configured': return 'Die Seite ist noch nicht eingerichtet (APP_PASSWORD fehlt).';
    case 'store_unavailable': return 'Der Speicher antwortet gerade nicht.';
    case 'not_found': return 'Dieser Pass existiert nicht mehr.';
    case 'upload_not_configured': return 'Der Foto-Import ist noch nicht eingerichtet.';
    case 'pass_id_required': return 'Bitte erst einen Pass auswählen.';
    case 'dedupe_failed': return 'Die Suche nach Doppeln ist fehlgeschlagen.';
    case 'too_large': return 'Das Video ist zu groß (mehr als 300 MB).';
    case 'blob_not_configured': return 'Der Videospeicher ist noch nicht eingerichtet.';
    case 'bad_pathname': return 'Das Video konnte nicht eingetragen werden.';
    case 'unsupported_type': return 'Dieses Bildformat geht nicht.';
    default: return 'Speichern fehlgeschlagen. Bitte nochmal versuchen.';
  }
}

/* ------------------------------------------------------------ Helfer --- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Die Rangfolge: zuerst zählt Fahrspaß, und zwar immer – Ambiente entscheidet
// nur zwischen Pässen mit gleichem Fahrspaß. Eine fehlende Bewertung zählt
// unter jeder vorhandenen.
const val = v => (typeof v === 'number' ? v : -1);
const rated = p => typeof p.fun === 'number' || typeof p.amb === 'number';

function byRank(a, b) {
  return val(b.fun) - val(a.fun) || val(b.amb) - val(a.amb) || (a.order ?? 0) - (b.order ?? 0);
}

/* ------------------------------------------------------ Login-Schranke --- */

let loginResolve = null;

function openGate(msg) {
  const dlg = $('#loginDlg');
  $('#loginErr').hidden = !msg;
  $('#loginErr').textContent = msg || '';
  document.body.classList.add('locked');
  if (!dlg.open) dlg.showModal();
  $('#loginForm').password.focus();
  return new Promise(res => { loginResolve = res; });
}

// Die Schranke lässt sich nicht mit Esc wegdrücken.
$('#loginDlg').addEventListener('cancel', e => e.preventDefault());

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const input = e.target.password;
  const pw = input.value;
  if (!pw) return;
  btn.disabled = true;
  btn.textContent = 'Prüfe …';
  try {
    const d = await api.login(pw);
    authed = true;
    canWrite = d.role !== 'guest';
    applyRole();
    input.value = '';
    $('#loginErr').hidden = true;
    $('#loginDlg').close();
    document.body.classList.remove('locked');
    const done = loginResolve; loginResolve = null;
    if (done) done();
  } catch (err) {
    $('#loginErr').hidden = false;
    $('#loginErr').textContent = err.code === 'too_many_attempts'
      ? 'Zu viele Versuche. Bitte in 15 Minuten nochmal.'
      : err.code === 'not_configured'
        ? 'Auf dem Server fehlt APP_PASSWORD.'
        : err.code === 'offline'
          ? 'Keine Verbindung zum Server.'
          : 'Falsches Passwort.';
    input.select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});

// Fällt die Sitzung mitten im Betrieb weg, wieder nach dem Passwort fragen
// und danach den frischen Stand vom Server holen.
let recovering = null;
function recoverAuth() {
  if (!recovering) {
    recovering = openGate('Sitzung abgelaufen. Bitte neu anmelden.')
      .then(() => load())
      .finally(() => { recovering = null; });
  }
  return recovering;
}

/* ----------------------------------------------------------- Rendern --- */

function render(changed = EMPTY) {
  // Während jemand in einer Notiz tippt, nicht unter den Fingern neu bauen.
  if (document.activeElement && document.activeElement.classList.contains('note')) { pendingRender = true; return; }
  pendingRender = false;

  // Fahrspaß vor Ambiente, dann die Reihenfolge des Eintragens; Unbewertete ans Ende.
  const sorted = passes.slice().sort(byRank);

  $('#count').textContent = passes.length === 1 ? '1 Pass gefahren' : passes.length + ' Pässe gefahren';

  if (!sorted.length) {
    list.innerHTML = '<li class="empty">Noch keine Pässe eingetragen. Füge unten euren ersten Pass hinzu.</li>';
    return;
  }

  const before = positions();
  const first = !list.querySelector('.pass');

  let rank = 0, last;
  list.innerHTML = sorted.map((p, i) => {
    // Einen Platz teilen sich nur Pässe mit gleichem Fahrspaß und gleichem Ambiente.
    const s = rated(p) ? `${val(p.fun)}/${val(p.amb)}` : null;
    if (s !== last) { rank = i + 1; last = s; }
    const rankTxt = s == null ? '–' : rank;
    const intl = [p.intl ? esc(p.intl) : '', p.lad ? '<span>' + esc(p.lad) + '</span>' : ''].filter(Boolean).join(' · ');
    const photos = (p.photos || []).map(id => isVideo(id)
      // preload="metadata" holt nur das erste Bild, nicht das ganze Video.
      ? `<span class="clip" data-photo="${esc(id)}" data-pass="${esc(p.id)}">
           <video src="/api/photos/${encodeURIComponent(id)}" muted playsinline preload="metadata"
                  data-photo="${esc(id)}" data-pass="${esc(p.id)}"></video>
           <span class="play" aria-hidden="true"></span>
         </span>`
      : `<img src="/api/photos/${encodeURIComponent(id)}" alt="Foto vom ${esc(p.de)}" loading="lazy" data-photo="${esc(id)}" data-pass="${esc(p.id)}">`
    ).join('');
    return `<li class="pass${s != null && rank <= 3 ? ' top' : ''}${changed.has(p.id) ? ' fresh' : ''}" data-id="${esc(p.id)}" style="--n:${i}">
      <div class="head">
        <div class="thumb">
          ${cover(p)}
          <span class="rank" aria-label="Platz ${rankTxt}">${rankTxt}</span>
        </div>
        <div class="title">
          <h2>${esc(p.de)}</h2>
          ${intl ? `<p class="intl">${intl}</p>` : ''}
          ${p.alt || p.region ? `<p class="meta">${p.alt ? `<span class="sign">${esc(p.alt)} m</span>` : ''}${p.region ? `<span class="region">${esc(p.region)}</span>` : ''}</p>` : ''}
        </div>
      </div>
      ${facts(p)}
      <div class="ratings">
        ${rateRow(p, 'fun', 'Fahrspaß')}
        ${rateRow(p, 'amb', 'Ambiente')}
      </div>
      ${photos || canWrite ? `<div class="photos">${photos}${canWrite ? `<button class="add-photo" data-upload="${esc(p.id)}">${ICON_CAMERA}Fotos</button>` : ''}</div>` : ''}
      ${canWrite || p.note ? `<textarea class="note" data-note="${esc(p.id)}" rows="2" placeholder="Notiz: Straßenzustand, Verkehr, Einkehr …"${canWrite ? '' : ' readonly'}>${esc(p.note)}</textarea>` : ''}
      <div class="foot">
        ${hasPlace(p) ? `<a class="link" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" data-map="${esc(p.id)}">${ICON_ROUTE}Strecke</a>` : ''}
        ${canWrite ? `<button class="link" data-edit="${esc(p.id)}">Bearbeiten</button>` : ''}
      </div>
    </li>`;
  }).join('');

  if (first) {
    list.classList.add('enter');
    setTimeout(() => list.classList.remove('enter'), 900);
  } else {
    glide(before);
  }
}

const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const ICON_ROUTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

/* ------------------------------------------------------ Umsortieren --- */

// Wenn eine Bewertung die Reihenfolge ändert, springt die Karte nicht, sondern
// gleitet an ihren neuen Platz – so sieht man, wohin sie gewandert ist.
// Gemessen wird die Position auf dem Bildschirm, auch mitten in einer
// laufenden Bewegung; eine neue setzt also dort an, wo die alte gerade ist.
function positions() {
  const out = new Map();
  for (const li of list.querySelectorAll('.pass')) {
    const r = li.getBoundingClientRect();
    out.set(li.dataset.id, { x: r.left, y: r.top });
  }
  return out;
}

// Kritisch gedämpfte Feder (kein Überschwingen), als linear()-Kurve für WAAPI.
const SPRING = (() => {
  const w = 2 * Math.PI / 0.42;          // Ansprechzeit 0,42 s
  const dur = 0.7, steps = 32, pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    pts.push((1 - (1 + w * t) * Math.exp(-w * t)).toFixed(4));
  }
  pts[steps] = '1';
  return { easing: `linear(${pts.join(',')})`, duration: dur * 1000 };
})();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function glide(before) {
  if (reduceMotion.matches || !before.size) return;
  for (const li of list.querySelectorAll('.pass')) {
    const was = before.get(li.dataset.id);
    if (was === undefined) continue;
    // Am Rechner stehen die Karten in zwei Spalten, also auch seitwärts.
    const now = li.getBoundingClientRect();
    const dx = was.x - now.left, dy = was.y - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const frames = [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }];
    try { li.animate(frames, SPRING); }
    catch { li.animate(frames, { duration: 450, easing: 'cubic-bezier(.32,.72,0,1)' }); }
  }
}

function rateRow(p, key, label) {
  const v = p[key];
  let dots = '';
  for (let n = 1; n <= 10; n++) {
    dots += `<button data-rate="${key}" data-n="${n}" data-pass="${esc(p.id)}" class="${v != null && n <= v ? 'on' : ''}" aria-label="${label} ${n} von 10"${canWrite ? '' : ' disabled'}></button>`;
  }
  return `<div class="rate ${key}"><label>${label}</label><div class="dots">${dots}</div><span class="val${v == null ? ' none' : ''}">${v == null ? '–' : v}</span></div>`;
}

/* ------------------------------------------------------------- Karte --- */

// Universeller Kartenlink: öffnet auf dem Handy die Karten-App, am Rechner
// den Browser.
function mapsUrl(p) {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;
}

function hasPlace(p) {
  return typeof p.lat === 'number' && typeof p.lon === 'number';
}

// Die Kachel neben dem Schild zeigt den Streckenverlauf, nicht die eigenen
// Fotos – die stehen unten im Streifen. Beim Scrollen hilft die Form der
// Straße beim Wiedererkennen mehr als ein Ausschnitt Himmel.
function cover(p) {
  if (!hasPlace(p)) return '<span class="cover blank" aria-hidden="true"></span>';
  return `<a class="cover" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener"
    data-map="${esc(p.id)}" aria-label="Strecke über den ${esc(p.de)} ansehen">
    <img src="/api/map/${encodeURIComponent(p.id)}?v=${MAP_VERSION}" alt="" loading="lazy" data-map="${esc(p.id)}"
         onerror="this.closest('.cover').classList.add('blank')">
    <svg class="cover-pin" viewBox="0 0 24 24" aria-hidden="true"><path
      d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg></a>`;
}

// Was die Straße ausmacht, aus dem Verlauf gerechnet: Länge, Kurven, Kehren.
// Erscheint, sobald das Kartenbild einmal gebaut wurde.
function facts(p) {
  const bits = [];
  const fact = (value, label) => `<li><b>${value}</b>${label}</li>`;
  if (p.ref) bits.push(`<li class="ref"><b>${esc(p.ref)}</b></li>`);
  if (p.km) bits.push(fact(String(p.km).replace('.', ','), 'km'));
  if (p.curves) {
    bits.push(fact(p.curves, p.curves === 1 ? 'Kurve' : 'Kurven'));
    if (p.hairpins) bits.push(fact(p.hairpins, p.hairpins === 1 ? 'Kehre' : 'Kehren'));
    if (p.km) {
      const perKm = Math.round((p.curves / p.km) * 10) / 10;
      if (perKm >= 1) bits.push(fact(String(perKm).replace('.', ','), 'Kurven/km'));
    }
  }
  return bits.length ? `<ul class="facts">${bits.join('')}</ul>` : '';
}

/* --------------------------------------------------------- Schreiben --- */

// Optimistisch anzeigen, im Hintergrund speichern, bei Fehler zurückdrehen.
// Pro Pass eine Kette, damit schnelle Klicks in der richtigen Reihenfolge ankommen.
function write(id, patch) {
  if (!canWrite) return;
  const p = passes.find(x => x.id === id);
  if (!p) return;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = p[k];
  Object.assign(p, patch);
  render();

  inflight++;
  queues[id] = (queues[id] || Promise.resolve())
    .then(() => api.patch(id, patch))
    .then(saved => {
      const cur = passes.find(x => x.id === id);
      if (cur && saved) for (const k of Object.keys(patch)) if (k in saved) cur[k] = saved[k];
    })
    .catch(err => {
      const cur = passes.find(x => x.id === id);
      if (cur) Object.assign(cur, before);
      render();
      if (err.status === 401) return recoverAuth();
      toast(message(err));
    })
    .finally(() => {
      inflight--;
      // Eigene Änderung: der Zähler ist jetzt weiter, ohne dass sie fremd wäre.
      touch();
      api.version().then(v => { rev = v.rev; inboxCount = v.inbox; }).catch(() => {});
    });
}

async function load({ markChanges = false } = {}) {
  try {
    const d = await api.list();
    const fresh = d.passes || [];
    const changed = markChanges ? diff(passes, fresh) : new Set();
    passes = fresh;
    if (typeof d.rev === 'number') rev = d.rev;
    render(changed);
  } catch (err) {
    if (err.status === 401) return recoverAuth();
    list.innerHTML = '<li class="notice">Pässe konnten nicht geladen werden. Lade die Seite neu.</li>';
  }
}

// Welche Pässe haben sich gegenüber dem letzten Stand bewegt? Nur um sie
// kurz aufleuchten zu lassen, wenn der andere etwas bewertet hat.
function diff(oldList, newList) {
  const before = new Map(oldList.map(p => [p.id, p]));
  const out = new Set();
  for (const p of newList) {
    const b = before.get(p.id);
    if (!b) { out.add(p.id); continue; }
    if (b.fun !== p.fun || b.amb !== p.amb || (b.note || '') !== (p.note || '') ||
        (b.photos || []).length !== (p.photos || []).length) out.add(p.id);
  }
  return out;
}

/* ---------------------------------------------------------- Ereignisse --- */

/* -------------------------------------------------------- Darstellung --- */

// Hell, dunkel oder wie das Gerät. Die Wahl gilt nur für dieses Gerät und
// wird schon im <head> gesetzt, bevor die Seite zum ersten Mal zeichnet.
const THEMES = ['auto', 'light', 'dark'];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function savedTheme() {
  try { const t = localStorage.getItem('theme'); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; }
}

function showTheme(theme) {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  const i = THEMES.indexOf(theme);
  document.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeSet === theme));
  $('.theme-thumb').style.transform = `translateX(${i * 100}%)`;
  // Die Browserleiste auf dem Handy passt sich mit an.
  const dark = theme === 'dark' || (theme === 'auto' && darkQuery.matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    if (theme === 'auto') m.content = m.media.includes('dark') ? '#000000' : '#F2F2F7';
    else m.content = dark ? '#000000' : '#F2F2F7';
  });
}

document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
  const theme = b.dataset.themeSet;
  if (theme === savedTheme()) return;
  try { if (theme === 'auto') localStorage.removeItem('theme'); else localStorage.setItem('theme', theme); } catch { /* dann eben nur bis zum Neuladen */ }
  // Ein harter Wechsel von Schwarz auf Weiß blendet; also kurz überblenden.
  if (document.startViewTransition && !reduceMotion.matches) document.startViewTransition(() => showTheme(theme));
  else showTheme(theme);
}));
showTheme(savedTheme());


list.addEventListener('click', e => {
  const t = e.target.closest('button,img,video,span.clip,a[data-map]');
  if (!t) return;
  if (t.dataset.map) {
    // Nicht wegnavigieren: erst die Strecke zeigen, der Weg nach draußen
    // steht im Dialog.
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    openMap(passes.find(x => x.id === t.dataset.map));
    return;
  }
  if (t.dataset.rate) {
    const p = passes.find(x => x.id === t.dataset.pass);
    const n = +t.dataset.n;
    if (p) write(p.id, { [t.dataset.rate]: p[t.dataset.rate] === n ? null : n });
  } else if (t.dataset.upload) {
    uploadFor = t.dataset.upload;
    $('#fileIn').click();
  } else if (t.dataset.edit) {
    openEdit(t.dataset.edit);
  } else if (t.dataset.photo) {
    openLightbox(t.dataset.pass, t.dataset.photo);
  }
});

list.addEventListener('focusout', e => {
  if (e.target.dataset && e.target.dataset.note) {
    const id = e.target.dataset.note, val = e.target.value;
    const p = passes.find(x => x.id === id);
    setTimeout(() => {
      if (p && (p.note || '') !== val) write(id, { note: val });
      else if (pendingRender) render();
    }, 0);
  }
});

/* ------------------------------------------------------------- Fotos --- */

// Vor dem Upload verkleinern: spart Speicher und lädt am Berg schneller.
// Gibt die Id des angelegten Videos zurück. `onProgress` bekommt 0..1.
async function sendVideo(file, passId, onProgress) {
  const type = String(file.type || '').split(';')[0];
  const { token, pathname } = await api.uploadToken(type, file.size);
  const blob = await blobUpload(pathname, file, {
    access: 'private',
    token,
    contentType: type,
    multipart: file.size > 8 * 1024 * 1024,
    onUploadProgress: p => onProgress && onProgress((p && p.percentage != null ? p.percentage / 100 : 0))
  });
  const d = await api.registerVideo({
    pathname: blob.pathname || pathname,
    contentType: type,
    passId: passId || '',
    taken: new Date(file.lastModified || Date.now()).toISOString()
  });
  return d.id;
}

async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const max = 1800, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

$('#fileIn').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  const id = uploadFor;
  if (!files.length || !id) return;

  const btn = list.querySelector(`[data-upload="${CSS.escape(id)}"]`);
  if (btn) { btn.classList.add('busy'); btn.textContent = 'Lädt …'; }

  const added = [];
  let lost = false;
  for (const f of files) {
    try {
      if (isVideoFile(f)) {
        // Videos hängen sich selbst an den Pass, sie laufen nicht über write().
        await sendVideo(f, id, p => { if (btn) btn.textContent = Math.round(p * 100) + ' %'; });
      } else {
        added.push(await api.upload(await shrink(f)));
      }
    } catch (err) {
      if (err.status === 401) { lost = true; break; }
      toast(message(err));
    }
  }
  if (lost) { await recoverAuth(); return; }

  if (added.length) {
    const p = passes.find(x => x.id === id);
    write(id, { photos: [...((p && p.photos) || []), ...added] });
    // write() schreibt im Hintergrund. Erst abwarten, sonst räumt der nächste
    // Schritt auf und dieser Schreibvorgang stellt die Doppel danach wieder her.
    try { await queues[id]; } catch { /* der Fehler ist dort schon gemeldet */ }
  }
  const doppelt = await sweepDuplicates();
  if (doppelt) toast(doppelt === 1 ? '1 doppeltes Foto entfernt' : `${doppelt} doppelte Fotos entfernt`);
  await load();
});

$('#lbClose').onclick = () => $('#lightbox').close();
$('#lightbox').addEventListener('close', () => { $('#lbVideo').pause(); resetZoom(); });
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('#lightbox').close(); });
$('#lbDel').onclick = async () => {
  if (!lb || !confirm('Dieses Foto entfernen?')) return;
  const p = passes.find(x => x.id === lb.pass);
  const id = lb.id;
  if (!p) return;

  write(p.id, { photos: (p.photos || []).filter(x => x !== id) });
  lbList = lbList.filter(x => x !== id);
  // Sind noch Fotos da, gleich das nächste zeigen, statt zu schließen.
  if (lbList.length) showLb(Math.min(lbIndex, lbList.length - 1));
  else $('#lightbox').close();

  try { await api.removePhoto(id); } catch { /* Verweis ist weg, das Blob räumt der nächste Lauf */ }
  toast('Foto entfernt');
};

/* ------------------------------------------------ Passvorschläge --- */

// 1811 Alpenpässe aus OpenStreetMap, einmal geladen und dann im Speicher
// durchsucht. Die Datei ist klein genug, dass sich eine Suche über den
// Server nicht lohnt – und beim Tippen antwortet sie sofort.
let catalog = null;
let catalogLoading = null;
let picks = [];
let cursor = -1;
let pickedPlace = null;   // Koordinaten des zuletzt übernommenen Vorschlags
let lastPickedName = '';

function loadCatalog() {
  if (catalog) return Promise.resolve(catalog);
  if (!catalogLoading) {
    catalogLoading = fetch('/data/passes-alps.json')
      .then(r => (r.ok ? r.json() : []))
      .then(rows => {
        catalog = rows.map(p => ({ ...p, hay: fold([p.n, p.it, p.lld, ...(p.a || [])].filter(Boolean).join(' ')) }));
        return catalog;
      })
      .catch(() => (catalog = []));
  }
  return catalogLoading;
}

// Damit "Groedner", "grodner" und "Grödner" dasselbe finden.
function fold(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Wortanfänge zuerst, dann alles andere. Kürzere Namen vor längeren, damit
// "Sella" das Sellajoch über den Sellajochhäusern zeigt.
function search(term, limit = 8) {
  const q = fold(term.trim());
  if (q.length < 2 || !catalog) return [];
  const out = [];
  for (const p of catalog) {
    const i = p.hay.indexOf(q);
    if (i < 0) continue;
    const wordStart = i === 0 || /[\s\-/(]/.test(p.hay[i - 1]);
    const primary = fold(p.n).startsWith(q);
    out.push({ p, rank: primary ? 0 : wordStart ? 1 : 2, len: p.n.length });
  }
  out.sort((a, b) => a.rank - b.rank || a.len - b.len || a.p.n.localeCompare(b.p.n, 'de'));
  return out.slice(0, limit).map(x => x.p);
}

function highlight(text, term) {
  const q = fold(term.trim());
  const i = fold(text).indexOf(q);
  if (q.length < 2 || i < 0) return esc(text);
  // fold() ändert die Länge nicht (ä→ae wäre eine Ausnahme), deshalb hier
  // sicherheitshalber nur markieren, wenn die Längen zusammenpassen.
  if (fold(text).length !== text.length) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function showSuggestions(term) {
  const box = $('#suggest');
  const input = $('#editForm').de;
  picks = search(term);
  cursor = -1;

  if (!term.trim() || term.trim().length < 2) {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!picks.length) {
    box.innerHTML = '<li class="s-empty">Kein Pass gefunden – einfach selbst eintragen.</li>';
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    return;
  }
  box.innerHTML = picks.map((p, i) => {
    const sub = [p.it, p.lld].filter(Boolean).join(' / ');
    return `<li role="option" id="sug-${i}" data-i="${i}" aria-selected="false">
      <span class="s-name">${highlight(p.n, term)}${sub ? `<span class="s-sub">${esc(sub)}</span>` : ''}</span>
      ${p.alt ? `<span class="s-alt">${p.alt} m</span>` : ''}
    </li>`;
  }).join('');
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function hideSuggestions() {
  $('#suggest').hidden = true;
  $('#editForm').de.setAttribute('aria-expanded', 'false');
  cursor = -1;
}

function moveCursor(step) {
  if ($('#suggest').hidden || !picks.length) return;
  cursor = (cursor + step + picks.length) % picks.length;
  const items = [...$('#suggest').querySelectorAll('li[role="option"]')];
  items.forEach((li, i) => li.setAttribute('aria-selected', i === cursor));
  const active = items[cursor];
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
    $('#editForm').de.setAttribute('aria-activedescendant', active.id);
  }
}

// Übernimmt einen Vorschlag: Namen und Höhe stehen im Datensatz, die Gegend
// wird einmal nachgeschlagen und serverseitig gemerkt.
async function applyPick(p) {
  const f = $('#editForm');
  pickedPlace = (typeof p.lat === 'number' && typeof p.lon === 'number') ? { lat: p.lat, lon: p.lon } : null;
  lastPickedName = p.n;
  f.de.value = p.n;
  f.intl.value = p.it || '';
  f.lad.value = p.lld || '';
  f.alt.value = p.alt || '';
  hideSuggestions();

  if (!f.region.value.trim() && typeof p.lat === 'number') {
    const note = $('#regionNote');
    if (note) { note.textContent = 'suche Gegend …'; note.hidden = false; }
    try {
      const d = await req(`/api/place?lat=${p.lat}&lon=${p.lon}`);
      if (d.region && !f.region.value.trim()) {
        f.region.value = d.region;
        if (note) { note.textContent = 'automatisch ergänzt, änderbar'; note.hidden = false; }
      } else if (note) { note.hidden = true; }
    } catch {
      if (note) note.hidden = true;   // ohne Netz bleibt das Feld eben leer
    }
  }
  f.intl.focus();
}

$('#editForm').de.addEventListener('input', e => {
  if (editId) return;                 // beim Bearbeiten nicht dazwischenreden
  loadCatalog().then(() => {
    if (document.activeElement === e.target) showSuggestions(e.target.value);
  });
});

$('#editForm').de.addEventListener('keydown', e => {
  if ($('#suggest').hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter' && cursor >= 0) { e.preventDefault(); applyPick(picks[cursor]); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideSuggestions(); }
});

$('#suggest').addEventListener('pointerdown', e => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();                 // Fokus im Feld lassen
  applyPick(picks[+li.dataset.i]);
});

$('#editForm').de.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

// Zeigt die Passstraße mit ihren Kehren. Das Bild kommt von /api/map und
// wird dort einmal gebaut; hier ist nur der Rahmen drumherum.
function openMap(p) {
  if (!p || !hasPlace(p)) return;
  const img = $('#mapImg');
  const fail = $('#mapFail');
  fail.hidden = true;
  img.hidden = false;
  img.alt = 'Straßenverlauf über den ' + p.de;
  img.onerror = () => { img.hidden = true; fail.hidden = false; };
  img.src = `/api/map/${encodeURIComponent(p.id)}?size=large&v=${MAP_VERSION}`;
  $('#mapTitle').textContent = p.alt ? `${p.de} · ${p.alt} m` : p.de;
  $('#mapOpen').href = mapsUrl(p);
  $('#mapDlg').showModal();
}

$('#mapClose').onclick = () => $('#mapDlg').close();
$('#mapDlg').addEventListener('click', e => { if (e.target.id === 'mapDlg') $('#mapDlg').close(); });

/* --------------------------------------------------------- Lightbox --- */

// Beim Öffnen die ganze Fotoreihe des Passes mitnehmen, damit sich blättern
// lässt, ohne jedes Mal zu schließen.
function openLightbox(passId, photoId) {
  const p = passes.find(x => x.id === passId);
  lbList = p ? [...(p.photos || [])] : [photoId];
  lbIndex = Math.max(0, lbList.indexOf(photoId));
  lb = { pass: passId, id: photoId };
  showLb(lbIndex);
  $('#lbDel').hidden = !canWrite;
  $('#lightbox').showModal();
}

// Ein einzelnes Foto ohne Reihe – aus dem Eingang.
function openSingle(src, alt, video) {
  lb = null; lbList = []; lbIndex = -1;
  showMedia(src, !!video);
  if (!video) $('#lbImg').alt = alt || '';
  $('#lbDel').hidden = true;
  updateLbNav();
  $('#lightbox').showModal();
}

function showLb(i) {
  if (!lbList.length) return;
  lbIndex = (i + lbList.length) % lbList.length;
  const id = lbList[lbIndex];
  if (lb) lb.id = id;
  showMedia('/api/photos/' + encodeURIComponent(id), isVideo(id));
  updateLbNav();
}

// Ein Feld für beides: Bild oder Video, immer nur eines sichtbar.
function showMedia(src, video) {
  const img = $('#lbImg'), vid = $('#lbVideo');
  vid.pause();
  if (video) {
    img.hidden = true; img.removeAttribute('src');
    vid.hidden = false; vid.src = src;
  } else {
    vid.hidden = true; vid.removeAttribute('src');
    img.hidden = false; img.src = src; img.alt = 'Foto';
  }
  // Ein Video bringt eigene Bedienelemente mit, Zoomen wäre dort nur im Weg.
  stage.classList.toggle('video', !!video);
  resetZoom();
}

function updateLbNav() {
  const many = lbList.length > 1;
  $('#lbPrev').hidden = !many;
  $('#lbNext').hidden = !many;
  $('#lbCount').hidden = !many;
  if (many) $('#lbCount').textContent = `${lbIndex + 1} / ${lbList.length}`;
}

$('#lbPrev').onclick = e => { e.stopPropagation(); showLb(lbIndex - 1); };
$('#lbNext').onclick = e => { e.stopPropagation(); showLb(lbIndex + 1); };

// Tastatur am Rechner, Wischen am Handy.
$('#lightbox').addEventListener('keydown', e => {
  if (!lbList.length) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); showLb(lbIndex - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); showLb(lbIndex + 1); }
});

// Wischen zum Blättern, Zwei-Finger zum Vergrößern. Beides am selben Bild,
// deshalb hängt alles an einem Zustand: solange nicht vergrößert ist, blättert
// ein waagerechter Wisch; ist vergrößert, schiebt derselbe Wisch den Ausschnitt.
const MAX_ZOOM = 6;
let zoom = { scale: 1, x: 0, y: 0 };
let swipeX = 0, swipeY = 0, swiping = false;
let panX = 0, panY = 0, panning = false;
let pinchDist = 0, pinchScale = 1, pinchX = 0, pinchY = 0;
// Ein Tippen ist nur dann eines, wenn genau ein Finger aufsetzt, kaum wandert
// und wieder abhebt. Ohne diese Buchführung zählt das Ende einer Zwei-Finger-
// Geste als Tipp – und der nächste Fingerabdruck als Doppeltipp.
let tapOk = false, tapX = 0, tapY = 0;

const stage = document.querySelector('.lb-stage');
const lbImg = $('#lbImg');

function applyZoom() {
  lbImg.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  const on = zoom.scale > 1.01;
  stage.classList.toggle('zoomed', on);
  // Ist vergrößert, gehört jede Fingerbewegung dem Bild – sonst scrollt die Seite.
  stage.style.touchAction = on ? 'none' : 'pan-y';
  lbImg.style.cursor = on ? 'grab' : '';
}

function resetZoom() {
  zoom = { scale: 1, x: 0, y: 0 };
  lbImg.style.transition = '';
  applyZoom();
}

// Nicht über den Rand hinausschieben: bei Vergrößerung n darf höchstens die
// halbe hinzugekommene Breite verschoben werden.
function clampZoom() {
  const r = stage.getBoundingClientRect();
  const maxX = Math.max(0, (r.width * zoom.scale - r.width) / 2);
  const maxY = Math.max(0, (r.height * zoom.scale - r.height) / 2);
  zoom.x = Math.max(-maxX, Math.min(maxX, zoom.x));
  zoom.y = Math.max(-maxY, Math.min(maxY, zoom.y));
}

// Um einen Punkt herum vergrößern, damit sich das Bild nicht unter dem Finger
// wegbewegt.
function zoomAt(scale, clientX, clientY) {
  const r = stage.getBoundingClientRect();
  const cx = clientX - r.left - r.width / 2;
  const cy = clientY - r.top - r.height / 2;
  const next = Math.max(1, Math.min(MAX_ZOOM, scale));
  const k = next / zoom.scale;
  zoom.x = cx - (cx - zoom.x) * k;
  zoom.y = cy - (cy - zoom.y) * k;
  zoom.scale = next;
  if (zoom.scale <= 1.01) { zoom.x = 0; zoom.y = 0; zoom.scale = 1; }
  clampZoom();
  applyZoom();
}

const spread = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const middle = t => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

stage.addEventListener('touchstart', e => {
  if (stage.classList.contains('video')) return;
  lbImg.style.transition = '';
  if (e.touches.length === 1) {
    tapOk = true; tapX = e.touches[0].clientX; tapY = e.touches[0].clientY;
  } else {
    tapOk = false;
  }
  if (e.touches.length === 2) {
    swiping = panning = false;
    pinchDist = spread(e.touches);
    pinchScale = zoom.scale;
    const m = middle(e.touches);
    pinchX = m.x; pinchY = m.y;
    return;
  }
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  if (zoom.scale > 1.01) {
    panning = true; swiping = false;
    panX = t.clientX - zoom.x;
    panY = t.clientY - zoom.y;
  } else {
    swiping = true; panning = false;
    swipeX = t.clientX; swipeY = t.clientY;
  }
}, { passive: true });

stage.addEventListener('touchmove', e => {
  if (stage.classList.contains('video')) return;
  if (tapOk && e.touches.length === 1) {
    const t = e.touches[0];
    if (Math.abs(t.clientX - tapX) > 10 || Math.abs(t.clientY - tapY) > 10) tapOk = false;
  }
  if (e.touches.length === 2 && pinchDist) {
    e.preventDefault();
    const m = middle(e.touches);
    // Erst auf den neuen Mittelpunkt schieben, dann skalieren – so folgt das
    // Bild den Fingern, auch wenn sie sich beim Zoomen mitbewegen.
    zoom.x += m.x - pinchX; zoom.y += m.y - pinchY;
    pinchX = m.x; pinchY = m.y;
    zoomAt(pinchScale * (spread(e.touches) / pinchDist), m.x, m.y);
    return;
  }
  if (panning && e.touches.length === 1) {
    e.preventDefault();
    zoom.x = e.touches[0].clientX - panX;
    zoom.y = e.touches[0].clientY - panY;
    clampZoom();
    applyZoom();
  }
}, { passive: false });

stage.addEventListener('touchend', e => {
  if (e.touches.length === 0) pinchDist = 0;
  if (panning) { panning = e.touches.length > 0; return; }
  if (!swiping || lbList.length < 2 || zoom.scale > 1.01) { swiping = false; return; }
  swiping = false;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeX;
  const dy = t.clientY - swipeY;
  // Waagerecht und weit genug: sonst war es Scrollen oder ein Tippen.
  if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
  showLb(lbIndex + (dx < 0 ? 1 : -1));
}, { passive: true });

// Trackpad-Geste und Strg+Rad kommen als wheel mit ctrlKey an.
stage.addEventListener('wheel', e => {
  if (!e.ctrlKey || stage.classList.contains('video')) return;
  e.preventDefault();
  zoomAt(zoom.scale * (1 - e.deltaY / 200), e.clientX, e.clientY);
}, { passive: false });

// Doppeltippen und Doppelklick: hin und her zwischen ganz und nah.
stage.addEventListener('dblclick', e => {
  if (stage.classList.contains('video')) return;
  e.preventDefault();
  lbImg.style.transition = 'transform 180ms ease-out';
  zoomAt(zoom.scale > 1.01 ? 1 : 2.5, e.clientX, e.clientY);
});

let lastTap = 0;
stage.addEventListener('touchend', e => {
  // Nur ein echtes Tippen zählt: ein Finger, kaum bewegt, alle wieder ab.
  const wasTap = tapOk && e.touches.length === 0 && e.changedTouches.length === 1;
  tapOk = false;
  if (!wasTap) { lastTap = 0; return; }

  const now = Date.now();
  if (now - lastTap < 300) {
    const t = e.changedTouches[0];
    lbImg.style.transition = 'transform 180ms ease-out';
    zoomAt(zoom.scale > 1.01 ? 1 : 2.5, t.clientX, t.clientY);
    lastTap = 0;
  } else lastTap = now;
}, { passive: true });

/* ------------------------------------------------------- Pass-Dialog --- */

function openEdit(id) {
  editId = id;
  const f = $('#editForm');
  f.reset();
  pickedPlace = null;
  lastPickedName = '';
  hideSuggestions();
  const note = $('#regionNote');
  if (note) note.hidden = true;
  if (!id) loadCatalog();
  const p = id ? passes.find(x => x.id === id) : null;
  $('#editTitle').textContent = p ? 'Pass bearbeiten' : 'Pass hinzufügen';
  $('#delPass').hidden = !p;
  if (p) {
    f.de.value = p.de || '';
    f.intl.value = p.intl || '';
    f.lad.value = p.lad || '';
    f.alt.value = p.alt || '';
    f.region.value = p.region || '';
  }
  $('#editDlg').showModal();
}

$('#addPass').onclick = () => openEdit(null);
$('#cancelEdit').onclick = () => $('#editDlg').close();

$('#editForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const data = {
    de: f.de.value.trim(),
    intl: f.intl.value.trim(),
    lad: f.lad.value.trim(),
    alt: f.alt.value ? +f.alt.value : null,
    region: f.region.value.trim()
  };
  // Nur übernehmen, wenn der Name noch der aus dem Vorschlag ist – sonst
  // hinge an einem handgetippten Pass die Koordinate eines anderen.
  if (pickedPlace && data.de === lastPickedName) {
    data.lat = pickedPlace.lat;
    data.lon = pickedPlace.lon;
  }
  if (!data.de) return;
  $('#editDlg').close();

  if (editId) {
    write(editId, data);
    toast('Gespeichert');
    return;
  }
  try {
    const pass = await api.create(data);
    passes.push(pass);
    render();
    toast(data.de + ' hinzugefügt');
  } catch (err) {
    if (err.status === 401) return recoverAuth();
    toast(message(err));
  }
});

$('#delPass').onclick = async () => {
  const p = passes.find(x => x.id === editId);
  if (!p || !confirm(p.de + ' mit allen Bewertungen und Fotos löschen?')) return;
  $('#editDlg').close();
  const keep = passes;
  passes = passes.filter(x => x.id !== p.id);
  render();
  try {
    await api.remove(p.id);
    toast(p.de + ' gelöscht');
  } catch (err) {
    passes = keep;
    render();
    if (err.status === 401) return recoverAuth();
    toast('Löschen fehlgeschlagen.');
  }
};

$('#logout').onclick = async () => {
  try { await api.logout(); } catch { /* egal, Cookie ist ohnehin gleich weg */ }
  passes = [];
  canWrite = true;
  applyRole();
  render();
  await openGate();
  await load();
};

// Nach jedem Hochladen einmal durchwischen. Neue Doppel entstehen ohnehin
// keine mehr – beide Wege erkennen dieselben Bytes –, aber Altbestände und
// Fotos, die vor dieser Prüfung hereinkamen, verschwinden so von selbst.
// Läuft still: schlägt es fehl, ist das kein Grund, den Upload zu vermelden.
async function sweepDuplicates() {
  try {
    const d = await api.dedupe(true);
    return d.removed || 0;
  } catch { return 0; }
}

/* -------------------------------------------- Fotos sammeln hochladen --- */

// Mehrere Fotos auf einmal: der Ort wird aus der Datei gelesen, bevor sie
// durchs Canvas geht – danach wäre er weg. Was einen Ort hat, landet direkt
// beim nächstgelegenen Pass, der Rest im Eingang.
$('#bulkPhotos').onclick = () => $('#bulkIn').click();

function logLine(name, where, kind) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="name">${esc(name)}</span><span class="where${kind ? ' ' + kind : ''}">${esc(where)}</span>`;
  $('#uploadLog').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

$('#bulkIn').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;

  $('#uploadLog').innerHTML = '';
  $('#uploadClose').hidden = true;
  $('#uploadTitle').textContent = files.length === 1 ? '1 Foto' : files.length + ' Fotos';
  $('#uploadStatus').textContent = 'Wird vorbereitet …';
  $('#uploadDlg').showModal();

  let done = 0, placed = 0, inbox = 0, failed = 0, located = 0;
  inflight++;
  try {
    for (const f of files) {
      done++;
      $('#uploadStatus').textContent = `${done} von ${files.length} …`;
      try {
        if (isVideoFile(f)) {
          // Ein Video kennt keinen Ort, den wir lesen könnten – es geht in den
          // Eingang und wird dort von Hand zugeordnet.
          await sendVideo(f, '', p => {
            $('#uploadStatus').textContent = `${done} von ${files.length} · ${f.name} ${Math.round(p * 100)} %`;
          });
          inbox++;
          logLine(f.name, 'Video · im Eingang', 'none');
          continue;
        }
        // Reihenfolge ist entscheidend: erst lesen, dann verkleinern.
        const meta = await readExif(f);
        if (meta.lat !== null) located++;
        const blob = await shrink(f);
        const r = await api.importPhoto(blob, meta);

        if (r.duplicate) logLine(f.name, 'schon vorhanden', 'none');
        else if (r.passId) { placed++; logLine(f.name, `${r.passName} · ${r.distanceM} m`); }
        else { inbox++; logLine(f.name, meta.lat === null ? 'kein Ort im Foto' : 'kein Pass in der Nähe', 'none'); }
      } catch (err) {
        failed++;
        if (err.status === 401) { $('#uploadDlg').close(); await recoverAuth(); return; }
        logLine(f.name, 'fehlgeschlagen', 'bad');
      }
    }
  } finally {
    inflight--;
    touch();
  }

  const parts = [];
  if (placed) parts.push(`${placed} zugeordnet`);
  if (inbox) parts.push(`${inbox} im Eingang`);
  if (failed) parts.push(`${failed} fehlgeschlagen`);
  // Die Zahl beantwortet nebenbei, ob das Handy den Ort überhaupt mitliefert.
  const doppelt = await sweepDuplicates();
  if (doppelt) parts.push(doppelt === 1 ? '1 Doppel entfernt' : `${doppelt} Doppel entfernt`);

  const bilder = files.filter(f => !isVideoFile(f)).length;
  $('#uploadStatus').textContent = parts.join(', ') || 'nichts geändert';
  if (bilder) $('#uploadStatus').textContent += ` · ${located} von ${bilder} hatten einen Ort`;
  $('#uploadClose').hidden = false;

  await load();
  await loadInbox();
});

$('#uploadClose').onclick = () => $('#uploadDlg').close();

/* ------------------------------------------------------------ Eingang --- */

// Fotos, die der Kurzbefehl nicht sicher zuordnen konnte. Normalerweise ist
// hier nichts – dann bleibt der ganze Bereich unsichtbar.
async function loadInbox() {
  if (!canWrite) { inboxItems = []; renderInbox(); return; }
  try {
    inboxItems = await api.inbox();
    inboxCount = inboxItems.length;
  } catch (err) {
    if (err.status === 401) return recoverAuth();
    inboxItems = [];
  }
  renderInbox();
}

function whenLabel(taken) {
  if (!taken) return 'ohne Zeitangabe';
  const d = new Date(taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  if (isNaN(d)) return esc(taken);
  return d.toLocaleString('de-DE', {
    weekday: 'short', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderInbox() {
  const box = $('#inbox');
  if (!canWrite || !inboxItems.length) { box.hidden = true; return; }

  $('#inboxTitle').textContent = inboxItems.length === 1
    ? '1 neues Foto'
    : inboxItems.length + ' neue Fotos';

  const options = passes.slice()
    .sort((a, b) => a.de.localeCompare(b.de, 'de'))
    .map(p => `<option value="${esc(p.id)}">${esc(p.de)}</option>`)
    .join('');

  $('#inboxList').innerHTML = inboxItems.map(it => {
    const s = it.suggestion;
    const near = s
      ? `in der Nähe: ${esc(s.name)} · ${s.distanceM < 1000
          ? s.distanceM + ' m'
          : String(Math.round(s.distanceM / 100) / 10).replace('.', ',') + ' km'}`
      : 'kein Ort im Foto';
    return `<li class="inbox-row" data-photo-row="${esc(it.id)}">
      ${isVideo(it.id)
        ? `<span class="clip" data-inbox-photo="${esc(it.id)}"><video src="/api/photos/${encodeURIComponent(it.id)}" muted playsinline preload="metadata" data-inbox-photo="${esc(it.id)}"></video><span class="play" aria-hidden="true"></span></span>`
        : `<img src="/api/photos/${encodeURIComponent(it.id)}" alt="" loading="lazy" data-inbox-photo="${esc(it.id)}">`}
      <span class="inbox-meta">
        <span class="inbox-when">${whenLabel(it.taken)}</span>
        <span class="inbox-near">${near}</span>
      </span>
      <select data-inbox-pass="${esc(it.id)}" aria-label="Pass auswählen">
        <option value="">Pass wählen …</option>
        ${options}
      </select>
      <span class="inbox-act">
        <button class="btn" data-inbox-assign="${esc(it.id)}">Zuordnen</button>
        <button class="btn danger" data-inbox-discard="${esc(it.id)}">Verwerfen</button>
      </span>
    </li>`;
  }).join('');

  // Vorschlag vorwählen, ohne ihn zu erzwingen.
  for (const it of inboxItems) {
    if (!it.suggestion) continue;
    const sel = $('#inboxList').querySelector(`[data-inbox-pass="${CSS.escape(it.id)}"]`);
    if (sel && passes.some(p => p.id === it.suggestion.passId)) sel.value = it.suggestion.passId;
  }

  box.hidden = false;
}

$('#inboxList').addEventListener('click', async e => {
  const t = e.target.closest('button,img,video,span.clip');
  if (!t) return;

  if (t.dataset.inboxPhoto) {
    const id = t.dataset.inboxPhoto;            // kein Pass dahinter, also kein Löschen
    openSingle('/api/photos/' + encodeURIComponent(id), '', isVideo(id));
    return;
  }

  const assignId = t.dataset.inboxAssign;
  const discardId = t.dataset.inboxDiscard;
  const id = assignId || discardId;
  if (!id) return;

  if (discardId && !confirm('Dieses Foto endgültig verwerfen?')) return;

  let passId = '';
  if (assignId) {
    const sel = $('#inboxList').querySelector(`[data-inbox-pass="${CSS.escape(id)}"]`);
    passId = sel ? sel.value : '';
    if (!passId) { toast('Bitte erst einen Pass auswählen.'); return; }
  }

  t.disabled = true;
  inflight++;
  try {
    if (assignId) await api.assign([id], passId);
    else await api.discard([id]);
    inboxItems = inboxItems.filter(x => x.id !== id);
    inboxCount = inboxItems.length;
    renderInbox();
    toast(assignId ? 'Foto zugeordnet' : 'Foto verworfen');
    await load();
  } catch (err) {
    t.disabled = false;
    if (err.status === 401) return recoverAuth();
    toast(message(err));
  } finally {
    inflight--;
    touch();
  }
});


/* ----------------------------------------------------- Live-Abgleich --- */

// Zu zweit unterwegs: /api/session?poll=1 ist eine winzige Zahl, die bei jeder
// Änderung hochgeht. Nur wenn sie sich bewegt hat, wird die Liste geholt.
// Solange gemeinsam bewertet wird, alle 3 Sekunden; danach zieht sich der
// Takt zurück, damit ein vergessener Tab nicht stundenlang pollt.
const FAST = 3000, SLOW = 15000, IDLE = 60000;
let lastActivity = Date.now();
let syncTimer = null;

function touch() { lastActivity = Date.now(); }

function interval() {
  const quiet = Date.now() - lastActivity;
  if (quiet < 2 * 60 * 1000) return FAST;
  if (quiet < 10 * 60 * 1000) return SLOW;
  return IDLE;
}

// Nicht abgleichen, während ein Dialog offen ist, jemand eine Notiz tippt oder
// eigene Änderungen noch unterwegs sind – sonst überschreibt der Server, was
// gerade erst lokal passiert ist.
function busy() {
  const active = document.activeElement;
  return inflight > 0 ||
    document.querySelector('dialog[open]') ||
    (active && active.classList.contains('note')) ||
    // Während jemand im Eingang einen Pass auswählt, nicht neu bauen.
    (active && active.closest && active.closest('#inbox'));
}

async function tick() {
  syncTimer = null;
  if (authed && document.visibilityState === 'visible' && !busy()) {
    try {
      const v = await api.version();
      if (v.rev !== rev) {
        rev = v.rev;
        touch();
        await load({ markChanges: true });
      }
      if (canWrite && v.inbox !== inboxCount) {
        inboxCount = v.inbox;
        await loadInbox();
      }
    } catch (err) {
      if (err.status === 401) await recoverAuth();
    }
  }
  schedule();
}

function schedule() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(tick, document.visibilityState === 'visible' ? interval() : IDLE);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { touch(); schedule(); tick(); }
});
list.addEventListener('pointerdown', touch);

// Blendet aus, was ein Gast nicht benutzen darf. Der eigentliche Schutz sitzt
// im Server, das hier ist nur die Oberfläche dazu.
function applyRole() {
  document.body.classList.toggle('guest', !canWrite);
  $('#addPass').hidden = !canWrite;
  $('#bulkPhotos').hidden = !canWrite;
  if (!canWrite) { inboxItems = []; $('#inbox').hidden = true; }
  $('#intro').textContent = canWrite
    ? 'Gerankt nach Fahrspaß, bei Gleichstand nach Ambiente. Tippe auf die Balken, um von 1 bis 10 zu bewerten.'
    : 'Gerankt nach Fahrspaß, bei Gleichstand nach Ambiente.';
}

(async () => {
  let s;
  try { s = await api.session(); } catch { s = { authed: false }; }
  authed = !!s.authed;
  canWrite = s.role !== 'guest';
  if (!authed) {
    await openGate(s.configured === false ? 'Auf dem Server fehlt APP_PASSWORD.' : '');
  } else {
    document.body.classList.remove('locked');
  }
  applyRole();
  $('#logout').hidden = false;
  await load();
  await loadInbox();
  schedule();
})();
