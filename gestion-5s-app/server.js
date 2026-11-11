'use strict';
/* Gestion 5S - serveur sans dépendance (Node 18 ou plus récent).
   Données partagées, comptes avec code PIN, temps réel, notifications push, rappels planifiés. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');

const COLS = new Set(['reports', 'departments', 'members', 'settings', 'photos']);
const LAZY = new Set(['photos']); // lues sur le disque à la demande, jamais listées
const ADMIN_WRITE = new Set(['departments', 'members', 'settings']);
const ADMIN_DELETE = new Set(['reports', 'departments', 'members', 'settings']);
const MAX_BODY = 700 * 1024;
const MAX_DOC = 400 * 1024;
const MAX_REPORTS = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

fs.mkdirSync(path.join(DATA, 'docs'), { recursive: true });

/* ---------- Stockage des documents ---------- */
const mem = {};
function colDir(c) { return path.join(DATA, 'docs', c); }
function writeAtomic(file, str) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);
}
for (const c of COLS) {
  fs.mkdirSync(colDir(c), { recursive: true });
  if (LAZY.has(c)) continue;
  mem[c] = new Map();
  for (const f of fs.readdirSync(colDir(c))) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(colDir(c), f), 'utf8'));
      mem[c].set(f.slice(0, -5), rec);
    } catch (e) { console.error('Fichier illisible', c, f); }
  }
}
function getDoc(c, id) {
  if (LAZY.has(c)) {
    try { return JSON.parse(fs.readFileSync(path.join(colDir(c), id + '.json'), 'utf8')); } catch (e) { return null; }
  }
  return mem[c].get(id) || null;
}
function putDoc(c, id, rec) {
  writeAtomic(path.join(colDir(c), id + '.json'), JSON.stringify(rec));
  if (!LAZY.has(c)) mem[c].set(id, rec);
}
function delDoc(c, id) {
  try { fs.unlinkSync(path.join(colDir(c), id + '.json')); } catch (e) { /* déjà absent */ }
  if (!LAZY.has(c)) mem[c].delete(id);
}
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/* ---------- Comptes, sessions, notifications ---------- */
const AUTH_FILE = path.join(DATA, 'auth.json');
let auth = { users: {}, sessions: {}, vapid: null, subs: {}, sched: {} };
try { auth = Object.assign(auth, JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))); } catch (e) { /* premier démarrage */ }
let saveTimer = null;
function saveAuth() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { writeAtomic(AUTH_FILE, JSON.stringify(auth)); } catch (e) { console.error(e); } }, 200);
}
function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 32).toString('hex'); }
function setUserPin(id, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  auth.users[id] = { salt, hash: hashPin(pin, salt) };
  saveAuth();
}
function checkPin(id, pin) {
  const u = auth.users[id];
  if (!u) return false;
  const a = Buffer.from(hashPin(String(pin), u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function memberByName(name) {
  const n = String(name || '').trim().toLowerCase();
  for (const [id, rec] of mem.members) {
    if (auth.users[id] && String(rec.data.name || '').trim().toLowerCase() === n) return { id, rec };
  }
  return null;
}
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  auth.sessions[token] = { uid, at: Date.now() };
  saveAuth();
  return token;
}
function userFromToken(token) {
  const s = token && auth.sessions[token];
  if (!s) return null;
  if (Date.now() - s.at > 90 * 86400000) { delete auth.sessions[token]; saveAuth(); return null; }
  const m = mem.members.get(s.uid);
  if (!m || !auth.users[s.uid]) return null;
  return { id: s.uid, name: String(m.data.name || ''), admin: m.data.admin === true, token };
}
function removeUser(uid) {
  delete auth.users[uid];
  for (const t of Object.keys(auth.sessions)) if (auth.sessions[t].uid === uid) delete auth.sessions[t];
  for (const k of Object.keys(auth.subs)) if (auth.subs[k].uid === uid) delete auth.subs[k];
  saveAuth();
}
const fails = new Map();
function tooMany(key) {
  const f = fails.get(key);
  return f && f.n >= 5 && Date.now() - f.t < 60000;
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.t > 60000) fails.set(key, { n: 1, t: Date.now() });
  else { f.n++; f.t = Date.now(); }
}

/* ---------- Web Push (sans charge utile, détails lus par le service worker) ---------- */
function b64u(b) { return Buffer.from(b).toString('base64url'); }
function ensureVapid() {
  if (auth.vapid) return;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  auth.vapid = { pub: b64u(pub), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  saveAuth();
}
ensureVapid();
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: auth.vapid.priv, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + auth.vapid.pub;
}
async function pushTo(subId, msg) {
  const s = auth.subs[subId];
  if (!s) return;
  s.queue = (s.queue || []).concat([msg]).slice(-10);
  saveAuth();
  try {
    const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: msg.urgent ? 'high' : 'normal', Authorization: vapidAuth(s.endpoint) } });
    if (r.status === 404 || r.status === 410) { delete auth.subs[subId]; saveAuth(); }
  } catch (e) { /* hors ligne : le message reste en file */ }
}
function pushAll(msg, exceptUid) {
  for (const id of Object.keys(auth.subs)) {
    if (exceptUid && auth.subs[id].uid === exceptUid) continue;
    pushTo(id, msg);
  }
}

