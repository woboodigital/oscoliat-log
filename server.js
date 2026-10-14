const fs = require('fs'), path = require('path'), crypto = require('crypto');
if (fs.existsSync('.env')) fs.readFileSync('.env', 'utf8').split('\n').forEach(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
});
const express = require('express');
const db = require('./db');
const { ADMIN_PASSWORD, SESSION_SECRET = 'dev-secret', PORT = 3000 } = process.env;
if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD tanımlı değil (.env)'); process.exit(1); }

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);
const SECURE = process.env.NODE_ENV === 'production' ? '; Secure' : '';
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Basit imzalı çerez oturumu ---
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isAdmin = req => {
  const m = (req.headers.cookie || '').match(/(?:^|; )sess=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return Number(exp) > Date.now() && !!sig && safeEq(sig, sign(exp));
};
const need = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'Giriş gerekli' });
let fails = {};
app.post('/api/login', (req, res) => {
  const ip = req.ip, f = fails[ip] || { n: 0, t: Date.now() };
  if (f.n >= 5 && Date.now() - f.t < 600000) return res.status(429).json({ error: 'Çok fazla deneme, 10 dk bekle' });
  const pw = String(req.body.password || '');
  if (!safeEq(sign(pw), sign(ADMIN_PASSWORD))) { fails[ip] = { n: f.n + 1, t: Date.now() }; return res.status(401).json({ error: 'Şifre yanlış' }); }
  delete fails[ip];
  const exp = String(Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `sess=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (_, res) => { res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ admin: isAdmin(req) }));

// --- Steam arama (yerel liste) ---
app.get('/api/search', need, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const local = db.catalog.prepare(`SELECT appid, name FROM apps WHERE name LIKE ? COLLATE NOCASE
    ORDER BY (name LIKE ? COLLATE NOCASE) DESC, length(name) LIMIT 15`).all(like, q + '%');
  if (local.length) return res.json(local);
  // Yerel liste boşsa Steam'in herkese açık aramalarını canlı dene (anahtar gerektirmez)
  const H = { 'User-Agent': 'Mozilla/5.0 (compatible; OscoliatLog/1.0)', Accept: 'application/json' };
  const tries = [
    async () => (await (await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`, { headers: H })).json())
      .items.filter(i => i.type === 'app').map(i => ({ appid: i.id, name: i.name })),
    async () => (await (await fetch(`https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(q)}`, { headers: H })).json())
      .map(i => ({ appid: +i.appid, name: i.name }))
  ];
  for (const t of tries) {
    try { const a = await t(); if (a.length) return res.json(a.slice(0, 15)); }
    catch (e) { console.warn('Steam arama hatası:', e.message); }
  }
  console.warn('Steam araması sonuç vermedi:', q);
  res.json([]);
});

