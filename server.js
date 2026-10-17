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
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});
try { app.use(require('compression')()); } catch (e) { console.warn('compression yüklenemedi, sıkıştırma kapalı'); }
const json50 = express.json({ limit: '50kb' }), json8m = express.json({ limit: '8mb' });
app.use((req, res, next) => (req.path === '/api/restore' ? json8m : json50)(req, res, next));
app.get('/healthz', (_, res) => res.type('text').send('ok'));

// --- Sayfalar: __ANAHTAR__ yer tutucularını doldurur (paylaşım önizlemesi, hukuki bilgiler) ---
const eh = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Sayfa dosyası önce public/ içinde, bulunamazsa ana klasörde aranır (yanlış klasöre yüklenmiş olsa da çalışsın)
const findFile = name => [path.join(__dirname, 'public', name), path.join(__dirname, name)].find(p => fs.existsSync(p));
function sendPage(req, res, file, vars = {}, status = 200) {
  const f = findFile(file);
  if (!f) { console.error('Sayfa dosyası bulunamadı:', file); return res.status(500).type('text').send(`Sayfa dosyası bulunamadı: ${file}. Dosya GitHub deposunda "public" klasörüne yüklenmeli.`); }
  fs.readFile(f, 'utf8', (e, t) => {
    if (e) return res.status(500).type('text').send('Sayfa okunamadı');
    const host = String(req.get('host') || '').replace(/[^a-zA-Z0-9.:-]/g, '');
    const origin = `${req.protocol}://${host}`, all = { ORIGIN: origin, IMG: origin + '/logo.webp', ...vars };
    res.status(status).set('Cache-Control', 'no-cache').type('html').send(t.replace(/__([A-Z_]+)__/g, (m, k) => (k in all ? eh(all[k]) : m)));
  });
}
app.get('/site.css', (req, res) => { const f = findFile('site.css'); return f ? res.type('css').sendFile(f) : res.status(404).end(); });
const LEGAL = () => ({
  LEGAL_NAME: process.env.LEGAL_NAME || '[Ad Soyad / Ünvan]',
  LEGAL_EMAIL: process.env.LEGAL_EMAIL || '[iletişim e-posta adresi]',
  LEGAL_ADDRESS: process.env.LEGAL_ADDRESS || '[adres]',
  LEGAL_DATE: '15 Ekim 2026'
});
app.get(['/', '/index.html'], (req, res) => sendPage(req, res, 'index.html'));
app.get(['/gizlilik', '/gizlilik.html'], (req, res) => sendPage(req, res, 'gizlilik.html', LEGAL()));
app.get(['/cerez', '/cerez.html'], (req, res) => sendPage(req, res, 'cerez.html', LEGAL()));
app.get(['/oyun/:appid', '/oyun.html'], (req, res) => {
  const appid = parseInt(req.params.appid, 10);
  const g = appid && db.prepare('SELECT name, image FROM games WHERE appid=?').get(appid);
  const st = g && db.prepare('SELECT ROUND(AVG(score),1) AS a, COUNT(*) AS n FROM plays WHERE appid=?').get(appid);
  if (!g || !st.n) return sendPage(req, res, 'oyun.html', { TITLE: 'Oyun bulunamadı · OscoMatik', DESC: 'Bu oyun puan defterinde yok.', APPID: '0' }, 404);
  const v = { TITLE: `${g.name} · OscoMatik`, DESC: `Oscoliat'ın puanı: ${st.a} / 10 (${st.n} oynanış)`, APPID: String(appid) };
  if (g.image) v.IMG = g.image;
  sendPage(req, res, 'oyun.html', v);
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (r, f) => { if (f.endsWith('.webp')) r.setHeader('Cache-Control', 'public, max-age=604800'); }
}));

