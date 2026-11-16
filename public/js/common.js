const $ = (s) => document.querySelector(s);
const eventId = () => location.pathname.split('/')[2];

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Etwas ist schiefgelaufen');
  return data;
}

// Gespeicherte Feiern (nur auf diesem Gerät, für den Ersteller)
function getFeiern() {
  try { return JSON.parse(localStorage.getItem('feiern') || '[]'); } catch { return []; }
}
function saveFeier(f) {
  const list = getFeiern().filter((x) => x.id !== f.id);
  list.unshift(f);
  try { localStorage.setItem('feiern', JSON.stringify(list)); } catch {}
}

// Name des Gasts und anonyme Gerätekennung (für Herzen)
function getName() {
  try { return (localStorage.getItem('gastname') || '').trim(); } catch { return ''; }
}
function setName(n) {
  try { localStorage.setItem('gastname', n); } catch {}
}
function getVoter() {
  let v = '';
  try { v = localStorage.getItem('voter') || ''; } catch {}
  if (!v) {
    v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('voter', v); } catch {}
  }
  return v;
}

// Foto vor dem Upload verkleinern (spart Datenvolumen und Speicher)
async function shrink(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

// Feiernamen in den Titel schreiben
async function loadEvent() {
  try {
    const ev = await api('/events/' + eventId());
    document.title = ev.name;
    return ev;
  } catch (e) {
    document.body.innerHTML = '<main class="wrap"><h1>Feier nicht gefunden</h1><p class="muted">Der Link stimmt nicht oder die Feier wurde gelöscht.</p><a class="btn" href="/">Zur Startseite</a></main>';
    throw e;
  }
}
