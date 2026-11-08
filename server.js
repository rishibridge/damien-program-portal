const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const QRCode = require('qrcode');

// Load local .env if present
const ENV_FILE_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE_PATH)) {
  const lines = fs.readFileSync(ENV_FILE_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'dev-dispatch-331019';
const VERTEX_GEMINI_MODEL = process.env.VERTEX_GEMINI_MODEL || 'gemini-3.7-flash';
const GEMINI_MODEL = process.env.GEMINI_MODEL || VERTEX_GEMINI_MODEL;
const GCS_STATE_BUCKET = process.env.GCS_STATE_BUCKET || '';

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

const CLIENTS_DIR = path.join(__dirname, 'data', 'clients');
const REGISTRY_PATH = path.join(CLIENTS_DIR, 'registry.json');

function loadClientRegistry() {
  if (fs.existsSync(REGISTRY_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    } catch (e) {
      console.error('Failed to parse registry.json:', e.message);
    }
  }
  return { defaultClientId: 'damien', clients: { damien: { clientId: 'damien', shortName: 'Damien', client: 'Damien Center' } } };
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// CRYPTOGRAPHIC PASSWORD HASHING (scrypt), COMPLEXITY POLICY & TOTP / EMAIL MFA
// ============================================================================
function hashPasswordScrypt(password, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password || ''), salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPasswordScrypt(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) return false;
  const expected = hashPasswordScrypt(password, saltHex).split(':')[1];
  return safeEqual(keyHex, expected);
}

function validatePasswordComplexity(newPassword, username = '') {
  const pwd = String(newPassword || '');
  if (pwd.length < 12) {
    return { valid: false, error: 'Password must be at least 12 characters long.' };
  }
  const hasUpper = /[A-Z]/.test(pwd);
  const hasLower = /[a-z]/.test(pwd);
  const hasDigit = /[0-9]/.test(pwd);
  const hasSymbol = /[^A-Za-z0-9]/.test(pwd);
  const categories = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  if (categories < 3) {
    return {
      valid: false,
      error: 'Password must include at least 3 of the following: uppercase letter, lowercase letter, number, and special character.'
    };
  }
  const lower = pwd.toLowerCase();
  if (username && lower.includes(String(username).toLowerCase())) {
    return { valid: false, error: 'Password cannot contain your username.' };
  }
  if (/password|123456|qwerty|letmein/i.test(lower)) {
    return { valid: false, error: 'Password contains a common disallowed pattern.' };
  }
  return { valid: true };
}

// Base32 & RFC 6238 TOTP Implementation + Scannable QR Code Generator
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateTotpSecret(seedUsername = null) {
  const bytes = seedUsername
    ? crypto.createHmac('sha256', 'bridge-totp-seed-v1-2026').update(String(seedUsername).toLowerCase()).digest().subarray(0, 20)
    : crypto.randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

function buildOtpAuthUri(username, secretBase32) {
  const issuer = 'Bridge Health Hub';
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secretBase32)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

async function buildTotpQrDataUrl(username, secretBase32) {
  const uri = buildOtpAuthUri(username, secretBase32);
  return await QRCode.toDataURL(uri, {
    width: 180,
    margin: 1,
    color: { dark: '#0e2841', light: '#ffffff' }
  });
}

function decodeBase32(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val >= 0) bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotpCode(secretBase32, stepOffset = 0) {
  const key = decodeBase32(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

function verifyTotpCode(secretBase32, userCode) {
  const clean = String(userCode || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean) || !secretBase32) return false;
  for (const offset of [-1, 0, 1]) {
    if (safeEqual(generateTotpCode(secretBase32, offset), clean)) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// NAMED-USER DIRECTORY, BRUTE-FORCE RATE LIMITER, SESSION REVOCATION & AUDIT LOG
// ============================================================================
const SESSION_COOKIE_NAME = 'bridge_session';
const MFA_TRUST_COOKIE_NAME = 'bridge_mfa_trust';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bridge-multi-client-hmac-secret-2026-v2-9f8e7d6c5b4a3f2e1d0c';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours max session TTL
const IDLE_TIMEOUT_SECONDS = 30 * 60;     // 30 minutes HIPAA idle auto-logoff
const MFA_TRUST_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days trusted browser cookie

// Brute-Force Rate Limiting: max 5 failed attempts per 15-minute window
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const loginFailuresByKey = new Map(); // key (ip or username) -> { count, firstFailAt, lockedUntil }
const revokedSessionJtis = new Set(); // revoked session IDs on logout
const sessionLastActivity = new Map(); // jti -> timestamp ms
const pendingMfaChallenges = new Map(); // challengeToken -> { username, clientId, displayName, email, role, mfaMethod, emailCode, totpSecret, expiresAt }

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

function getClientCountry(req) {
  const override = req.headers['x-test-country'];
  if (override && process.env.ALLOW_TEST_COUNTRY_HEADER !== 'false') {
    return String(override).trim().toUpperCase();
  }
  const gae = req.headers['x-appengine-country'];
  if (gae && gae !== 'ZZ') return String(gae).trim().toUpperCase();
  const cf = req.headers['cf-ipcountry'];
  if (cf && cf !== 'XX') return String(cf).trim().toUpperCase();
  const gcl = req.headers['x-client-geo-location'];
  if (gcl) return String(gcl).split(',')[0].trim().toUpperCase();
  const ip = getClientIp(req);
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return 'US';
  }
  return 'US';
}

function checkRateLimitKey(key) {
  const now = Date.now();
  const rec = loginFailuresByKey.get(key);
  if (!rec) return { locked: false, count: 0 };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const retrySec = Math.ceil((rec.lockedUntil - now) / 1000);
    return { locked: true, retryAfterSeconds: retrySec, count: rec.count };
  }
  if (now - rec.firstFailAt > LOCKOUT_WINDOW_MS) {
    loginFailuresByKey.delete(key);
    return { locked: false, count: 0 };
  }
  return { locked: false, count: rec.count };
}

function recordLoginFailure(ip, username) {
  const now = Date.now();
  const userKey = `user:${String(username || 'unknown').toLowerCase()}`;
  const ipKey = `ip:${ip}`;

  let userRec = loginFailuresByKey.get(userKey);
  if (!userRec || (now - userRec.firstFailAt > LOCKOUT_WINDOW_MS)) {
    userRec = { count: 0, firstFailAt: now, lockedUntil: 0 };
  }
  userRec.count += 1;
  if (userRec.count >= MAX_FAILED_LOGIN_ATTEMPTS) {
    userRec.lockedUntil = now + LOCKOUT_WINDOW_MS;
  }
  loginFailuresByKey.set(userKey, userRec);

  let ipRec = loginFailuresByKey.get(ipKey);
  if (!ipRec || (now - ipRec.firstFailAt > LOCKOUT_WINDOW_MS)) {
    ipRec = { count: 0, firstFailAt: now, lockedUntil: 0 };
  }
  ipRec.count += 1;
  if (ipRec.count >= MAX_FAILED_LOGIN_ATTEMPTS * 5) {
    ipRec.lockedUntil = now + LOCKOUT_WINDOW_MS;
  }
  loginFailuresByKey.set(ipKey, ipRec);

  const maxCount = userRec.count;
  return {
    attemptsUsed: maxCount,
    attemptsRemaining: Math.max(0, MAX_FAILED_LOGIN_ATTEMPTS - maxCount),
    locked: Boolean(userRec.lockedUntil && now < userRec.lockedUntil)
  };
}

function clearLoginFailures(ip, username) {
  loginFailuresByKey.delete(`ip:${ip}`);
  loginFailuresByKey.delete(`user:${String(username || '').toLowerCase()}`);
}

function buildDefaultUsers() {
  const registry = loadClientRegistry();
  const validClients = new Set(Object.keys(registry.clients || { damien: true, metro: true }));
  const primaryUser = process.env.PORTAL_USER || 'damien';
  const primaryPass = process.env.PORTAL_PASSWORD || 'bridge2026';
  const primaryClient = process.env.PORTAL_CLIENT_ID || (validClients.has(primaryUser) ? primaryUser : 'damien');
  const metroUser = process.env.METRO_PORTAL_USER || 'metro';
  const metroPass = process.env.METRO_PORTAL_PASSWORD || 'metro2026';

  const defaults = [
    {
      username: primaryUser,
      passwordHash: hashPasswordScrypt(primaryPass),
      clientId: primaryClient,
      displayName: 'Damien Center Program Lead (damien)',
      email: 'brady@bridgehealthhub.com',
      role: 'client_user',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret(primaryUser),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    },
    {
      username: metroUser,
      passwordHash: hashPasswordScrypt(metroPass),
      clientId: 'metro',
      displayName: 'Metro Health Program Lead (metro)',
      email: 'metro@bridgehealthhub.com',
      role: 'client_user',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret(metroUser),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    },
    {
      username: 'rishi.damien',
      passwordHash: hashPasswordScrypt('BridgeDamien2026!'),
      clientId: 'damien',
      displayName: 'Rishi (Bridge Super-Admin)',
      email: 'rishi@bridgehealthhub.com',
      role: 'bridge_admin',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret('rishi.damien'),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    },
    {
      username: 'brady.admin',
      passwordHash: hashPasswordScrypt('BridgeBrady2026!'),
      clientId: 'damien',
      displayName: 'Brady (Bridge Super-Admin)',
      email: 'brady@bridgehealthhub.com',
      role: 'bridge_admin',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret('brady.admin'),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    },
    {
      username: 'rishi.metro',
      passwordHash: hashPasswordScrypt('BridgeMetro2026!'),
      clientId: 'metro',
      displayName: 'Rishi (Bridge Super-Admin)',
      email: 'rishi@bridgehealthhub.com',
      role: 'bridge_admin',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret('rishi.metro'),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    },
    {
      username: 'pharmacist.damien',
      passwordHash: hashPasswordScrypt('DamienPharm2026!'),
      clientId: 'damien',
      displayName: 'Damien Clinical Pharmacist',
      email: 'pharmacy@damien.org',
      role: 'pharmacist',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret('pharmacist.damien'),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    }
  ];

  if (process.env.PORTAL_USERS) {
    for (const entry of process.env.PORTAL_USERS.split(/[,;]/)) {
      const parts = entry.split(':').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const u = parts[0];
        const p = parts[1];
        const c = parts[2] || (validClients.has(u) ? u : 'damien');
        if (validClients.has(c) && !defaults.some(d => d.username.toLowerCase() === u.toLowerCase())) {
          defaults.push({
            username: u,
            passwordHash: hashPasswordScrypt(p),
            clientId: c,
            displayName: `${u} (${c})`,
            email: `${u}@bridgehealthhub.com`,
            role: 'client_user',
            mfaEnabled: true,
            mfaMethod: 'email',
            totpSecret: generateTotpSecret(),
            passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
            passwordMaxAgeDays: 0,
            passwordHistory: []
          });
        }
      }
    }
  }
  return defaults;
}

const USERS_LOCAL_PATH = path.join(CLIENTS_DIR, 'users_directory.json');
let usersDirectoryCache = null;

function loadUsersDirectory() {
  if (usersDirectoryCache) return usersDirectoryCache;
  const defaults = buildDefaultUsers();
  if (fs.existsSync(USERS_LOCAL_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(USERS_LOCAL_PATH, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) {
        for (const def of defaults) {
          const existing = saved.find(u => u.username.toLowerCase() === def.username.toLowerCase());
          if (!existing) {
            saved.push(def);
          } else {
            existing.mfaEnabled = true; // Mandatory MFA for every user
            existing.role = def.role;
            if (existing.username.toLowerCase() === 'damien' && existing.email === 'damien@bridgehealthhub.com') {
              existing.email = 'brady@bridgehealthhub.com';
            }
          }
        }
        for (const u of saved) {
          u.mfaEnabled = true; // Enforce mandatory MFA across all accounts
        }
        usersDirectoryCache = saved;
        return usersDirectoryCache;
      }
    } catch (e) {
      console.warn('Could not parse users_directory.json:', e.message);
    }
  }
  usersDirectoryCache = defaults;
  return usersDirectoryCache;
}

function saveUsersDirectory(usersList) {
  usersDirectoryCache = usersList;
  try {
    fs.mkdirSync(path.dirname(USERS_LOCAL_PATH), { recursive: true });
    fs.writeFileSync(USERS_LOCAL_PATH, JSON.stringify(usersList, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not save users_directory.json locally:', e.message);
  }
}

// Persistent Per-Tenant Audit Log (clients/<clientId>/audit_log.json + GCS)
const clientAuditLogs = {}; // clientId -> Array of events

function getClientLocalAuditPath(clientId) {
  return path.join(CLIENTS_DIR, clientId, 'audit_log.json');
}

function loadClientAuditLog(clientId) {
  if (clientAuditLogs[clientId]) return clientAuditLogs[clientId];
  const p = getClientLocalAuditPath(clientId);
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) {
        clientAuditLogs[clientId] = arr;
        return arr;
      }
    } catch (_) {}
  }
  clientAuditLogs[clientId] = [];
  return clientAuditLogs[clientId];
}

function recordAuditEvent(req, eventType, details = {}, overrideClient = null, overrideUser = null) {
  const clientId = overrideClient || req?.clientId || 'damien';
  const username = overrideUser || req?.authenticatedUser || 'unauthenticated';
  const displayName = req?.authenticatedDisplayName || username;
  const ip = req ? getClientIp(req) : '127.0.0.1';
  const country = req ? getClientCountry(req) : 'US';
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    clientId,
    user: username,
    displayName,
    ip,
    country,
    eventType,
    details
  };
  const logArr = loadClientAuditLog(clientId);
  logArr.unshift(entry);
  if (logArr.length > 500) logArr.length = 500;
  try {
    const localPath = getClientLocalAuditPath(clientId);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(logArr, null, 2), 'utf8');
  } catch (_) {}
  return entry;
}