// --- Oturum: imzalı çerez. Yayıncı (owner) ADMIN_PASSWORD ile, ekip üyeleri (editor) kendi hesabıyla girer ---
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const safeEq = (x, y) => x.length === y.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y));
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
const checkPw = (pw, stored) => { const [salt, h] = String(stored).split(':'); return !!h && safeEq(crypto.scryptSync(pw, salt, 32).toString('hex'), h); };
const who = req => {
  const m = (req.headers.cookie || '').match(/(?:^|; )sess=([^;]+)/);
  if (!m) return null;
  const [exp, user, sig] = m[1].split('.');
  if (!(Number(exp) > Date.now()) || !user || !sig || !safeEq(sig, sign(exp + '.' + user))) return null;
  if (user === 'owner') return { user: 'owner', role: 'owner' };
  const a = db.prepare('SELECT username FROM admins WHERE username=?').get(user);
  return a ? { user: a.username, role: 'editor' } : null;
};
const need = (req, res, next) => (who(req) ? next() : res.status(401).json({ error: 'Giriş gerekli' }));
const needOwner = (req, res, next) => {
  const w = who(req);
  return !w ? res.status(401).json({ error: 'Giriş gerekli' }) : w.role === 'owner' ? next() : res.status(403).json({ error: 'Bu işlem sadece yayıncıya açık' });
};
let fails = {};
app.post('/api/login', (req, res) => {
  const ip = req.ip, f = fails[ip] || { n: 0, t: Date.now() };
  if (f.n >= 5 && Date.now() - f.t < 600000) return res.status(429).json({ error: 'Çok fazla deneme, 10 dk bekle' });
  const pw = String(req.body.password || ''), un = String(req.body.username || '').trim().toLowerCase();
  let user = null;
  if (!un) { if (safeEq(sign(pw), sign(ADMIN_PASSWORD))) user = 'owner'; }
  else {
    const a = db.prepare('SELECT username, pass FROM admins WHERE username=?').get(un);
    if (a && checkPw(pw, a.pass)) user = a.username; else checkPw(pw, hashPw('x'));
  }
  if (!user) { fails[ip] = { n: f.n + 1, t: Date.now() }; return res.status(401).json({ error: un ? 'Kullanıcı adı veya şifre yanlış' : 'Şifre yanlış' }); }
  delete fails[ip];
  const exp = String(Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `sess=${exp}.${user}.${sign(exp + '.' + user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SECURE}`);
  res.json({ ok: true });
});
app.post('/api/logout', (_, res) => { res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const w = who(req); res.json({ admin: !!w, role: w ? w.role : null, user: w ? w.user : null }); });

// --- Ekip hesapları (sadece yayıncı) ---
app.get('/api/admins', needOwner, (_, res) => res.json(db.prepare('SELECT id, username, created_at FROM admins ORDER BY id').all()));
app.post('/api/admins', needOwner, (req, res) => {
  const un = String(req.body.username || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^[a-z0-9_-]{3,30}$/.test(un) || un === 'owner') return res.status(400).json({ error: 'Kullanıcı adı 3-30 karakter olmalı: harf, rakam, _ ve -' });
  if (pw.length < 10) return res.status(400).json({ error: 'Şifre en az 10 karakter olmalı' });
  try { db.prepare('INSERT INTO admins(username, pass) VALUES(?,?)').run(un, hashPw(pw)); res.json({ ok: true }); }
  catch (e) { res.status(409).json({ error: 'Bu kullanıcı adı zaten var' }); }
});
app.delete('/api/admins/:id', needOwner, (req, res) => { db.prepare('DELETE FROM admins WHERE id=?').run(req.params.id); res.json({ ok: true }); });

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

