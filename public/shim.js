/* Gestion 5S - couche client : connexion, données partagées en direct, compte, installation, notifications.
   Elle fournit à l'interface la même API de données que la version en ligne (window.claude.use("db" | "user")). */
(function () {
  'use strict';
  var KEY = 'g5s_token';
  var token = null, me = null, names = {}, offline = false, sse = null;
  var caches = {};

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }

  /* ---------- Requêtes ---------- */
  function api(method, url, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) {
          var e = new Error((j && j.error) || 'Erreur');
          e.status = r.status;
          e.code = r.status === 401 ? 'revoked' : (r.status === 507 ? 'quota_exceeded' : (r.status >= 400 && r.status < 500 ? 'invalid_argument' : 'unavailable'));
          if (r.status === 401 && token && url !== '/api/login') { lsSet(KEY, ''); location.reload(); }
          throw e;
        }
        return j;
      });
    }, function () {
      var e = new Error('Pas de connexion au serveur.');
      e.code = 'unavailable';
      throw e;
    });
  }

  /* ---------- Écran de connexion ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#g5s-auth{position:fixed;inset:0;z-index:200;background:var(--bg);display:grid;place-items:center;padding:16px;overflow:auto}' +
    '#g5s-auth form,#g5s-auth .box{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:22px;display:flex;flex-direction:column;gap:14px}' +
    '#g5s-auth h1{font-family:var(--font-display);font-size:34px;line-height:1;margin:0}' +
    '#g5s-auth p{margin:0;color:var(--muted);font-size:15px}' +
    '#g5s-auth label{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}' +
    '#g5s-auth .f{display:flex;flex-direction:column;gap:6px}' +
    '#g5s-auth input,#g5s-auth select{width:100%;background:var(--bg);border:1.5px solid var(--line);border-radius:8px;padding:12px;min-height:48px;font:inherit;color:inherit}' +
    '#g5s-auth button{min-height:48px;border-radius:8px;border:1.5px solid var(--accent);background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}' +
    '#g5s-auth .err{background:var(--open-soft);color:var(--open);border:1px solid var(--open);border-radius:8px;padding:10px 12px;font-size:14px}';
  document.head.appendChild(css);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function authScreen() {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.id = 'g5s-auth';
      document.body.appendChild(ov);
      function retryBox(msg) {
        ov.innerHTML = '<div class="box"><h1>Gestion 5S</h1><div class="err">' + esc(msg) + '</div><button type="button" id="g5s-retry">Réessayer</button></div>';
        ov.querySelector('#g5s-retry').onclick = load;
      }
      function load() {
        ov.innerHTML = '<div class="box"><h1>Gestion 5S</h1><p>Connexion au serveur…</p></div>';
        api('GET', '/api/status').then(function (st) { form(st); }, function () { retryBox('Le serveur est injoignable. Vérifiez votre connexion.'); });
      }
      function form(st) {
        var setup = st.needsSetup;
        var nameField = (setup || st.hideNames)
          ? '<div class="f"><label for="g5s-n">' + (setup ? 'Votre nom' : 'Nom') + '</label><input id="g5s-n" type="text" autocomplete="username" autocapitalize="words" required></div>'
          : '<div class="f"><label for="g5s-n">Nom</label><select id="g5s-n" required>' + st.users.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</select></div>';
        ov.innerHTML = '<form><h1>' + esc(st.company || 'Gestion 5S') + '</h1>' +
          '<p>' + (setup ? 'Première utilisation : créez le compte administrateur.' : 'Connectez-vous pour voir les alertes et signaler une action.') + '</p>' +
          nameField +
          '<div class="f"><label for="g5s-p">' + (setup ? 'Code PIN (4 à 8 chiffres)' : 'Code PIN') + '</label><input id="g5s-p" type="password" inputmode="numeric" autocomplete="' + (setup ? 'new-password' : 'current-password') + '" required></div>' +
          '<div class="err" id="g5s-e" hidden></div>' +
          '<button type="submit">' + (setup ? 'Créer le compte et commencer' : 'Se connecter') + '</button></form>';
        var f = ov.querySelector('form');
        f.onsubmit = function (e) {
          e.preventDefault();
          var b = f.querySelector('button'); b.disabled = true;
          api('POST', setup ? '/api/setup' : '/api/login', { name: ov.querySelector('#g5s-n').value, pin: ov.querySelector('#g5s-p').value }).then(function (r) {
            token = r.token; lsSet(KEY, token); ov.remove(); resolve(r.me);
          }, function (err) {
            var box = ov.querySelector('#g5s-e'); box.textContent = err.message; box.hidden = false; b.disabled = false;
          });
        };
      }
      load();
    });
  }

  /* ---------- Données partagées (même API que la version en ligne) ---------- */
  var LAZY = { photos: 1 };
  var COLS = { reports: 1, departments: 1, members: 1, settings: 1, photos: 1 };
  function cs(c) { return caches[c] || (caches[c] = { map: new Map(), loaded: false, loading: null, listeners: new Set() }); }
  function meta() { return { fromCache: offline, hasPendingWrites: false }; }
  function notify(c) { cs(c).listeners.forEach(function (fn) { fn(); }); }
  function ensureLoaded(c) {
    var s = cs(c);
    if (s.loaded) return Promise.resolve();
    if (!s.loading) {
      s.loading = api('GET', '/api/col/' + c).then(function (list) {
        s.map = new Map(); list.forEach(function (d) { s.map.set(d.id, d); }); s.loaded = true; s.loading = null;
      }, function (e) { s.loading = null; throw e; });
    }
    return s.loading;
  }
  function applyRec(c, id, rec) {
    var s = cs(c);
    if (!s.loaded || LAZY[c]) return;
    var cur = s.map.get(id);
    if (cur && cur.version >= rec.version) return;
    s.map.set(id, { id: id, data: rec.data, version: rec.version });
    notify(c);
  }
  function applyEvent(ev) {
    var s = cs(ev.col);
    if (!s.loaded) return;
    if (ev.op === 'del') { s.map.delete(ev.id); notify(ev.col); } else applyRec(ev.col, ev.id, ev);
    if (ev.col === 'members') refreshNames();
  }
  function resync() {
    Object.keys(caches).forEach(function (c) {
      var s = caches[c];
      if (!s.loaded) return;
      api('GET', '/api/col/' + c).then(function (list) {
        s.map = new Map(); list.forEach(function (d) { s.map.set(d.id, d); }); notify(c);
      }, function () { /* nouvelle tentative à la prochaine reconnexion */ });
    });
    refreshNames();
  }
  function emitConn() { window.dispatchEvent(new CustomEvent('g5s-conn', { detail: { online: !offline } })); }
  function connectSSE() {
    sse = new EventSource('/api/events?token=' + encodeURIComponent(token));
    sse.onmessage = function (e) { try { applyEvent(JSON.parse(e.data)); } catch (x) { /* ignoré */ } };
    sse.onopen = function () { var was = offline; offline = false; if (was) resync(); emitConn(); Object.keys(caches).forEach(notify); };
    sse.onerror = function () {
      offline = true; emitConn(); Object.keys(caches).forEach(notify);
      api('GET', '/api/me').catch(function () { /* 401 : rechargement géré dans api() */ });
    };
  }
  function refreshNames() {
    return api('GET', '/api/users').then(function (list) {
      var m = {}; list.forEach(function (u) { m[u.id] = u.name; }); names = m;
    }, function () { /* conserve les noms connus */ });
  }

  function newId() {
    var a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', o = '', r = new Uint8Array(20);
    (window.crypto || window.msCrypto).getRandomValues(r);
    for (var i = 0; i < 20; i++) o += a[r[i] % a.length];
    return o;
  }
  function docSnap(c, id) {
    var rec = cs(c).map.get(id);
    return { id: id, exists: !!rec, data: function () { return rec ? rec.data : undefined; }, metadata: meta() };
  }

  function Query(c, order, dir, lim) { this.c = c; this.order = order || null; this.dir = dir || 'asc'; this.lim = lim || 0; }
  Query.prototype.orderBy = function (f, d) { return new Query(this.c, f, d || 'asc', this.lim); };
  Query.prototype.limit = function (n) { return new Query(this.c, this.order, this.dir, n); };
  Query.prototype._docs = function () {
    var arr = Array.from(cs(this.c).map.values()), f = this.order, mul = this.dir === 'desc' ? -1 : 1;
    arr.sort(function (a, b) {
      if (f) {
        var x = a.data[f], y = b.data[f];
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        if (x < y) return -1 * mul;
        if (x > y) return 1 * mul;
        return 0;
      }
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return this.lim ? arr.slice(0, this.lim) : arr;
  };
  Query.prototype._snap = function (prev) {
    var docs = this._docs(), changes = [], seen = new Set();
    docs.forEach(function (r, i) {
      seen.add(r.id);
      var v = prev.get(r.id);
      if (v === undefined) changes.push({ type: 'added', doc: docSnapFromRec(r), oldIndex: -1, newIndex: i });
      else if (v !== r.version) changes.push({ type: 'modified', doc: docSnapFromRec(r), oldIndex: i, newIndex: i });
    });
    prev.forEach(function (v, id) {
      if (!seen.has(id)) changes.push({ type: 'removed', doc: { id: id, exists: true, data: function () { return {}; }, metadata: meta() }, oldIndex: -1, newIndex: -1 });
    });
    return { docs: docs.map(docSnapFromRec), size: docs.length, empty: !docs.length, docChanges: function () { return changes; }, metadata: meta(), _ver: new Map(docs.map(function (r) { return [r.id, r.version]; })) };
  };
  function docSnapFromRec(r) { return { id: r.id, exists: true, data: function () { return r.data; }, metadata: meta() }; }
  Query.prototype.get = function () {
    var q = this;
    return ensureLoaded(q.c).then(function () { return q._snap(new Map()); });
  };
  Query.prototype.onSnapshot = function (next, error) {
    var q = this, prev = new Map(), stopped = false, s = cs(q.c);
    function emit() {
      if (stopped || !s.loaded) return;
      var snap = q._snap(prev);
      prev = snap._ver;
      next(snap);
    }
    s.listeners.add(emit);
    ensureLoaded(q.c).then(emit, function (e) { if (error) error({ code: e.code || 'unavailable', message: e.message }); });
    return function () { stopped = true; s.listeners.delete(emit); };
  };

  function CollectionRef(c) { Query.call(this, c); }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.doc = function (id) { return new DocRef(this.c, id || newId()); };
  CollectionRef.prototype.add = function (data) { var r = this.doc(); return r.set(data).then(function () { return r; }); };

  function DocRef(c, id) { this.c = c; this.id = id; this.path = c + '/' + id; }
  DocRef.prototype.get = function () {
    var c = this.c, id = this.id;
    if (LAZY[c]) {
      return api('GET', '/api/doc/' + c + '/' + id).then(function (r) {
        return { id: id, exists: true, data: function () { return r.data; }, metadata: meta() };
      }, function (e) {
        if (e.status === 404) return { id: id, exists: false, data: function () { return undefined; }, metadata: meta() };
        throw e;
      });
    }
    return ensureLoaded(c).then(function () { return docSnap(c, id); });
  };
  DocRef.prototype.set = function (data) {
    var c = this.c, id = this.id;
    return api('PUT', '/api/doc/' + c + '/' + id, { data: data }).then(function (r) { applyRec(c, id, r); });
  };
  DocRef.prototype.update = function (data) {
    var c = this.c, id = this.id;
    return api('PATCH', '/api/doc/' + c + '/' + id, { data: data }).then(function (r) { applyRec(c, id, r); });
  };
  DocRef.prototype.delete = function () {
    var c = this.c, id = this.id;
    return api('DELETE', '/api/doc/' + c + '/' + id).then(function () {
      var s = cs(c);
      if (s.loaded && !LAZY[c]) { s.map.delete(id); notify(c); }
    });
  };
  DocRef.prototype.onSnapshot = function (next, error) {
    var c = this.c, id = this.id, s = cs(c), last = null, stopped = false;
    function emit() {
      if (stopped || !s.loaded) return;
      var rec = s.map.get(id), v = rec ? rec.version : 0;
      if (last === v) return;
      last = v;
      next(docSnap(c, id));
    }
    s.listeners.add(emit);
    ensureLoaded(c).then(emit, function (e) { if (error) error({ code: e.code || 'unavailable', message: e.message }); });
    return function () { stopped = true; s.listeners.delete(emit); };
  };

  var db = {
    collection: function (c) { if (!COLS[c]) throw new TypeError('Collection inconnue : ' + c); return new CollectionRef(c); },
    doc: function (path) {
      var p = String(path).split('/');
      if (p.length !== 2 || !COLS[p[0]] || !/^[A-Za-z0-9_-]{1,100}$/.test(p[1])) throw new TypeError('Chemin invalide : ' + path);
      return new DocRef(p[0], p[1]);
    }
  };

  /* ---------- Utilisateur ---------- */
  var userApi = {
    isOwner: function () { return Promise.resolve(!!(me && me.admin)); },
    canEdit: function () { return Promise.resolve(!!(me && me.admin)); },
    can: function (n) { return Promise.resolve(n === 'data.write' ? true : null); },
    id: function () { return Promise.resolve(me ? me.id : null); },
    name: function () { return Promise.resolve(me ? me.name : ''); },
    me: function () {
      return Promise.resolve({ id: me ? me.id : null, name: me ? me.name : '', avatarUrl: '', color: '#0B4FA8', email: null, isOwner: !!(me && me.admin), canEdit: !!(me && me.admin) });
    },
    profiles: function (ids) {
      ids = typeof ids === 'string' ? [ids] : ids;
      var out = {};
      ids.forEach(function (id) { out[id] = { id: id, name: names[id] || '', avatarUrl: '', color: '#0B4FA8', email: null, isMe: !!(me && me.id === id), guest: false }; });
      return Promise.resolve(out);
    },
    search: function () { return Promise.resolve([]); }
  };

  /* ---------- Compte, installation, notifications ---------- */
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; window.dispatchEvent(new CustomEvent('g5s-install')); });
  window.addEventListener('appinstalled', function () { deferredInstall = null; window.dispatchEvent(new CustomEvent('g5s-install')); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () { /* hors HTTPS : pas de service worker */ });

  function urlB64(b) {
    var p = '='.repeat((4 - b.length % 4) % 4), s = (b + p).replace(/-/g, '+').replace(/_/g, '/'), raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  var account = {
    me: function () { return me; },
    logout: function () { return api('POST', '/api/logout').catch(function () { /* ignoré */ }).then(function () { lsSet(KEY, ''); lsSet('g5s_me', ''); location.reload(); }); },
    changePin: function (oldPin, newPin) { return api('POST', '/api/pin', { old: oldPin, new: newPin }); },
    push: {
      supported: pushSupported,
      state: function () {
        if (!pushSupported()) return Promise.resolve('unsupported');
        if (Notification.permission === 'denied') return Promise.resolve('denied');
        return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) { return s ? 'on' : 'off'; }, function () { return 'unsupported'; });
      },
      enable: function () {
        return Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') throw new Error('Les notifications sont refusées. Autorisez-les dans les réglages du navigateur.');
          return navigator.serviceWorker.ready;
        }).then(function (reg) {
          return api('GET', '/api/push/key').then(function (k) {
            return reg.pushManager.getSubscription().then(function (s) {
              return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(k.publicKey) });
            });
          });
        }).then(function (s) { return api('POST', '/api/push/subscribe', { subscription: s.toJSON() }); });
      },
      disable: function () {
        return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) {
          if (!s) return null;
          return api('POST', '/api/push/unsubscribe', { endpoint: s.endpoint }).then(function () { return s.unsubscribe(); });
        });
      }
    },
    install: {
      available: function () { return !!deferredInstall; },
      prompt: function () { var d = deferredInstall; deferredInstall = null; if (!d) return Promise.resolve(); d.prompt(); return d.userChoice.then(function () { window.dispatchEvent(new CustomEvent('g5s-install')); }); },
      ios: function () { return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone; },
      installed: function () { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
    }
  };

  /* ---------- Démarrage ---------- */
  var ready = new Promise(function (resolve) {
    function start() {
      token = lsGet(KEY) || null;
      var first = token ? api('GET', '/api/me').catch(function (e) {
        if (e.status === 401) { token = null; return null; }
        var cached = lsGet('g5s_me');
        if (cached) { try { offline = true; return JSON.parse(cached); } catch (x) { /* ignoré */ } }
        throw e;
      }) : Promise.resolve(null);
      first.then(function (m) { return m || authScreen(); }, function () { return authScreen(); }).then(function (m) {
        me = m;
        lsSet('g5s_me', JSON.stringify(m));
        return refreshNames();
      }).then(function () { connectSSE(); resolve(); });
    }
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  });

  window.g5s = account;
  window.claude = {
    use: function (name) {
      return ready.then(function () { return name === 'db' ? db : (name === 'user' ? userApi : null); });
    }
  };
})();