async function ensureGame(appid, fallbackName) {
  if (db.prepare('SELECT 1 FROM games WHERE appid=?').get(appid)) return;
  let g = { name: fallbackName, image: null, genres: [], developer: null, release: null };
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`);
    const d = (await r.json())[appid];
    if (d && d.success) {
      const x = d.data;
      g = { name: x.name, image: x.header_image, genres: (x.genres || []).map(e => e.description),
        developer: (x.developers || [])[0] || null, release: x.release_date && x.release_date.date };
    }
  } catch (e) { console.warn('appdetails alınamadı', appid, e.message); }
  db.prepare('INSERT OR IGNORE INTO games(appid,name,image,genres,developer,release) VALUES(?,?,?,?,?,?)')
    .run(appid, g.name, g.image, JSON.stringify(g.genres), g.developer, g.release);
}

// --- Kayıtlar ---
const rows = () => db.prepare(`SELECT p.id, p.appid, p.score, p.note, p.played_at, p.status, p.tags,
  (SELECT ROUND(AVG(score),1) FROM votes WHERE play_id=p.id) AS v_avg,
  (SELECT COUNT(*) FROM votes WHERE play_id=p.id) AS v_n, g.name, g.image,
  g.genres, g.developer, g.release FROM plays p JOIN games g USING(appid)
  ORDER BY p.played_at DESC, p.id DESC`).all().map(r => ({ ...r, genres: JSON.parse(r.genres), tags: JSON.parse(r.tags || '[]') }));
const STATUSES = ['bitirdi', 'yarida', 'tekrar'];
app.get('/api/plays', (_, res) => res.json(rows()));
const play1 = id => rows().find(x => x.id === id);

// --- OBS overlay durumu (bellekte tutulur, sunucu yeniden başlarsa sıfırlanır) ---
let ov = { nonce: 0, id: null, at: 0 };
const showOverlay = id => { ov = { nonce: ov.nonce + 1, id, at: Date.now() }; };
app.get('/api/overlay', (_, res) => {
  const p = ov.id && play1(ov.id);
  res.set('Cache-Control', 'no-store').json({ nonce: ov.nonce, elapsed: Date.now() - ov.at,
    play: p ? { name: p.name, image: p.image, score: p.score, v_avg: p.v_avg, v_n: p.v_n } : null });
});
app.post('/api/overlay/show', need, (req, res) => {
  const id = parseInt(req.body.play_id, 10);
  if (!play1(id)) return res.status(404).json({ error: 'Kayıt yok' });
  showOverlay(id); res.json({ ok: true });
});

// --- İzleyici oyu: çerez başına 1 oy, aynı ağdan (IP) en fazla 3 oy ---
const hits = {};
app.post('/api/plays/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT 1 FROM plays WHERE id=?').get(id)) return res.status(404).json({ error: 'Kayıt yok' });
  const score = Math.round(Number(req.body.score) * 2) / 2;
  if (!(score >= 0 && score <= 10)) return res.status(400).json({ error: 'Puan 0-10 arası olmalı' });
  const now = Date.now(); hits[req.ip] = (hits[req.ip] || []).filter(t => now - t < 60000);
  if (hits[req.ip].length >= 20) return res.status(429).json({ error: 'Çok hızlı, biraz bekle' });
  hits[req.ip].push(now);
  let vid = ((req.headers.cookie || '').match(/(?:^|; )vid=([a-f0-9]{32})/) || [])[1];
  if (!vid) {
    vid = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `vid=${vid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${SECURE}`);
  }
  const voter = sign('v' + vid), ip = sign('i' + req.ip);
  if (db.prepare('SELECT 1 FROM votes WHERE play_id=? AND voter=?').get(id, voter)) return res.status(409).json({ error: 'Bu oyuna zaten oy verdin' });
  if (db.prepare('SELECT COUNT(*) n FROM votes WHERE play_id=? AND ip=?').get(id, ip).n >= 3) return res.status(429).json({ error: 'Bu ağdan çok fazla oy verildi' });
  db.prepare('INSERT INTO votes(play_id,score,voter,ip) VALUES(?,?,?,?)').run(id, score, voter, ip);
  res.json({ ok: true });
});

// --- CSV dışa aktarma (sadece yayıncı) ---
app.get('/api/export.csv', need, (_, res) => {
  const q = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['tarih', 'oyun', 'puan', 'durum', 'etiketler', 'turler', 'gelistirici', 'cikis', 'not', 'izleyici_ort', 'izleyici_oy'];
  const lines = [head.join(',')].concat(rows().map(p => [p.played_at, p.name, p.score, p.status, p.tags.join('; '),
    p.genres.join('; '), p.developer, p.release, p.note, p.v_avg, p.v_n].map(q).join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="oscoliat-oyunlar.csv"' });
  res.send('\ufeff' + lines.join('\r\n'));
});

function parsePlay(b) {
  const score = Math.round(Number(b.score) * 2) / 2;
  if (!(score >= 0 && score <= 10)) throw new Error('Puan 0-10 arası olmalı');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.played_at) ? b.played_at : new Date().toISOString().slice(0, 10);
  const status = STATUSES.includes(b.status) ? b.status : 'bitirdi';
  const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(t => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 10);
  return { score, note: String(b.note || '').slice(0, 2000), day, status, tags: JSON.stringify(tags) };
}
app.post('/api/plays', need, async (req, res) => {
  try {
    const appid = parseInt(req.body.appid, 10), p = parsePlay(req.body);
    if (!appid) throw new Error('Oyun seçilmedi');
    const a = db.catalog.prepare('SELECT name FROM apps WHERE appid=?').get(appid);
    await ensureGame(appid, (a && a.name) || String(req.body.name || 'Bilinmeyen oyun').slice(0, 200));
    const r = db.prepare('INSERT INTO plays(appid,score,note,played_at,status,tags) VALUES(?,?,?,?,?,?)').run(appid, p.score, p.note, p.day, p.status, p.tags);
    showOverlay(r.lastInsertRowid);
    res.json(play1(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/plays/:id', need, (req, res) => {
  try {
    const p = parsePlay(req.body);
    const nm = String(req.body.name || '').trim().slice(0, 200);
    if (nm) db.prepare('UPDATE games SET name=? WHERE appid=(SELECT appid FROM plays WHERE id=?)').run(nm, req.params.id);
    db.prepare('UPDATE plays SET score=?, note=?, played_at=?, status=?, tags=? WHERE id=?').run(p.score, p.note, p.day, p.status, p.tags, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/plays/:id', need, (req, res) => {
  db.prepare('DELETE FROM votes WHERE play_id=?').run(req.params.id);
  db.prepare('DELETE FROM plays WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// --- Listeler ---
const getLists = () => db.prepare('SELECT id, name FROM lists ORDER BY id').all().map(l => ({ ...l,
  items: db.prepare(`SELECT g.appid, g.name, g.image,
    (SELECT ROUND(AVG(score),1) FROM plays WHERE appid=g.appid) AS score
    FROM list_items i JOIN games g USING(appid) WHERE i.list_id=?`).all(l.id) }));
app.get('/api/lists', (_, res) => res.json(getLists()));
app.post('/api/lists', need, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Liste adı boş olamaz' });
  db.prepare('INSERT INTO lists(name) VALUES(?)').run(name); res.json({ ok: true });
});
app.delete('/api/lists/:id', need, (req, res) => {
  db.prepare('DELETE FROM list_items WHERE list_id=?').run(req.params.id);
  db.prepare('DELETE FROM lists WHERE id=?').run(req.params.id); res.json({ ok: true });
});
app.post('/api/lists/:id/items', need, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO list_items(list_id,appid) VALUES(?,?)').run(req.params.id, parseInt(req.body.appid, 10)); res.json({ ok: true });
});
app.delete('/api/lists/:id/items/:appid', need, (req, res) => {
  db.prepare('DELETE FROM list_items WHERE list_id=? AND appid=?').run(req.params.id, req.params.appid); res.json({ ok: true });
});

// --- İstatistik ---
app.get('/api/stats', (_, res) => {
  const all = rows(), n = all.length;
  const avg = a => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null;
  const sorted = [...all].sort((a, b) => b.score - a.score);
  const gen = {}, mon = {}, dist = Array(11).fill(0), st = {}, tg = {};
  all.forEach(p => {
    p.genres.forEach(g => (gen[g] = gen[g] || []).push(p.score));
    const m = p.played_at.slice(0, 7); mon[m] = (mon[m] || 0) + 1;
    dist[Math.round(p.score)]++; st[p.status] = (st[p.status] || 0) + 1;
    p.tags.forEach(t => tg[t] = (tg[t] || 0) + 1);
  });
  res.json({
    total: n, average: avg(all.map(p => p.score)),
    best: sorted.slice(0, 5), worst: sorted.slice(-5).reverse(),
    genres: Object.entries(gen).map(([name, s]) => ({ name, count: s.length, avg: avg(s) })).sort((a, b) => b.count - a.count),
    months: Object.entries(mon).sort().map(([month, count]) => ({ month, count })), distribution: dist, statuses: st,
    tags: Object.entries(tg).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  });
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));

// Steam listesi boşsa açılışta çek, sonra günde bir güncelle
{
  const { syncSteam } = require('./steam');
  const run = () => syncSteam().catch(e => console.error('Steam senkronu başarısız:', e.message));
  if (db.catalog.prepare('SELECT COUNT(*) n FROM apps').get().n === 0) run();
  setInterval(run, 24 * 3600 * 1000);
}
