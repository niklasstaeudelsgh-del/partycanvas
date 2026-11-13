const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2; // liest CLOUDINARY_URL automatisch
const rateLimit = require('express-rate-limit');

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
    CREATE INDEX IF NOT EXISTS photos_event_idx ON photos(event_id, id DESC);
  `);
}

const newId = () => crypto.randomBytes(6).toString('base64url').slice(0, 8);
const newToken = () => crypto.randomBytes(18).toString('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const thumb = (url) => url.replace('/upload/', '/upload/c_limit,w_1000,q_auto,f_auto/');
const shape = (p) => ({ id: p.id, url: thumb(p.url), full: p.url, task: p.task, created_at: p.created_at });

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Nur Bilder sind erlaubt')),
});

app.get('/health', (req, res) => res.send('ok'));

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
  res.json({ ok: true, id: req.ev.id, name: req.ev.name });
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

// Fotos der Feier
app.get('/api/events/:id/photos', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, url, task, created_at FROM photos WHERE event_id = $1 ORDER BY id DESC LIMIT 500',
      [req.params.id]
    );
    res.set('Cache-Control', 'no-store').json(rows.map(shape));
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
    const { rows } = await pool.query(
      'INSERT INTO photos(event_id, url, public_id, task) VALUES($1,$2,$3,$4) RETURNING id, url, task, created_at',
      [ev.id, result.secure_url, result.public_id, task]
    );
    res.json(shape(rows[0]));
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

// Seiten
app.use(express.static(path.join(__dirname, 'public')));
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/e/:id', page('guest.html'));
app.get('/e/:id/foto', page('foto.html'));
app.get('/e/:id/leinwand', page('leinwand.html'));
app.get('/admin/:id', page('admin.html'));

app.use((err, req, res, next) => {
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Das Foto ist zu groß' : err.message === 'Nur Bilder sind erlaubt' ? err.message : 'Etwas ist schiefgelaufen';
  res.status(err.code === 'LIMIT_FILE_SIZE' || err.message === 'Nur Bilder sind erlaubt' ? 400 : 500).json({ error: msg });
});

const port = process.env.PORT || 3000;
init()
  .then(() => app.listen(port, () => console.log(`Läuft auf Port ${port}`)))
  .catch((e) => { console.error('Start fehlgeschlagen:', e); process.exit(1); });
