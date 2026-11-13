'use strict';
/* Gestion 5S - serveur Node (18 ou plus), sans dépendance.
   Données dans Supabase (variables SUPABASE_URL et SUPABASE_SECRET_KEY). Sans ces variables, les données
   sont enregistrées dans des fichiers locaux : réservé à l'essai sur votre ordinateur.
   Comptes avec code PIN, temps réel (SSE), notifications push, rappels planifiés. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const USE_SUPABASE = !!(SUPABASE_URL || SUPABASE_KEY);
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');

const COLS = new Set(['reports', 'departments', 'members', 'settings', 'photos']);
const LAZY = new Set(['photos']); // lues dans la base à la demande, jamais listées
const ADMIN_WRITE = new Set(['departments', 'members', 'settings']);
const ADMIN_DELETE = new Set(['reports', 'departments', 'members', 'settings']);
const MAX_BODY = 700 * 1024;
const MAX_DOC = 400 * 1024;
const MAX_REPORTS = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/* ---------- Stockage : Supabase ou fichiers ---------- */
class StoreError extends Error {
  constructor(msg, status) { super(msg); this.name = 'StoreError'; this.status = status; }
}
class SupabaseStore {
  constructor() { this.base = SUPABASE_URL + '/rest/v1'; }
  headers(extra) {
    const h = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
    if (SUPABASE_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SUPABASE_KEY; // ancienne clé service_role (JWT)
    return Object.assign(h, extra || {});
  }
  async req(method, pathq, body, extra) {
    let r;
    try {
      r = await fetch(this.base + pathq, { method, headers: this.headers(extra), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    } catch (e) {
      throw new StoreError('Supabase injoignable (' + ((e.cause && e.cause.code) || e.name) + ').', 0);
    }
    if (!r.ok) {
      let t = ''; try { t = await r.text(); } catch (e) { /* ignoré */ }
      let j = null; try { j = JSON.parse(t); } catch (e) { /* ignoré */ }
      const err = new StoreError((j && (j.message || j.hint)) || ('HTTP ' + r.status), r.status);
      err.code = j && j.code;
      throw err;
    }
    if (r.status === 204) return null;
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }
  async init() {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Il faut les deux variables SUPABASE_URL et SUPABASE_SECRET_KEY.');
    if (!/^https?:\/\//.test(SUPABASE_URL)) throw new Error("SUPABASE_URL doit commencer par https:// (exemple : https://abcdxyz.supabase.co).");
    try { await this.req('GET', '/docs?select=id&limit=1'); }
    catch (e) {
      const detail = ' [Supabase répond : HTTP ' + e.status + (e.code ? ', code ' + e.code : '') + ', « ' + e.message + ' » ; projet : ' + (SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0]) + ']';
      if (e.status === 404 || e.code === 'PGRST205' || e.code === '42P01') throw new Error("Les tables docs et meta ne sont pas trouvées dans ce projet. Vérifiez que SUPABASE_URL est celle du projet où vous avez exécuté le script SQL, puis que l'API Data est active." + detail);
      if (e.status === 401 || e.status === 403) throw new Error("Clé refusée par Supabase. Vérifiez SUPABASE_SECRET_KEY : il faut la clé « secret » (sb_secret_...) ou l'ancienne clé service_role." + detail);
      e.message += detail;
      throw e;
    }
    try { await this.req('POST', '/meta?on_conflict=id', { id: 'ping', value: { t: Date.now() } }, { Prefer: 'resolution=merge-duplicates,return=minimal' }); }
    catch (e) {
      if (e.status === 401 || e.status === 403 || e.code === '42501') throw new Error("Cette clé peut lire mais pas écrire : c'est sans doute la clé « publishable » (anon). Utilisez la clé « secret » (sb_secret_...) ou l'ancienne clé service_role.");
      throw e;
    }
  }
  async touch() { await this.req('GET', '/docs?select=id&limit=1'); }
  async loadAll(c) {
    const out = [];
    for (let off = 0; ; off += 200) {
      const rows = await this.req('GET', '/docs?col=eq.' + encodeURIComponent(c) + '&select=doc_id,data,version,updated_at&order=doc_id&limit=200&offset=' + off);
      for (const r of rows) out.push([r.doc_id, { data: r.data, version: r.version, updatedAt: r.updated_at }]);
      if (rows.length < 200) break;
    }
    return out;
  }
  async get(c, id) {
    const rows = await this.req('GET', '/docs?id=eq.' + encodeURIComponent(c + '/' + id) + '&select=data,version,updated_at&limit=1');
    const r = rows && rows[0];
    return r ? { data: r.data, version: r.version, updatedAt: r.updated_at } : null;
  }
  async put(c, id, rec) {
    await this.req('POST', '/docs?on_conflict=id', { id: c + '/' + id, col: c, doc_id: id, data: rec.data, version: rec.version, updated_at: rec.updatedAt }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  async del(c, id) { await this.req('DELETE', '/docs?id=eq.' + encodeURIComponent(c + '/' + id), undefined, { Prefer: 'return=minimal' }); }
  async loadAuth() {
    const rows = await this.req('GET', '/meta?id=eq.auth&select=value&limit=1');
    return rows && rows[0] ? rows[0].value : null;
  }
  async saveAuth(a) { await this.req('POST', '/meta?on_conflict=id', { id: 'auth', value: a }, { Prefer: 'resolution=merge-duplicates,return=minimal' }); }
  async close() { /* rien à fermer */ }
}

class FileStore {
  async init() {
    for (const c of COLS) fs.mkdirSync(path.join(DATA, 'docs', c), { recursive: true });
  }
  dir(c) { return path.join(DATA, 'docs', c); }
  async loadAll(c) {
    const out = [];
    for (const f of fs.readdirSync(this.dir(c))) {
      if (!f.endsWith('.json')) continue;
      try { out.push([f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(this.dir(c), f), 'utf8'))]); }
      catch (e) { console.error('Fichier illisible', c, f); }
    }
    return out;
  }
  async get(c, id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir(c), id + '.json'), 'utf8')); } catch (e) { return null; }
  }
  async put(c, id, rec) {
    const file = path.join(this.dir(c), id + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(rec));
    fs.renameSync(file + '.tmp', file);
  }
  async del(c, id) { try { fs.unlinkSync(path.join(this.dir(c), id + '.json')); } catch (e) { /* déjà absent */ } }
  async loadAuth() { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'auth.json'), 'utf8')); } catch (e) { return null; } }
  async saveAuth(a) {
    const file = path.join(DATA, 'auth.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(a));
    fs.renameSync(file + '.tmp', file);
  }
  async close() { /* rien à fermer */ }
}