/* ---------- Temps réel ---------- */
const clients = new Set();
function broadcast(ev) {
  const s = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const c of clients) { try { c.write(s); } catch (e) { clients.delete(c); } }
}
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 25000);

/* ---------- Rappels planifiés ---------- */
function todayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function validTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : ''; }
function openSummary() {
  const byDept = {}; let total = 0, late = 0; const today = todayStr();
  for (const rec of mem.reports.values()) {
    const r = rec.data;
    if ((r.status || 'open') === 'done') continue;
    total++;
    if (r.due && r.due < today) late++;
    const name = r.deptName || 'Département';
    byDept[name] = (byDept[name] || 0) + 1;
  }
  return { total, late, parts: Object.keys(byDept).map(k => k + ' ' + byDept[k]) };
}
function tick() {
  const set = mem.settings.get('company');
  const d = (set && set.data) || {};
  const times = [validTime(d.remind1) || '08:00', validTime(d.remind2) || '14:00'];
  const now = new Date();
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const at = new Date(); at.setHours(h, m, 0, 0);
    if (at <= now && now - at < 6 * 3600 * 1000) {
      const key = todayStr() + '_' + t;
      if (auth.sched[key]) continue;
      auth.sched[key] = 1;
      for (const k of Object.keys(auth.sched)) if (k.slice(0, 10) < todayStr(new Date(Date.now() - 3 * 86400000))) delete auth.sched[k];
      saveAuth();
      const s = openSummary();
      if (s.total) {
        pushAll({ title: 'Rappel 5S · ' + s.total + ' action' + (s.total > 1 ? 's' : '') + ' non corrigée' + (s.total > 1 ? 's' : ''), body: s.parts.join(', ') + (s.late ? ' · ' + s.late + ' en retard' : ''), tag: 'rappel', urgent: s.late > 0, url: '/#alertes' });
      }
    }
  }
}
setInterval(tick, 30000);

/* ---------- Utilitaires HTTP ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function send(res, status, obj, req) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (req && body.length > 2000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(body));
  }
  res.writeHead(status, headers);
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Données trop volumineuses.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new HttpError(400, 'Requête invalide.')); } });
    req.on('error', reject);
  });
}
function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('token') || '';
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep) && file !== PUB) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    const ext = path.extname(file);
    const noCache = ext === '.html' || p === '/sw.js' || ext === '.webmanifest' || ext === '.js';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}
function recOut(id, rec) { return { id, data: rec.data, version: rec.version }; }

/* ---------- Membres : codes PIN et accès ---------- */
function processMember(id, data) {
  if (data.pin !== undefined) {
    const pin = String(data.pin).trim();
    delete data.pin;
    if (pin) {
      if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'Le code PIN doit comporter de 4 à 8 chiffres.');
      const name = String(data.name || (mem.members.get(id) && mem.members.get(id).data.name) || '').trim().toLowerCase();
      for (const [oid, rec] of mem.members) {
        if (oid !== id && auth.users[oid] && String(rec.data.name || '').trim().toLowerCase() === name) throw new HttpError(400, 'Un autre membre avec accès porte déjà ce nom.');
      }
      setUserPin(id, pin);
    }
  }
  data.hasPin = !!auth.users[id];
  if (data.admin !== undefined) data.admin = data.admin === true;
  return data;
}
function seedDepartments() {
  ['Production', 'Maintenance', 'Qualité', 'Logistique', 'Magasin', 'Administration'].forEach(n => {
    const id = n.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
    if (!mem.departments.has(id)) putDoc('departments', id, { data: { name: n, leader: '', phone: '', updatedAt: Date.now() }, version: 1, updatedAt: Date.now() });
  });
}

