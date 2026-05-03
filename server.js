// Octuna - tiny image host
// Zero framework. One dep (busboy). JSON metadata. Streams everything.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

if (!config.adminHash || !config.adminSalt || !config.adminUser) {
  console.error('No admin credentials configured. Run:  npm run setup');
  process.exit(1);
}

const SITE_NAME = config.siteName || 'Octuna';
const STARTED_AT = Date.now();
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const META_PATH = path.join(ROOT, 'data', 'meta.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Metadata: tiny JSON store, kept in memory, persisted on writes ---
let meta = {};
if (fs.existsSync(META_PATH)) {
  try { meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { meta = {}; }
}
let saveTimer = null;
function saveMeta() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = META_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, META_PATH);
  }, 50);
}

// --- Helpers ---
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm'
};
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
  html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript',
  json: 'application/json', svg: 'image/svg+xml', ico: 'image/x-icon', txt: 'text/plain'
};
function mimeOf(filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
function makeId(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
function uniqueId() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = makeId(config.idLength);
    if (!meta[id]) return id;
  }
  for (;;) {
    const id = makeId(config.idLength + 2);
    if (!meta[id]) return id;
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// --- Magic-byte validation ---
function magicMatches(buf, mime) {
  if (!buf || buf.length < 4) return false;
  switch (mime) {
    case 'image/png':
      return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
          && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
    case 'image/jpeg':
      return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    case 'image/gif':
      return buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
          && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61;
    case 'image/webp':
      return buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
    case 'video/mp4':
      return buf.length >= 8 && buf.slice(4, 8).toString() === 'ftyp';
    case 'video/webm':
      return buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
  }
  return false;
}

// --- Cached static assets & templates ---
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const STATIC_FILES = {};
for (const name of fs.readdirSync(PUBLIC_DIR)) {
  STATIC_FILES['/' + name] = {
    body: fs.readFileSync(path.join(PUBLIC_DIR, name)),
    type: mimeOf(name)
  };
}
const TPL_INDEX = STATIC_FILES['/index.html'].body.toString();
const TPL_IMAGE = fs.readFileSync(path.join(VIEWS_DIR, 'image.html'), 'utf8');
const TPL_ADMIN = fs.readFileSync(path.join(VIEWS_DIR, 'admin.html'), 'utf8');
const TPL_ABOUT = fs.readFileSync(path.join(VIEWS_DIR, 'about.html'), 'utf8');

// --- Public-safe config injected into HTML pages ---
const CLIENT_CONFIG = JSON.stringify({
  siteName: SITE_NAME,
  addressBarMode: config.addressBarMode || 'real',
  addressBarFixed: config.addressBarFixed || ''
});

// --- Auth: scrypt + stateless HMAC-signed cookie ---
// The cookie carries the signed session. No server-side state, no expiration:
// it stays valid until the user clears the cookie (or the secret is rotated).
const ADMIN_SALT = Buffer.from(config.adminSalt, 'base64');
const ADMIN_HASH = Buffer.from(config.adminHash, 'base64');
const SESSION_SECRET = Buffer.from(config.sessionSecret || '', 'base64');
if (SESSION_SECRET.length < 16) {
  console.error('config.sessionSecret is missing or too short. Run:  npm run setup');
  process.exit(1);
}
const COOKIE_NAME = 'octuna_sid';
const COOKIE_SECURE = /^https:/i.test(config.publicUrl || '');
const COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60; // ~10 years; effectively forever

function verifyPassword(user, password) {
  const userBuf = Buffer.from(user || '');
  const expectedUserBuf = Buffer.from(config.adminUser);
  const userOk = userBuf.length === expectedUserBuf.length
    && crypto.timingSafeEqual(userBuf, expectedUserBuf);
  let candidate;
  try {
    candidate = crypto.scryptSync(String(password || ''), ADMIN_SALT, 64, { N: 16384, r: 8, p: 1 });
  } catch { return false; }
  const passOk = candidate.length === ADMIN_HASH.length
    && crypto.timingSafeEqual(candidate, ADMIN_HASH);
  return userOk && passOk;
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function signSession(user) {
  const issued = Date.now().toString(36);
  const payload = user + '.' + issued;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function getSession(req) {
  const c = parseCookies(req);
  const tok = c[COOKIE_NAME];
  if (!tok) return null;
  const i1 = tok.indexOf('.');
  const i2 = tok.lastIndexOf('.');
  if (i1 < 0 || i1 === i2) return null;
  const user = tok.slice(0, i1);
  const issued = tok.slice(i1 + 1, i2);
  const sig = tok.slice(i2 + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(user + '.' + issued).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (user !== config.adminUser) return null; // user was renamed → invalidate
  return { user };
}

function setSessionCookie(res, user) {
  const value = signSession(user);
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}


// --- Rate limiter ---
function makeLimiter(maxHits, windowMs) {
  const hits = new Map();
  return function check(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (arr.length >= maxHits) { hits.set(ip, arr); return false; }
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    return true;
  };
}
const adminLimiter = makeLimiter(120, 5 * 60 * 1000);
const loginLimiter = makeLimiter(8, 15 * 60 * 1000);
const uploadLimiter = makeLimiter(60, 10 * 60 * 1000);

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// --- Security headers ---
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'interest-cohort=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
const HTML_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'";
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox";

// --- Response helpers ---
function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS, ...extra
  });
  res.end(body);
}
function sendHtml(res, code, html, extra = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': HTML_CSP,
    ...SECURITY_HEADERS, ...extra
  });
  res.end(html);
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
  res.end(text);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location, ...SECURITY_HEADERS });
  res.end();
}
function readJsonBody(req, cb) {
  let buf = '';
  req.on('data', c => {
    buf += c;
    if (buf.length > 1e5) { req.destroy(); cb(new Error('body too large')); }
  });
  req.on('end', () => {
    try { cb(null, buf ? JSON.parse(buf) : {}); }
    catch (e) { cb(e); }
  });
}