// --- Steam'den zengin oyun bilgisi (oyun sayfası için) ---
const plainText = t => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const STEAM_IMG = u => /^https:\/\/[a-z0-9.-]+\.steamstatic\.com\//.test(String(u));
const REV_TR = { 'Overwhelmingly Positive': 'Aşırı olumlu', 'Very Positive': 'Çok olumlu', 'Positive': 'Olumlu', 'Mostly Positive': 'Çoğunlukla olumlu', 'Mixed': 'Karışık',
  'Mostly Negative': 'Çoğunlukla olumsuz', 'Negative': 'Olumsuz', 'Very Negative': 'Çok olumsuz', 'Overwhelmingly Negative': 'Aşırı olumsuz' };
const KEEP_CATS = new Set([2, 1, 49, 36, 9, 38, 39, 24, 27, 28, 22]);
function parseSteamInfo(x, summary) {
  const info = { at: Date.now() };
  if (x) {
    info.about = plainText(x.short_description).slice(0, 700);
    info.publishers = (x.publishers || []).map(plainText).filter(Boolean).slice(0, 3);
    info.platforms = ['windows', 'mac', 'linux'].filter(k => x.platforms && x.platforms[k]);
    info.metacritic = x.metacritic && Number(x.metacritic.score) ? Number(x.metacritic.score) : null;
    info.free = !!x.is_free;
    info.price = x.price_overview ? plainText(x.price_overview.final_formatted) : '';
    info.tr = /turkish|türkçe/i.test(String(x.supported_languages || ''));
    info.cats = (x.categories || []).filter(c => KEEP_CATS.has(Number(c.id))).map(c => plainText(c.description)).slice(0, 8);
    info.shots = (x.screenshots || []).map(s => ({ t: s.path_thumbnail, f: s.path_full })).filter(s => STEAM_IMG(s.t) && STEAM_IMG(s.f)).slice(0, 6);
  }
  if (summary && summary.total_reviews > 0)
    info.rev = { pct: Math.round(summary.total_positive / summary.total_reviews * 100), n: summary.total_reviews, d: REV_TR[summary.review_score_desc] || plainText(summary.review_score_desc) };
  return info;
}
const infoJobs = {};
function steamInfo(appid) {
  if (infoJobs[appid]) return infoJobs[appid];
  infoJobs[appid] = (async () => {
    let x = null, summary = null;
    try { const d = (await (await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=turkish`)).json())[appid]; if (d && d.success) x = d.data; }
    catch (e) { console.warn('Steam ayrıntısı alınamadı', appid, e.message); }
    try { summary = (await (await fetch(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`)).json()).query_summary; }
    catch (e) { /* yorum özeti isteğe bağlı */ }
    const info = parseSteamInfo(x, summary);
    if (x || summary) db.prepare('UPDATE games SET info=? WHERE appid=?').run(JSON.stringify(info), appid);
    return info;
  })().finally(() => { setTimeout(() => delete infoJobs[appid], 60000); });
  return infoJobs[appid];
}

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
  steamInfo(appid).catch(() => {});
}

