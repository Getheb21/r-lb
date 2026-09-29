const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ KEY HARDCODE DI SINI ============
const SET_PASSWORD = 'vpn123';   // ← ganti password Anda
const SESSION_SECRET = 'railway-vpn-secret-2024-' + SET_PASSWORD;
// ==============================================

const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'hosts.json');
const DEBUG = process.env.DEBUG !== '0';
const PING_INTERVAL = Number(process.env.PING_INTERVAL || 30000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 60000);

const uaList = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

// ===== Storage =====
let backendHosts = [];
let latencyMap = {};
let cooldownMap = {};

function setCooldown(host, ms = COOLDOWN_MS) {
  cooldownMap[host] = Date.now() + ms;
  if (DEBUG) console.log(`[cooldown] ${host} di-skip ${ms}ms`);
}

function isAvailable(host) {
  const until = cooldownMap[host];
  return !until || until < Date.now();
}

function defaultHosts() {
  return String(process.env.HOST || 'lo.kopikapal23.workers.dev')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadHosts() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(j.hosts)) {
        backendHosts = j.hosts.filter(Boolean);
        return;
      }
    }
  } catch (e) {
    console.error('load:', e.message);
  }
  backendHosts = defaultHosts();
  saveHosts();
}

function saveHosts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ hosts: backendHosts }, null, 2));
  } catch (e) {
    console.error('save:', e.message);
  }
}

loadHosts();

// ===== Session (cookie-based) =====
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 hari

function makeToken() {
  const exp = Date.now() + SESSION_MAX_AGE;
  const data = `admin.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [user, exp, sig] = parts;
  if (user !== 'admin') return false;
  if (Number(exp) < Date.now()) return false;
  const data = `${user}.${exp}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAuthed(req) {
  const c = parseCookies(req);
  return verifyToken(c.session);
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Silakan login ulang.' });
  }
  next();
}

// ===== Middleware =====
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

// ===== Latency checker =====
function checkLatency(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = https.request(
      {
        hostname: host,
        port: 443,
        path: '/',
        method: 'HEAD',
        timeout: 8000,
        headers: { 'User-Agent': uaList[0] },
      },
      (up) => {
        up.resume();
        resolve({ host, ms: Date.now() - t0, status: up.statusCode });
      }
    );
    r.on('error', (e) => resolve({ host, ms: Infinity, error: e.code || e.message }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ host, ms: Infinity, error: 'TIMEOUT' });
    });
    r.end();
  });
}

async function refreshLatency() {
  if (backendHosts.length === 0) return;
  const results = await Promise.all(backendHosts.map(checkLatency));
  const m = {};
  for (const r of results) m[r.host] = r.ms;
  latencyMap = m;
  if (DEBUG) {
    const sorted = Object.entries(latencyMap).sort((a, b) => a[1] - b[1]);
    const preview = sorted
      .slice(0, 5)
      .map(([h, ms]) => `${h}:${ms === Infinity ? 'ERR' : ms + 'ms'}`)
      .join(' | ');
    console.log(`[latency] ${backendHosts.length} host → ${preview}`);
  }
}

setInterval(refreshLatency, PING_INTERVAL);
setTimeout(refreshLatency, 1500);

function sortByLatency(hosts) {
  return [...hosts]
    .filter(isAvailable)
    .sort((a, b) => {
      const va = latencyMap[a] === undefined ? 500 : latencyMap[a];
      const vb = latencyMap[b] === undefined ? 500 : latencyMap[b];
      return va - vb;
    });
}

function sortAllByLatency(hosts) {
  return [...hosts].sort((a, b) => {
    const va = latencyMap[a] === undefined ? 500 : latencyMap[a];
    const vb = latencyMap[b] === undefined ? 500 : latencyMap[b];
    return va - vb;
  });
}

// ===== Auth Routes =====
app.post('/set/login', (req, res) => {
  const pwd = (req.body && req.body.password) || '';
  if (pwd === SET_PASSWORD) {
    const token = makeToken();
    res.setHeader(
      'Set-Cookie',
      `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`
    );
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Password salah' });
});

app.post('/set/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// ===== /set UI =====
app.get('/set', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!isAuthed(req)) {
    return res.send(loginPage());
  }
  res.send(UI());
});