// --- Templating: inject the safe client config into pages ---
function withConfig(tpl) {
  return tpl.replace('{{CONFIG_JSON}}', CLIENT_CONFIG);
}
const RENDERED_INDEX = withConfig(
  TPL_INDEX.includes('{{CONFIG_JSON}}')
    ? TPL_INDEX
    : TPL_INDEX.replace('</body>', '<script>window.OCTUNA=' + CLIENT_CONFIG + ';</script></body>')
);
const RENDERED_ADMIN = withConfig(TPL_ADMIN);
const RENDERED_ABOUT = withConfig(TPL_ABOUT);

// --- Handlers ---
function handleUpload(req, res) {
  const ip = clientIp(req);
  if (!uploadLimiter(ip)) return sendJson(res, 429, { error: 'Too many uploads, slow down.' });

  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { fileSize: config.maxUploadMB * 1024 * 1024, files: 1 } }); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  let fileSeen = false;
  let responded = false;
  const respond = (code, obj) => {
    if (responded) return;
    responded = true;
    sendJson(res, code, obj);
  };

  bb.on('file', (_field, stream, info) => {
    fileSeen = true;
    const { filename, mimeType } = info;
    if (!config.allowedTypes.includes(mimeType)) {
      stream.resume();
      return respond(400, { error: 'Unsupported file type: ' + mimeType });
    }
    const id = uniqueId();
    const ext = EXT_BY_MIME[mimeType] || path.extname(filename).slice(1).toLowerCase() || 'bin';
    const filepath = path.join(UPLOAD_DIR, id + '.' + ext);
    const out = fs.createWriteStream(filepath);

    let size = 0;
    let limited = false;
    let rejected = false;
    let magicChecked = false;
    let header = Buffer.alloc(0);

    const reject = (code, err) => {
      if (rejected) return;
      rejected = true;
      stream.unpipe(out);
      out.destroy();
      fs.unlink(filepath, () => {});
      stream.on('data', () => {});
      respond(code, { error: err });
    };

    stream.on('data', d => {
      size += d.length;
      if (!magicChecked && !rejected) {
        header = header.length ? Buffer.concat([header, d]) : Buffer.from(d);
        if (header.length >= 16) {
          magicChecked = true;
          if (!magicMatches(header, mimeType)) reject(400, 'File contents do not match its type.');
        }
      }
    });
    stream.on('limit', () => { limited = true; reject(413, 'File too large'); });
    stream.on('end', () => {
      if (!magicChecked && !limited && !rejected) {
        magicChecked = true;
        if (!magicMatches(header, mimeType)) reject(400, 'File contents do not match its type.');
      }
    });
    stream.pipe(out);
    out.on('finish', () => {
      if (limited || rejected || responded) return;
      meta[id] = { ext, original_name: filename, size, mime: mimeType, uploaded_at: Date.now() };
      saveMeta();
      respond(200, {
        id, ext,
        url: `${config.publicUrl}/${id}.${ext}`,
        viewUrl: `${config.publicUrl}/${id}`
      });
    });
    out.on('error', err => { if (!rejected) respond(500, { error: err.message }); });
  });
  bb.on('error', err => respond(400, { error: err.message }));
  bb.on('close', () => { if (!fileSeen) respond(400, { error: 'No file' }); });
  req.pipe(bb);
}