// --- Kayıtlar ---
const rows = () => db.prepare(`SELECT p.id, p.appid, p.score, p.note, p.played_at, p.status, p.tags,
  (SELECT ROUND(AVG(score),1) FROM votes WHERE play_id=p.id) AS v_avg,
  (SELECT COUNT(*) FROM votes WHERE play_id=p.id) AS v_n, g.name, g.image,
  p.video_url, g.genres, g.developer, g.release FROM plays p JOIN games g USING(appid)
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
app.get('/api/export.csv', needOwner, (_, res) => {
  const q = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['tarih', 'oyun', 'puan', 'durum', 'etiketler', 'turler', 'gelistirici', 'cikis', 'not', 'izleyici_ort', 'izleyici_oy', 'video'];
  const lines = [head.join(',')].concat(rows().map(p => [p.played_at, p.name, p.score, p.status, p.tags.join('; '),
    p.genres.join('; '), p.developer, p.release, p.note, p.v_avg, p.v_n, p.video_url].map(q).join(',')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="oscomatik-oyunlar.csv"' });
  res.send('\ufeff' + lines.join('\r\n'));
});

function cleanVideo(u) {
  u = String(u || '').trim();
  if (!u) return '';
  try {
    const x = new URL(u), h = x.hostname.replace(/^www\./, '');
    if (x.protocol === 'https:' && ['youtube.com', 'm.youtube.com', 'youtu.be', 'kick.com'].includes(h)) return x.href.slice(0, 300);
  } catch (e) { /* aşağıda hata verilir */ }
  throw new Error('Video bağlantısı YouTube veya Kick adresi olmalı (https://...)');
}
function parsePlay(b) {
  const score = Math.round(Number(b.score) * 2) / 2;
  if (!(score >= 0 && score <= 10)) throw new Error('Puan 0-10 arası olmalı');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.played_at) ? b.played_at : new Date().toISOString().slice(0, 10);
  const status = STATUSES.includes(b.status) ? b.status : 'bitirdi';
  const tags = [...new Set((Array.isArray(b.tags) ? b.tags : []).map(t => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 10);
  return { score, note: String(b.note || '').slice(0, 2000), day, status, tags: JSON.stringify(tags), video: cleanVideo(b.video_url) };
}
app.post('/api/plays', need, async (req, res) => {
  try {
    const appid = parseInt(req.body.appid, 10), p = parsePlay(req.body);
    if (!appid) throw new Error('Oyun seçilmedi');
    const a = db.catalog.prepare('SELECT name FROM apps WHERE appid=?').get(appid);
    await ensureGame(appid, (a && a.name) || String(req.body.name || 'Bilinmeyen oyun').slice(0, 200));
    const r = db.prepare('INSERT INTO plays(appid,score,note,played_at,status,tags,video_url) VALUES(?,?,?,?,?,?,?)').run(appid, p.score, p.note, p.day, p.status, p.tags, p.video);
    showOverlay(r.lastInsertRowid);
    res.json(play1(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/plays/:id', need, (req, res) => {
  try {
    const p = parsePlay(req.body);
    const nm = String(req.body.name || '').trim().slice(0, 200);
    if (nm) db.prepare('UPDATE games SET name=? WHERE appid=(SELECT appid FROM plays WHERE id=?)').run(nm, req.params.id);
    db.prepare('UPDATE plays SET score=?, note=?, played_at=?, status=?, tags=?, video_url=? WHERE id=?').run(p.score, p.note, p.day, p.status, p.tags, p.video, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/plays/:id', needOwner, (req, res) => {
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
app.delete('/api/lists/:id', needOwner, (req, res) => {
  db.prepare('DELETE FROM list_items WHERE list_id=?').run(req.params.id);
  db.prepare('DELETE FROM lists WHERE id=?').run(req.params.id); res.json({ ok: true });
});
app.post('/api/lists/:id/items', need, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO list_items(list_id,appid) VALUES(?,?)').run(req.params.id, parseInt(req.body.appid, 10)); res.json({ ok: true });
});
app.delete('/api/lists/:id/items/:appid', need, (req, res) => {
  db.prepare('DELETE FROM list_items WHERE list_id=? AND appid=?').run(req.params.id, req.params.appid); res.json({ ok: true });
});

// --- Site: YouTube videoları ve Kick yayın durumu ---
const YT_ID = process.env.YOUTUBE_CHANNEL_ID || 'UCiqYGJyn_xZE4VxdwT_ULNQ';
const KICK_SLUG = process.env.KICK_SLUG || 'oscoliat';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; OscoliatLog/1.0)' };
const unxml = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
let vcache = { at: 0, items: [] };
app.get('/api/videos', async (_, res) => {
  if (Date.now() - vcache.at > 15 * 60000) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_ID}`, { headers: UA });
      if (!r.ok) throw new Error('YouTube ' + r.status);
      const xml = await r.text();
      const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
        const e = m[1], g = re => (e.match(re) || [])[1] || '';
        const id = g(/<yt:videoId>([^<]+)</), href = g(/<link rel="alternate" href="([^"]+)"/);
        return { id, title: unxml(g(/<title>([^<]*)</)), published: g(/<published>([^<]+)</),
          url: href.startsWith('https://www.youtube.com/') ? href : `https://www.youtube.com/watch?v=${id}` };
      }).filter(v => /^[\w-]{6,20}$/.test(v.id)).slice(0, 12);
      vcache = { at: Date.now(), items };
    } catch (e) { console.warn('YouTube akışı alınamadı:', e.message); vcache.at = Date.now() - 12 * 60000; }
  }
  res.json(vcache.items);
});