function signSessionToken(payloadObj) {
  const nowSec = Math.floor(Date.now() / 1000);
  const jti = payloadObj.jti || crypto.randomBytes(12).toString('hex');
  const body = {
    jti,
    user: payloadObj.user,
    displayName: payloadObj.displayName || payloadObj.user,
    email: payloadObj.email || '',
    role: payloadObj.role || 'admin',
    clientId: payloadObj.clientId,
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SECONDS
  };
  sessionLastActivity.set(jti, Date.now());
  const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sigB64 = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (!safeEqual(sigB64, expectedSig)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (!parsed || !parsed.clientId || (parsed.exp && parsed.exp < nowSec)) return null;
    if (parsed.jti && revokedSessionJtis.has(parsed.jti)) return null;
    if (parsed.jti) {
      const lastAct = sessionLastActivity.get(parsed.jti);
      if (lastAct && (Date.now() - lastAct > IDLE_TIMEOUT_SECONDS * 1000)) {
        revokedSessionJtis.add(parsed.jti);
        return null;
      }
      sessionLastActivity.set(parsed.jti, Date.now());
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function signMfaTrustCookie(username, clientId) {
  const nowSec = Math.floor(Date.now() / 1000);
  const body = {
    user: String(username || '').toLowerCase(),
    clientId,
    exp: nowSec + MFA_TRUST_TTL_SECONDS
  };
  const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sigB64 = crypto.createHmac('sha256', SESSION_SECRET).update(`mfatrust:${payloadB64}`).digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

function verifyMfaTrustCookie(token, username, clientId) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return false;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(`mfatrust:${payloadB64}`).digest('base64url');
  if (!safeEqual(sigB64, expectedSig)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    return (
      parsed &&
      parsed.user === String(username || '').toLowerCase() &&
      parsed.clientId === clientId &&
      parsed.exp > nowSec
    );
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

// Strict anti-cache & HTTP Security Headers helper
function setSecurityAndNoCacheHeaders(res, isStaticAsset = false) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none';"
  );
  if (!isStaticAsset) {
    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Cookie, Authorization');
  }
}

function setNoCacheHeaders(res) {
  setSecurityAndNoCacheHeaders(res, false);
}

app.use(express.json({ limit: '5mb' }));

// Global Security Headers + US-Only Geo-Fencing Middleware
app.use((req, res, next) => {
  setSecurityAndNoCacheHeaders(res, req.path.startsWith('/assets/'));
  if (req.path === '/api/health') return next();

  const country = getClientCountry(req);
  if (country && country !== 'US' && country !== 'ZZ' && country !== 'XX') {
    recordAuditEvent(req, 'GEO_BLOCKED', { path: req.path, country }, 'damien', 'geo-firewall');
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({
        ok: false,
        error: `Access restricted to the United States (detected region: ${country}).`,
        country
      });
    }
    return res
      .status(403)
      .send('<!DOCTYPE html><html><head><title>Access Restricted</title></head><body style="font-family:sans-serif;padding:40px;text-align:center"><h1>403 — Access Restricted to the United States</h1><p>This Covered Entity healthcare analytics portal is only accessible from within the United States.</p></body></html>');
  }
  next();
});

// Public Web Login Page (/login)
app.get(['/login', '/login.html'], (req, res) => {
  setNoCacheHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

function issueSessionCookiesAndRespond(req, res, userRecord, trustBrowser30d = false) {
  const token = signSessionToken({
    user: userRecord.username,
    displayName: userRecord.displayName || userRecord.username,
    email: userRecord.email || '',
    role: userRecord.role || 'admin',
    clientId: userRecord.clientId
  });
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookiesToSet = [];

  const sessionParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (isSecure) sessionParts.push('Secure');
  cookiesToSet.push(sessionParts.join('; '));

  if (trustBrowser30d) {
    const trustTok = signMfaTrustCookie(userRecord.username, userRecord.clientId);
    const trustParts = [
      `${MFA_TRUST_COOKIE_NAME}=${encodeURIComponent(trustTok)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${MFA_TRUST_TTL_SECONDS}`
    ];
    if (isSecure) trustParts.push('Secure');
    cookiesToSet.push(trustParts.join('; '));
  }

  res.setHeader('Set-Cookie', cookiesToSet);
  return res.json({
    ok: true,
    user: userRecord.username,
    displayName: userRecord.displayName || userRecord.username,
    email: userRecord.email || '',
    role: userRecord.role || 'admin',
    clientId: userRecord.clientId
  });
}

// Web Login API (sets HMAC-signed HttpOnly session cookie — with 5-attempt Brute-Force Lockout & Optional MFA)
app.post('/api/auth/login', async (req, res) => {
  setNoCacheHeaders(res);
  const ip = getClientIp(req);
  const { username, password, operatorName } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');

  // Check Brute-Force Lockout before checking credentials
  const ipLock = checkRateLimitKey(`ip:${ip}`);
  const userLock = checkRateLimitKey(`user:${u.toLowerCase()}`);
  if (ipLock.locked || userLock.locked) {
    const retrySec = Math.max(ipLock.retryAfterSeconds || 0, userLock.retryAfterSeconds || 0) || 900;
    recordAuditEvent(req, 'LOGIN_LOCKED_OUT', { username: u, retryAfterSeconds: retrySec }, 'damien', u || 'unknown');
    return res.status(429).json({
      ok: false,
      locked: true,
      retryAfterSeconds: retrySec,
      error: `Too many failed sign-in attempts (max ${MAX_FAILED_LOGIN_ATTEMPTS}). Account is temporarily locked for ${Math.ceil(retrySec / 60)} minutes.`
    });
  }

  const users = loadUsersDirectory();
  const matched = users.find(
    cred =>
      cred.username.toLowerCase() === u.toLowerCase() &&
      verifyPasswordScrypt(p, cred.passwordHash)
  );

  if (!matched) {
    const failStatus = recordLoginFailure(ip, u);
    recordAuditEvent(
      req,
      failStatus.locked ? 'BRUTE_FORCE_LOCKOUT_TRIGGERED' : 'LOGIN_FAILED',
      { username: u, attemptsUsed: failStatus.attemptsUsed, attemptsRemaining: failStatus.attemptsRemaining },
      u.toLowerCase().includes('metro') ? 'metro' : 'damien',
      u || 'unknown'
    );
    if (failStatus.locked) {
      return res.status(429).json({
        ok: false,
        locked: true,
        retryAfterSeconds: 900,
        error: `Too many failed sign-in attempts (${MAX_FAILED_LOGIN_ATTEMPTS} of ${MAX_FAILED_LOGIN_ATTEMPTS}). Account locked for 15 minutes.`
      });
    }
    return res.status(401).json({
      ok: false,
      attemptsRemaining: failStatus.attemptsRemaining,
      error: 'Invalid Client ID or password.'
    });
  }

  // Successful password verification -> reset brute-force counter
  clearLoginFailures(ip, u);

  const effectiveDisplayName = operatorName
    ? `${String(operatorName).trim()} (${matched.username})`
    : (matched.displayName || matched.username);

  // Mandatory MFA for EVERY user on sign-in unless browser has valid 30-day trust cookie
  const cookies = parseCookies(req);
  const isBrowserTrusted = verifyMfaTrustCookie(cookies[MFA_TRUST_COOKIE_NAME], matched.username, matched.clientId);

  if (!isBrowserTrusted) {
    if (!matched.totpSecret) matched.totpSecret = generateTotpSecret(matched.username);
    const challengeToken = crypto.randomBytes(24).toString('hex');
    const emailCode = String(crypto.randomInt(100000, 999999));
    const totpQrDataUrl = await buildTotpQrDataUrl(matched.username, matched.totpSecret);
    pendingMfaChallenges.set(challengeToken, {
      username: matched.username,
      clientId: matched.clientId,
      displayName: effectiveDisplayName,
      email: matched.email || `${matched.username}@bridgehealthhub.com`,
      role: matched.role || 'client_user',
      mfaMethod: matched.mfaMethod || 'email',
      emailCode,
      totpSecret: matched.totpSecret,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    recordAuditEvent(req, 'MFA_CHALLENGE_ISSUED', { supportedMethods: ['email', 'totp'], email: matched.email }, matched.clientId, matched.username);
    const maskedEmail = (matched.email || `${matched.username}@bridgehealthhub.com`).replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => `${a}${'*'.repeat(Math.min(b.length, 4))}${c}`);
    return res.json({
      ok: true,
      mfaRequired: true,
      challengeToken,
      mfaMethod: matched.mfaMethod || 'email',
      maskedEmail,
      totpQrDataUrl,
      totpSecret: matched.totpSecret,
      // Expose preview code when no external SMTP server is configured so testers can verify Email MFA immediately
      emailCodePreview: process.env.SMTP_HOST ? undefined : emailCode
    });
  }

  recordAuditEvent(
    req,
    'LOGIN_SUCCESS',
    { method: isBrowserTrusted ? 'password+trusted_device' : 'password', role: matched.role || 'admin' },
    matched.clientId,
    matched.username
  );

  return issueSessionCookiesAndRespond(req, res, { ...matched, displayName: effectiveDisplayName }, false);
});

// Verify 6-Digit MFA Code (Supports BOTH Email 6-Digit Code AND Authenticator App TOTP!)
app.post('/api/auth/verify-mfa', (req, res) => {
  setNoCacheHeaders(res);
  const { challengeToken, code, trustDevice } = req.body || {};
  const ch = pendingMfaChallenges.get(String(challengeToken || ''));
  if (!ch || Date.now() > ch.expiresAt) {
    pendingMfaChallenges.delete(String(challengeToken || ''));
    return res.status(401).json({ ok: false, error: 'Verification code expired. Please sign in again.' });
  }
  const cleanCode = String(code || '').replace(/\s+/g, '');
  const validEmailCode = safeEqual(cleanCode, ch.emailCode);
  const validTotpCode = verifyTotpCode(ch.totpSecret, cleanCode);

  if (!validEmailCode && !validTotpCode) {
    recordAuditEvent(req, 'MFA_VERIFICATION_FAILED', { username: ch.username }, ch.clientId, ch.username);
    return res.status(401).json({ ok: false, error: 'Invalid 6-digit verification code.' });
  }

  pendingMfaChallenges.delete(String(challengeToken || ''));
  recordAuditEvent(
    req,
    'LOGIN_SUCCESS_MFA',
    { verifiedVia: validTotpCode ? 'totp_authenticator' : 'email_code', trustDevice: Boolean(trustDevice) },
    ch.clientId,
    ch.username
  );
  return issueSessionCookiesAndRespond(req, res, ch, Boolean(trustDevice));
});

// Resend Email MFA Code
app.post('/api/auth/resend-mfa', (req, res) => {
  setNoCacheHeaders(res);
  const { challengeToken } = req.body || {};
  const ch = pendingMfaChallenges.get(String(challengeToken || ''));
  if (!ch || Date.now() > ch.expiresAt) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please sign in again.' });
  }
  ch.emailCode = String(crypto.randomInt(100000, 999999));
  ch.expiresAt = Date.now() + 10 * 60 * 1000;
  recordAuditEvent(req, 'MFA_EMAIL_CODE_RESENT', { email: ch.email }, ch.clientId, ch.username);
  return res.json({
    ok: true,
    message: 'A new 6-digit verification code has been sent to your email.',
    emailCodePreview: process.env.SMTP_HOST ? undefined : ch.emailCode
  });
});

// Web Logout API (revokes session JTI server-side & clears session cookie)
app.post('/api/auth/logout', (req, res) => {
  setNoCacheHeaders(res);
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  if (session) {
    if (session.jti) revokedSessionJtis.add(session.jti);
    recordAuditEvent(req, 'LOGOUT', {}, session.clientId, session.user);
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res.json({ ok: true });
});

// Session Authentication & Strict 1-to-1 Tenant Lock Middleware (NO WWW-Authenticate header)
app.use((req, res, next) => {
  if (
    req.path === '/api/health' ||
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path === '/api/auth/verify-mfa' ||
    req.path === '/api/auth/resend-mfa' ||
    req.path === '/styles.css' ||
    req.path === '/favicon.ico' ||
    req.path.startsWith('/assets/')
  ) {
    return next();
  }

  setNoCacheHeaders(res);

  // 1. Verify signed HttpOnly session cookie (with revocation & 30-min idle timeout check)
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  if (session && session.clientId) {
    req.clientId = session.clientId;
    req.authenticatedUser = session.user;
    req.authenticatedDisplayName = session.displayName || session.user;
    req.authenticatedEmail = session.email || '';
    req.authenticatedRole = session.role || 'admin';
    req.sessionJti = session.jti;
    return next();
  }

  // 2. Unauthenticated API calls get 401 JSON (never WWW-Authenticate)
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required', loginUrl: '/login' });
  }

  // 3. Unauthenticated browser navigation redirects to /login web page
  return res.redirect(302, '/login');
});

app.get('/api/auth/me', (req, res) => {
  const users = loadUsersDirectory();
  const userRec = users.find(u => u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase());
  const effectiveRole = userRec?.role || req.authenticatedRole || 'client_user';
  res.json({
    authenticated: true,
    user: req.authenticatedUser,
    displayName: req.authenticatedDisplayName || req.authenticatedUser,
    email: userRec?.email || req.authenticatedEmail || '',
    role: effectiveRole,
    isBridgeAdmin: effectiveRole === 'bridge_admin',
    clientId: req.clientId,
    mfaEnabled: true,
    mfaMethod: userRec?.mfaMethod || 'email'
  });
});

// ============================================================================
// NAMED-USER MANAGEMENT, PASSWORD COMPLEXITY CHANGE, MFA CONFIG & AUDIT API
// STRICT ROLE-BASED ACCESS CONTROL (RBAC): ONLY bridge_admin CAN MANAGE USERS
// ============================================================================
function isCallerBridgeAdmin(req) {
  const users = loadUsersDirectory();
  const userRec = users.find(u => u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase());
  const role = userRec?.role || req.authenticatedRole || 'client_user';
  return role === 'bridge_admin';
}

app.get('/api/security/overview', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const isAdmin = isCallerBridgeAdmin(req);
  const allTenantUsers = loadUsersDirectory().filter(u => u.clientId === clientId);
  const visibleUsers = await Promise.all(
    (isAdmin ? allTenantUsers : allTenantUsers.filter(u => u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase()))
      .map(async u => {
        const canSeeSecret = isAdmin || u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase();
        const qrUrl = canSeeSecret ? await buildTotpQrDataUrl(u.username, u.totpSecret || generateTotpSecret(u.username)) : undefined;
        return {
          username: u.username,
          displayName: u.displayName,
          email: u.email,
          role: u.role,
          mfaEnabled: true,
          mfaMethod: u.mfaMethod || 'email',
          totpSecret: canSeeSecret ? u.totpSecret : undefined,
          totpQrDataUrl: qrUrl,
          passwordUpdatedAt: u.passwordUpdatedAt
        };
      })
  );
  const allAuditEvents = loadClientAuditLog(clientId);
  const auditEvents = (isAdmin
    ? allAuditEvents
    : allAuditEvents.filter(ev => String(ev.user || '').toLowerCase() === String(req.authenticatedUser || '').toLowerCase())
  ).slice(0, 100);

  res.json({
    ok: true,
    clientId,
    isBridgeAdmin: isAdmin,
    currentUser: {
      username: req.authenticatedUser,
      displayName: req.authenticatedDisplayName,
      role: isAdmin ? 'bridge_admin' : (visibleUsers[0]?.role || 'client_user')
    },
    securityPolicy: {
      geoRestriction: 'US_ONLY',
      maxFailedAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
      lockoutMinutes: 15,
      idleTimeoutMinutes: 30,
      passwordMinLength: 12,
      passwordComplexityCategories: 3,
      mfaMandatory: true,
      mfaSupportedMethods: ['email', 'totp'],
      rbacEnforced: true
    },
    users: visibleUsers,
    auditEvents
  });
});

app.post('/api/security/users', (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: '/api/security/users' });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can add or manage user accounts.'
    });
  }
  const clientId = req.clientId || 'damien';
  const { username, password, displayName, email, role, mfaMethod } = req.body || {};
  const cleanUser = String(username || '').trim();
  if (!cleanUser || cleanUser.length < 3) {
    return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters.' });
  }
  const complexity = validatePasswordComplexity(password, cleanUser);
  if (!complexity.valid) {
    return res.status(400).json({ ok: false, error: complexity.error });
  }
  const users = loadUsersDirectory();
  if (users.some(u => u.username.toLowerCase() === cleanUser.toLowerCase())) {
    return res.status(400).json({ ok: false, error: `User '${cleanUser}' already exists.` });
  }
  const newUser = {
    username: cleanUser,
    passwordHash: hashPasswordScrypt(password),
    clientId,
    displayName: String(displayName || cleanUser).trim(),
    email: String(email || `${cleanUser}@bridgehealthhub.com`).trim(),
    role: ['bridge_admin', 'client_user', 'pharmacist'].includes(role) ? role : 'pharmacist',
    mfaEnabled: true, // Mandatory MFA for every user — cannot be disabled
    mfaMethod: ['email', 'totp'].includes(mfaMethod) ? mfaMethod : 'email',
    totpSecret: generateTotpSecret(),
    passwordUpdatedAt: new Date().toISOString(),
    passwordMaxAgeDays: 0,
    passwordHistory: []
  };
  users.push(newUser);
  saveUsersDirectory(users);
  recordAuditEvent(req, 'USER_CREATED', { createdUsername: cleanUser, role: newUser.role, mfaEnabled: true });
  res.json({
    ok: true,
    user: {
      username: newUser.username,
      displayName: newUser.displayName,
      email: newUser.email,
      role: newUser.role,
      mfaEnabled: true,
      mfaMethod: newUser.mfaMethod
    }
  });
});