const store = USE_SUPABASE ? new SupabaseStore() : new FileStore();
const mem = {};
for (const c of COLS) if (!LAZY.has(c)) mem[c] = new Map();

async function getDoc(c, id) {
  if (LAZY.has(c)) return store.get(c, id);
  return mem[c].get(id) || null;
}
async function putDoc(c, id, rec) {
  await store.put(c, id, rec);
  if (!LAZY.has(c)) mem[c].set(id, rec);
}
async function delDoc(c, id) {
  await store.del(c, id);
  if (!LAZY.has(c)) mem[c].delete(id);
}
/* Une seule modification à la fois par document : évite les mises à jour perdues. */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    if (UNSAFE.has(k)) continue;
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/* ---------- Comptes, sessions, notifications ---------- */
let auth = { users: {}, sessions: {}, vapid: null, subs: {}, sched: {} };
let saveTimer = null, savePending = false, saveChain = Promise.resolve();
function saveAuth() {
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushAuth(); }, 200);
}
function flushAuth() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!savePending) return saveChain;
  savePending = false;
  const snapshot = JSON.parse(JSON.stringify(auth));
  saveChain = saveChain.then(() => store.saveAuth(snapshot)).catch(e => { savePending = true; console.error('Sauvegarde des comptes impossible :', e.message); });
  return saveChain;
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
function tokenKey(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  auth.sessions[tokenKey(token)] = { uid, at: Date.now() };
  saveAuth();
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const k = tokenKey(token), s = auth.sessions[k];
  if (!s) return null;
  if (Date.now() - s.at > 90 * 86400000) { delete auth.sessions[k]; saveAuth(); return null; }
  const m = mem.members.get(s.uid);
  if (!m || !auth.users[s.uid]) return null;
  return { id: s.uid, name: String(m.data.name || ''), admin: m.data.admin === true, key: k };
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
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return xf || req.socket.remoteAddress || '';
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
async function seedDepartments() {
  for (const n of ['Production', 'Maintenance', 'Qualité', 'Logistique', 'Magasin', 'Administration']) {
    const id = n.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
    if (!mem.departments.has(id)) await putDoc('departments', id, { data: { name: n, leader: '', phone: '', updatedAt: Date.now() }, version: 1, updatedAt: Date.now() });
  }
}

/* ---------- Routes API ---------- */
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const ip = clientIp(req);

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
    await putDoc('members', id, { data: { name, dept: '', role: 'Administrateur', phone: '', admin: true, hasPin: true, updatedAt: Date.now() }, version: 1, updatedAt: Date.now() });
    await seedDepartments();
    const token = newSession(id);
    await flushAuth();
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
  if (p === '/api/relance-link' && m === 'GET') {
    const d = url.searchParams.get('dept') || '';
    if (!ID_RE.test(d) || !mem.departments.has(d)) throw new HttpError(404, 'Département inconnu.');
    return send(res, 200, { path: '/r/' + d + '/' + linkSig(d) });
  }
  if (p === '/api/logout' && m === 'POST') { delete auth.sessions[user.key]; saveAuth(); return send(res, 200, { ok: true }); }
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
      const rec = await getDoc(c, id);
      if (!rec) throw new HttpError(404, 'Introuvable.');
      return send(res, 200, recOut(id, rec), req);
    }
    if (m === 'PUT' || m === 'PATCH') {
      if (ADMIN_WRITE.has(c) && !user.admin) throw new HttpError(403, 'Réservé aux administrateurs.');
      const b = await readJson(req);
      let data = b.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Document invalide.');
      const result = await withLock(c + '/' + id, async () => {
        const existing = await getDoc(c, id);
        if (m === 'PATCH' && !existing) throw new HttpError(404, 'Introuvable.');
        let d = data;
        if (c === 'members') d = processMember(id, d);
        if (m === 'PATCH') d = deepMerge(existing.data, d);
        if (JSON.stringify(d).length > MAX_DOC) throw new HttpError(413, 'Document trop volumineux.');
        if (c === 'reports' && !existing && mem.reports.size >= MAX_REPORTS) throw new HttpError(507, 'Espace plein.');
        const rec = { data: d, version: (existing ? existing.version : 0) + 1, updatedAt: Date.now() };
        await putDoc(c, id, rec);
        return { rec, isNew: !existing };
      });
      const rec = result.rec;
      if (!LAZY.has(c)) broadcast({ col: c, id, op: 'set', data: rec.data, version: rec.version });
      if (c === 'reports' && result.isNew && !rec.data.imported) {
        const d = rec.data;
        pushAll({ title: (d.prio === 'urgent' ? 'Alerte urgente · ' : 'Nouvelle alerte · ') + (d.deptName || ''), body: ((d.cat ? d.cat + ' : ' : '') + (d.desc || (d.photos && d.photos[0] && d.photos[0].note) || 'Voir les photos')).slice(0, 140), tag: 'rapport-' + id, urgent: d.prio === 'urgent', url: '/#alertes' }, user.id);
      }
      return send(res, 200, recOut(id, rec));
    }
    if (m === 'DELETE') {
      if (ADMIN_DELETE.has(c) && !user.admin) throw new HttpError(403, 'Réservé aux administrateurs.');
      const version = await withLock(c + '/' + id, async () => {
        const existing = await getDoc(c, id);
        if (c === 'members' && existing) {
          if (id === user.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte.');
          removeUser(id);
        }
        await delDoc(c, id);
        return existing ? existing.version + 1 : 1;
      });
      if (!LAZY.has(c)) broadcast({ col: c, id, op: 'del', version });
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Introuvable.');
}

/* ---------- Liens de rappel par département : page en lecture seule, sans connexion ---------- */
function ensureLinkKey() { if (!auth.linkKey) { auth.linkKey = crypto.randomBytes(32).toString('hex'); saveAuth(); } }
function linkSig(dept) { return crypto.createHmac('sha256', auth.linkKey).update('relance:' + dept).digest('base64url').slice(0, 24); }
function linkOk(dept, sig) {
  if (!ID_RE.test(dept) || typeof sig !== 'string') return false;
  const a = Buffer.from(linkSig(dept)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hesc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function agoFr(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "à l'instant";
  if (m < 60) return 'il y a ' + m + ' min';
  const h = Math.round(m / 60);
  return h < 48 ? 'il y a ' + h + ' h' : 'il y a ' + Math.round(h / 24) + ' j';
}
function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function relancePage(dept, sig) {
  const d = mem.departments.get(dept);
  if (!d) throw new HttpError(404, 'Introuvable.');
  const co = mem.settings.get('company');
  const company = (co && co.data && co.data.name) || '';
  const list = [...mem.reports.entries()]
    .filter(([, r]) => r.data.dept === dept && (r.data.status || 'open') !== 'done' && !r.data.archived)
    .sort((a, b) => (b[1].data.createdAt || 0) - (a[1].data.createdAt || 0));
  const today = todayIso();
  let h = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Rappel 5S - ' + hesc(d.data.name) + '</title>' +
    '<style>body{margin:0;font:16px/1.45 system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#EDF0F3;color:#14202B}header{background:#14202B;color:#fff;padding:16px}header b{color:#F2B705;letter-spacing:.06em;font-size:13px}h1{margin:4px 0 0;font-size:24px}main{padding:12px;max-width:720px;margin:auto}' +
    '.c{background:#fff;border-radius:12px;padding:14px;margin-bottom:12px;border-left:5px solid #BE2F1B}.late{color:#BE2F1B;font-weight:700}.m{color:#586674;font-size:14px}img{width:100%;height:auto;border-radius:8px;margin-top:8px;display:block}.n{font-size:14px;color:#586674;margin:2px 0 0}</style></head><body>' +
    '<header><b>RAPPEL 5S' + (company ? ' · ' + hesc(company).toUpperCase() : '') + '</b><h1>' + hesc(d.data.name) + '</h1><div class="m" style="color:#cfd6dd">' + list.length + ' action' + (list.length > 1 ? 's' : '') + ' non corrigée' + (list.length > 1 ? 's' : '') + ' · mis à jour ' + hesc(new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })) + '</div></header><main>';
  if (!list.length) h += '<div class="c" style="border-color:#1B7443">Aucune action en attente. Merci !</div>';
  list.forEach(([id, r], i) => {
    const x = r.data, late = x.due && x.due < today;
    h += '<div class="c"><div><b>' + (i + 1) + '. ' + hesc(x.cat ? x.cat + ' : ' : '') + hesc(x.desc || 'Voir la photo') + '</b></div>' +
      '<div class="m">' + hesc(agoFr(x.createdAt || Date.now())) + (x.due ? ' · à corriger avant le ' + hesc(x.due) : '') + (late ? ' · <span class="late">EN RETARD</span>' : '') + '</div>';
    (x.photos || []).slice(0, 4).forEach((ph, k) => {
      h += '<img loading="lazy" alt="Photo ' + (k + 1) + '" src="/r/' + hesc(dept) + '/' + hesc(sig) + '/p/' + hesc(id) + '/' + k + '">' + (ph && ph.note ? '<p class="n">' + hesc(ph.note) + '</p>' : '');
    });
    h += '</div>';
  });
  return h + '</main></body></html>';
}
async function serveRelance(req, res, parts) {
  const [dept, sig, kind, id, idx] = parts;
  if (!linkOk(dept, sig)) throw new HttpError(404, 'Lien invalide.');
  const sec = { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  if (!kind) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }, sec));
    return res.end(relancePage(dept, sig));
  }
  if (kind !== 'p' || !ID_RE.test(id || '') || !/^\d$/.test(idx || '')) throw new HttpError(404, 'Introuvable.');
  const rep = mem.reports.get(id);
  const k = Number(idx);
  if (!rep || rep.data.dept !== dept || !(rep.data.photos || [])[k]) throw new HttpError(404, 'Introuvable.');
  let src = '';
  try { const ph = await getDoc('photos', id + '_' + k); src = ph && ph.data && ph.data.src; } catch (e) { /* repli sur la miniature */ }
  if (typeof src !== 'string' || !/^data:image\//.test(src)) src = rep.data.photos[k].thumb;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(src || '');
  if (!m) throw new HttpError(404, 'Introuvable.');
  res.writeHead(200, Object.assign({ 'Content-Type': 'image/' + m[1], 'Cache-Control': 'private, max-age=3600' }, sec));
  return res.end(Buffer.from(m[2], 'base64'));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/r/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return await serveRelance(req, res, url.pathname.split('/').slice(2));
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (e && e.name === 'StoreError') return send(res, 503, { error: 'Base de données indisponible. Réessayez dans un instant.' });
    send(res, 500, { error: 'Erreur du serveur.' });
  }
});