// ===== /set API =====
function parseHosts(b) {
  let arr = [];
  if (b && b.host !== undefined) {
    arr = Array.isArray(b.host) ? b.host : [b.host];
  } else if (Array.isArray(b)) {
    arr = b;
  } else if (typeof b === 'string') {
    arr = [b];
  }
  return arr
    .flatMap((s) => String(s).split(/[\s,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

app.get('/set/api/list', requireAuth, (req, res) => {
  const now = Date.now();
  res.json({
    ok: true,
    hosts: backendHosts,
    latency: backendHosts.map((h) => ({
      host: h,
      ms: latencyMap[h] === Infinity ? null : latencyMap[h] ?? null,
      cooldown:
        cooldownMap[h] && cooldownMap[h] > now
          ? Math.ceil((cooldownMap[h] - now) / 1000)
          : 0,
    })),
  });
});

app.post('/set/api/add', requireAuth, (req, res) => {
  backendHosts = Array.from(new Set([...backendHosts, ...parseHosts(req.body)]));
  saveHosts();
  refreshLatency();
  res.json({ ok: true, hosts: backendHosts });
});

app.post('/set/api/set', requireAuth, (req, res) => {
  backendHosts = Array.from(new Set(parseHosts(req.body)));
  saveHosts();
  refreshLatency();
  res.json({ ok: true, hosts: backendHosts });
});

app.post('/set/api/delete', requireAuth, (req, res) => {
  const t = parseHosts(req.body);
  backendHosts = backendHosts.filter((h) => !t.includes(h));
  for (const h of t) delete cooldownMap[h];
  saveHosts();
  res.json({ ok: true, hosts: backendHosts });
});

app.post('/set/api/clear', requireAuth, (req, res) => {
  backendHosts = [];
  latencyMap = {};
  cooldownMap = {};
  saveHosts();
  res.json({ ok: true, hosts: backendHosts });
});

app.get('/latency', requireAuth, (req, res) => {
  const now = Date.now();
  const rows = backendHosts.map((h) => ({
    host: h,
    ms: latencyMap[h] === Infinity ? null : latencyMap[h] ?? null,
    cooldownUntil:
      cooldownMap[h] && cooldownMap[h] > now
        ? new Date(cooldownMap[h]).toISOString()
        : null,
    cooldownLeft:
      cooldownMap[h] && cooldownMap[h] > now
        ? Math.ceil((cooldownMap[h] - now) / 1000) + 's'
        : null,
  }));
  rows.sort((a, b) => (a.ms ?? 99999) - (b.ms ?? 99999));
  res.json({ ok: true, updatedAt: new Date().toISOString(), hosts: rows });
});

app.get('/cek', requireAuth, async (req, res) => {
  const out = [];
  for (const host of backendHosts) out.push(await checkLatency(host));
  res.json({ hosts: out });
});

// ===== Proxy HTTP =====
app.all('*', async (req, res) => {
  if (
    req.path.startsWith('/set') ||
    req.path === '/cek' ||
    req.path === '/latency'
  ) {
    return res.status(404).send('Not found');
  }
  if (backendHosts.length === 0) return res.status(503).send('No backend');

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  let list = sortByLatency(backendHosts);
  if (list.length === 0) {
    if (DEBUG) console.log('[http] semua host cooldown, pakai fallback');
    list = sortAllByLatency(backendHosts);
  }
  const errors = [];

  for (const host of list) {
    try {
      await proxyHttp(req, res, host, body);
      return;
    } catch (e) {
      const code = e.statusCode;
      errors.push(`${host}: ${code || e.code || e.message}`);

      if (code === 429 || code === 403) setCooldown(host, COOLDOWN_MS);
      else if (code >= 500) setCooldown(host, 15000);
      else latencyMap[host] = Infinity;

      if (DEBUG) console.log(`[http] ${host} → ${code || e.code || e.message}`);
    }
  }
  res.status(502).type('text').send('All backends failed:\n' + errors.join('\n'));
});

function proxyHttp(req, res, host, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];
    headers['host'] = host;
    headers['user-agent'] = uaList[0];
    if (body.length) headers['content-length'] = String(body.length);

    let settled = false;
    const up = https.request(
      {
        hostname: host,
        port: 443,
        path: req.originalUrl || req.url,
        method: req.method,
        headers,
        timeout: 15000,
      },
      (r) => {
        settled = true;

        if (r.statusCode !== 200) {
          r.resume();
          const err = new Error(`HTTP ${r.statusCode}`);
          err.statusCode = r.statusCode;
          return reject(err);
        }

        res.status(r.statusCode);
        for (const [k, v] of Object.entries(r.headers)) {
          if (['transfer-encoding', 'connection', 'keep-alive'].includes(k.toLowerCase())) continue;
          try {
            res.setHeader(k, v);
          } catch {}
        }
        r.pipe(res);
        r.on('end', resolve);
        r.on('error', reject);
      }
    );
    up.on('error', (e) => {
      if (!settled) reject(e);
    });
    up.on('timeout', () => up.destroy(new Error('TIMEOUT')));
    if (body.length) up.write(body);
    up.end();
  });
}

// ===== HTTP + WebSocket server =====
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (backendHosts.length === 0) {
    socket.destroy();
    return;
  }

  let list = sortByLatency(backendHosts);
  if (list.length === 0) {
    if (DEBUG) console.log('[ws] semua host cooldown, pakai fallback');
    list = sortAllByLatency(backendHosts);
  }

  let i = 0;
  const next = () => {
    if (i >= list.length) {
      if (DEBUG) console.log('[ws] semua host gagal');
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head, list[i++], next);
  };
  next();
});

