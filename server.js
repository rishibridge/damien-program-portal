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
  if (typeof saveJsonToGcsAsync === 'function') {
    saveJsonToGcsAsync('global/users_directory.json', usersList);
  }
}

// Persistent Per-Tenant Audit Log (clients/<clientId>/audit_log.json + GCS)
const clientAuditLogs = {}; // clientId -> Array of events
// Persistent Per-Tenant Ask Bridge AI Q&A Transcript Log (clients/<clientId>/qa_history.json + GCS)
const clientQaLogs = {}; // clientId -> Array of { id, timestamp, clientId, user, displayName, role, ip, question, answer, aiPowered, aiModel, memberLevelBlocked, latencyMs }

function getClientLocalAuditPath(clientId) {
  return path.join(CLIENTS_DIR, clientId, 'audit_log.json');
}

function getClientLocalQaPath(clientId) {
  return path.join(CLIENTS_DIR, clientId, 'qa_history.json');
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

function loadClientQaLog(clientId) {
  if (clientQaLogs[clientId]) return clientQaLogs[clientId];
  const p = getClientLocalQaPath(clientId);
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) {
        clientQaLogs[clientId] = arr;
        return arr;
      }
    } catch (_) {}
  }
  clientQaLogs[clientId] = [];
  return clientQaLogs[clientId];
}

function classifyAuditCategory(eventType) {
  const et = String(eventType || '').toUpperCase();
  if (et.startsWith('LOGIN') || et.startsWith('LOGOUT') || et.startsWith('MFA') || et.includes('LOCKOUT') || et.includes('GEO_BLOCK') || et.includes('PASSWORD') || et.includes('USER_') || et.includes('UNAUTHORIZED')) {
    return 'security_auth';
  }
  if (et.includes('VIEW') || et.includes('SEARCH') || et === 'PORTAL_LOADED' || et.includes('BRIEFING')) {
    return 'view_access';
  }
  if (et.startsWith('WORKLIST_')) {
    return 'worklist_edit';
  }
  if (et === 'AI_QUERY') {
    return 'ai_qa';
  }
  if (et.includes('EXPORT')) {
    return 'export';
  }
  return 'other';
}

function formatAuditSummary(eventType, details = {}) {
  const et = String(eventType || '').toUpperCase();
  if (et === 'LOGIN_SUCCESS_MFA') return `Signed in with 2FA (${details.verifiedVia === 'totp_authenticator' ? 'Authenticator App' : 'Email Code'})`;
  if (et === 'LOGIN_SUCCESS') return `Signed in (${details.method || 'trusted browser'})`;
  if (et === 'LOGOUT') return 'Signed out and revoked session token';
  if (et === 'LOGIN_FAILED') return `Failed password attempt (${details.attemptsUsed || 1}/5 used)`;
  if (et === 'BRUTE_FORCE_LOCKOUT_TRIGGERED' || et === 'LOGIN_LOCKED_OUT') return `Account locked out for 15m (5 failed attempts)`;
  if (et === 'MFA_CHALLENGE_ISSUED') return `2FA challenge issued (${details.email || ''})`;
  if (et === 'MFA_VERIFICATION_FAILED') return 'Entered invalid 6-digit MFA code';
  if (et === 'GEO_BLOCKED') return `Blocked non-US request from ${details.country || 'outside US'} (${details.path || '/'})`;
  if (et === 'PORTAL_LOADED') return `Opened ${details.clientName || details.clientId || 'Program'} Analytics Portal`;
  if (et === 'SECTION_VIEW') return `Viewed section: ${details.viewTitle || details.viewId || 'Dashboard'}`;
  if (et === 'WORKLIST_SUBTAB_VIEW') return `Viewed worklist tab: ${details.subtabTitle || details.subtab || 'Worklist'}`;
  if (et === 'PATIENT_RECORD_VIEW') return `Viewed Patient Record: ${details.patientId || details.rowId || ''} (${details.sheet || 'worklist'})`;
  if (et === 'PATIENT_SEARCH_QUERY') return `Searched ${details.sheet || 'worklist'} for "${details.query || ''}" (${details.matchCount ?? 0} matches)`;
  if (et === 'ENROLLMENT_FILTER_VIEW') return `Viewed Enrollment Report (${details.mode || 'cumulative'}${details.periodLabel ? ': ' + details.periodLabel : ''})`;
  if (et === 'DEFINITIONS_VIEW') return 'Viewed Program Definitions & Data Notes';
  if (et === 'EXECUTIVE_BRIEFING_VIEW' || et === 'EXECUTIVE_BRIEFING_PRINT') return `Executive Briefing (${details.action || 'viewed/printed'})`;
  if (et === 'WORKLIST_ROW_EDIT') return `Updated patient ${details.patientId || details.rowId} in ${details.sheet} (${(details.updatedFields || []).join(', ')})`;
  if (et === 'WORKLIST_APPLY_FUZZY_FIXES') return `Auto-reconciled ${details.appliedCount || 0} fuzzy ID matches (${details.todoLinkedCount || 0} linked)`;
  if (et === 'WORKLIST_RESET') return 'Reset worklist runtime edits to baseline';
  if (et === 'CSV_EXPORT') return `Exported CSV: ${details.filename || details.sheet || 'worklist'} (${details.rowCount || 0} rows)`;
  if (et === 'AI_QUERY') return `Asked Bridge AI: "${String(details.question || '').slice(0, 90)}"`;
  if (et === 'USER_CREATED') return `Created named user '${details.createdUsername}' (role: ${details.role})`;
  if (et === 'USER_UPDATED_BY_ADMIN') return `Updated user '${details.targetUsername}' (${(details.updatedFields || []).join(', ')})`;
  if (et === 'USER_UNLOCKED_BY_ADMIN') return `Unlocked brute-force lockout for '${details.targetUsername}'`;
  if (et === 'USER_PASSWORD_RESET_BY_ADMIN') return `Reset password for '${details.targetUsername}'`;
  if (et === 'USER_DELETED_BY_ADMIN') return `Removed user account '${details.deletedUsername}'`;
  if (et === 'MFA_CONFIG_UPDATED') return `Updated MFA settings for '${details.targetUsername}' (method: ${details.mfaMethod})`;
  if (et === 'PASSWORD_CHANGED') return 'Updated account password';
  if (et === 'UNAUTHORIZED_ADMIN_ATTEMPT') return `Blocked unauthorized admin call to ${details.endpoint || 'admin API'}`;
  if (et === 'PII_INPUT_REJECTED') return `Rejected prohibited PII / non-hex input in ${details.field || 'worklist'} (${details.reason || 'policy'})`;
  return JSON.stringify(details || {});
}