// --- Public stats (cheap, cached briefly) ---
let statsCache = { at: 0, body: null };
function computeStats() {
  if (Date.now() - statsCache.at < 3000 && statsCache.body) return statsCache.body;
  let count = 0, totalSize = 0, oldest = null;
  for (const id in meta) {
    const r = meta[id];
    count++;
    totalSize += r.size || 0;
    if (oldest == null || r.uploaded_at < oldest) oldest = r.uploaded_at;
  }
  const body = { count, totalSize, since: oldest, started: STARTED_AT };
  statsCache = { at: Date.now(), body };
  return body;
}

// --- Login / logout / who-am-i ---
function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!loginLimiter(ip)) return sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
  readJsonBody(req, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Bad JSON' });
    if (!verifyPassword(body.user, body.password))
      return sendJson(res, 401, { error: 'Invalid username or password.' });
    setSessionCookie(res, config.adminUser);
    sendJson(res, 200, { ok: true, user: config.adminUser });
  });
}
function handleLogout(_req, res) {
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}
function handleMe(req, res) {
  const s = getSession(req);
  sendJson(res, 200, s ? { user: s.user } : { user: null });
}

function handleAdminList(_req, res) {
  const list = Object.entries(meta).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.uploaded_at - a.uploaded_at);
  sendJson(res, 200, list);
}
function handleAdminRename(req, res) {
  readJsonBody(req, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Bad JSON' });
    const { id, newId } = body;
    if (!id || !newId || !/^[a-z0-9]{2,16}$/.test(newId))
      return sendJson(res, 400, { error: 'Bad id' });
    const row = meta[id];
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    if (meta[newId]) return sendJson(res, 409, { error: 'Id already taken' });
    fs.renameSync(
      path.join(UPLOAD_DIR, `${id}.${row.ext}`),
      path.join(UPLOAD_DIR, `${newId}.${row.ext}`)
    );
    meta[newId] = row;
    delete meta[id];
    saveMeta();
    sendJson(res, 200, { ok: true, id: newId });
  });
}
function handleAdminDelete(req, res) {
  readJsonBody(req, (err, body) => {
    if (err) return sendJson(res, 400, { error: 'Bad JSON' });
    const { id } = body;
    const row = meta[id];
    if (!row) return sendJson(res, 404, { error: 'Not found' });
    const p = path.join(UPLOAD_DIR, `${id}.${row.ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    delete meta[id];
    saveMeta();
    sendJson(res, 200, { ok: true });
  });
}

function serveImageFile(req, res, id, ext) {
  const row = meta[id];
  if (!row || row.ext !== ext) return sendText(res, 404, 'Not found');
  const filepath = path.join(UPLOAD_DIR, `${id}.${row.ext}`);
  fs.stat(filepath, (err, st) => {
    if (err) return sendText(res, 404, 'Not found');
    const headers = {
      'Content-Type': row.mime || mimeOf(filepath),
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': FILE_CSP,
      'Content-Disposition': 'inline',
      ...SECURITY_HEADERS
    };
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        headers['Accept-Ranges'] = 'bytes';
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        return fs.createReadStream(filepath, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, headers);
    fs.createReadStream(filepath).pipe(res);
  });
}

function renderImagePage(id) {
  const row = meta[id];
  if (!row) return null;
  const fileUrl = `/${id}.${row.ext}`;
  const isVideo = row.mime && row.mime.startsWith('video/');
  const media = isVideo
    ? `<video src="${fileUrl}" controls autoplay loop muted></video>`
    : `<img src="${fileUrl}" alt="${id}">`;
  return TPL_IMAGE
    .replaceAll('{{ID}}', id)
    .replaceAll('{{EXT}}', row.ext)
    .replaceAll('{{URL}}', `${config.publicUrl}${fileUrl}`)
    .replaceAll('{{SIZE}}', formatBytes(row.size))
    .replaceAll('{{DATE}}', new Date(row.uploaded_at).toUTCString())
    .replaceAll('{{ORIGINAL}}', escapeHtml(row.original_name || ''))
    .replaceAll('{{MEDIA}}', media)
    .replaceAll('{{CONFIG_JSON}}', CLIENT_CONFIG);
}

// --- Router ---
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

  // Index — inject config
  if (method === 'GET' && url === '/') {
    return sendHtml(res, 200, RENDERED_INDEX);
  }

  // About page
  if (method === 'GET' && (url === '/about' || url === '/about/')) {
    return sendHtml(res, 200, RENDERED_ABOUT);
  }

  // Other static assets
  if (method === 'GET' && STATIC_FILES[url] && url !== '/index.html') {
    const f = STATIC_FILES[url];
    res.writeHead(200, {
      'Content-Type': f.type,
      'Content-Length': f.body.length,
      'Cache-Control': 'public, max-age=3600',
      ...SECURITY_HEADERS
    });
    return res.end(f.body);
  }

  if (method === 'POST' && url === '/upload') return handleUpload(req, res);

  // Public APIs
  if (method === 'GET' && url === '/api/stats') {
    return sendJson(res, 200, computeStats(), { 'Cache-Control': 'public, max-age=3' });
  }

  // Login / who-am-i (public)
  if (method === 'POST' && url === '/admin/login') return handleLogin(req, res);
  if (method === 'POST' && url === '/admin/logout') return handleLogout(req, res);
  if (method === 'GET' && url === '/admin/me') return handleMe(req, res);

  // Authenticated admin routes
  if (url.startsWith('/admin')) {
    const ip = clientIp(req);
    if (!adminLimiter(ip)) return sendText(res, 429, 'Too many admin requests.');
    const session = getSession(req);
    if (!session) {
      if (method === 'GET' && url === '/admin') return redirect(res, '/');
      return sendJson(res, 401, { error: 'Not authenticated' });
    }
    // Sliding refresh: re-issue the cookie so browsers don't time it out (~400d cap).
    setSessionCookie(res, session.user);
    if (method === 'GET' && url === '/admin') return sendHtml(res, 200, RENDERED_ADMIN);
    if (method === 'GET' && url === '/admin/list') return handleAdminList(req, res);
    if (method === 'POST' && url === '/admin/rename') return handleAdminRename(req, res);
    if (method === 'POST' && url === '/admin/delete') return handleAdminDelete(req, res);
    return sendText(res, 404, 'Not found');
  }

  let m = url.match(/^\/([a-z0-9]+)\.([a-z0-9]+)$/i);
  if (m && method === 'GET') return serveImageFile(req, res, m[1].toLowerCase(), m[2].toLowerCase());

  m = url.match(/^\/([a-z0-9]+)$/i);
  if (m && method === 'GET') {
    const html = renderImagePage(m[1].toLowerCase());
    if (html) return sendHtml(res, 200, html);
  }

  sendText(res, 404, 'Not found');
});

server.listen(config.port, () => {
  console.log(`${SITE_NAME} running on ${config.publicUrl} (port ${config.port})`);
  console.log(`admin: ${config.publicUrl}/admin  (user: ${config.adminUser})`);
  const m = process.memoryUsage();
  console.log(`memory: rss=${(m.rss / 1024 / 1024).toFixed(1)}MB heap=${(m.heapUsed / 1024 / 1024).toFixed(1)}MB`);
});