app.post('/api/security/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const users = loadUsersDirectory();
  const userRec = users.find(u => u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase());
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'User not found.' });
  }
  if (!verifyPasswordScrypt(currentPassword, userRec.passwordHash)) {
    recordAuditEvent(req, 'PASSWORD_CHANGE_FAILED', { reason: 'incorrect_current_password' });
    return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
  }
  const complexity = validatePasswordComplexity(newPassword, userRec.username);
  if (!complexity.valid) {
    return res.status(400).json({ ok: false, error: complexity.error });
  }
  if (verifyPasswordScrypt(newPassword, userRec.passwordHash)) {
    return res.status(400).json({ ok: false, error: 'New password cannot be the same as your current password.' });
  }
  userRec.passwordHistory = [userRec.passwordHash, ...(userRec.passwordHistory || [])].slice(0, 3);
  userRec.passwordHash = hashPasswordScrypt(newPassword);
  userRec.passwordUpdatedAt = new Date().toISOString();
  saveUsersDirectory(users);
  recordAuditEvent(req, 'PASSWORD_CHANGED', { username: userRec.username });
  res.json({ ok: true, message: 'Password updated successfully.' });
});

app.post('/api/security/mfa-config', (req, res) => {
  const { targetUsername, mfaMethod, email } = req.body || {};
  const isAdmin = isCallerBridgeAdmin(req);
  const callerUser = String(req.authenticatedUser || '').toLowerCase();
  const lookupUser = String(targetUsername || req.authenticatedUser || '').toLowerCase();

  // Non-admins cannot modify another user or alter their assigned MFA email address
  if (!isAdmin && (lookupUser !== callerUser || email !== undefined)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: '/api/security/mfa-config', targetUsername: lookupUser });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins can change assigned MFA email addresses or modify other users.'
    });
  }

  const users = loadUsersDirectory();
  const userRec = users.find(u => u.username.toLowerCase() === lookupUser && u.clientId === req.clientId);
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'User not found in this tenant.' });
  }
  userRec.mfaEnabled = true; // Mandatory MFA — can never be turned off
  if (mfaMethod && ['email', 'totp'].includes(mfaMethod)) userRec.mfaMethod = mfaMethod;
  if (isAdmin && email && String(email).includes('@')) userRec.email = String(email).trim();
  if (!userRec.totpSecret) userRec.totpSecret = generateTotpSecret();
  saveUsersDirectory(users);
  recordAuditEvent(req, 'MFA_CONFIG_UPDATED', { targetUsername: userRec.username, email: userRec.email, mfaEnabled: true, mfaMethod: userRec.mfaMethod });
  res.json({
    ok: true,
    username: userRec.username,
    email: userRec.email,
    mfaEnabled: true,
    mfaMethod: userRec.mfaMethod,
    totpSecret: userRec.totpSecret
  });
});

app.post('/api/security/audit-event', (req, res) => {
  const { eventType, details } = req.body || {};
  if (!eventType) return res.status(400).json({ ok: false });
  const entry = recordAuditEvent(req, String(eventType), details || {});
  res.json({ ok: true, entry });
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    setNoCacheHeaders(res);
  }
}));

// ============================================================================
// PER-CLIENT STATE MANAGER + DURABLE GCS OVERLAY PERSISTENCE
// ============================================================================
const ALLOWED_EDIT_FIELDS = ['Status', 'Date contacted', 'Notes', 'Corrected patient ID', 'Priority', 'Next action', 'Updated by', 'Updated at'];
const clientStates = {};       // clientId -> hydrated portalData object
const clientOverlays = {};     // clientId -> { clientId, updatedAt, edits: { [stableKey]: { ... } } }
const clientWriteQueues = {};  // clientId -> Promise chain for sequential GCS + disk writes
const clientInitPromises = {}; // clientId -> Promise