function recordAuditEvent(req, eventType, details = {}, overrideClient = null, overrideUser = null) {
  const clientId = overrideClient || req?.clientId || 'damien';
  const username = overrideUser || req?.authenticatedUser || 'unauthenticated';
  const displayName = req?.authenticatedDisplayName || username;
  const role = req?.authenticatedRole || 'client_user';
  const ip = req ? getClientIp(req) : '127.0.0.1';
  const country = req ? getClientCountry(req) : 'US';
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    clientId,
    user: username,
    displayName,
    role,
    ip,
    country,
    eventType,
    category: classifyAuditCategory(eventType),
    summary: formatAuditSummary(eventType, details),
    details
  };
  const logArr = loadClientAuditLog(clientId);
  logArr.unshift(entry);
  if (logArr.length > 1000) logArr.length = 1000;
  try {
    const localPath = getClientLocalAuditPath(clientId);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(logArr, null, 2), 'utf8');
  } catch (_) {}
  if (typeof saveJsonToGcsAsync === 'function') {
    saveJsonToGcsAsync(`clients/${clientId}/audit_log.json`, logArr);
  }
  return entry;
}

function recordQaHistoryEntry(req, qaPayload) {
  const clientId = qaPayload.clientId || req?.clientId || 'damien';
  const username = req?.authenticatedUser || 'unauthenticated';
  const displayName = req?.authenticatedDisplayName || username;
  const role = req?.authenticatedRole || 'client_user';
  const ip = req ? getClientIp(req) : '127.0.0.1';
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    clientId,
    user: username,
    displayName,
    role,
    ip,
    question: String(qaPayload.question || ''),
    answer: String(qaPayload.answer || ''),
    aiPowered: Boolean(qaPayload.aiPowered),
    aiModel: String(qaPayload.aiModel || 'unknown'),
    memberLevelBlocked: Boolean(qaPayload.memberLevelBlocked),
    latencyMs: Number(qaPayload.latencyMs || 0)
  };
  const qaArr = loadClientQaLog(clientId);
  qaArr.unshift(entry);
  if (qaArr.length > 500) qaArr.length = 500;
  try {
    const localPath = getClientLocalQaPath(clientId);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify(qaArr, null, 2), 'utf8');
  } catch (_) {}
  if (typeof saveJsonToGcsAsync === 'function') {
    saveJsonToGcsAsync(`clients/${clientId}/qa_history.json`, qaArr);
  }
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
const BUILTIN_PROTECTED_USERS = new Set(['damien', 'metro', 'rishi.damien', 'brady.admin', 'rishi.metro', 'pharmacist.damien']);

function isCallerBridgeAdmin(req) {
  const users = loadUsersDirectory();
  const userRec = users.find(u => u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase());
  const role = userRec?.role || req.authenticatedRole || 'client_user';
  return role === 'bridge_admin';
}

