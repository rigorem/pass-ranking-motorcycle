// Pässeranking – Frontend. Spricht ausschließlich mit den eigenen /api-Routen.

const $ = s => document.querySelector(s);
const list = $('#list');

let passes = [];
let sortKey = 'total';
let pendingRender = false;
let uploadFor = null;
let editId = null;
let lb = null;
let authed = false;
const queues = {};

/* ---------------------------------------------------------------- API --- */

class ApiError extends Error {
  constructor(status, code) { super(code || String(status)); this.status = status; this.code = code; }
}

async function req(path, { method = 'GET', body, type } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
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
  list: () => req('/api/passes').then(d => d.passes || []),
  create: data => req('/api/passes', { method: 'POST', body: data }).then(d => d.pass),
  patch: (id, data) => req('/api/passes/' + encodeURIComponent(id), { method: 'PATCH', body: data }).then(d => d.pass),
  remove: id => req('/api/passes/' + encodeURIComponent(id), { method: 'DELETE' }),
  upload: blob => req('/api/photos', { method: 'POST', body: blob }).then(d => d.id),
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

function score(p, key) {
  if (key === 'fun') return p.fun ?? null;
  if (key === 'amb') return p.amb ?? null;
  const v = [p.fun, p.amb].filter(x => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
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
    await api.login(pw);
    authed = true;
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

function render() {
  // Während jemand in einer Notiz tippt, nicht unter den Fingern neu bauen.
  if (document.activeElement && document.activeElement.classList.contains('note')) { pendingRender = true; return; }
  pendingRender = false;

  const sorted = passes.slice().sort((a, b) => {
    const sa = score(a, sortKey), sb = score(b, sortKey);
    if (sa == null && sb == null) return (a.order ?? 0) - (b.order ?? 0);
    if (sa == null) return 1;
    if (sb == null) return -1;
    if (sb !== sa) return sb - sa;
    const ta = score(a, 'total') ?? 0, tb = score(b, 'total') ?? 0;
    return tb - ta || (a.order ?? 0) - (b.order ?? 0);
  });

  $('#count').textContent = passes.length === 1 ? '1 Pass gefahren' : passes.length + ' Pässe gefahren';

  if (!sorted.length) {
    list.innerHTML = '<li class="empty">Noch keine Pässe eingetragen. Füge unten euren ersten Pass hinzu.</li>';
    return;
  }

  let rank = 0, last;
  list.innerHTML = sorted.map((p, i) => {
    const s = score(p, sortKey);
    if (s !== last) { rank = i + 1; last = s; }
    const rankTxt = s == null ? '–' : rank;
    const intl = [p.intl ? esc(p.intl) : '', p.lad ? '<span>' + esc(p.lad) + '</span>' : ''].filter(Boolean).join(' / ');
    const photos = (p.photos || []).map(id =>
      `<img src="/api/photos/${encodeURIComponent(id)}" alt="Foto vom ${esc(p.de)}" loading="lazy" data-photo="${esc(id)}" data-pass="${esc(p.id)}">`
    ).join('');
    return `<li class="pass${s != null && rank <= 3 ? ' top' : ''}" data-id="${esc(p.id)}">
      <div class="rank" aria-label="Platz ${rankTxt}">${rankTxt}</div>
      <div>
        <div class="plate"><div class="plate-in">
          <h2>${esc(p.de)}</h2>${p.alt ? `<span class="alt">${esc(p.alt)} m</span>` : '<span></span>'}
          ${intl ? `<div class="intl">${intl}</div>` : ''}
        </div></div>
        ${p.region ? `<p class="region">${esc(p.region)}</p>` : ''}
        <div class="ratings">
          ${rateRow(p, 'fun', 'Fahrspaß')}
          ${rateRow(p, 'amb', 'Ambiente')}
        </div>
        <div class="photos">${photos}<button class="add-photo" data-upload="${esc(p.id)}">+ Fotos</button></div>
        <textarea class="note" data-note="${esc(p.id)}" rows="2" placeholder="Notiz: Straßenzustand, Verkehr, Einkehr …">${esc(p.note)}</textarea>
        <div class="foot"><button class="link" data-edit="${esc(p.id)}">Namen und Daten bearbeiten</button></div>
      </div>
    </li>`;
  }).join('');
}

function rateRow(p, key, label) {
  const v = p[key];
  let dots = '';
  for (let n = 1; n <= 10; n++) {
    dots += `<button data-rate="${key}" data-n="${n}" data-pass="${esc(p.id)}" class="${v != null && n <= v ? 'on' : ''}" aria-label="${label} ${n} von 10"></button>`;
  }
  return `<div class="rate ${key}"><label>${label}</label><div class="dots">${dots}</div><span class="val${v == null ? ' none' : ''}">${v == null ? '–' : v}</span></div>`;
}

/* --------------------------------------------------------- Schreiben --- */

// Optimistisch anzeigen, im Hintergrund speichern, bei Fehler zurückdrehen.
// Pro Pass eine Kette, damit schnelle Klicks in der richtigen Reihenfolge ankommen.
function write(id, patch) {
  const p = passes.find(x => x.id === id);
  if (!p) return;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = p[k];
  Object.assign(p, patch);
  render();

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
    });
}

async function load() {
  try {
    passes = await api.list();
    render();
  } catch (err) {
    if (err.status === 401) return recoverAuth();
    list.innerHTML = '<li class="notice">Pässe konnten nicht geladen werden. Lade die Seite neu.</li>';
  }
}

/* ---------------------------------------------------------- Ereignisse --- */

document.querySelectorAll('.seg-ctl button').forEach(b => b.addEventListener('click', () => {
  sortKey = b.dataset.sort;
  document.querySelectorAll('.seg-ctl button').forEach(x => x.setAttribute('aria-pressed', x === b));
  render();
}));

list.addEventListener('click', e => {
  const t = e.target.closest('button,img');
  if (!t) return;
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
    lb = { pass: t.dataset.pass, id: t.dataset.photo };
    $('#lbImg').src = t.src;
    $('#lbImg').alt = t.alt;
    $('#lbDel').hidden = false;
    $('#lightbox').showModal();
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
      added.push(await api.upload(await shrink(f)));
    } catch (err) {
      if (err.status === 401) { lost = true; break; }
      toast('Ein Foto konnte nicht hochgeladen werden.');
    }
  }
  if (lost) { await recoverAuth(); return; }

  if (added.length) {
    const p = passes.find(x => x.id === id);
    write(id, { photos: [...((p && p.photos) || []), ...added] });
    toast(added.length === 1 ? 'Foto hinzugefügt' : added.length + ' Fotos hinzugefügt');
  } else {
    render();
  }
});