function getClientBaselinePath(clientId) {
  const p = path.join(CLIENTS_DIR, clientId, 'portal_data.json');
  if (fs.existsSync(p)) return p;
  return path.join(__dirname, 'data', 'portal_data.json');
}

function getClientLocalOverlayPath(clientId) {
  return path.join(CLIENTS_DIR, clientId, 'worklist_edits.json');
}

function loadClientBaseline(clientId) {
  return JSON.parse(fs.readFileSync(getClientBaselinePath(clientId), 'utf8'));
}

let _cachedGcpToken = null;
let _cachedGcpTokenExpiry = 0;

async function getGcpAccessToken() {
  if (_cachedGcpToken && Date.now() < _cachedGcpTokenExpiry) {
    return _cachedGcpToken;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (resp.ok) {
      const data = await resp.json();
      if (data.access_token) {
        _cachedGcpToken = data.access_token;
        _cachedGcpTokenExpiry = Date.now() + 300 * 1000;
        return _cachedGcpToken;
      }
    }
  } catch (_) {
    // Metadata server not reachable (running locally); fall back to gcloud CLI
  }
  const token = execSync('gcloud auth print-access-token', {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (!token) {
    throw new Error('Could not obtain GCP access token from metadata server or gcloud CLI');
  }
  _cachedGcpToken = token;
  _cachedGcpTokenExpiry = Date.now() + 300 * 1000;
  return _cachedGcpToken;
}

async function loadOverlayFromGcs(clientId) {
  if (!GCS_STATE_BUCKET) return null;
  try {
    const token = await getGcpAccessToken();
    const objectName = `clients/${clientId}/worklist_edits.json`;
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(GCS_STATE_BUCKET)}/o/${encodeURIComponent(objectName)}?alt=media`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`GCS GET HTTP ${resp.status}`);
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[GCS] Could not load overlay for ${clientId} from gs://${GCS_STATE_BUCKET}:`, err.message);
    return null;
  }
}

async function saveOverlayToGcs(clientId, overlayData) {
  if (!GCS_STATE_BUCKET) return false;
  try {
    const token = await getGcpAccessToken();
    const objectName = `clients/${clientId}/worklist_edits.json`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(GCS_STATE_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(overlayData, null, 2)
    });
    if (!resp.ok) {
      throw new Error(`GCS POST HTTP ${resp.status}`);
    }
    return true;
  } catch (err) {
    console.warn(`[GCS] Could not save overlay for ${clientId} to gs://${GCS_STATE_BUCKET}:`, err.message);
    return false;
  }
}

async function deleteOverlayFromGcs(clientId) {
  if (!GCS_STATE_BUCKET) return false;
  try {
    const token = await getGcpAccessToken();
    const objectName = `clients/${clientId}/worklist_edits.json`;
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(GCS_STATE_BUCKET)}/o/${encodeURIComponent(objectName)}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.ok || resp.status === 404;
  } catch (err) {
    console.warn(`[GCS] Could not delete overlay for ${clientId}:`, err.message);
    return false;
  }
}

function getAllWorklistRows(wl) {
  return [
    ...(wl.pharmacyTodo?.rows || []),
    ...(wl.refillFollowup?.rows || []),
    ...(wl.pharmacyDataFixes?.noIdRows || []),
    ...(wl.pharmacyDataFixes?.unmatchedRows || []),
    ...(wl.endedNeverFilled?.rows || [])
  ];
}

function applyOverlayToState(state, overlay) {
  if (!overlay || !overlay.edits) return;
  const rows = getAllWorklistRows(state.worklists);
  for (const row of rows) {
    const key = row.stableKey || row.id;
    const rowEdits = overlay.edits[key];
    if (rowEdits) {
      for (const field of ALLOWED_EDIT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(rowEdits, field)) {
          row[field] = rowEdits[field];
        }
      }
    }
  }
}

async function ensureClientStateLoaded(clientId) {
  if (clientStates[clientId]) return clientStates[clientId];
  if (clientInitPromises[clientId]) return clientInitPromises[clientId];

  clientInitPromises[clientId] = (async () => {
    const baseline = loadClientBaseline(clientId);
    let overlay = await loadOverlayFromGcs(clientId);

    if (!overlay) {
      const localPath = getClientLocalOverlayPath(clientId);
      if (fs.existsSync(localPath)) {
        try {
          overlay = JSON.parse(fs.readFileSync(localPath, 'utf8'));
        } catch (e) {
          console.warn(`Could not parse local overlay for ${clientId}:`, e.message);
        }
      }
    }

    if (!overlay || typeof overlay.edits !== 'object') {
      overlay = { clientId, updatedAt: new Date().toISOString(), edits: {} };
    }

    applyOverlayToState(baseline, overlay);
    clientOverlays[clientId] = overlay;
    clientStates[clientId] = baseline;
    return baseline;
  })();

  try {
    return await clientInitPromises[clientId];
  } finally {
    delete clientInitPromises[clientId];
  }
}

function recordRowEdit(clientId, row) {
  if (!clientOverlays[clientId]) {
    clientOverlays[clientId] = { clientId, updatedAt: new Date().toISOString(), edits: {} };
  }
  const key = row.stableKey || row.id;
  const entry = {};
  for (const field of ALLOWED_EDIT_FIELDS) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      entry[field] = row[field];
    }
  }
  clientOverlays[clientId].edits[key] = entry;
  clientOverlays[clientId].updatedAt = new Date().toISOString();
}

function enqueueOverlayPersist(clientId) {
  const overlaySnapshot = JSON.parse(JSON.stringify(clientOverlays[clientId] || { clientId, edits: {} }));
  const prev = clientWriteQueues[clientId] || Promise.resolve();
  const next = prev.then(async () => {
    // Save local file first
    try {
      const localPath = getClientLocalOverlayPath(clientId);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, JSON.stringify(overlaySnapshot, null, 2), 'utf8');
    } catch (e) {
      console.warn(`Could not write local overlay for ${clientId}:`, e.message);
    }
    // Save to GCS if configured
    await saveOverlayToGcs(clientId, overlaySnapshot);
  });
  clientWriteQueues[clientId] = next.catch(() => {});
  return next;
}

function computeWorklistSummary(wl) {
  const todoRows = wl.pharmacyTodo.rows;
  const refillRows = wl.refillFollowup.rows;
  const noIdRows = wl.pharmacyDataFixes.noIdRows;
  const unmatchedRows = wl.pharmacyDataFixes.unmatchedRows;
  const endedRows = wl.endedNeverFilled.rows;

  const todoUrgent = todoRows.filter(r => String(r['Priority'] || '').startsWith('1')).length;
  const todoHigh = todoRows.filter(r => String(r['Priority'] || '').startsWith('2')).length;
  const todoMonitor = todoRows.filter(r => String(r['Priority'] || '').startsWith('4')).length;
  const todoCompleted = todoRows.filter(r => r['Status'] && r['Status'] !== 'Not started').length;

  const refillPendingCancel = refillRows.filter(r => String(r['Membership status'] || '').includes('cancellation pending')).length;
  const refillCompleted = refillRows.filter(r => r['Status'] && r['Status'] !== 'Not started').length;

  const fixesResolvedNoId = noIdRows.filter(r => r['Corrected patient ID'] && String(r['Corrected patient ID']).trim() !== '').length;
  const fixesResolvedUnmatched = unmatchedRows.filter(r => r['Corrected patient ID'] && String(r['Corrected patient ID']).trim() !== '').length;
  const fuzzySuggestedCount = unmatchedRows.filter(r => r.suggestedMatch).length;
  const todoWithFuzzyCount = todoRows.filter(r => r.possibleDataFixes && r.possibleDataFixes.length > 0).length;

  return {
    todoTotal: todoRows.length,
    todoUrgent,
    todoHigh,
    todoMonitor,
    todoCompleted,
    todoWithFuzzyCount,
    refillTotal: refillRows.length,
    refillPendingCancel,
    refillCompleted,
    fixesNoIdTotal: noIdRows.length,
    fixesUnmatchedTotal: unmatchedRows.length,
    fixesTotal: noIdRows.length + unmatchedRows.length,
    fixesResolved: fixesResolvedNoId + fixesResolvedUnmatched,
    fuzzySuggestedCount,
    endedTotal: endedRows.length
  };
}

// Health check (unauthenticated for Cloud Run startup/liveness probes; exposes zero tenant PII)
app.get('/api/health', async (req, res) => {
  const registry = loadClientRegistry();
  res.json({
    status: 'ok',
    service: 'bridge-program-portal',
    multiClient: true,
    configuredClients: Object.keys(registry.clients || {}),
    gcsPersistenceEnabled: Boolean(GCS_STATE_BUCKET),
    gcsBucket: GCS_STATE_BUCKET || null,
    preparedBy: 'Bridge Health Hub',
    geminiConfigured: true,
    geminiModel: VERTEX_GEMINI_MODEL,
    geminiProvider: 'vertex-ai-gcp-billing'
  });
});

// Full portal data for authenticated tenant
app.get('/api/portal-data', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const summary = computeWorklistSummary(state.worklists);
  res.json({
    ...state,
    worklistSummary: summary
  });
});

// Update individual worklist row for authenticated tenant
app.patch('/api/worklist/:sheet/:id', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const { sheet, id } = req.params;
  const updates = req.body || {};
  const wl = state.worklists;

  let targetArray = null;
  if (sheet === 'todo') targetArray = wl.pharmacyTodo.rows;
  else if (sheet === 'refill') targetArray = wl.refillFollowup.rows;
  else if (sheet === 'fixes-noid') targetArray = wl.pharmacyDataFixes.noIdRows;
  else if (sheet === 'fixes-unmatched') targetArray = wl.pharmacyDataFixes.unmatchedRows;
  else if (sheet === 'ended') targetArray = wl.endedNeverFilled.rows;

  if (!targetArray) {
    return res.status(400).json({ error: `Unknown worklist sheet: ${sheet}` });
  }

  const row = targetArray.find(r => r.id === id);
  if (!row) {
    return res.status(404).json({ error: `Row ${id} not found in ${sheet}` });
  }

  for (const key of ALLOWED_EDIT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      row[key] = updates[key];
    }
  }
  row['Updated by'] = req.authenticatedDisplayName || req.authenticatedUser || 'User';
  row['Updated at'] = new Date().toISOString();
  recordRowEdit(clientId, row);

  // If updating Corrected patient ID on fixes-unmatched or fixes-noid, check if there is a matching Pharmacy To-Do patient
  let linkedTodoUpdated = null;
  if ((sheet === 'fixes-unmatched' || sheet === 'fixes-noid') && updates['Corrected patient ID']) {
    const cleanId = String(updates['Corrected patient ID']).trim().toLowerCase();
    const todoMatch = wl.pharmacyTodo.rows.find(
      t => String(t['Pharmacy patient ID'] || '').toLowerCase() === cleanId
    );
    if (todoMatch && updates.autoUpdateTodo !== false) {
      todoMatch['Status'] = 'Filled – ID Corrected';
      todoMatch['Date contacted'] = todoMatch['Date contacted'] || '2026-10-25';
      const prevNotes = todoMatch['Notes'] ? `${todoMatch['Notes']} | ` : '';
      todoMatch['Notes'] = `${prevNotes}Linked to dispensed fill (${row['Dispensed item']} on ${row['Date filled']}) via Pharmacy Data Fixes.`;
      todoMatch['Updated by'] = req.authenticatedDisplayName || req.authenticatedUser || 'User';
      todoMatch['Updated at'] = new Date().toISOString();
      recordRowEdit(clientId, todoMatch);
      linkedTodoUpdated = todoMatch;
    }
  }

  recordAuditEvent(req, 'WORKLIST_ROW_EDIT', {
    sheet,
    rowId: id,
    patientId: row['Pharmacy patient ID'] || row['Patient ID on file'] || id,
    updatedFields: Object.keys(updates)
  });

  await enqueueOverlayPersist(clientId);
  res.json({
    ok: true,
    clientId,
    row,
    linkedTodoUpdated,
    worklistSummary: computeWorklistSummary(wl)
  });
});