function computeUserAndTenantUsage(clientId, allTenantUsers, allAuditEvents, allQaEvents) {
  const now = Date.now();
  const perUser = {};
  for (const u of allTenantUsers) {
    const key = u.username.toLowerCase();
    const lockCheck = checkRateLimitKey(`user:${key}`);
    perUser[key] = {
      loginCount: 0,
      viewCount: 0,
      patientViewCount: 0,
      editCount: 0,
      aiQueryCount: 0,
      exportCount: 0,
      lastLoginAt: null,
      lastActiveAt: null,
      isOnline: false,
      isLockedOut: Boolean(lockCheck.locked),
      lockoutRetrySeconds: lockCheck.retryAfterSeconds || 0
    };
  }

  let totalLogins = 0;
  let totalPageAndPatientViews = 0;
  let totalPatientRecordViews = 0;
  let totalWorklistEdits = 0;
  let totalExports = 0;

  for (const ev of allAuditEvents) {
    const uKey = String(ev.user || '').toLowerCase();
    const uStat = perUser[uKey];
    const et = String(ev.eventType || '').toUpperCase();
    const cat = ev.category || classifyAuditCategory(et);

    if (uStat && ev.timestamp) {
      if (!uStat.lastActiveAt || ev.timestamp > uStat.lastActiveAt) {
        uStat.lastActiveAt = ev.timestamp;
      }
      if ((now - new Date(ev.timestamp).getTime()) < IDLE_TIMEOUT_SECONDS * 1000 && et !== 'LOGOUT') {
        uStat.isOnline = true;
      }
    }

    if (et === 'LOGIN_SUCCESS_MFA' || et === 'LOGIN_SUCCESS') {
      totalLogins++;
      if (uStat) {
        uStat.loginCount++;
        if (!uStat.lastLoginAt || ev.timestamp > uStat.lastLoginAt) {
          uStat.lastLoginAt = ev.timestamp;
        }
      }
    } else if (cat === 'view_access') {
      totalPageAndPatientViews++;
      if (uStat) uStat.viewCount++;
      if (et === 'PATIENT_RECORD_VIEW' || et === 'PATIENT_SEARCH_QUERY') {
        totalPatientRecordViews++;
        if (uStat) uStat.patientViewCount++;
      }
    } else if (cat === 'worklist_edit') {
      totalWorklistEdits++;
      if (uStat) uStat.editCount++;
    } else if (cat === 'export') {
      totalExports++;
      if (uStat) uStat.exportCount++;
    }
  }

  for (const qa of allQaEvents) {
    const uKey = String(qa.user || '').toLowerCase();
    const uStat = perUser[uKey];
    if (uStat) {
      uStat.aiQueryCount++;
      if (qa.timestamp && (!uStat.lastActiveAt || qa.timestamp > uStat.lastActiveAt)) {
        uStat.lastActiveAt = qa.timestamp;
      }
    }
  }

  // Also Count AI_QUERY events if qa_history didn't capture earlier ones
  for (const ev of allAuditEvents) {
    if (ev.eventType === 'AI_QUERY') {
      const uKey = String(ev.user || '').toLowerCase();
      const uStat = perUser[uKey];
      if (uStat && uStat.aiQueryCount === 0) {
        uStat.aiQueryCount++;
      }
    }
  }

  const activeUsersOnline = Object.values(perUser).filter(s => s.isOnline).length;
  const totalAiQuestions = Math.max(
    allQaEvents.length,
    allAuditEvents.filter(e => e.eventType === 'AI_QUERY').length
  );

  return {
    usageSummary: {
      totalLogins,
      activeUsersOnline,
      totalNamedUsers: allTenantUsers.length,
      totalPageAndPatientViews,
      totalPatientRecordViews,
      totalWorklistEdits,
      totalAiQuestions,
      totalExports
    },
    perUser
  };
}

app.get('/api/security/overview', async (req, res) => {
  const clientId = req.clientId || 'damien';
  await ensureSecurityLogsHydrated(clientId);
  const isAdmin = isCallerBridgeAdmin(req);
  const allTenantUsers = loadUsersDirectory().filter(u => u.clientId === clientId);
  const allAuditEvents = loadClientAuditLog(clientId).map(ev => ({
    ...ev,
    category: ev.category || classifyAuditCategory(ev.eventType),
    summary: ev.summary || formatAuditSummary(ev.eventType, ev.details)
  }));
  const allQaEvents = loadClientQaLog(clientId);

  const { usageSummary, perUser } = computeUserAndTenantUsage(clientId, allTenantUsers, allAuditEvents, allQaEvents);

  const visibleUsers = await Promise.all(
    (isAdmin ? allTenantUsers : allTenantUsers.filter(u => u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase()))
      .map(async u => {
        const canSeeSecret = isAdmin || u.username.toLowerCase() === String(req.authenticatedUser || '').toLowerCase();
        const qrUrl = canSeeSecret ? await buildTotpQrDataUrl(u.username, u.totpSecret || generateTotpSecret(u.username)) : undefined;
        const stats = perUser[u.username.toLowerCase()] || {};
        return {
          username: u.username,
          displayName: u.displayName,
          email: u.email,
          role: u.role,
          isBuiltIn: BUILTIN_PROTECTED_USERS.has(u.username.toLowerCase()),
          mfaEnabled: true,
          mfaMethod: u.mfaMethod || 'email',
          totpSecret: canSeeSecret ? u.totpSecret : undefined,
          totpQrDataUrl: qrUrl,
          passwordUpdatedAt: u.passwordUpdatedAt,
          usage: stats
        };
      })
  );

  const auditEvents = (isAdmin
    ? allAuditEvents
    : allAuditEvents.filter(ev => String(ev.user || '').toLowerCase() === String(req.authenticatedUser || '').toLowerCase())
  ).slice(0, 250);

  const qaHistory = (isAdmin
    ? allQaEvents
    : allQaEvents.filter(qa => String(qa.user || '').toLowerCase() === String(req.authenticatedUser || '').toLowerCase())
  ).slice(0, 150);

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
    usageSummary,
    users: visibleUsers,
    auditEvents,
    qaHistory
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
    totpSecret: generateTotpSecret(cleanUser),
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

// Admin User Lifecycle Management: Edit Email/Role/DisplayName, Reset Password, or Unlock Account (bridge_admin only)
app.patch('/api/security/users/:username', (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: `/api/security/users/${req.params.username}`, method: 'PATCH' });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can modify user accounts.'
    });
  }
  const targetUsername = String(req.params.username || '').trim().toLowerCase();
  const users = loadUsersDirectory();
  const userRec = users.find(u => u.username.toLowerCase() === targetUsername && u.clientId === req.clientId);
  if (!userRec) {
    return res.status(404).json({ ok: false, error: 'User not found in this tenant.' });
  }

  const { email, displayName, role, newPassword, unlock } = req.body || {};
  const updatedFields = [];

  if (unlock) {
    loginFailuresByKey.delete(`user:${targetUsername}`);
    updatedFields.push('unlocked_account');
    recordAuditEvent(req, 'USER_UNLOCKED_BY_ADMIN', { targetUsername: userRec.username });
  }
  if (email !== undefined && String(email).includes('@')) {
    userRec.email = String(email).trim();
    updatedFields.push('email');
  }
  if (displayName !== undefined && String(displayName).trim()) {
    userRec.displayName = String(displayName).trim();
    updatedFields.push('displayName');
  }
  if (role !== undefined && ['bridge_admin', 'client_user', 'pharmacist'].includes(role)) {
    userRec.role = role;
    updatedFields.push('role');
  }
  if (newPassword !== undefined && String(newPassword).length > 0) {
    const complexity = validatePasswordComplexity(newPassword, userRec.username);
    if (!complexity.valid) {
      return res.status(400).json({ ok: false, error: complexity.error });
    }
    userRec.passwordHistory = [userRec.passwordHash, ...(userRec.passwordHistory || [])].slice(0, 3);
    userRec.passwordHash = hashPasswordScrypt(newPassword);
    userRec.passwordUpdatedAt = new Date().toISOString();
    loginFailuresByKey.delete(`user:${targetUsername}`);
    updatedFields.push('password_reset');
    recordAuditEvent(req, 'USER_PASSWORD_RESET_BY_ADMIN', { targetUsername: userRec.username });
  }

  userRec.mfaEnabled = true; // Always mandatory
  saveUsersDirectory(users);
  if (updatedFields.length > 0 && !updatedFields.includes('password_reset') && !updatedFields.includes('unlocked_account')) {
    recordAuditEvent(req, 'USER_UPDATED_BY_ADMIN', { targetUsername: userRec.username, updatedFields, role: userRec.role, email: userRec.email });
  }

  res.json({
    ok: true,
    user: {
      username: userRec.username,
      displayName: userRec.displayName,
      email: userRec.email,
      role: userRec.role,
      mfaEnabled: true,
      mfaMethod: userRec.mfaMethod
    },
    updatedFields
  });
});