async function shutdown() {
  try { await flushAuth(); await store.close(); } catch (e) { /* ignoré */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function main() {
  if (!USE_SUPABASE && (process.env.RENDER || process.env.NODE_ENV === 'production') && process.env.ALLOW_FILE_STORAGE !== '1') {
    console.error('SUPABASE_URL et SUPABASE_SECRET_KEY sont absentes. Sur Render, les fichiers locaux disparaissent à chaque redémarrage : ajoutez ces deux variables (voir README.md).');
    process.exit(1);
  }
  try { await store.init(); }
  catch (e) {
    console.error('Connexion à la base impossible :', e.message);
    console.error("Vérifiez SUPABASE_URL (adresse du projet), SUPABASE_SECRET_KEY (clé secrète) et que le projet n'est pas en pause.");
    process.exit(1);
  }
  for (const c of COLS) {
    if (LAZY.has(c)) continue;
    for (const [id, rec] of await store.loadAll(c)) mem[c].set(id, rec);
  }
  const saved = await store.loadAuth();
  if (saved) auth = Object.assign(auth, saved);
  ensureVapid();
  ensureLinkKey();
  await flushAuth();
  server.listen(PORT, () => {
    console.log('Gestion 5S en marche sur le port ' + PORT);
    console.log(USE_SUPABASE ? 'Données : Supabase (' + SUPABASE_URL + ')' : 'Données : fichiers locaux (' + DATA + ') - essai uniquement');
  });
  if (store.touch) setInterval(() => { store.touch().catch(e => console.error('Lecture de maintien Supabase impossible :', e.message)); }, 12 * 3600 * 1000);
}
main();