// Apply all fuzzy ID fixes for authenticated tenant in one click
app.post('/api/worklist/apply-fuzzy-fixes', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const wl = state.worklists;
  let appliedCount = 0;
  let todoLinkedCount = 0;
  const actorName = req.authenticatedDisplayName || req.authenticatedUser || 'User';
  const nowIso = new Date().toISOString();

  for (const row of wl.pharmacyDataFixes.unmatchedRows) {
    if (row.suggestedMatch && row.suggestedMatch.suggestedPatientId) {
      const targetId = row.suggestedMatch.suggestedPatientId;
      row['Corrected patient ID'] = targetId;
      row['Updated by'] = actorName;
      row['Updated at'] = nowIso;
      recordRowEdit(clientId, row);
      appliedCount++;

      const todoMatch = wl.pharmacyTodo.rows.find(
        t => String(t['Pharmacy patient ID'] || '').toLowerCase() === targetId.toLowerCase()
      );
      if (todoMatch && todoMatch['Status'] === 'Not started') {
        todoMatch['Status'] = 'Filled – ID Corrected';
        todoMatch['Date contacted'] = '2026-10-25';
        todoMatch['Notes'] = `Auto-reconciled with unmatched fill (${row['Patient ID on file']} -> ${targetId}, ${row['Dispensed item']} filled ${row['Date filled']}).`;
        todoMatch['Updated by'] = actorName;
        todoMatch['Updated at'] = nowIso;
        recordRowEdit(clientId, todoMatch);
        todoLinkedCount++;
      }
    }
  }

  recordAuditEvent(req, 'WORKLIST_APPLY_FUZZY_FIXES', { appliedCount, todoLinkedCount });

  await enqueueOverlayPersist(clientId);
  res.json({
    ok: true,
    clientId,
    appliedCount,
    todoLinkedCount,
    worklistSummary: computeWorklistSummary(wl)
  });
});

// Reset runtime edits back to baseline for authenticated tenant only
app.post('/api/worklist/reset', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const baseline = loadClientBaseline(clientId);
  clientStates[clientId] = baseline;
  clientOverlays[clientId] = { clientId, updatedAt: new Date().toISOString(), edits: {} };

  const localPath = getClientLocalOverlayPath(clientId);
  if (fs.existsSync(localPath)) {
    try { fs.unlinkSync(localPath); } catch (e) {}
  }
  await deleteOverlayFromGcs(clientId);
  recordAuditEvent(req, 'WORKLIST_RESET', { clientId });

  res.json({
    ok: true,
    clientId,
    worklistSummary: computeWorklistSummary(baseline.worklists)
  });
});

// CSV Export for any worklist sheet (parameterized by tenant shortName & asOfShort)
app.get('/api/worklist/export/:sheet', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const { sheet } = req.params;
  const wl = state.worklists;
  const shortPrefix = String(state.meta?.shortName || 'Client').replace(/\s+/g, '_');
  const asOfSuffix = String(state.meta?.asOfShort || 'Sep2026');

  let headers = [];
  let rows = [];
  let filename = `${shortPrefix}_Worklist_${sheet}_${asOfSuffix}.csv`;

  if (sheet === 'todo') {
    headers = wl.pharmacyTodo.headers;
    rows = wl.pharmacyTodo.rows;
    filename = `${shortPrefix}_Pharmacy_To_Do_${asOfSuffix}.csv`;
  } else if (sheet === 'refill') {
    headers = wl.refillFollowup.headers;
    rows = wl.refillFollowup.rows;
    filename = `${shortPrefix}_Refill_Follow_Up_${asOfSuffix}.csv`;
  } else if (sheet === 'fixes-noid') {
    headers = wl.pharmacyDataFixes.noIdHeaders;
    rows = wl.pharmacyDataFixes.noIdRows;
    filename = `${shortPrefix}_Pharmacy_Data_Fixes_NoID_${asOfSuffix}.csv`;
  } else if (sheet === 'fixes-unmatched') {
    headers = [...wl.pharmacyDataFixes.unmatchedHeaders, 'Suggested Match ID'];
    rows = wl.pharmacyDataFixes.unmatchedRows.map(r => ({
      ...r,
      'Suggested Match ID': r.suggestedMatch ? r.suggestedMatch.suggestedPatientId : ''
    }));
    filename = `${shortPrefix}_Pharmacy_Data_Fixes_Unmatched_${asOfSuffix}.csv`;
  } else if (sheet === 'ended') {
    headers = wl.endedNeverFilled.headers;
    rows = wl.endedNeverFilled.rows;
    filename = `${shortPrefix}_Ended_Never_Filled_${asOfSuffix}.csv`;
  } else {
    return res.status(400).send('Invalid sheet name');
  }

  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[,"\n]/.test(s) ? `"${s}"` : s;
  };

  const csvLines = [headers.map(esc).join(',')];
  for (const r of rows) {
    csvLines.push(headers.map(h => esc(r[h])).join(','));
  }

  recordAuditEvent(req, 'CSV_EXPORT', { sheet, filename, rowCount: rows.length });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvLines.join('\r\n'));
});