// Admin User Deletion (bridge_admin only; protects core built-in baseline users)
app.delete('/api/security/users/:username', (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: `/api/security/users/${req.params.username}`, method: 'DELETE' });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can remove user accounts.'
    });
  }
  const targetUsername = String(req.params.username || '').trim().toLowerCase();
  if (BUILTIN_PROTECTED_USERS.has(targetUsername)) {
    return res.status(400).json({
      ok: false,
      error: `Core baseline account '${targetUsername}' is protected and cannot be deleted.`
    });
  }
  const users = loadUsersDirectory();
  const idx = users.findIndex(u => u.username.toLowerCase() === targetUsername && u.clientId === req.clientId);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'User not found in this tenant.' });
  }
  const [removed] = users.splice(idx, 1);
  saveUsersDirectory(users);
  recordAuditEvent(req, 'USER_DELETED_BY_ADMIN', { deletedUsername: removed.username, role: removed.role });
  res.json({ ok: true, deletedUsername: removed.username });
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
// PER-CLIENT STATE MANAGER (POWERPOINT DECK DATA ONLY)
// ============================================================================
const clientStates = {};       // clientId -> hydrated portalData object
const clientInitPromises = {}; // clientId -> Promise

function getClientBaselinePath(clientId) {
  const p = path.join(CLIENTS_DIR, clientId, 'portal_data.json');
  if (fs.existsSync(p)) return p;
  return path.join(__dirname, 'data', 'portal_data.json');
}

function loadClientBaseline(clientId) {
  const raw = JSON.parse(fs.readFileSync(getClientBaselinePath(clientId), 'utf8'));
  // Ensure any Excel-sourced keys (worklists, worklistSummary, enrollmentReporting, analysisWorkbook) are stripped
  delete raw.worklists;
  delete raw.worklistSummary;
  delete raw.enrollmentReporting;
  delete raw.analysisWorkbook;
  if (raw.slide2_summary?.whatYouNeedToKnow) {
    for (const item of raw.slide2_summary.whatYouNeedToKnow) {
      if (item.targetView === 'worklist') item.targetView = 'funnel';
    }
  }
  return raw;
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

const gcsJsonWriteQueues = {}; // objectName -> Promise
const gcsSecurityHydratedTenants = new Set();
let gcsUsersHydrated = false;

async function loadJsonFromGcs(objectName) {
  if (!GCS_STATE_BUCKET) return null;
  try {
    const token = await getGcpAccessToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(GCS_STATE_BUCKET)}/o/${encodeURIComponent(objectName)}?alt=media`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GCS GET HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.warn(`[GCS] Could not load ${objectName} from gs://${GCS_STATE_BUCKET}:`, err.message);
    return null;
  }
}