function proxyUpgrade(req, socket, head, host, onFail) {
  const headers = { ...req.headers };
  delete headers['host'];
  headers['host'] = host;
  headers['user-agent'] = uaList[0];

  let settled = false;

  const up = https.request({
    hostname: host,
    port: 443,
    path: req.url,
    method: req.method,
    headers,
    timeout: 15000,
  });

  up.on('upgrade', (upRes, upSocket, upHead) => {
    if (settled) return;
    settled = true;
    if (DEBUG) console.log(`[ws] ${host} ✓ 101`);

    let raw = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
    for (const [k, v] of Object.entries(upRes.headers)) raw += `${k}: ${v}\r\n`;
    raw += '\r\n';
    socket.write(raw);
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });

  up.on('response', (r) => {
    if (settled) return;
    settled = true;
    r.resume();

    const code = r.statusCode;
    if (DEBUG) console.log(`[ws] ${host} → ${code} (bukan 101, failover)`);

    if (code === 429 || code === 403) setCooldown(host, COOLDOWN_MS);
    else if (code >= 500) setCooldown(host, 15000);
    else latencyMap[host] = Infinity;

    onFail();
  });

  up.on('error', (e) => {
    if (settled) return;
    settled = true;
    if (DEBUG) console.log(`[ws] ${host} ✗ ${e.code || e.message}`);
    latencyMap[host] = Infinity;
    onFail();
  });

  up.on('timeout', () => up.destroy(new Error('TIMEOUT')));
  up.end();
}

server.listen(PORT, () => console.log(`[VPN] Listening on ${PORT}`));

