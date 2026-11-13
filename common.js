const $ = (s) => document.querySelector(s);
const eventId = () => location.pathname.split('/')[2];

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