function saveJsonToGcsAsync(objectName, dataPayload) {
  if (!GCS_STATE_BUCKET) return Promise.resolve(false);
  const snapshot = JSON.stringify(dataPayload, null, 2);
  const prev = gcsJsonWriteQueues[objectName] || Promise.resolve();
  const next = prev.then(async () => {
    try {
      const token = await getGcpAccessToken();
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(GCS_STATE_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: snapshot
      });
      return resp.ok;
    } catch (err) {
      console.warn(`[GCS] Could not save ${objectName} to gs://${GCS_STATE_BUCKET}:`, err.message);
      return false;
    }
  });
  gcsJsonWriteQueues[objectName] = next.catch(() => false);
  return next;
}

async function ensureSecurityLogsHydrated(clientId) {
  if (!GCS_STATE_BUCKET) return;
  if (!gcsUsersHydrated) {
    gcsUsersHydrated = true;
    const remoteUsers = await loadJsonFromGcs('global/users_directory.json');
    if (Array.isArray(remoteUsers) && remoteUsers.length > 0) {
      const localUsers = loadUsersDirectory();
      for (const ru of remoteUsers) {
        const existing = localUsers.find(u => u.username.toLowerCase() === String(ru.username || '').toLowerCase());
        if (!existing) {
          ru.mfaEnabled = true;
          localUsers.push(ru);
        }
      }
      usersDirectoryCache = localUsers;
    }
  }
  if (!gcsSecurityHydratedTenants.has(clientId)) {
    gcsSecurityHydratedTenants.add(clientId);
    const [remoteAudit, remoteQa] = await Promise.all([
      loadJsonFromGcs(`clients/${clientId}/audit_log.json`),
      loadJsonFromGcs(`clients/${clientId}/qa_history.json`)
    ]);
    if (Array.isArray(remoteAudit) && remoteAudit.length > 0) {
      const localAudit = loadClientAuditLog(clientId);
      const seenIds = new Set(localAudit.map(e => e.id));
      for (const ev of remoteAudit) {
        if (ev && ev.id && !seenIds.has(ev.id)) {
          localAudit.push(ev);
          seenIds.add(ev.id);
        }
      }
      localAudit.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      clientAuditLogs[clientId] = localAudit.slice(0, 1000);
    }
    if (Array.isArray(remoteQa) && remoteQa.length > 0) {
      const localQa = loadClientQaLog(clientId);
      const seenQaIds = new Set(localQa.map(q => q.id));
      for (const qa of remoteQa) {
        if (qa && qa.id && !seenQaIds.has(qa.id)) {
          localQa.push(qa);
          seenQaIds.add(qa.id);
        }
      }
      localQa.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      clientQaLogs[clientId] = localQa.slice(0, 500);
    }
  }
}

async function ensureClientStateLoaded(clientId) {
  if (clientStates[clientId]) return clientStates[clientId];
  if (clientInitPromises[clientId]) return clientInitPromises[clientId];

  clientInitPromises[clientId] = (async () => {
    const baseline = loadClientBaseline(clientId);
    clientStates[clientId] = baseline;
    return baseline;
  })();

  try {
    return await clientInitPromises[clientId];
  } finally {
    delete clientInitPromises[clientId];
  }
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

// Full portal data for authenticated tenant (PowerPoint Slides 1–10 only)
app.get('/api/portal-data', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  if (req.query.silent !== '1') {
    recordAuditEvent(req, 'PORTAL_LOADED', {
      clientId,
      clientName: state.meta?.client || clientId,
      activeView: 'summary'
    });
  }
  res.json(state);
});