// ===== Login Page =====
function loginPage() {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — Backend Manager</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:32px 26px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{font-size:20px;margin-bottom:6px;text-align:center}
.sub{font-size:13px;color:#94a3b8;text-align:center;margin-bottom:24px}
label{display:block;font-size:13px;color:#94a3b8;margin-bottom:8px}
input{width:100%;padding:11px 14px;border-radius:9px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:15px;outline:none;transition:border .15s}
input:focus{border-color:#3b82f6}
button{width:100%;padding:11px;margin-top:18px;border-radius:9px;border:none;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s}
button:hover:not(:disabled){background:#2563eb}
button:disabled{opacity:.6;cursor:not-allowed}
.err{color:#f87171;font-size:13px;margin-top:12px;text-align:center;min-height:18px}
</style></head><body>
<form class="login" id="form">
  <h1>🔒 Backend Manager</h1>
  <div class="sub">Masukkan password untuk melanjutkan</div>
  <label>Password</label>
  <input type="password" id="pwd" autofocus autocomplete="current-password">
  <button id="btn" type="submit">Login</button>
  <div class="err" id="err"></div>
</form>
<script>
const form=document.getElementById('form');
const pwd=document.getElementById('pwd');
const btn=document.getElementById('btn');
const err=document.getElementById('err');
form.addEventListener('submit',async(e)=>{
  e.preventDefault();
  err.textContent='';
  btn.disabled=true;btn.textContent='Memeriksa...';
  try{
    const r=await fetch('/set/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:pwd.value})
    });
    const j=await r.json();
    if(r.ok&&j.ok){location.reload();return;}
    err.textContent=j.error||'Password salah';
  }catch(e){err.textContent='Gagal terhubung ke server';}
  btn.disabled=false;btn.textContent='Login';
  pwd.select();
});
</script></body></html>`;
}

// ===== Admin UI =====
function UI() {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Backend Manager</title><style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:20px}
.container{max-width:720px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}.sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px;margin-bottom:16px}
label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px}
input,textarea,button{font-family:inherit;font-size:14px}
input[type=text],input[type=password],textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;outline:none}
textarea{resize:vertical;min-height:90px;font-family:ui-monospace,monospace}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
button{padding:9px 16px;border-radius:8px;border:none;cursor:pointer;font-weight:500}
.btn-primary{background:#3b82f6;color:#fff}.btn-green{background:#10b981;color:#fff}
.btn-ghost{background:transparent;color:#94a3b8;border:1px solid #334155}.btn-danger{background:#ef4444;color:#fff}
.list{list-style:none;padding:0;margin:0}
.list li{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;margin-bottom:8px;font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}
.list li .idx{color:#64748b;min-width:24px}.list li .host{flex:1}.list li button{padding:5px 10px;font-size:12px}
.list li .ms{font-size:11px;padding:2px 8px;border-radius:999px;background:#334155;color:#cbd5e1}
.list li .ms.fast{background:#065f46;color:#6ee7b7}.list li .ms.slow{background:#7f1d1d;color:#fca5a5}
.list li .ms.cool{background:#7c2d12;color:#fdba74}
.empty{color:#64748b;text-align:center;padding:20px;font-style:italic}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(100px);background:#10b981;color:#fff;padding:10px 20px;border-radius:8px;transition:transform .3s;z-index:999}
.toast.show{transform:translateX(-50%) translateY(0)}.toast.error{background:#ef4444}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#1e40af;color:#bfdbfe;font-size:11px;margin-left:6px}
.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.logout{background:transparent;border:1px solid #334155;color:#94a3b8;padding:6px 12px;font-size:12px;border-radius:8px;cursor:pointer}
.logout:hover{color:#f87171;border-color:#7f1d1d}
</style></head><body><div class="container">
<div class="hdr">
<h1>Backend Manager <span class="badge" id="count">0</span></h1>
<button class="logout" id="btnLogout">Logout</button>
</div>
<div class="sub">Cek: <a href="/latency" target="_blank" style="color:#60a5fa">/latency</a> · <a href="/cek" target="_blank" style="color:#60a5fa">/cek</a></div>

<div class="card"><label>Tambah backend (1 per baris atau pisah koma)</label>
<textarea id="addInput" placeholder="vpn.contoh.workers.dev&#10;vpn.lain.workers.dev"></textarea>
<div class="row"><button class="btn-green" id="btnAdd">+ Tambah</button><button class="btn-ghost" id="btnSet">Ganti Semua</button></div></div>

<div class="card"><label>Daftar (urut tercepat)</label><ul class="list" id="list"></ul>
<div class="row"><button class="btn-danger" id="btnClear">Kosongkan</button><button class="btn-ghost" id="btnRefresh">Refresh</button></div></div>
</div><div class="toast" id="toast"></div><script>
const $=(i)=>document.getElementById(i);
function toast(m,e){const t=$('toast');t.textContent=m;t.className='toast show'+(e?' error':'');clearTimeout(t._tid);t._tid=setTimeout(()=>t.className='toast',2200);}
function api(p,m='GET',b){const u=new URL(p,location.origin);const o={method:m,headers:{'Content-Type':'application/json'}};if(b)o.body=JSON.stringify(b);return fetch(u,o).then(async r=>{
  if(r.status===401){location.reload();throw new Error('Sesi berakhir, silakan login ulang');}
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);return j;});}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function msClass(ms,cool){if(cool)return'cool';if(ms==null)return'';if(ms<300)return'fast';if(ms>1500)return'slow';return'';}
function render(data){const hs=data.hosts||[];const lat=data.latency||[];const lm={};lat.forEach(l=>lm[l.host]={ms:l.ms,cool:l.cooldown});
$('count').textContent=hs.length;const ul=$('list');if(!hs.length){ul.innerHTML='<div class="empty">Belum ada backend.</div>';return;}
ul.innerHTML=hs.map((h,i)=>{const info=lm[h]||{};const ms=info.ms;const cool=info.cool;const t=cool?('⏱ '+cool+'s'):(ms==null?'?':ms+'ms');
return '<li><span class="idx">'+(i+1)+'.</span><span class="host">'+esc(h)+'</span><span class="ms '+msClass(ms,cool)+'">'+t+'</span><button class="btn-danger" data-h="'+esc(h)+'">Hapus</button></li>';}).join('');
ul.querySelectorAll('button[data-h]').forEach(b=>b.onclick=async()=>{if(!confirm('Hapus '+b.dataset.h+'?'))return;try{await api('/set/api/delete','POST',{host:b.dataset.h});refresh();toast('Dihapus');}catch(e){toast(e.message,1);}});}
async function refresh(){try{const r=await api('/set/api/list');render(r);}catch(e){toast(e.message,1);}}
$('btnLogout').onclick=async()=>{await fetch('/set/logout',{method:'POST'});location.reload();};
$('btnAdd').onclick=async()=>{const h=$('addInput').value.trim();if(!h)return toast('Isi',1);try{await api('/set/api/add','POST',{host:h});$('addInput').value='';refresh();toast('OK');}catch(e){toast(e.message,1);}};
$('btnSet').onclick=async()=>{const h=$('addInput').value.trim();if(!h)return toast('Isi',1);if(!confirm('Ganti SEMUA?'))return;try{await api('/set/api/set','POST',{host:h});$('addInput').value='';refresh();toast('OK');}catch(e){toast(e.message,1);}};
$('btnClear').onclick=async()=>{if(!confirm('Kosongkan?'))return;try{await api('/set/api/clear','POST');refresh();toast('OK');}catch(e){toast(e.message,1);}};
$('btnRefresh').onclick=refresh;
refresh();setInterval(refresh,10000);
</script></body></html>`;
          }
