const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2; // liest CLOUDINARY_URL automatisch
const rateLimit = require('express-rate-limit');
const icons = require('./icons');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      public_id TEXT NOT NULL,
      task TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE events ADD COLUMN IF NOT EXISTS reveal_at TIMESTAMPTZ;
    ALTER TABLE photos ADD COLUMN IF NOT EXISTS author TEXT;
    CREATE TABLE IF NOT EXISTS likes (
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      voter TEXT NOT NULL,
      PRIMARY KEY (photo_id, voter)
    );
    CREATE INDEX IF NOT EXISTS photos_event_idx ON photos(event_id, id DESC);
  `);
}

const newId = () => crypto.randomBytes(6).toString('base64url').slice(0, 8);
const newToken = () => crypto.randomBytes(18).toString('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cleanVoter = (v) => (/^[\w-]{8,64}$/.test(String(v || '')) ? String(v) : '');
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const small = (url) => url.replace('/upload/', '/upload/c_limit,w_420,q_auto,f_auto/');
const large = (url) => url.replace('/upload/', '/upload/c_limit,w_1400,q_auto,f_auto/');
const isOpen = (ev) => !!ev.reveal_at && new Date(ev.reveal_at) <= new Date();
const shape = (p) => ({
  id: p.id,
  thumb: small(p.url),
  url: large(p.url),
  author: p.author,
  task: p.task,
  likes: p.likes || 0,
  liked: !!p.liked,
  created_at: p.created_at,
});

async function getEvent(id) {
  const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
  return rows[0];
}

async function requireAdmin(req, res, next) {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Feier nicht gefunden' });
    if (!safeEq(req.get('x-admin-token') || '', ev.admin_token)) {
      return res.status(403).json({ error: 'Kein Zugriff' });
    }
    req.ev = ev;
    next();
  } catch (e) { next(e); }
}

const createLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const likeLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Nur Bilder sind erlaubt')),
});

app.get('/health', (req, res) => res.send('ok'));

// App-Icons
const png = (b64) => (req, res) => res.type('png').set('Cache-Control', 'public, max-age=604800').send(Buffer.from(b64, 'base64'));
app.get('/icon-192.png', png(icons.i192));
app.get('/icon-512.png', png(icons.i512));
app.get('/apple-touch-icon.png', png(icons.i180));

// Feier erstellen
app.post('/api/events', createLimiter, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Bitte gib einen Namen ein' });
    const id = newId(), token = newToken();
    await pool.query('INSERT INTO events(id, name, admin_token) VALUES($1,$2,$3)', [id, name, token]);
    res.json({ id, name, adminToken: token });
  } catch (e) { next(e); }
});

// Feier lesen
app.get('/api/events/:id', async (req, res, next) => {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Feier nicht gefunden' });
    res.json({ id: ev.id, name: ev.name });
  } catch (e) { next(e); }
});

// Admin-Token prüfen
app.post('/api/events/:id/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, id: req.ev.id, name: req.ev.name, revealAt: req.ev.reveal_at });
});

// Zeitpunkt der Siegerehrung setzen (at = ISO-Zeit, "now" oder null)
app.post('/api/events/:id/reveal', requireAdmin, async (req, res, next) => {
  try {
    const at = req.body.at;
    let val = null;
    if (at === 'now') val = new Date();
    else if (at) {
      val = new Date(at);
      if (isNaN(val.getTime())) return res.status(400).json({ error: 'Ungültiges Datum' });
    }
    await pool.query('UPDATE events SET reveal_at = $1 WHERE id = $2', [val, req.ev.id]);
    res.json({ ok: true, revealAt: val });
  } catch (e) { next(e); }
});

// QR-Code (PNG) für den Gast-Link
app.get('/api/events/:id/qr.png', async (req, res, next) => {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).end();
    const buf = await QRCode.toBuffer(`${baseUrl(req)}/e/${ev.id}`, {
      width: 900, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#16181d', light: '#ffffff' },
    });
    res.type('png').set('Cache-Control', 'public, max-age=86400').send(buf);
  } catch (e) { next(e); }
});

// Fotos der Feier (mit Herzen)
app.get('/api/events/:id/photos', async (req, res, next) => {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Feier nicht gefunden' });
    const voter = cleanVoter(req.query.voter);
    const { rows } = await pool.query(
      `SELECT p.id, p.url, p.task, p.author, p.created_at,
              (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id)::int AS likes,
              EXISTS (SELECT 1 FROM likes l WHERE l.photo_id = p.id AND l.voter = $2) AS liked
         FROM photos p WHERE p.event_id = $1 ORDER BY p.id DESC LIMIT 500`,
      [ev.id, voter]
    );
    res.set('Cache-Control', 'no-store').json({
      photos: rows.map(shape),
      revealOpen: isOpen(ev),
      revealAt: ev.reveal_at,
    });
  } catch (e) { next(e); }
});

// Foto hochladen
app.post('/api/events/:id/photos', uploadLimiter, upload.single('photo'), async (req, res, next) => {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Feier nicht gefunden' });
    if (!req.file) return res.status(400).json({ error: 'Kein Foto empfangen' });
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder: `feier/${ev.id}`, resource_type: 'image' }, (err, r) => (err ? reject(err) : resolve(r)))
        .end(req.file.buffer);
    });
    const task = String(req.body.task || '').slice(0, 300) || null;
    const author = String(req.body.author || '').trim().slice(0, 30) || null;
    const { rows } = await pool.query(
      'INSERT INTO photos(event_id, url, public_id, task, author) VALUES($1,$2,$3,$4,$5) RETURNING id, url, task, author, created_at',
      [ev.id, result.secure_url, result.public_id, task, author]
    );
    res.json(shape(rows[0]));
  } catch (e) { next(e); }
});

// Herz geben oder zurücknehmen
app.post('/api/events/:id/photos/:photoId/like', likeLimiter, async (req, res, next) => {
  try {
    const voter = cleanVoter(req.body.voter);
    const pid = parseInt(req.params.photoId, 10);
    if (!voter || !Number.isInteger(pid)) return res.status(400).json({ error: 'Ungültige Anfrage' });
    const ph = await pool.query('SELECT 1 FROM photos WHERE id = $1 AND event_id = $2', [pid, req.params.id]);
    if (!ph.rowCount) return res.status(404).json({ error: 'Foto nicht gefunden' });
    const want = req.body.like !== false;
    if (want) await pool.query('INSERT INTO likes(photo_id, voter) VALUES($1,$2) ON CONFLICT DO NOTHING', [pid, voter]);
    else await pool.query('DELETE FROM likes WHERE photo_id = $1 AND voter = $2', [pid, voter]);
    const c = await pool.query('SELECT COUNT(*)::int AS n FROM likes WHERE photo_id = $1', [pid]);
    res.json({ liked: want, likes: c.rows[0].n });
  } catch (e) { next(e); }
});

// Siegerehrung: Top 3 (erst nach der eingestellten Zeit)
app.get('/api/events/:id/leaderboard', async (req, res, next) => {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Feier nicht gefunden' });
    if (!isOpen(ev)) return res.json({ open: false });
    const { rows } = await pool.query(
      `SELECT p.id, p.url, p.task, p.author, p.created_at, COUNT(l.voter)::int AS likes
         FROM photos p JOIN likes l ON l.photo_id = p.id
        WHERE p.event_id = $1
        GROUP BY p.id
        ORDER BY likes DESC, p.id ASC
        LIMIT 3`,
      [ev.id]
    );
    res.json({ open: true, winners: rows.map(shape) });
  } catch (e) { next(e); }
});

// Foto löschen (nur Admin)
app.delete('/api/events/:id/photos/:photoId', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM photos WHERE id = $1 AND event_id = $2 RETURNING public_id',
      [req.params.photoId, req.ev.id]
    );
    if (rows[0]) await cloudinary.uploader.destroy(rows[0].public_id).catch(() => {});
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Manifest je Feier (für "Zum Home-Bildschirm hinzufügen")
app.get('/e/:id/manifest.webmanifest', async (req, res, next) => {
  try {
    const ev = await getEvent(req.params.id);
    if (!ev) return res.status(404).end();
    res.type('application/manifest+json').json({
      name: ev.name,
      short_name: ev.name.slice(0, 14),
      start_url: `/e/${ev.id}`,
      scope: '/',
      display: 'standalone',
      background_color: '#f6f6f3',
      theme_color: '#1f3d36',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch (e) { next(e); }
});

// Seiten
const guestHtml = fs.readFileSync(path.join(__dirname, 'public', 'guest.html'), 'utf8');
app.get('/e/:id', (req, res) => {
  const id = req.params.id.replace(/[^\w-]/g, '');
  res.type('html').send(guestHtml.replace(/__ID__/g, id));
});

app.use(express.static(path.join(__dirname, 'public')));
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/e/:id/foto', page('foto.html'));
app.get('/e/:id/leinwand', page('leinwand.html'));
app.get('/admin/:id', page('admin.html'));

app.use((err, req, res, next) => {
  console.error(err);
  const known = err.code === 'LIMIT_FILE_SIZE' || err.message === 'Nur Bilder sind erlaubt';
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Das Foto ist zu groß' : known ? err.message : 'Etwas ist schiefgelaufen';
  res.status(known ? 400 : 500).json({ error: msg });
});

const port = process.env.PORT || 3000;
init()
  .then(() => app.listen(port, () => console.log(`Läuft auf Port ${port}`)))
  .catch((e) => { console.error('Start fehlgeschlagen:', e); process.exit(1); });