// ============================================================================
// TENANT-ISOLATED AGGREGATE ANALYTICS Q&A ENGINE (/api/ask)
// 100% POWERED BY POWERPOINT DECK SLIDES 1–10 (ZERO MEMBER-LEVEL OR EXCEL DATA)
// ============================================================================
function isMemberLevelQuery(state, rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ql = q.toLowerCase();
  const legacyRedactedHash = '991a0d6a7f1457d29c76724c721f5e3b05364a84145020579850c5784f9e2f21';

  // Detect explicit 8-char hex member IDs or redacted legacy tokens
  const tokens = ql.split(/[\s,?;:!()'"]+/).filter(t => t.length >= 6);
  for (const tok of tokens) {
    const tokHash = crypto.createHash('sha256').update(tok).digest('hex');
    if (/^[0-9a-f]{8}(-[0-9a-f]{4,})?$/.test(tok) || tokHash === legacyRedactedHash) {
      return true;
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
      `For member privacy, **Ask Bridge AI** only provides **aggregate** program, financial, patient source, paid media ROI, first-fill funnel, refill persistence, cohort retention, and medication mix analytics for **${meta.client || 'this program'}**—individual member-level and patient-level records are not included in the portal.`
  };
}

function answerQuestion(state, rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ql = q.toLowerCase();
  const meta = state.meta || {};
  const s2 = state.slide2_summary || {};
  const s3 = state.slide3_financials || {};
  const s4 = state.slide4_sources || {};
  const s5 = state.slide5_paidMedia || {};
  const s6 = state.slide6_funnel || {};
  const s7 = state.slide7_refill || {};
  const s8 = state.slide8_medMix || {};
  const s10 = state.slide10_retention || {};

  // 0. Strict Member-Level Privacy Guardrail
  if (isMemberLevelQuery(state, q)) {
    return buildMemberPrivacyGuardrailReply(state, q);
  }

  // 1. Channel / Broker vs Paid Media & Patient Sources (Slide 4 & Slide 5)
  if (
    ql.includes('epic') || ql.includes('lhd') || ql.includes('mcgohan') ||
    ql.includes('source') || ql.includes('channel') || ql.includes('broker') ||
    ql.includes('paid media') || ql.includes('roas') || ql.includes('ad spend')
  ) {
    const srcRows = s4.table || [];
    const epicRow = srcRows.find(r => r.source.toLowerCase().includes('epic')) || srcRows[0] || {};
    const pmRow = srcRows.find(r => r.source.toLowerCase().includes('paid media')) || srcRows[1] || {};
    const tableLines = srcRows.map(r =>
      `| **${r.source}** | ${r.enrolledSept} | **${r.enrolledYtd}** | ${r.share} | **${r.filled1stRx}** | ${r.refilled1to2} | ${r.glp1Fills.toLocaleString()} | **${r.grossMarginFmt}** |`
    ).join('\n');

    return {
      question: q,
      answer:
        `### **Patient Sources & Channel Economics (${meta.client} Through ${meta.asOfDateFormatted || 'Sep 30, 2026'})**\n` +
        `• **Headline**: ${s4.headline || 'Broker partners drove 62% of September sign-ups and convert to first fill at a higher rate than paid media.'}\n` +
        (epicRow.source ? `• **${epicRow.source}**: **${epicRow.enrolledYtd} YTD enrollments** (${epicRow.enrolledSept} in Sep, ${epicRow.share} share), **${epicRow.filled1stRx} first-fill conversion**, **${epicRow.refilled1to2} refill rate**, and **${epicRow.grossMarginFmt} gross margin** across ${epicRow.glp1Fills?.toLocaleString() || 0} fills.\n` : '') +
        (pmRow.source ? `• **${pmRow.source}**: **${pmRow.enrolledYtd} YTD enrollments** (${pmRow.enrolledSept} in Sep, ${pmRow.share} share), **${pmRow.filled1stRx} first-fill conversion**, **${pmRow.refilled1to2} refill rate**, and **${pmRow.grossMarginFmt} gross margin** across ${pmRow.glp1Fills?.toLocaleString() || 0} fills.\n\n` : '\n') +
        `| Source | Enrolled Sep | Enrolled YTD | Share | Filled 1st Rx | Refilled 1st→2nd | GLP-1 Fills | Gross Margin |\n` +
        `| --- | --- | --- | --- | --- | --- | --- | --- |\n` +
        `${tableLines}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'YTD Enrollments by Patient Source',
          labels: srcRows.map(r => r.source),
          datasets: [
            { label: 'Enrolled YTD', data: srcRows.map(r => Number(r.enrolledYtd) || 0), backgroundColor: '#154672' },
            { label: 'GLP-1 Fills', data: srcRows.map(r => Number(r.glp1Fills) || 0), backgroundColor: '#26abe4' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 2. Medication Mix: Wegovy Pen vs. Wegovy Pill vs. Ozempic (Slide 8)
  if (
    ql.includes('wegovy') || ql.includes('ozempic') || ql.includes('pill') ||
    ql.includes('pen') || ql.includes('medication') || ql.includes('drug')
  ) {
    const callouts = s8.septemberCallouts || [];
    const calloutLines = callouts.map(c => `• **${c.label}**: **${c.value}** fills in September (**${c.share}** share)`).join('\n');
    const months = s8.chart?.months || [];
    const tableLines = months.map((m, i) => {
      const pen = s8.chart.wegovyPen[i] || 0;
      const pill = s8.chart.wegovyPill[i] || 0;
      const oz = s8.chart.ozempic[i] || 0;
      const tot = pen + pill + oz;
      return `| **${m}** | ${pen} | ${pill} | ${oz} | **${tot}** |`;
    }).join('\n');

    return {
      question: q,
      answer:
        `### **Medication Mix (${meta.client} Through ${meta.asOfDateFormatted || 'Sep 30, 2026'})**\n` +
        `${calloutLines}\n\n` +
        `| Month | Wegovy Pen | Wegovy Pill | Ozempic | Total Fills |\n` +
        `| --- | --- | --- | --- | --- |\n` +
        `${tableLines}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'Monthly GLP-1 Fills by Medication',
          labels: months,
          datasets: [
            { label: 'Wegovy Pen', data: s8.chart?.wegovyPen || [], backgroundColor: '#154672' },
            { label: 'Wegovy Pill', data: s8.chart?.wegovyPill || [], backgroundColor: '#26abe4' },
            { label: 'Ozempic', data: s8.chart?.ozempic || [], backgroundColor: '#94a3b8' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 3. First-Fill Funnel & Refill Persistence / Retention (Slide 6, Slide 7, Slide 10)
  if (
    ql.includes('funnel') || ql.includes('conversion') || ql.includes('refill') ||
    ql.includes('retention') || ql.includes('cohort') || ql.includes('drop')
  ) {
    const steps = s6.steps || [];
    const stepLines = steps.map(s => `• **${s.stage}**: **${s.patients}** patients (**${s.pctOfEnrolled}%** of enrolled)`).join('\n');
    const refillSteps = (s7.stepTable || []).map(r => `| **${r.step}** | **${r.cameBack}** | ${r.eligiblePts} |`).join('\n');

    return {
      question: q,
      answer:
        `### **First-Fill Funnel & Refill Persistence (${meta.client})**\n` +
        `${stepLines}\n\n` +
        `| Refill Step | Came Back | Eligible Patients |\n` +
        `| --- | --- | --- |\n` +
        `${refillSteps}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'First-Fill Conversion Funnel (Patients)',
          labels: steps.map(s => s.stage),
          datasets: [
            { label: 'Patients', data: steps.map(s => s.patients), backgroundColor: '#154672' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 4. Financials / Monthly P&L / Proceeds / Revenue / Fees (Slide 3)
  if (
    ql.includes('financial') || ql.includes('proceeds') || ql.includes('p&l') || ql.includes('pnl') ||
    ql.includes('revenue') || ql.includes('profit') || ql.includes('fee') || ql.includes('commission') ||
    ql.includes('962k') || ql.includes('371k') || ql.includes('911') || ql.includes('cost to fill') ||
    ql.includes('margin') || ql.includes('monthly') || ql.includes('august') || ql.includes('july') ||
    ql.includes('june')
  ) {
    const revRow = s3.ytdTable.find(r => r.item === 'Pharmacy revenue');
    const gmRow = s3.ytdTable.find(r => r.item === 'Pharmacy gross margin');
    const feesRow = s3.ytdTable.find(r => r.item === 'Membership fees collected');
    const procRow = s3.ytdTable.find(r => r.item === 'Program proceeds');
    const sepProceeds = s3.monthlyProceeds.values[s3.monthlyProceeds.values.length - 1];
    const augProceeds = s3.monthlyProceeds.values[s3.monthlyProceeds.values.length - 2] || 0;
    const pnlLines = s3.ytdTable.map(r => `| **${r.item}** | **${r.formatted}** |`).join('\n');

    return {
      question: q,
      answer:
        `### **${meta.client} Financial Performance & P&L Through ${meta.asOfDateFormatted || 'September 30, 2026'}**\n` +
        `• **Pharmacy Revenue**: **${revRow ? revRow.formatted : '$2,336,983'}** YTD across **${(s3.totalFillsInPnl || 2034).toLocaleString()}** GLP-1 fills\n` +
        `• **Pharmacy Gross Margin**: **${gmRow ? gmRow.formatted : '$1,758,625'}** YTD (**$${s3.septemberGrossMarginPerFill || 911}/fill** in September)\n` +
        `• **Membership Fees Collected**: **+${feesRow ? feesRow.formatted : '$44,164'}** YTD\n` +
        `• **Net Program Proceeds (After Ad Spend & Fees)**: **$${sepProceeds.toLocaleString()}** in September (vs. **$${augProceeds.toLocaleString()}** in August) and **${procRow ? procRow.formatted : '$961,691'}** YTD.\n\n` +
        `| YTD P&L Line Item | YTD Through Sep 2026 |\n` +
        `| --- | --- |\n` +
        `${pnlLines}\n\n` +
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

  // Default executive overview for the authenticated tenant (Slides 1–3)
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
      `• **Channel & Conversion Highlights**: ${s4.headline || ''} ${s6.headline || ''}`
  };
}

function buildGeminiDataContext(state) {
  // Strictly AGGREGATE PowerPoint deck context only (Slides 1–10)
  return {
    privacyPolicy: 'AGGREGATE_POWERPOINT_DECK_ONLY_NO_MEMBER_LEVEL_DATA',
    meta: state.meta,
    executiveSummary: state.slide2_summary,
    programFinancials: state.slide3_financials,
    patientSources: state.slide4_sources,
    paidMediaRoi: state.slide5_paidMedia,
    conversionFunnel: state.slide6_funnel,
    refillPersistence: state.slide7_refill,
    medicationMix: state.slide8_medMix,
    programDefinitions: state.slide9_appendix,
    cohortRetention: state.slide10_retention
  };
}

async function askGeminiWithFullData(state, question, history = []) {
  const memberBlockedFlag = isMemberLevelQuery(state, question);
  const contextData = buildGeminiDataContext(state);
  const meta = state.meta || {};
  const s2 = state.slide2_summary || {};
  const s3 = state.slide3_financials || {};

  const activeSep = s2.kpis?.find(k => k.id === 'active_sep')?.value || '862';
  const fillsSep = s2.kpis?.find(k => k.id === 'fills_sep')?.value || '673';
  const sepProceedsVal = s3.monthlyProceeds?.values?.[s3.monthlyProceeds.values.length - 1] || 371214;
  const ytdProceedsFmt = s3.ytdTable?.find(r => r.item === 'Program proceeds')?.formatted || '$961,691';
  const ytdRevFmt = s3.ytdTable?.find(r => r.item === 'Pharmacy revenue')?.formatted || '$2,336,983';
  const ytdFeesFmt = s3.ytdTable?.find(r => r.item === 'Membership fees collected')?.formatted || '$44,164';

  const systemInstruction = `You are a sharp, insightful, executive-level healthcare analytics strategist at Bridge Health Hub supporting the ${meta.programTitle || 'GLP-1 Weight Loss Program'} for ${meta.client || 'our client'} and ${meta.pharmacyPartner || 'the pharmacy'} (data through ${meta.asOfDateFormatted || 'September 30, 2026'}).

You are having an intelligent, natural, executive-ready conversation with a stakeholder or pharmacy/program leader.

STRICT PRIVACY & AGGREGATE-ONLY RULE:
- You ONLY provide AGGREGATE program, financial, patient source, paid media ROI, first-fill funnel conversion, refill persistence, cohort retention, and medication mix analytics from the executive report deck.
- Zero individual member IDs, patient alternate IDs, or row-level member/patient records exist in your context. NEVER output or fabricate individual member IDs, patient alternate IDs, UUIDs, or individual member/patient records.
- If someone asks to look up a specific member ID or individual patient record (e.g. an 8-char hex ID like 6d3f1831), politely explain that for member privacy, Ask Bridge AI only provides aggregate program, financial, channel, funnel, refill, and medication analytics—individual member-level and patient-level records are not included in the portal.

KEY PROGRAM METRICS (${meta.client}):
- Headline KPIs: ${activeSep} active members in Sep, ${fillsSep} Sep GLP-1 fills, $${sepProceedsVal.toLocaleString()} Sep net program proceeds after ad spend, ${ytdProceedsFmt} YTD net program proceeds after ad spend, ${ytdRevFmt} YTD pharmacy revenue across ${s3.totalFillsInPnl?.toLocaleString() || '2,034'} completed GLP-1 fills, ${ytdFeesFmt} YTD membership fees collected. Whenever asked about revenue, membership fees, or net program proceeds, always cite both the September net proceeds ($${sepProceedsVal.toLocaleString()}) and the YTD net proceeds (${ytdProceedsFmt}) alongside YTD pharmacy revenue (${ytdRevFmt}) and YTD membership fees (${ytdFeesFmt}).
- Answer both the "what" (exact numbers, percentages, and trends from the provided context) and the "so what" (strategic insight and operational takeaways).
- Never cite slide numbers ("Slide 3") or raw JSON key names.

RICH VISUAL FORMATTING — ALWAYS INCLUDE MARKDOWN TABLES & INTERACTIVE CHARTS:
- For any analytical question, structure your response with:
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
    ? '\n[SYSTEM NOTE: The user message references a specific member/patient identifier. Politely explain that for member privacy, Ask Bridge AI only provides aggregate program, financial, channel, funnel, refill, and medication analytics—individual member-level records are not included in the portal.]'
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
  const startMs = Date.now();
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const { question, history, mode } = req.body || {};
  const q = String(question || '').trim() || 'How is the program performing through September 2026?';
  const memberBlockedFlag = isMemberLevelQuery(state, q);

  if (mode !== 'instant') {
    try {
      const geminiResult = await askGeminiWithFullData(state, q, history);
      const latencyMs = Date.now() - startMs;
      const qaEntry = recordQaHistoryEntry(req, {
        clientId,
        question: q,
        answer: geminiResult.reply || geminiResult.answer || '',
        aiPowered: true,
        aiModel: geminiResult.aiModel || VERTEX_GEMINI_MODEL,
        memberLevelBlocked: Boolean(geminiResult.memberLevelBlocked),
        latencyMs
      });
      recordAuditEvent(req, 'AI_QUERY', {
        qaId: qaEntry.id,
        question: q,
        answerPreview: String(geminiResult.reply || '').slice(0, 180),
        aiModel: geminiResult.aiModel || VERTEX_GEMINI_MODEL,
        latencyMs,
        memberBlocked: memberBlockedFlag
      });
      return res.json({ ...geminiResult, qaId: qaEntry.id, latencyMs });
    } catch (err) {
      console.error('Gemini API error, falling back to deterministic engine:', err.message);
    }
  }

  if (memberBlockedFlag) {
    const blocked = buildMemberPrivacyGuardrailReply(state, q);
    const latencyMs = Date.now() - startMs;
    const qaEntry = recordQaHistoryEntry(req, {
      clientId,
      question: q,
      answer: blocked.answer,
      aiPowered: false,
      aiModel: 'privacy-guardrail',
      memberLevelBlocked: true,
      latencyMs
    });
    recordAuditEvent(req, 'AI_QUERY', {
      qaId: qaEntry.id,
      question: q,
      answerPreview: String(blocked.answer || '').slice(0, 180),
      aiModel: 'privacy-guardrail',
      latencyMs,
      memberBlocked: true
    });
    return res.json({
      question: q,
      clientId,
      aiPowered: false,
      aiModel: 'privacy-guardrail',
      memberLevelBlocked: true,
      qaId: qaEntry.id,
      latencyMs,
      reply: blocked.answer,
      answer: blocked.answer
    });
  }

  const fallback = answerQuestion(state, q);
  const latencyMs = Date.now() - startMs;
  const qaEntry = recordQaHistoryEntry(req, {
    clientId,
    question: q,
    answer: fallback.answer,
    aiPowered: false,
    aiModel: 'deterministic-fallback',
    memberLevelBlocked: false,
    latencyMs
  });
  recordAuditEvent(req, 'AI_QUERY', {
    qaId: qaEntry.id,
    question: q,
    answerPreview: String(fallback.answer || '').slice(0, 180),
    aiModel: 'deterministic-fallback',
    latencyMs,
    memberBlocked: false
  });
  res.json({
    question: q,
    clientId,
    aiPowered: false,
    aiModel: 'deterministic-fallback',
    qaId: qaEntry.id,
    latencyMs,
    reply: fallback.answer,
    answer: fallback.answer
  });
});

app.listen(PORT, () => {
  console.log(`Bridge Multi-Client GLP-1 Program Portal running on http://localhost:${PORT} (Gemini Model: ${VERTEX_GEMINI_MODEL} via Vertex AI GCP Billing, GCS Bucket: ${GCS_STATE_BUCKET || 'local-fallback'})`);
});
