'use strict';

const crypto = require('crypto');

const COST_AUTH_COOKIE_NAME = 'cost_auth_gate_v2';
const COST_AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const COST_COOKIE_HMAC_SECRET =
  process.env.COST_COOKIE_SECRET || 'cost-analysis-gate-static-hmac-secret-change-me';
const LEGACY_APP_PASSWORD = 'Ali Ab882674..';

const USERNAME_RE = /^[\p{L}\p{N}._-]{2,64}$/u;

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (_) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function requestIsHttps(req) {
  if (req.secure) return true;
  const p = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return p === 'https';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (expected.length !== 64) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function signSessionPayload(session) {
  const payload = JSON.stringify({
    v: 2,
    exp: session.exp,
    uid: session.uid,
    uname: session.uname,
    role: session.role,
  });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', COST_COOKIE_HMAC_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySessionToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const lastDot = tokenStr.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const b64 = tokenStr.slice(0, lastDot);
  const sig = tokenStr.slice(lastDot + 1);
  const expSig = crypto.createHmac('sha256', COST_COOKIE_HMAC_SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || payload.v !== 2 || typeof payload.exp !== 'number') return null;
  if (payload.exp <= Date.now()) return null;
  if (typeof payload.uid !== 'number' || !payload.uname || !payload.role) return null;
  if (payload.role !== 'admin' && payload.role !== 'user') return null;
  return {
    uid: payload.uid,
    uname: String(payload.uname),
    role: payload.role,
    exp: payload.exp,
  };
}

function getSession(req) {
  const raw = parseCookies(req.headers.cookie || '')[COST_AUTH_COOKIE_NAME];
  return raw ? verifySessionToken(raw) : null;
}

function isAuthed(req) {
  return !!getSession(req);
}

function setAuthCookie(res, req, session) {
  const token = signSessionPayload({
    exp: Date.now() + COST_AUTH_COOKIE_MAX_AGE_MS,
    uid: session.uid,
    uname: session.uname,
    role: session.role,
  });
  const encoded = encodeURIComponent(token);
  const maxAgeSec = Math.floor(COST_AUTH_COOKIE_MAX_AGE_MS / 1000);
  let cookie = `${COST_AUTH_COOKIE_NAME}=${encoded}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`;
  if (requestIsHttps(req)) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function clearAuthCookie(res, req) {
  let cookie = `${COST_AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  if (requestIsHttps(req)) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function normalizeUsername(input) {
  return String(input || '').trim();
}

function validateUsername(username) {
  const u = normalizeUsername(username);
  if (!USERNAME_RE.test(u)) {
    return { ok: false, error: 'Kullanıcı adı 2–64 karakter; harf, rakam, . _ - kullanılabilir.' };
  }
  return { ok: true, username: u };
}

function validateRole(role) {
  const r = String(role || 'user').trim().toLowerCase();
  if (r !== 'admin' && r !== 'user') return { ok: false, error: 'Rol admin veya user olmalı.' };
  return { ok: true, role: r };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 4) {
    return { ok: false, error: 'Parola en az 4 karakter olmalı.' };
  }
  return { ok: true, password };
}

async function ensureUsersTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fb_cost.kullanicilar (
      id            SERIAL PRIMARY KEY,
      kullanici_adi TEXT NOT NULL,
      parola_hash   TEXT NOT NULL,
      rol           TEXT NOT NULL DEFAULT 'user' CHECK (rol IN ('admin', 'user')),
      aktif         BOOLEAN NOT NULL DEFAULT TRUE,
      olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kullanicilar_adi_lower
      ON fb_cost.kullanicilar (LOWER(kullanici_adi));
  `);
}

async function findUserByUsername(pool, username) {
  const u = normalizeUsername(username);
  if (!u) return null;
  const { rows } = await pool.query(
    `SELECT id, kullanici_adi, parola_hash, rol, aktif, olusturma
     FROM fb_cost.kullanicilar
     WHERE LOWER(kullanici_adi) = LOWER($1)
     LIMIT 1`,
    [u]
  );
  return rows[0] || null;
}

async function insertUser(pool, username, password, role) {
  const hash = hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO fb_cost.kullanicilar (kullanici_adi, parola_hash, rol)
     VALUES ($1, $2, $3)
     RETURNING id, kullanici_adi, rol, aktif, olusturma`,
    [username, hash, role]
  );
  return rows[0];
}

async function ensureBootstrapUsers(pool) {
  await ensureUsersTable(pool);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM fb_cost.kullanicilar`);
  const count = rows[0]?.n || 0;
  if (count > 0) return;

  const adminUser =
    (process.env.COST_BOOTSTRAP_ADMIN_USER || 'admin').trim() || 'admin';
  const adminPass =
    process.env.COST_BOOTSTRAP_ADMIN_PASSWORD || LEGACY_APP_PASSWORD;

  await insertUser(pool, adminUser, adminPass, 'admin');
  await insertUser(pool, 'Elvan', '2528', 'user');
  console.log(
    `[auth] İlk kullanıcılar oluşturuldu: admin="${adminUser}", user="Elvan" (parolaları güvenli tutun).`
  );
}