let liveCache = { at: 0, live: false, title: '', warned: false }, liveMode = 'auto', kickTok = { v: '', exp: 0 };
async function kickLive() {
  const id = process.env.KICK_CLIENT_ID, sec = process.env.KICK_CLIENT_SECRET;
  if (id && sec) { // Resmî Kick API (uygulama anahtarı gerekir)
    if (Date.now() > kickTok.exp) {
      const r = await fetch('https://id.kick.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: sec }) });
      if (!r.ok) throw new Error('Kick token ' + r.status);
      const t = await r.json(); kickTok = { v: t.access_token, exp: Date.now() + (t.expires_in - 300) * 1000 };
    }
    const r = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(KICK_SLUG)}`, { headers: { Authorization: 'Bearer ' + kickTok.v } });
    if (!r.ok) throw new Error('Kick kanal ' + r.status);
    const c = ((await r.json()).data || [])[0] || {};
    return { live: !!(c.stream && c.stream.is_live), title: c.stream_title || '' };
  }
  // Anahtarsız deneme: Kick engelleyebilir, o zaman elle rozet anahtarı kullanılır
  const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(KICK_SLUG)}`, { headers: UA });
  if (!r.ok) throw new Error('Kick ' + r.status);
  const j = await r.json();
  return { live: !!j.livestream, title: (j.livestream && j.livestream.session_title) || '' };
}
app.get('/api/live', async (_, res) => {
  if (Date.now() - liveCache.at > 60000) {
    liveCache.at = Date.now();
    try { Object.assign(liveCache, await kickLive()); }
    catch (e) { if (!liveCache.warned) { console.warn('Kick durumu alınamadı:', e.message); liveCache.warned = true; } liveCache.live = false; }
  }
  const live = liveMode === 'on' ? true : liveMode === 'off' ? false : liveCache.live;
  res.json({ live, title: liveMode === 'on' ? '' : liveCache.title, mode: liveMode });
});
app.post('/api/live/override', need, (req, res) => {
  if (!['auto', 'on', 'off'].includes(req.body.mode)) return res.status(400).json({ error: 'Geçersiz mod' });
  liveMode = req.body.mode; res.json({ ok: true });
});

// --- Oyun sayfası verisi ---
app.get('/api/games/:appid', async (req, res) => {
  const appid = parseInt(req.params.appid, 10);
  const g = db.prepare('SELECT appid, name, image, genres, developer, release, info FROM games WHERE appid=?').get(appid);
  const all = rows();
  const plays = g ? all.filter(p => p.appid === appid).map(({ appid: _a, name, image, genres, developer, release, ...p }) => p) : [];
  if (!g || !plays.length) return res.status(404).json({ error: 'Oyun bulunamadı' });
  const avg = +(plays.reduce((t, p) => t + p.score, 0) / plays.length).toFixed(1);
  const lists = db.prepare('SELECT l.name FROM list_items i JOIN lists l ON l.id=i.list_id WHERE i.appid=?').all(appid).map(x => x.name);
  let info = {};
  try { info = g.info ? JSON.parse(g.info) : {}; } catch (e) { info = {}; }
  if (!info.at) info = await Promise.race([steamInfo(appid), new Promise(r => setTimeout(() => r({}), 8000))]).catch(() => ({}));
  else if (Date.now() - info.at > 7 * 864e5) steamInfo(appid).catch(() => {});
  // Aynı türden, puan defterinde bulunan diğer oyunlar
  const genres = JSON.parse(g.genres), by = {};
  all.forEach(p => { if (p.appid !== appid) (by[p.appid] = by[p.appid] || { appid: p.appid, name: p.name, image: p.image, genres: p.genres, s: [] }).s.push(p.score); });
  const similar = Object.values(by).map(o => ({ appid: o.appid, name: o.name, image: o.image, shared: o.genres.filter(x => genres.includes(x)).length, score: +(o.s.reduce((t, v) => t + v, 0) / o.s.length).toFixed(1) }))
    .filter(o => o.shared > 0).sort((x, y) => y.shared - x.shared || y.score - x.score).slice(0, 4).map(({ shared, ...o }) => o);
  res.json({ game: { appid: g.appid, name: g.name, image: g.image, developer: g.developer, release: g.release, genres }, info, plays, avg, lists, similar });
});