$('#lbClose').onclick = () => $('#lightbox').close();
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') $('#lightbox').close(); });
$('#lbDel').onclick = async () => {
  if (!lb || !confirm('Dieses Foto entfernen?')) return;
  const p = passes.find(x => x.id === lb.pass);
  const id = lb.id;
  $('#lightbox').close();
  if (!p) return;
  write(p.id, { photos: (p.photos || []).filter(x => x !== id) });
  try { await api.removePhoto(id); } catch { /* Verweis ist weg, das Blob räumt der nächste Lauf */ }
  toast('Foto entfernt');
};

/* ------------------------------------------------------- Pass-Dialog --- */

function openEdit(id) {
  editId = id;
  const f = $('#editForm');
  f.reset();
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
  render();
  await openGate();
  await load();
};

/* ------------------------------------------------- Frischhalten & Boot --- */

// Kein Realtime mehr wie im Artifact, deshalb beim Zurückkommen neu laden.
// Ruhig bleiben, solange ein Dialog offen ist oder jemand tippt.
function busy() {
  return document.querySelector('dialog[open]') ||
    (document.activeElement && document.activeElement.classList.contains('note'));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authed && !busy()) load();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && authed && !busy()) load();
}, 45000);

(async () => {
  let s;
  try { s = await api.session(); } catch { s = { authed: false }; }
  authed = !!s.authed;
  if (!authed) {
    await openGate(s.configured === false ? 'Auf dem Server fehlt APP_PASSWORD.' : '');
  } else {
    document.body.classList.remove('locked');
  }
  $('#addPass').hidden = false;
  $('#logout').hidden = false;
  await load();
})();