async function authenticateUser(pool, username, password) {
  const row = await findUserByUsername(pool, username);
  if (!row || !row.aktif) return null;
  if (!verifyPassword(password, row.parola_hash)) return null;
  return {
    id: row.id,
    kullanici_adi: row.kullanici_adi,
    rol: row.rol,
  };
}

async function listUsers(pool) {
  const { rows } = await pool.query(
    `SELECT id, kullanici_adi, rol, aktif, olusturma
     FROM fb_cost.kullanicilar
     ORDER BY LOWER(kullanici_adi)`
  );
  return rows;
}

async function createUser(pool, username, password, role) {
  const vu = validateUsername(username);
  if (!vu.ok) return { error: vu.error };
  const vp = validatePassword(password);
  if (!vp.ok) return { error: vp.error };
  const vr = validateRole(role);
  if (!vr.ok) return { error: vr.error };

  const existing = await findUserByUsername(pool, vu.username);
  if (existing) return { error: 'Bu kullanıcı adı zaten kayıtlı.' };

  const row = await insertUser(pool, vu.username, vp.password, vr.role);
  return { user: row };
}

function attachUser(req, _res, next) {
  req.costUser = getSession(req);
  next();
}

function requireAuth(req, res, next) {
  if (!req.costUser) return res.status(401).json({ error: 'Oturum gerekli' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.costUser) return res.status(401).json({ error: 'Oturum gerekli' });
  if (req.costUser.role !== 'admin') return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  next();
}

function registerAuthRoutes(app, pool) {
  app.post('/api/auth/login', async (req, res) => {
    const username = req.body && req.body.username;
    const password = req.body && req.body.password;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: 'Kullanıcı adı ve parola gerekli' });
    }
    try {
      const user = await authenticateUser(pool, username, password);
      if (!user) return res.status(401).json({ ok: false, error: 'Geçersiz kullanıcı adı veya parola' });
      setAuthCookie(res, req, { uid: user.id, uname: user.kullanici_adi, role: user.rol });
      return res.json({
        ok: true,
        user: { id: user.id, kullanici_adi: user.kullanici_adi, rol: user.rol },
      });
    } catch (err) {
      console.error('auth/login:', err);
      return res.status(500).json({ ok: false, error: 'Giriş işlemi başarısız' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res, req);
    return res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Oturum gerekli' });
    return res.json({
      id: session.uid,
      kullanici_adi: session.uname,
      rol: session.role,
    });
  });

  app.get('/api/auth/users', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const users = await listUsers(pool);
      res.json(users);
    } catch (err) {
      console.error('auth/users GET:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/users', requireAuth, requireAdmin, async (req, res) => {
    const { kullanici_adi, password, rol } = req.body || {};
    try {
      const out = await createUser(pool, kullanici_adi, password, rol);
      if (out.error) return res.status(400).json({ error: out.error });
      return res.status(201).json({ ok: true, user: out.user });
    } catch (err) {
      console.error('auth/users POST:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  COST_AUTH_COOKIE_NAME,
  ensureBootstrapUsers,
  getSession,
  isAuthed,
  setAuthCookie,
  clearAuthCookie,
  attachUser,
  requireAuth,
  requireAdmin,
  registerAuthRoutes,
};