// --- Yedek: indir ve geri yükle (sadece yayıncı). Geri yükleme kayıtların üzerine yazar, hiçbir şeyi silmez ---
app.get('/api/backup', needOwner, (_, res) => {
  const all = t => db.prepare(`SELECT * FROM ${t}`).all();
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="oscomatik-yedek-${new Date().toISOString().slice(0, 10)}.json"` });
  res.send(JSON.stringify({ app: 'oscomatik', version: 1, exported_at: new Date().toISOString(), games: all('games'), plays: all('plays'),
    votes: all('votes'), lists: all('lists'), list_items: all('list_items') }));
});
app.post('/api/restore', needOwner, (req, res) => {
  const d = req.body;
  try {
    if (!d || d.app !== 'oscomatik' || d.version !== 1) throw new Error('Bu dosya bir OscoMatik yedeği değil');
    const arr = k => { if (!Array.isArray(d[k])) throw new Error('Yedek eksik: ' + k); return d[k]; };
    const games = arr('games'), plays = arr('plays'), votes = arr('votes'), lists = arr('lists'), items = arr('list_items');
    const int = v => { const n = Number(v); if (!Number.isInteger(n)) throw new Error('Yedekte geçersiz sayı'); return n; };
    const sc = v => { const n = Number(v); if (!(n >= 0 && n <= 10)) throw new Error('Yedekte geçersiz puan'); return n; };
    const str = (v, m = 2000) => String(v ?? '').slice(0, m);
    const js = v => typeof v === 'string' ? v : JSON.stringify(v || []);
    // önce hepsini doğrula, sonra yaz
    games.forEach(g => { int(g.appid); if (!g.name) throw new Error('Yedekte oyun adı eksik'); });
    plays.forEach(p => { int(p.id); int(p.appid); sc(p.score); });
    votes.forEach(v => { int(v.id); int(v.play_id); sc(v.score); });
    lists.forEach(l => int(l.id)); items.forEach(i => { int(i.list_id); int(i.appid); });
    const upG = db.prepare(`INSERT INTO games(appid,name,image,genres,developer,release,info) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(appid) DO UPDATE SET name=excluded.name,image=excluded.image,genres=excluded.genres,developer=excluded.developer,release=excluded.release,info=excluded.info`);
    const upP = db.prepare(`INSERT INTO plays(id,appid,score,note,played_at,status,tags,video_url,created_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET appid=excluded.appid,score=excluded.score,note=excluded.note,played_at=excluded.played_at,status=excluded.status,tags=excluded.tags,video_url=excluded.video_url`);
    const upV = db.prepare('INSERT OR IGNORE INTO votes(id,play_id,score,voter,ip,created_at) VALUES(?,?,?,?,?,?)');
    const upL = db.prepare('INSERT INTO lists(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
    const upI = db.prepare('INSERT OR IGNORE INTO list_items(list_id,appid) VALUES(?,?)');
    games.forEach(g => upG.run(int(g.appid), str(g.name, 200), g.image ? str(g.image, 500) : null, js(g.genres), g.developer ? str(g.developer, 200) : null, g.release ? str(g.release, 50) : null, typeof g.info === 'string' ? g.info.slice(0, 20000) : ''));
    plays.forEach(p => upP.run(int(p.id), int(p.appid), sc(p.score), str(p.note), str(p.played_at, 10), STATUSES.includes(p.status) ? p.status : 'bitirdi', js(p.tags), str(p.video_url, 300), str(p.created_at, 30)));
    votes.forEach(v => upV.run(int(v.id), int(v.play_id), sc(v.score), str(v.voter, 100), str(v.ip, 100), str(v.created_at, 30)));
    lists.forEach(l => upL.run(int(l.id), str(l.name, 80)));
    items.forEach(i => upI.run(int(i.list_id), int(i.appid)));
    res.json({ ok: true, games: games.length, plays: plays.length, votes: votes.length, lists: lists.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Kick: son yayınlar (VOD). Resmî olmayan Kick adresleri denenir; olmazsa kayıtlardaki Kick bağlantılarından üretilir ---
const kickHost = u => /^https:\/\/([a-z0-9-]+\.)?kick\.com\//i.test(String(u || ''));
function parseKickVods(j) {
  const arr = Array.isArray(j) ? j : (j && (j.data || j.videos || j.previous_livestreams)) || [];
  return (Array.isArray(arr) ? arr : []).map(v => {
    const ls = v.livestream || v.live_stream || v, vid = v.video || v;
    const uuid = String(vid.uuid || v.uuid || '');
    let thumb = (ls.thumbnail && (ls.thumbnail.src || ls.thumbnail)) || vid.thumb || '';
    if (typeof thumb !== 'string' || !kickHost(thumb)) thumb = '';
    const when = String(ls.start_time || ls.created_at || v.created_at || '').slice(0, 10);
    return { id: uuid, title: plainText(ls.session_title || v.session_title || '').slice(0, 200), url: `https://kick.com/${KICK_SLUG}/videos/${uuid}`,
      thumb, date: /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : '', mins: Number(ls.duration) > 0 ? Math.round(Number(ls.duration) / 60000) : 0, views: Number(ls.views || v.views) || 0, source: 'kick' };
  }).filter(x => /^[0-9a-f-]{20,}$/i.test(x.id) && x.title);
}
let kcache = { at: 0, items: [] };
async function kickVods() {
  if (Date.now() - kcache.at < 15 * 60000) return kcache.items;
  kcache.at = Date.now();
  for (const u of [`https://kick.com/api/v2/channels/${encodeURIComponent(KICK_SLUG)}/videos`, `https://kick.com/api/v2/channels/${encodeURIComponent(KICK_SLUG)}`]) {
    try {
      const r = await fetch(u, { headers: UA });
      if (!r.ok) throw new Error('Kick ' + r.status);
      const items = parseKickVods(await r.json());
      if (items.length) { kcache.items = items; return items; }
    } catch (e) { if (!kcache.warned) console.warn('Kick yayın listesi alınamadı:', e.message); }
  }
  kcache.warned = true; kcache.items = []; return [];
}
app.get('/api/streams', async (_, res) => {
  const auto = await kickVods().catch(() => []);
  const seen = new Set(auto.map(x => x.id));
  const fromRecords = rows().filter(p => kickHost(p.video_url)).map(p => ({ id: 'r' + p.id, title: p.name, url: p.video_url, thumb: p.image || '', date: p.played_at, mins: 0, views: 0, score: p.score, source: 'kayit' }))
    .filter(x => !seen.has((x.url.match(/videos\/([0-9a-f-]+)/i) || [])[1]));
  res.json([...auto, ...fromRecords].slice(0, 12));
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