/* ---------- Routes API ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const ip = req.socket.remoteAddress || '';

  if (p === '/api/status' && m === 'GET') {
    const names = [];
    for (const [id, rec] of mem.members) if (auth.users[id]) names.push(String(rec.data.name || ''));
    const set = mem.settings.get('company');
    return send(res, 200, { needsSetup: Object.keys(auth.users).length === 0, users: names.sort((a, b) => a.localeCompare(b, 'fr')), company: (set && set.data.name) || '' });
  }
  if (p === '/api/setup' && m === 'POST') {
    if (Object.keys(auth.users).length) throw new HttpError(403, 'Le logiciel est déjà configuré.');
    const b = await readJson(req);
    const name = String(b.name || '').trim(), pin = String(b.pin || '').trim();
    if (!name) throw new HttpError(400, 'Indiquez votre nom.');
    if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'Le code PIN doit comporter de 4 à 8 chiffres.');
    const id = crypto.randomBytes(8).toString('hex');
    setUserPin(id, pin);
    putDoc('members', id, { data: { name, dept: '', role: 'Administrateur', phone: '', admin: true, hasPin: true, updatedAt: Date.now() }, version: 1, updatedAt: Date.now() });
    seedDepartments();
    const token = newSession(id);
    return send(res, 200, { token, me: { id, name, admin: true } });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req);
    const key = ip + '|' + String(b.name || '').toLowerCase();
    if (tooMany(key)) throw new HttpError(429, 'Trop d\'essais. Patientez une minute.');
    const found = memberByName(b.name);
    if (!found || !checkPin(found.id, b.pin)) { noteFail(key); throw new HttpError(400, 'Nom ou code incorrect.'); }
    fails.delete(key);
    const token = newSession(found.id);
    return send(res, 200, { token, me: { id: found.id, name: String(found.rec.data.name), admin: found.rec.data.admin === true } });
  }
  if (p === '/api/push/inbox' && m === 'GET') {
    const s = auth.subs[url.searchParams.get('id') || ''];
    const msgs = s ? (s.queue || []) : [];
    if (s) { s.queue = []; saveAuth(); }
    return send(res, 200, { messages: msgs });
  }

  const user = userFromToken(bearer(req, url));
  if (!user) throw new HttpError(401, 'Connexion requise.');

  if (p === '/api/me' && m === 'GET') return send(res, 200, { id: user.id, name: user.name, admin: user.admin });
  if (p === '/api/logout' && m === 'POST') { delete auth.sessions[user.token]; saveAuth(); return send(res, 200, { ok: true }); }
  if (p === '/api/pin' && m === 'POST') {
    const b = await readJson(req);
    if (!checkPin(user.id, b.old)) throw new HttpError(400, 'Le code actuel est incorrect.');
    if (!/^\d{4,8}$/.test(String(b.new || ''))) throw new HttpError(400, 'Le nouveau code doit comporter de 4 à 8 chiffres.');
    setUserPin(user.id, String(b.new));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/users' && m === 'GET') {
    const out = [];
    for (const [id, rec] of mem.members) out.push({ id, name: String(rec.data.name || ''), admin: rec.data.admin === true });
    return send(res, 200, out);
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/push/key' && m === 'GET') return send(res, 200, { publicKey: auth.vapid.pub });
  if (p === '/api/push/subscribe' && m === 'POST') {
    const b = await readJson(req);
    const sub = b.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw new HttpError(400, 'Abonnement invalide.');
    const id = crypto.createHash('sha256').update(sub.endpoint).digest('hex');
    auth.subs[id] = { uid: user.id, endpoint: sub.endpoint, queue: (auth.subs[id] && auth.subs[id].queue) || [] };
    saveAuth();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const b = await readJson(req);
    const id = crypto.createHash('sha256').update(String(b.endpoint || '')).digest('hex');
    if (auth.subs[id] && auth.subs[id].uid === user.id) { delete auth.subs[id]; saveAuth(); }
    return send(res, 200, { ok: true });
  }

  let mt;
  if ((mt = p.match(/^\/api\/col\/([a-z]+)$/)) && m === 'GET') {
    const c = mt[1];
    if (!COLS.has(c) || LAZY.has(c)) throw new HttpError(404, 'Collection inconnue.');
    const out = [];
    for (const [id, rec] of mem[c]) out.push(recOut(id, rec));
    return send(res, 200, out, req);
  }
  if ((mt = p.match(/^\/api\/doc\/([a-z]+)\/([A-Za-z0-9_-]+)$/))) {
    const c = mt[1], id = mt[2];
    if (!COLS.has(c) || !ID_RE.test(id)) throw new HttpError(404, 'Document inconnu.');
    if (m === 'GET') {
      const rec = getDoc(c, id);
      if (!rec) throw new HttpError(404, 'Introuvable.');
      return send(res, 200, recOut(id, rec), req);
    }
    if (m === 'PUT' || m === 'PATCH') {
      if (ADMIN_WRITE.has(c) && !user.admin) throw new HttpError(403, 'Réservé aux administrateurs.');
      const b = await readJson(req);
      let data = b.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Document invalide.');
      const existing = getDoc(c, id);
      if (m === 'PATCH' && !existing) throw new HttpError(404, 'Introuvable.');
      if (c === 'members') data = processMember(id, data);
      if (m === 'PATCH') data = deepMerge(existing.data, data);
      if (JSON.stringify(data).length > MAX_DOC) throw new HttpError(413, 'Document trop volumineux.');
      if (c === 'reports' && !existing && mem.reports.size >= MAX_REPORTS) throw new HttpError(507, 'Espace plein.');
      const rec = { data, version: (existing ? existing.version : 0) + 1, updatedAt: Date.now() };
      putDoc(c, id, rec);
      if (!LAZY.has(c)) broadcast({ col: c, id, op: 'set', data: rec.data, version: rec.version });
      if (c === 'reports' && !existing && !data.imported) {
        pushAll({ title: (data.prio === 'urgent' ? 'Alerte urgente · ' : 'Nouvelle alerte · ') + (data.deptName || ''), body: ((data.cat ? data.cat + ' : ' : '') + (data.desc || (data.photos && data.photos[0] && data.photos[0].note) || 'Voir les photos')).slice(0, 140), tag: 'rapport-' + id, urgent: data.prio === 'urgent', url: '/#alertes' }, user.id);
      }
      return send(res, 200, recOut(id, rec));
    }
    if (m === 'DELETE') {
      if (ADMIN_DELETE.has(c) && !user.admin) throw new HttpError(403, 'Réservé aux administrateurs.');
      const existing = getDoc(c, id);
      if (c === 'members' && existing) {
        if (id === user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte.');
        removeUser(id);
      }
      delDoc(c, id);
      if (!LAZY.has(c)) broadcast({ col: c, id, op: 'del', version: existing ? existing.version + 1 : 1 });
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Introuvable.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Erreur du serveur.' });
  }
});
server.listen(PORT, () => {
  console.log('Gestion 5S en marche : http://localhost:' + PORT);
  console.log('Données : ' + DATA);
});
process.on('SIGTERM', () => { try { writeAtomic(AUTH_FILE, JSON.stringify(auth)); } catch (e) { /* ignore */ } process.exit(0); });
process.on('SIGINT', () => { try { writeAtomic(AUTH_FILE, JSON.stringify(auth)); } catch (e) { /* ignore */ } process.exit(0); });