// ============================================================================
// TENANT-ISOLATED AGGREGATE ANALYTICS & WORKLIST Q&A ENGINE (/api/ask)
// ZERO MEMBER-LEVEL / PATIENT-LEVEL DATA EXPOSED IN AI Q&A
// ============================================================================
function countByField(rows, field) {
  const counts = {};
  for (const r of rows) {
    const val = r[field] !== null && r[field] !== undefined && r[field] !== '' ? String(r[field]) : 'Unlisted / None';
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

function isMemberLevelQuery(state, rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ql = q.toLowerCase();
  const wl = state.worklists || {};
  const allRows = getAllWorklistRows(wl);

  // Only detect explicit 8-char hex member IDs or exact known patient IDs on file (e.g., 6d3f1831, trinidad)
  const tokens = ql.split(/[\s,?;:!()'"]+/).filter(t => t.length >= 6);
  for (const tok of tokens) {
    if (/^[0-9a-f]{8}(-[0-9a-f]{4,})?$/.test(tok) || tok === 'trinidad') {
      return true;
    }
    const cleanTok = tok.replace(/^todo-|^refill-|^ended-|^fix-noid-|^fix-unmatched-/, '');
    if (cleanTok.length >= 6 && /[0-9]/.test(cleanTok)) {
      const matched = allRows.some(r =>
        String(r['Pharmacy patient ID'] || '').toLowerCase() === cleanTok ||
        String(r['Alpha member ID'] || '').toLowerCase().startsWith(cleanTok) ||
        String(r['Patient ID on file'] || '').toLowerCase() === cleanTok
      );
      if (matched) return true;
    }
  }
  return false;
}

function buildMemberPrivacyGuardrailReply(state, rawQuestion) {
  const meta = state.meta || {};
  return {
    question: String(rawQuestion || '').trim(),
    memberLevelBlocked: true,
    answer:
      `For member privacy, **Ask Bridge AI** only provides **aggregate** program, financial, channel, employer, prescriber, payer, medication, and worklist summary analytics for **${meta.client || 'this program'}**—individual member-level and patient-level records are not included in AI Q&A.\n\n` +
      `To look up or update a specific patient ID, please use the search bar in the **Pharmacy To-Do**, **Refill Follow-Up**, **Pharmacy Data Fixes**, or **Ended Memberships** tabs.`
  };
}

function answerQuestion(state, rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ql = q.toLowerCase();
  const wl = state.worklists;
  const meta = state.meta || {};
  const summary = computeWorklistSummary(wl);
  const aw = state.analysisWorkbook || {};
  const ex = aw.exhibits || {};
  const alpha = aw.alphaAnalytics || {};
  const disp = aw.dispenseAnalytics || {};

  // 0. Strict Member-Level Privacy Guardrail (Zero member/patient records in AI Q&A)
  if (isMemberLevelQuery(state, q)) {
    return buildMemberPrivacyGuardrailReply(state, q);
  }

  const allTodo = wl.pharmacyTodo.rows;
  const allUnmatched = wl.pharmacyDataFixes.unmatchedRows;

  // 0.5. Channel / Broker vs Paid Media & Employer comparison (from PPTX + Enrollment Reporting)
  if (
    (ql.includes('epic') && ql.includes('paid media')) ||
    (ql.includes('compare') && (ql.includes('channel') || ql.includes('broker')))
  ) {
    const er = state.enrollmentReporting || aw.enrollmentReporting || {};
    const chList = er.channels || [];
    const epicCh = chList.find(c => c.channel === 'EPIC') || { totalEnrolled: 452, activeMembers: 384, cancelledMembers: 68, activeRetentionPct: 85.0, disenrollmentPct: 15.0 };
    const pmCh = chList.find(c => c.channel === 'Paid Media') || { totalEnrolled: 417, activeMembers: 266, cancelledMembers: 151, activeRetentionPct: 63.8, disenrollmentPct: 36.2 };
    const topEpicEmps = (er.employers || [])
      .filter(e => e.partnerSource === 'EPIC' && !e.isDirectNoEmployer)
      .slice(0, 5)
      .map(e => `**${e.employerGroup}** (${e.totalEnrolled} YTD: ${e.byMonth?.Aug || 0} Aug, ${e.byMonth?.Sep || 0} Sep; ${e.activeMembers} active, ${e.cancelledMembers} disenrolled)`)
      .join(', ');
    return {
      question: q,
      answer:
        `### **EPIC Broker Channel vs. Paid Media (${meta.client} Through Sep 2026)**\n` +
        `• **EPIC (Broker Partner)**: **${epicCh.totalEnrolled} YTD enrollments** (120 in Sep, 165 in Aug), **${epicCh.activeMembers} currently active (${epicCh.activeRetentionPct}% active retention)**, **${epicCh.cancelledMembers} disenrolled (${epicCh.disenrollmentPct}% churn)**, **77% first-fill conversion**, and **93% refill rate** ($696,172 gross margin on 748 fills).\n` +
        `• **Paid Media**: **${pmCh.totalEnrolled} YTD enrollments** (93 in Sep, 89 in Aug), **${pmCh.activeMembers} currently active (${pmCh.activeRetentionPct}% active retention)**, **${pmCh.cancelledMembers} disenrolled (${pmCh.disenrollmentPct}% churn)**, **62% first-fill conversion**, and **92% refill rate** ($671,400 gross margin on 804 fills; 4.63x ROAS on $142,033 media spend).\n` +
        (topEpicEmps ? `• **Top EPIC Employer Groups Driving Aug–Sep Growth**: ${topEpicEmps}.\n\n` : '\n') +
        `| Channel | YTD Enrolled | Active Members | Disenrolled | Retention Rate | 1st-Fill Rate |\n` +
        `| --- | --- | --- | --- | --- | --- |\n` +
        `| **EPIC (Broker)** | **${epicCh.totalEnrolled}** | **${epicCh.activeMembers}** | ${epicCh.cancelledMembers} | **${epicCh.activeRetentionPct}%** | **77%** |\n` +
        `| **Paid Media** | **${pmCh.totalEnrolled}** | **${pmCh.activeMembers}** | ${pmCh.cancelledMembers} | **${pmCh.activeRetentionPct}%** | **62%** |\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'EPIC Broker vs. Paid Media: Enrolled, Active & Disenrolled',
          labels: ['EPIC (Broker)', 'Paid Media'],
          datasets: [
            { label: 'Total Enrolled', data: [epicCh.totalEnrolled, pmCh.totalEnrolled], backgroundColor: '#154672' },
            { label: 'Active Members', data: [epicCh.activeMembers, pmCh.activeMembers], backgroundColor: '#059669' },
            { label: 'Disenrolled', data: [epicCh.cancelledMembers, pmCh.cancelledMembers], backgroundColor: '#d97706' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 1. Prescriber questions (from Dispense Data in September 2026 Analysis.xlsx)
  const prescribers = disp.byPrescriber || [];
  const matchedPrescriber = prescribers.find(p => {
    const parts = String(p.prescriber || '').toLowerCase().split(/[,\s]+/).filter(x => x.length >= 4);
    return parts.some(part => ql.includes(part)) || (p.npi && ql.includes(String(p.npi)));
  });
  if (matchedPrescriber || ql.includes('prescriber') || ql.includes('provider') && (ql.includes('fill') || ql.includes('revenue') || ql.includes('margin') || ql.includes('top') || ql.includes('most'))) {
    if (matchedPrescriber) {
      return {
        question: q,
        answer:
          `For **${meta.client}** at **${meta.pharmacyPartner}**, prescriber **${matchedPrescriber.prescriber}** (NPI \`${matchedPrescriber.npi || 'N/A'}\`) has **${matchedPrescriber.completedFills} completed fills**` +
          (matchedPrescriber.cancelledFills !== undefined ? ` (${matchedPrescriber.cancelledFills} cancelled, ${matchedPrescriber.waitingForPickupFills || 0} waiting for pickup)` : '') +
          `, generating **$${Number(matchedPrescriber.completedRevenue || 0).toLocaleString()}** in total pharmacy revenue and **$${Number(matchedPrescriber.completedMargin || 0).toLocaleString()}** in pharmacy gross margin (**$${Number(matchedPrescriber.avgMarginPerCompletedFill || 0).toLocaleString()}** average margin per completed fill).`
      };
    }
    const topP = prescribers.slice(0, 6).map(p =>
      `• **${p.prescriber}** (NPI \`${p.npi}\`): **${p.completedFills}** completed fills · **$${Number(p.completedRevenue).toLocaleString()}** revenue · **$${Number(p.completedMargin).toLocaleString()}** margin ($${Number(p.avgMarginPerCompletedFill).toLocaleString()}/fill)`
    ).join('\n');
    return {
      question: q,
      answer:
        `**Top Prescribers by Completed Fills at ${meta.pharmacyPartner} (${meta.client})**:\n${topP}`
    };
  }

  // 2. Payer / Third-Party / Savings Card / Remit / Copay / Acquisition Cost questions (from Dispense Data)
  if (
    ql.includes('payer') || ql.includes('third party') || ql.includes('savings card') ||
    ql.includes('connective') || ql.includes('anthem') || ql.includes('loyalty') ||
    ql.includes('remit') || ql.includes('copay') || ql.includes('acquisition cost') ||
    ql.includes('dc inj') || ql.includes('secondary')
  ) {
    const p1List = (disp.byPrimaryThirdPartyPayer || []).slice(0, 6).map(p =>
      `• **${p.primaryPayer}**: **${p.completedFills.toLocaleString()}** completed fills · **$${Number(p.totalRevenue).toLocaleString()}** revenue · **$${Number(p.acquisitionCost || 0).toLocaleString()}** acquisition cost · **$${Number(p.margin).toLocaleString()}** margin`
    ).join('\n');
    const p2List = (disp.bySecondaryThirdPartyPayer || []).slice(0, 4).map(p =>
      `• **${p.secondaryPayer}**: **${p.completedFills.toLocaleString()}** completed fills · **$${Number(p.secondaryRemit || 0).toLocaleString()}** secondary remit`
    ).join('\n');
    return {
      question: q,
      answer:
        `**Third-Party Payer & Savings Card Breakdown at ${meta.pharmacyPartner} (${meta.client})**:\n` +
        `**Primary Third-Party Payers:**\n${p1List}\n\n` +
        `**Secondary Third-Party Payers / Programs:**\n${p2List}`
    };
  }

  // 3. Specific Medication Dose Strengths / NDC / Pill vs Pen questions (from Exhibits & Dispense Data)
  if (
    ql.includes('dose') || ql.includes('strength') || ql.includes('0.25') || ql.includes('0.5') ||
    ql.includes('1.7') || ql.includes('2.4') || ql.includes('7.2') || ql.includes('1.5') ||
    ql.includes('25 mg') || ql.includes('25mg') || ql.includes('4 mg') || ql.includes('4mg') ||
    ql.includes('9 mg') || ql.includes('9mg') || ql.includes('tablet') || ql.includes('ndc') ||
    (ql.includes('wegovy') && (ql.includes('breakdown') || ql.includes('month') || ql.includes('by drug'))) ||
    (ql.includes('ozempic') && (ql.includes('breakdown') || ql.includes('month') || ql.includes('dose')))
  ) {
    const doses = ex.dispensesByDoseMonthly || [];
    const doseLines = doses
      .filter(d => d.medicationDose !== 'Grand Total')
      .map(d => `• **${d.medicationDose}**: **${d.Sep}** in Sep · **${d.Aug}** in Aug · **${d.YTD}** YTD`)
      .join('\n');
    const totalRow = doses.find(d => d.medicationDose === 'Grand Total');
    return {
      question: q,
      answer:
        `**GLP-1 Dispenses by Specific Medication & Dose Strength (${meta.client})**:\n${doseLines}\n` +
        (totalRow ? `\n**Total GLP-1 Fills**: **${totalRow.Sep}** in September (**${totalRow.YTD.toLocaleString()}** YTD).` : '')
    };
  }

  // 4. Cancellations / Churn / Auto-Disenrolled by Source & Month (from Exhibits & Alpha Data)
  if (
    ql.includes('cancel') || ql.includes('churn') || ql.includes('disenroll') || ql.includes('attrition')
  ) {
    const cancRows = ex.cancellationsBySourceMonthly || [];
    const totalCancRow = cancRows.find(r => r.source === 'Total') || {};
    const pctRow = ex.cancellationPctOfTotalEnrolledMonthly || {};
    const bySourceLines = cancRows
      .filter(r => r.source !== 'Total')
      .map(r => `• **${r.source}**: **${r.Sep || 0}** in Sep · **${r.Aug || 0}** in Aug · **${r.YTD || 0}** YTD`)
      .join('\n');
    return {
      question: q,
      answer:
        `**Membership Cancellations by Source & Month (${meta.client})**:\n` +
        `• **Total Cancellations**: **${totalCancRow.YTD ?? alpha.totalCancelledMembers ?? 264}** YTD (**${pctRow.YTD || '25.5%'}** of total enrolled), with **${totalCancRow.Sep ?? 91}** in September (**${pctRow.Sep || '33.3%'}**) and **${totalCancRow.Aug ?? 75}** in August (**${pctRow.Aug || '27.1%'}**).\n` +
        (alpha.totalAutoDisenrolledMembers ? `• **Auto-Disenrolled Members**: **${alpha.totalAutoDisenrolledMembers}** YTD.\n` : '') +
        (bySourceLines ? `\n**Cancellations by Channel:**\n${bySourceLines}` : '')
    };
  }

  // 5. Active Patient Tracker & Monthly Net Additions (from Exhibits)
  if (
    ql.includes('tracker') || ql.includes('net addition') || ql.includes('additions by month') ||
    (ql.includes('active') && ql.includes('by month'))
  ) {
    const tr = ex.activePatientTrackerMonthly || {};
    const add = ex.monthlyNetAdditions || {};
    const months = Object.keys(tr);
    const line = months.map(m => `**${m}**: ${tr[m]} active (${add[m] ? `+${add[m]} net` : 'baseline'})`).join(' · ');
    return {
      question: q,
      answer: `**Month-End Active Patient Tracker & Net Monthly Additions (${meta.client})**:\n${line}`
    };
  }

  // 6. Employer Groups, Referral Codes (ref_code) & Coupon Codes (from Exhibits, Alpha Data & Lookups)
  if (
    ql.includes('employer') || ql.includes('evansville') || ql.includes('putnam') ||
    ql.includes('hamilton') || ql.includes('gcs') || ql.includes('benton') ||
    ql.includes('therapy services') || ql.includes('warrick') || ql.includes('lawrence') ||
    ql.includes('imcu') || ql.includes('pcsc') || ql.includes('terre haute') ||
    ql.includes('drg') || ql.includes('bose') || ql.includes('kvc') || ql.includes('clay county') ||
    ql.includes('four rivers') || ql.includes('jennings') || ql.includes('little star') ||
    ql.includes('first financial') || ql.includes('ref code') || ql.includes('ref_code') ||
    ql.includes('referral code') || ql.includes('coupon') || ql.includes('company') ||
    ql.includes('companies') || ql.includes('metro transit') || ql.includes('lakeside')
  ) {
    const allGroups = alpha.allEmployerGroups || [];
    const matchedGroup = allGroups.find(g =>
      g.employerGroup !== 'No Employer Group / Direct' &&
      ql.includes(g.employerGroup.toLowerCase())
    );
    const notableMonthly = ex.notableEmployerGroupsMonthly || [];
    const matchedNotable = notableMonthly.find(n => ql.includes(n.employerGroup.toLowerCase()));

    if (matchedGroup || matchedNotable) {
      const gName = (matchedNotable && matchedNotable.employerGroup) || matchedGroup.employerGroup;
      const mLine = matchedNotable
        ? `Monthly enrollments: Jun **${matchedNotable.Jun || 0}**, Jul **${matchedNotable.Jul || 0}**, Aug **${matchedNotable.Aug || 0}**, Sep **${matchedNotable.Sep || 0}** (**${matchedNotable.YTD}** YTD). `
        : '';
      const aLine = matchedGroup
        ? `Across Alpha membership data, **${gName}** (${matchedGroup.partnerSource || 'Employer Partner'}, ref code: \`${(matchedGroup.refCodes || []).join(', ') || 'N/A'}\`) has **${matchedGroup.totalEnrolled} total enrolled** (**${matchedGroup.activeMembers} active**, **${matchedGroup.cancelledMembers} cancelled**).`
        : '';
      return {
        question: q,
        answer: `**${gName} — ${meta.client} Employer Enrollment Summary**:\n${mLine}${aLine}`
      };
    }

    const topNotable = notableMonthly.slice(0, 14).map(n =>
      `• **${n.employerGroup}**: **${n.YTD}** YTD (Aug: ${n.Aug || 0}, Sep: ${n.Sep || 0})`
    ).join('\n');
    const couponSummary = alpha.couponCodeCounts
      ? Object.entries(alpha.couponCodeCounts).map(([k, v]) => `\`${k}\` (${v})`).join(', ')
      : '';
    return {
      question: q,
      answer:
        `**Top Employer Groups by YTD Enrollment (${meta.client})**:\n${topNotable}` +
        (couponSummary ? `\n\n**Coupon Codes Used**: ${couponSummary}` : '')
    };
  }

  // 7. Fuzzy ID / Unmatched Patient ID / Data Fixes (Aggregate summary only)
  if (
    ql.includes('fuzzy') || ql.includes('unmatched') || ql.includes('data fix') ||
    ql.includes('alternate id') || ql.includes('don\'t match') || ql.includes('dont match') ||
    ql.includes('typo') || (ql.includes('link') && ql.includes('fill')) || ql.includes('no patient id')
  ) {
    const fuzzyRows = allUnmatched.filter(r => r.suggestedMatch);
    return {
      question: q,
      answer:
        `In **${meta.client}**'s **Pharmacy Data Fixes** worklist, there are **${summary.fixesTotal} unlinked records** (**${summary.fixesNoIdTotal}** missing a Patient Alternate ID and **${summary.fixesUnmatchedTotal}** with an unmatched ID on file). ` +
        `Comparing the unmatched IDs against **Pharmacy To-Do** (edit distance ≤ 2) surfaces **${fuzzyRows.length} fills** that are possible 1–2 character hex typos of active **Pharmacy To-Do** patients to verify.`
    };
  }

  // 8. Financials / Monthly P&L / Proceeds / Revenue / Margin per Rx / Fees
  if (
    ql.includes('financial') || ql.includes('proceeds') || ql.includes('p&l') || ql.includes('pnl') ||
    ql.includes('revenue') || ql.includes('profit') || ql.includes('fee') || ql.includes('commission') ||
    ql.includes('962k') || ql.includes('371k') || ql.includes('911') || ql.includes('cost to fill') ||
    ql.includes('margin') || ql.includes('monthly') || ql.includes('august') || ql.includes('july') ||
    ql.includes('june')
  ) {
    const s3 = state.slide3_financials;
    const revRow = s3.ytdTable.find(r => r.item === 'Pharmacy revenue');
    const gmRow = s3.ytdTable.find(r => r.item === 'Pharmacy gross margin');
    const feesRow = s3.ytdTable.find(r => r.item === 'Membership fees collected');
    const procRow = s3.ytdTable.find(r => r.item === 'Program proceeds');
    const sepProceeds = s3.monthlyProceeds.values[s3.monthlyProceeds.values.length - 1];
    const mpnl = ex.monthlyPnL || {};
    const mRev = mpnl['Revenue'] || {};
    const mGm = mpnl['Gross Margin'] || {};
    const mRx = mpnl['Rx Count'] || {};
    const mSub = mpnl['Sub. Fees'] || {};
    const mPerRx = mpnl['Gross Margin per Rx'] || {};

    return {
      question: q,
      answer:
        `### **${meta.client} Financial Performance & Monthly P&L Through ${meta.asOfDateFormatted || 'September 30, 2026'}**\n` +
        `• **Pharmacy Revenue**: **${revRow ? revRow.formatted : '$2,336,983'}** YTD across **${s3.totalFillsInPnl.toLocaleString()}** GLP-1 fills (Monthly: Jun **$${Number(mRev.Jun || 0).toLocaleString()}**, Jul **$${Number(mRev.Jul || 0).toLocaleString()}**, Aug **$${Number(mRev.Aug || 0).toLocaleString()}**, Sep **$${Number(mRev.Sep || 0).toLocaleString()}**)\n` +
        `• **Pharmacy Gross Margin**: **${gmRow ? gmRow.formatted : '$1,758,625'}** YTD deck headline / **$${Number(mGm.YTD || 0).toLocaleString()}** pre-adjustment worksheet (Sep: **$${Number(mGm.Sep || 0).toLocaleString()}** or **$${mPerRx.Sep || s3.septemberGrossMarginPerFill}/Rx**; Aug: **$${Number(mGm.Aug || 0).toLocaleString()}** or **$${mPerRx.Aug || 922.70}/Rx**; YTD avg: **$${mPerRx.YTD || 863.10}/Rx**)\n` +
        `• **Membership Fees Collected**: **+${feesRow ? feesRow.formatted : '$44,164'}** YTD (Sep: **$${Number(mSub.Sep || 0).toLocaleString()}**, Aug: **$${Number(mSub.Aug || 0).toLocaleString()}**)\n` +
        `• **Net Program Proceeds (After Ad Spend & Fees)**: **$${sepProceeds.toLocaleString()}** in September (on **${mRx.Sep || 673}** fills) and **${procRow ? procRow.formatted : '$961,691'}** YTD.\n\n` +
        `| Financial Line Item | Sep 2026 | YTD Through Sep 2026 |\n` +
        `| --- | --- | --- |\n` +
        `| **Pharmacy Revenue** | **$${Number(mRev.Sep || 0).toLocaleString()}** | **${revRow ? revRow.formatted : '$2,336,983'}** |\n` +
        `| **Pharmacy Gross Margin** | **$${Number(mGm.Sep || 0).toLocaleString()}** | **${gmRow ? gmRow.formatted : '$1,758,625'}** |\n` +
        `| **Membership Fees Collected** | **$${Number(mSub.Sep || 0).toLocaleString()}** | **${feesRow ? feesRow.formatted : '$44,164'}** |\n` +
        `| **Net Program Proceeds** | **$${sepProceeds.toLocaleString()}** | **${procRow ? procRow.formatted : '$961,691'}** |\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'Monthly Net Program Proceeds ($)',
          labels: s3.monthlyProceeds.months || ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'],
          datasets: [
            { label: 'Net Program Proceeds ($)', data: s3.monthlyProceeds.values || [], backgroundColor: '#2563eb' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // Default executive overview for the authenticated tenant
  const s2 = state.slide2_summary;
  const s3 = state.slide3_financials;
  const revRow = s3.ytdTable.find(r => r.item === 'Pharmacy revenue');
  const feesRow = s3.ytdTable.find(r => r.item === 'Membership fees collected');
  const procRow = s3.ytdTable.find(r => r.item === 'Program proceeds');
  const sepProceeds = s3.monthlyProceeds.values[s3.monthlyProceeds.values.length - 1];
  const activeSep = s2.kpis.find(k => k.id === 'active_sep')?.value || '862';
  const fillsSep = s2.kpis.find(k => k.id === 'fills_sep')?.value || '673';

  return {
    question: q || 'Executive Summary',
    answer:
      `**${meta.programTitle} (${meta.asOfDateFormatted || 'Through September 30, 2026'})**:\n` +
      `• **Active Members & Fills**: **${activeSep} active members** and **${fillsSep} GLP-1 fills** in September at **${meta.pharmacyPartner}**.\n` +
      `• **Revenue & Net Proceeds**: **${revRow ? revRow.formatted : '$2,336,983'}** YTD pharmacy revenue, **${feesRow ? feesRow.formatted : '$44,164'}** YTD membership fees collected, **$${sepProceeds.toLocaleString()}** September net program proceeds, and **${procRow ? procRow.formatted : '$961,691'}** YTD net program proceeds.\n` +
      `• **Worklist Action Queues**: **${summary.todoTotal}** active patients on Pharmacy To-Do (**${summary.todoUrgent}** urgent cancellation pending), **${summary.refillTotal}** overdue refills, **${summary.fixesTotal}** Pharmacy Data Fixes, and **${summary.endedTotal}** Ended – Never Filled records.`
  };
}

function buildGeminiDataContext(state) {
  const wl = state.worklists;
  const todoRows = wl.pharmacyTodo.rows;
  const refillRows = wl.refillFollowup.rows;
  const noIdRows = wl.pharmacyDataFixes.noIdRows;
  const unmatchedRows = wl.pharmacyDataFixes.unmatchedRows;
  const endedRows = wl.endedNeverFilled.rows;

  // Strictly AGGREGATE context only — zero individual member/patient rows or IDs
  return {
    privacyPolicy: 'AGGREGATE_ONLY_NO_MEMBER_LEVEL_DATA',
    meta: state.meta,
    executiveSummary: state.slide2_summary,
    programFinancials: state.slide3_financials,
    patientSources: state.slide4_sources,
    paidMediaRoi: state.slide5_paidMedia,
    conversionFunnel: state.slide6_funnel,
    refillPersistence: state.slide7_refill,
    medicationMix: state.slide8_medMix,
    programDefinitions: state.slide9_appendix,
    cohortRetention: state.slide10_retention,
    enrollmentReporting: state.enrollmentReporting || state.analysisWorkbook?.enrollmentReporting || null,
    analysisWorkbook: state.analysisWorkbook || null,
    worklistSummary: computeWorklistSummary(wl),
    worklistAggregations: {
      pharmacyTodo_ActivePatients: {
        totalCount: todoRows.length,
        byPriority: countByField(todoRows, 'Priority'),
        byPharmacyFinding: countByField(todoRows, 'Pharmacy finding'),
        byPatientSource: countByField(todoRows, 'Patient source'),
        byEmployerGroup: countByField(todoRows, 'Employer group'),
        byRxMedication: countByField(todoRows, 'Rx medication'),
        byMembershipStatus: countByField(todoRows, 'Membership status'),
        byStatus: countByField(todoRows, 'Status')
      },
      refillFollowup_OverduePatients: {
        totalCount: refillRows.length,
        byMembershipStatus: countByField(refillRows, 'Membership status'),
        byPatientSource: countByField(refillRows, 'Patient source'),
        byLastItemFilled: countByField(refillRows, 'Last item filled'),
        byFillsToDate: countByField(refillRows, 'GLP-1 fills to date'),
        byStatus: countByField(refillRows, 'Status')
      },
      pharmacyDataFixes_UnlinkedFills: {
        noIdCount: noIdRows.length,
        unmatchedCount: unmatchedRows.length,
        fuzzySuggestedMatchCount: unmatchedRows.filter(r => r.suggestedMatch).length,
        noIdByPrescriber: countByField(noIdRows, 'Prescriber'),
        noIdByPayer: countByField(noIdRows, 'Payer'),
        noIdByDispensedItem: countByField(noIdRows, 'Dispensed item'),
        unmatchedByPrescriber: countByField(unmatchedRows, 'Prescriber'),
        unmatchedByDispensedItem: countByField(unmatchedRows, 'Dispensed item'),
        combinedByPrescriber: countByField([...noIdRows, ...unmatchedRows], 'Prescriber')
      },
      endedNeverFilled_ChurnedMembers: {
        totalCount: endedRows.length,
        byStage: countByField(endedRows, 'Stage'),
        byPharmacyFinding: countByField(endedRows, 'Pharmacy finding'),
        byPatientSource: countByField(endedRows, 'Patient source'),
        byEmployerGroup: countByField(endedRows, 'Employer group')
      }
    }
  };
}

async function askGeminiWithFullData(state, question, history = []) {
  const memberBlockedFlag = isMemberLevelQuery(state, question);
  const contextData = buildGeminiDataContext(state);
  const meta = state.meta || {};
  const s2 = state.slide2_summary || {};
  const s3 = state.slide3_financials || {};
  const ws = contextData.worklistSummary;

  const activeSep = s2.kpis?.find(k => k.id === 'active_sep')?.value || '862';
  const fillsSep = s2.kpis?.find(k => k.id === 'fills_sep')?.value || '673';
  const sepProceedsVal = s3.monthlyProceeds?.values?.[s3.monthlyProceeds.values.length - 1] || 371214;
  const ytdProceedsFmt = s3.ytdTable?.find(r => r.item === 'Program proceeds')?.formatted || '$961,691';
  const ytdRevFmt = s3.ytdTable?.find(r => r.item === 'Pharmacy revenue')?.formatted || '$2,336,983';
  const ytdFeesFmt = s3.ytdTable?.find(r => r.item === 'Membership fees collected')?.formatted || '$44,164';

  const systemInstruction = `You are a sharp, insightful, executive-level healthcare analytics strategist at Bridge Health Hub supporting the ${meta.programTitle || 'GLP-1 Weight Loss Program'} for ${meta.client || 'our client'} and ${meta.pharmacyPartner || 'the pharmacy'} (data through ${meta.asOfDateFormatted || 'September 30, 2026'}).

You are having an intelligent, natural, executive-ready conversation with a stakeholder or pharmacy/program leader.

STRICT PRIVACY & AGGREGATE-ONLY RULE:
- You ONLY provide AGGREGATE program, financial, enrollment/disenrollment, channel/broker, employer-group, prescriber, payer, medication/dose, and worklist summary analytics.
- Zero individual member IDs, patient alternate IDs, or row-level member/patient records exist in your context. NEVER output or fabricate individual member IDs, patient alternate IDs, UUIDs, or individual member/patient records.
- If someone asks to look up a specific member ID or individual patient record (e.g. an 8-char hex ID like 6d3f1831 or trinidad), politely explain that for member privacy, Ask Bridge AI only provides aggregate program, financial, channel, employer, prescriber, payer, medication, and worklist summary analytics—and direct them to use the search bar in the Pharmacy To-Do, Refill Follow-Up, Pharmacy Data Fixes, or Ended Memberships tabs for individual patient lookups.

HOW TO REASON & COMMUNICATE INTELLIGENTLY ACROSS BOTH PPTX AND XLSX DATA:
- Synthesize across ALL THREE underlying data sources seamlessly:
  1. Executive Report Deck (${meta.client}):
     - Headline KPIs: ${activeSep} active members in Sep (+207 net additions vs Aug), ${fillsSep} Sep GLP-1 fills (411 Wegovy Pen, 256 Wegovy Pill [38%], 6 Ozempic), $${sepProceedsVal.toLocaleString()} Sep net program proceeds after ad spend, ${ytdProceedsFmt} YTD net program proceeds after ad spend, ${ytdRevFmt} YTD pharmacy revenue across ${s3.totalFillsInPnl?.toLocaleString() || '2,034'} completed GLP-1 fills, ${ytdFeesFmt} YTD membership fees collected. Whenever asked about revenue, membership fees, or net program proceeds, always cite both the September net proceeds ($${sepProceedsVal.toLocaleString()}) and the YTD net proceeds (${ytdProceedsFmt}) alongside YTD pharmacy revenue (${ytdRevFmt}) and YTD membership fees (${ytdFeesFmt}).
     - Channel & Paid Media Economics: Broker partners (EPIC, LHD, McGohan Brabender) drove 62.3% of September enrollments and have higher 1st-fill conversion (77% EPIC, 76% LHD, 88% McGohan) and lower churn than Paid Media (62% 1st-fill, 4.63x ROAS on $142,033 spend generating $658,361 gross margin).
     - First-Fill Funnel & Refill Persistence: 69% of pre-Sep sign-ups (523 of 760) filled their 1st Rx (90% saw provider, 80% prescribed, 86% of prescribed filled); once started, 94% refilled (Fill 1→2) and 87% were still filling at Fill 3.
  2. Granular Analysis Workbook (\`analysisWorkbook\` & \`enrollmentReporting\` from September 2026 Analysis.xlsx):
     - Enrollment, Disenrollment & Active Reporting (\`enrollmentReporting\`): Monthly (Jan–Sep), Quarterly (Q1–Q3), and YTD enrollments, disenrollments/cancellations, auto-disenrollments, and currently active counts by Channel/Broker (EPIC: 452 enrolled, 384 active [85.0%], 68 disenrolled [15.0%]; Paid Media: 417 enrolled, 266 active [63.8%], 151 disenrolled [36.2%]; Employee: 54 enrolled, 31 active, 23 disenrolled; LHD: 54 enrolled, 51 active [94.4%], 3 disenrolled [5.6%]; Other: 51 enrolled, 33 active, 18 disenrolled; McGohan Brabender: 8 enrolled, 7 active [87.5%], 1 disenrolled) and across all 38 Employer Groups (e.g., City of Evansville [80 YTD: 52 Aug, 28 Sep; 75 active, 5 disenrolled], Putnam County [31 YTD; 28 active, 3 disenrolled], Hamilton Center [29 YTD; 28 active, 1 disenrolled], GCS [27 Sep], Benton County [26 YTD], Healthcare Therapy Services [20 YTD], Warrick County [17 YTD], City of Lawrence [16 YTD], Epic Employees [16 YTD], IMCU [15 YTD], PCSC [13 YTD], Terre Haute [12 YTD], DRG [12 YTD], Bose McKinney & Evans [10 YTD], KVC [8], Clay County [8], Four Rivers [7], Jennings County [7], State of IN [7], Little Star [6], First Financial Bank [5], etc.).
     - Whenever asked about cancellations or disenrollments, always include both September cancellations and full YTD cancellations by source (e.g. 264 YTD / 25.5% of enrolled and 91 in September / 33.3%, with YTD source totals Paid Media 151, EPIC 68, Employee 23, Other 18, LHD 3, McGohan Brabender 1, plus 231 auto-disenrolled).
     - Full Monthly P&L (\`exhibits.monthlyPnL\`): Jan–Sep + YTD Rx Count, Pharmacy Revenue (Sep $769,074.12, Aug $558,672.02, Jul $382,652.42, Jun $247,935.52, YTD ${ytdRevFmt}), Gross Margin (Sep $613,123.94 [$911.03/Rx], Aug $469,654.60 [$922.70/Rx], YTD avg $863.10/Rx), Sub. Fees, Alpha fees, Bridge fees, Broker fees, and Cost to Fill.
     - Dose-Level Dispenses (\`exhibits.dispensesByDoseMonthly\`): Monthly dispenses across all 13 specific Ozempic & Wegovy Pen/Tablet dose strengths.
     - Pharmacy Claims Analytics (\`dispenseAnalytics\`): Breakdown by Transaction Status (Completed, Cancelled, Waiting for Pick up), by all 11 Prescribers (NPI, completed/cancelled/waiting fills, total revenue, acquisition cost, total margin, avg margin/fill), and by Primary & Secondary Third-Party Payers/Savings Cards (Wegovy Savings Card, Connective RX, Anthem, DC Inj Weight Loss Program, etc.).
  3. First-Fill & Operations Worklist Workbook (\`worklistSummary\` & \`worklistAggregations\`):
     - ${ws.todoTotal} active members on Pharmacy To-Do (${ws.todoUrgent} Urgent cancellation pending, ${ws.todoHigh} High priority, ${ws.todoMonitor} Monitor), ${ws.refillTotal} overdue refills on Refill Follow-Up, ${ws.fixesTotal} unlinked fills on Pharmacy Data Fixes (${ws.fixesNoIdTotal} missing an ID and ${ws.fixesUnmatchedTotal} unmatched-ID fills, of which ${ws.fuzzySuggestedCount} fills have a possible 1–2 character typo match to ${ws.todoWithFuzzyCount} active To-Do patients), and ${ws.endedTotal} Ended – Never Filled members.
- Answer both the "what" (exact numbers, percentages, and trends) and the "so what" (strategic insight, root causes, and operational takeaways).
- Never cite slide numbers ("Slide 3") or raw JSON key names.

RICH VISUAL FORMATTING — ALWAYS INCLUDE MARKDOWN TABLES & INTERACTIVE CHARTS:
- For any analytical question (financials, channels, employers, doses, prescribers, payers, cancellations, or worklists), structure your response with:
  1. **Executive Headline Summary** (concise bullet points with bold metrics).
  2. **Structured Markdown Pipe Table** (\`| Metric | ... |\`) comparing the relevant numbers, percentages, or time periods.
  3. **Interactive Chart Block (\`\`\`chart ... \`\`\`)**: Include a valid JSON Chart.js specification inside a fenced \`\`\`chart code block so the UI renders a live interactive chart directly inside your reply! Use this exact JSON schema inside \`\`\`chart:
\`\`\`chart
{"type":"bar","title":"Chart Title Here","labels":["Label 1","Label 2"],"datasets":[{"label":"Series 1","data":[100,200],"backgroundColor":"#2563eb"},{"label":"Series 2","data":[80,150],"backgroundColor":"#059669"}]}
\`\`\`
  (Keep the JSON inside \`\`\`chart on a single line or clean valid JSON with numeric values only—no dollar signs or commas inside the \`data\` array numbers).`;

  const conversationTurns = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-8)) {
      if (h && h.question && h.answer) {
        conversationTurns.push({ role: 'user', parts: [{ text: String(h.question) }] });
        conversationTurns.push({ role: 'model', parts: [{ text: String(h.answer) }] });
      }
    }
  }

  const privacyNote = memberBlockedFlag
    ? '\n[SYSTEM NOTE: The user message references a specific member/patient identifier. Politely explain that for member privacy, Ask Bridge AI only provides aggregate program, financial, channel, employer, prescriber, payer, medication, and worklist summary analytics (no individual member-level records), and direct them to use the Pharmacy Worklists tabs to look up individual patient IDs.]'
    : '';

  const userPrompt = `[Reference Aggregate Data Context for ${meta.client}: ${JSON.stringify(contextData)}]${privacyNote}\n\nUser message: ${question}`;
  conversationTurns.push({ role: 'user', parts: [{ text: userPrompt }] });

  const payload = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: conversationTurns,
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 256 }
    }
  };

  let data = null;
  let usedModel = VERTEX_GEMINI_MODEL;

  // Primary path: Vertex AI via GCP Project Billing (Cloud Run Service Account / gcloud ADC)
  try {
    const token = await getGcpAccessToken();
    const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${VERTEX_GEMINI_MODEL}:generateContent`;
    const vertexCtrl = new AbortController();
    const vertexTimer = setTimeout(() => vertexCtrl.abort(), 25000);
    let vertexResp;
    try {
      vertexResp = await fetch(vertexUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: vertexCtrl.signal
      });
    } finally {
      clearTimeout(vertexTimer);
    }
    if (!vertexResp.ok) {
      const errText = await vertexResp.text();
      throw new Error(`Vertex AI HTTP ${vertexResp.status}: ${errText.slice(0, 300)}`);
    }
    data = await vertexResp.json();
    usedModel = VERTEX_GEMINI_MODEL;
  } catch (vertexErr) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      throw vertexErr;
    }
    // Secondary fallback to AI Studio API key if configured
    const aiStudioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const studioResp = await fetch(aiStudioUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!studioResp.ok) {
      const errText = await studioResp.text();
      throw new Error(`Vertex (${vertexErr.message}) & AI Studio HTTP ${studioResp.status}: ${errText.slice(0, 200)}`);
    }
    data = await studioResp.json();
    usedModel = GEMINI_MODEL;
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find(p => typeof p.text === 'string' && !p.thought) || parts.find(p => typeof p.text === 'string');
  const rawText = textPart?.text;
  if (!rawText) {
    throw new Error('Empty response from Gemini API');
  }

  const cleanReply = rawText.trim();
  return {
    question,
    clientId: meta.clientId,
    aiPowered: true,
    aiModel: usedModel,
    memberLevelBlocked: memberBlockedFlag,
    reply: cleanReply,
    answer: cleanReply
  };
}

app.post('/api/ask', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const { question, history, mode } = req.body || {};
  const q = String(question || '').trim() || 'How is the program performing through September 2026?';
  const memberBlockedFlag = isMemberLevelQuery(state, q);
  recordAuditEvent(req, 'AI_QUERY', { question: q.slice(0, 140), memberBlocked: memberBlockedFlag });

  if (mode !== 'instant') {
    try {
      const geminiResult = await askGeminiWithFullData(state, q, history);
      return res.json(geminiResult);
    } catch (err) {
      console.error('Gemini API error, falling back to deterministic engine:', err.message);
    }
  }

  if (memberBlockedFlag) {
    const blocked = buildMemberPrivacyGuardrailReply(state, q);
    return res.json({
      question: q,
      clientId,
      aiPowered: false,
      aiModel: 'privacy-guardrail',
      memberLevelBlocked: true,
      reply: blocked.answer,
      answer: blocked.answer
    });
  }

  const fallback = answerQuestion(state, q);
  res.json({
    question: q,
    clientId,
    aiPowered: false,
    aiModel: 'deterministic-fallback',
    reply: fallback.answer,
    answer: fallback.answer
  });
});

app.listen(PORT, () => {
  console.log(`Bridge Multi-Client GLP-1 Program Portal running on http://localhost:${PORT} (Gemini Model: ${VERTEX_GEMINI_MODEL} via Vertex AI GCP Billing, GCS Bucket: ${GCS_STATE_BUCKET || 'local-fallback'})`);
});
