const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
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
    },
    {
      username: 'cmerski',
      passwordHash: hashPasswordScrypt('DamienCatherine2026!'),
      clientId: 'damien',
      displayName: 'Catherine Merski (Damien Center)',
      email: 'cmerski@damien.org',
      role: 'client_user',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret('cmerski'),
      passwordUpdatedAt: '2026-11-01T00:00:00.000Z',
      passwordMaxAgeDays: 0,
      passwordHistory: []
    },
    {
      username: 'bplunkett',
      passwordHash: hashPasswordScrypt('DamienBrad2026!'),
      clientId: 'damien',
      displayName: 'Brad Plunkett (Damien Center)',
      email: 'bplunkett@damien.org',
      role: 'client_user',
      mfaEnabled: true,
      mfaMethod: 'email',
      totpSecret: generateTotpSecret('bplunkett'),
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
  if (et === 'PPTX_DRAFT_UPLOADED') return `Staged PowerPoint draft '${details.filename || 'deck.pptx'}' (${details.asOfDateFormatted || 'new period'}, ${details.activeMembers || 0} active members)`;
  if (et === 'PPTX_DRAFT_PUBLISHED') return `Published staged PowerPoint report (${details.asOfDateFormatted || 'new period'}, ${details.activeMembers || 0} active members) to all users`;
  if (et === 'PPTX_DRAFT_DISCARDED') return `Discarded staged PowerPoint draft (${details.discardedAsOf || 'draft'})`;
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

app.use(express.json({ limit: '25mb' }));

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
      (cred.username.toLowerCase() === u.toLowerCase() ||
        (u.includes('@') && String(cred.email || '').toLowerCase() === u.toLowerCase())) &&
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
const BUILTIN_PROTECTED_USERS = new Set(['damien', 'metro', 'rishi.damien', 'brady.admin', 'rishi.metro', 'pharmacist.damien', 'cmerski', 'bplunkett']);

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

// Export Security & Usage Audit Log as CSV (bridge_admin only)
app.get('/api/security/export/audit-csv', async (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden: Only Bridge Super-Admins can export the full security audit log.' });
  }
  const clientId = req.clientId || 'damien';
  await ensureSecurityLogsHydrated(clientId);
  const events = loadClientAuditLog(clientId);
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  };
  const headers = ['Timestamp (UTC)', 'Tenant', 'Username', 'Display Name', 'Role', 'Category', 'Event Type', 'Summary', 'IP Address', 'Country', 'Raw Details JSON'];
  const lines = [headers.map(esc).join(',')];
  for (const ev of events) {
    lines.push([
      ev.timestamp || '',
      ev.clientId || clientId,
      ev.user || '',
      ev.displayName || '',
      ev.role || '',
      ev.category || classifyAuditCategory(ev.eventType),
      ev.eventType || '',
      ev.summary || formatAuditSummary(ev.eventType, ev.details),
      ev.ip || '',
      ev.country || 'US',
      JSON.stringify(ev.details || {})
    ].map(esc).join(','));
  }
  recordAuditEvent(req, 'CSV_EXPORT', { sheet: 'security_audit_log', filename: `${clientId}_security_audit_log.csv`, rowCount: events.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${clientId}_security_audit_log.csv"`);
  res.send(lines.join('\r\n'));
});

// Export Ask Bridge AI Q&A Transcript History as CSV (bridge_admin only)
app.get('/api/security/export/qa-csv', async (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden: Only Bridge Super-Admins can export the tenant AI Q&A transcript history.' });
  }
  const clientId = req.clientId || 'damien';
  await ensureSecurityLogsHydrated(clientId);
  const qaList = loadClientQaLog(clientId);
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  };
  const headers = ['Timestamp (UTC)', 'Tenant', 'Username', 'Display Name', 'Role', 'AI Model', 'Latency (ms)', 'Privacy Guardrail Triggered', 'Question Asked', 'AI Response'];
  const lines = [headers.map(esc).join(',')];
  for (const qa of qaList) {
    lines.push([
      qa.timestamp || '',
      qa.clientId || clientId,
      qa.user || '',
      qa.displayName || '',
      qa.role || '',
      qa.aiModel || '',
      qa.latencyMs || 0,
      qa.memberLevelBlocked ? 'Yes' : 'No',
      qa.question || '',
      qa.answer || ''
    ].map(esc).join(','));
  }
  recordAuditEvent(req, 'CSV_EXPORT', { sheet: 'ai_qa_history', filename: `${clientId}_ask_bridge_ai_qa_history.csv`, rowCount: qaList.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${clientId}_ask_bridge_ai_qa_history.csv"`);
  res.send(lines.join('\r\n'));
});

// Export PowerPoint Dashboard Tables as CSV (Slides 3, 4, 5, 6, 7, 8, 10)
app.get('/api/export/csv/:tableKey', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const usePreview = req.query.preview === '1' && isCallerBridgeAdmin(req);
  const state = usePreview
    ? ((await ensureClientDraftStateLoaded(clientId)) || (await ensureClientStateLoaded(clientId)))
    : (await ensureClientStateLoaded(clientId));
  const data = state.data || state || {};
  const meta = data.meta || {};
  const shortPrefix = String(meta.shortName || clientId).replace(/[^A-Za-z0-9_-]/g, '_');
  const asOfSuffix = String(meta.asOfShort || 'Sep2026').replace(/[^A-Za-z0-9_-]/g, '');
  const tableKey = String(req.params.tableKey || '').toLowerCase();

  let headers = [];
  let rows = [];
  let filename = `${shortPrefix}_${tableKey}_${asOfSuffix}.csv`;

  if (tableKey === 'financials') {
    headers = ['Line Item', 'YTD Amount ($)', 'Formatted'];
    rows = (data.slide3_financials?.ytdTable || []).map(r => [r.item, r.amount, r.formatted || '']);
    filename = `${shortPrefix}_YTD_Financials_${asOfSuffix}.csv`;
  } else if (tableKey === 'sources') {
    headers = ['Source', 'Enrolled in Sept', 'Enrolled YTD', 'Share', 'Filled 1st Rx', 'Refilled 1st -> 2nd', 'GLP-1 Fills', 'Gross Margin ($)'];
    rows = (data.slide4_sources?.table || []).map(r => [
      r.source,
      r.enrolledSept,
      r.enrolledYtd,
      r.share,
      r.filled1stRx,
      r.refilled1to2,
      r.glp1Fills,
      r.grossMargin
    ]);
    filename = `${shortPrefix}_Patient_Sources_${asOfSuffix}.csv`;
  } else if (tableKey === 'paidmedia') {
    headers = ['Sign-up Month', 'Media Spend ($)', 'Sign-ups', 'Spend / Sign-up', 'Started Therapy', 'Spend / Started', 'Fills to Date', 'Gross Margin ($)', 'Return on Spend'];
    rows = (data.slide5_paidMedia?.table || []).map(r => [
      r.month,
      r.spend,
      r.signups,
      r.spendPerSignup ?? '',
      r.started ?? '',
      r.spendPerStarted ?? '',
      r.fills ?? '',
      r.margin ?? '',
      r.roas ?? ''
    ]);
    filename = `${shortPrefix}_Paid_Media_Cohorts_${asOfSuffix}.csv`;
  } else if (tableKey === 'funnel') {
    headers = ['Funnel Stage', 'Patients', 'Share of Enrolled (%)', 'Step Conversion'];
    rows = (data.slide6_funnel?.steps || []).map(s => [s.stage, s.patients, s.pctOfEnrolled, s.stepConversion || '']);
    filename = `${shortPrefix}_First_Fill_Funnel_${asOfSuffix}.csv`;
  } else if (tableKey === 'refill-steps') {
    headers = ['Refill Step', 'Came Back', 'Eligible Patients'];
    rows = (data.slide7_refill?.stepTable || []).map(r => [r.step, r.cameBack, r.eligiblePts]);
    filename = `${shortPrefix}_Refill_Steps_${asOfSuffix}.csv`;
  } else if (tableKey === 'retention-matrix') {
    const ret = data.slide10_retention || {};
    const mCols = (ret.columns || []).filter(c => /^M\d+$/i.test(c));
    headers = ['Joined', 'Members', ...mCols];
    rows = (ret.rows || []).map(c => [
      c.joined,
      c.members,
      ...mCols.map(col => c[col] ?? '')
    ]);
    filename = `${shortPrefix}_Cohort_Retention_Matrix_${asOfSuffix}.csv`;
  } else if (tableKey === 'medmix') {
    const ch = data.slide8_medMix?.chart || {};
    headers = ['Month', 'Wegovy Pen', 'Wegovy Pill', 'Ozempic', 'Total Dispenses', 'Wegovy Pill Share (%)'];
    rows = (ch.months || []).map((mo, i) => {
      const pen = ch.wegovyPen?.[i] ?? 0;
      const pill = ch.wegovyPill?.[i] ?? 0;
      const oz = ch.ozempic?.[i] ?? 0;
      const tot = pen + pill + oz;
      const pillPct = tot > 0 ? ((pill / tot) * 100).toFixed(1) + '%' : '0.0%';
      return [mo, pen, pill, oz, tot, pillPct];
    });
    filename = `${shortPrefix}_Medication_Mix_${asOfSuffix}.csv`;
  } else {
    return res.status(404).json({ ok: false, error: 'Unknown export table key.' });
  }

  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  };
  const csvLines = [headers.map(esc).join(',')];
  for (const r of rows) {
    csvLines.push(r.map(esc).join(','));
  }

  recordAuditEvent(req, 'CSV_EXPORT', { sheet: tableKey, filename, rowCount: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvLines.join('\r\n'));
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
// PER-CLIENT STATE MANAGER & DYNAMIC 10-SLIDE POWERPOINT (.PPTX) ENGINE
// ============================================================================
const clientStates = {};       // clientId -> published portalData object
const clientDraftStates = {};  // clientId -> staged draft portalData object (bridge_admin preview only)
const clientInitPromises = {}; // clientId -> Promise

function getClientBaselinePath(clientId) {
  const p = path.join(CLIENTS_DIR, clientId, 'portal_data.json');
  if (fs.existsSync(p)) return p;
  return path.join(__dirname, 'data', 'portal_data.json');
}

function getClientDraftPath(clientId) {
  return path.join(CLIENTS_DIR, clientId, 'portal_data_draft.json');
}

function sanitizePortalDataObject(raw) {
  if (!raw || typeof raw !== 'object') return raw;
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

function loadClientBaseline(clientId) {
  const raw = JSON.parse(fs.readFileSync(getClientBaselinePath(clientId), 'utf8'));
  return sanitizePortalDataObject(raw);
}

function loadClientDraftFromDisk(clientId) {
  const p = getClientDraftPath(clientId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return sanitizePortalDataObject(raw);
  } catch (_) {
    return null;
  }
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Uploaded file is not a valid PowerPoint (.pptx) ZIP archive.');
  }
  const entries = {};
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid PowerPoint (.pptx) archive: End of Central Directory not found.');
  }
  const cdCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const fnLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localHdrOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + fnLen).toString('utf8');
    pos += 46 + fnLen + extraLen + commentLen;
    if (localHdrOffset + 30 > buffer.length || buffer.readUInt32LE(localHdrOffset) !== 0x04034b50) continue;
    const lFnLen = buffer.readUInt16LE(localHdrOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localHdrOffset + 28);
    const dataStart = localHdrOffset + 30 + lFnLen + lExtraLen;
    const compData = buffer.slice(dataStart, dataStart + compSize);
    if (compMethod === 0) {
      entries[name] = compData.toString('utf8');
    } else if (compMethod === 8) {
      entries[name] = zlib.inflateRawSync(compData).toString('utf8');
    }
  }
  return entries;
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractTextParagraphsFromXml(xmlBlock) {
  const paras = [];
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let pm;
  while ((pm = pRe.exec(xmlBlock)) !== null) {
    const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
    let tm;
    let line = '';
    while ((tm = tRe.exec(pm[1])) !== null) {
      line += decodeXmlEntities(tm[1]);
    }
    if (line.trim()) paras.push(line.trim());
  }
  return paras;
}

function parseChartXmlFromPptx(chartXml) {
  if (!chartXml) return null;
  const titleParas = [];
  const titleMatch = chartXml.match(/<c:title\b[^>]*>([\s\S]*?)<\/c:title>/);
  if (titleMatch) {
    titleParas.push(...extractTextParagraphsFromXml(titleMatch[1]));
  }
  const series = [];
  const serRe = /<c:ser\b[^>]*>([\s\S]*?)<\/c:ser>/g;
  let sm;
  while ((sm = serRe.exec(chartXml)) !== null) {
    const serBlock = sm[1];
    let name = '';
    const txMatch = serBlock.match(/<c:tx\b[^>]*>([\s\S]*?)<\/c:tx>/);
    if (txMatch) {
      const vMatch = txMatch[1].match(/<c:v\b[^>]*>([\s\S]*?)<\/c:v>/);
      if (vMatch) name = decodeXmlEntities(vMatch[1]).trim();
    }
    const cats = [];
    const catMatch = serBlock.match(/<c:cat\b[^>]*>([\s\S]*?)<\/c:cat>/);
    if (catMatch) {
      const ptRe = /<c:pt\b[^>]*idx="(\d+)"[^>]*>\s*<c:v\b[^>]*>([\s\S]*?)<\/c:v>\s*<\/c:pt>/g;
      let pm;
      while ((pm = ptRe.exec(catMatch[1])) !== null) {
        cats[Number(pm[1])] = decodeXmlEntities(pm[2]).trim();
      }
    }
    const vals = [];
    const valMatch = serBlock.match(/<c:val\b[^>]*>([\s\S]*?)<\/c:val>/);
    if (valMatch) {
      const ptRe = /<c:pt\b[^>]*idx="(\d+)"[^>]*>\s*<c:v\b[^>]*>([\s\S]*?)<\/c:v>\s*<\/c:pt>/g;
      let pm;
      while ((pm = ptRe.exec(valMatch[1])) !== null) {
        vals[Number(pm[1])] = Number(pm[2]);
      }
    }
    series.push({
      name,
      categories: cats.filter(x => x !== undefined),
      values: vals.filter(x => x !== undefined)
    });
  }
  return { title: titleParas.join(' ').trim(), series };
}

function parseSlideFromPptxEntries(entries, slideIndex) {
  const sXml = entries[`ppt/slides/slide${slideIndex}.xml`];
  if (!sXml) {
    throw new Error(`Missing Slide ${slideIndex} (ppt/slides/slide${slideIndex}.xml) — deck must contain all 10 program slides.`);
  }
  const rXml = entries[`ppt/slides/_rels/slide${slideIndex}.xml.rels`] || '';
  const shapes = [];
  const spRe = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g;
  let m;
  while ((m = spRe.exec(sXml)) !== null) {
    const ps = extractTextParagraphsFromXml(m[1]);
    if (ps.length) shapes.push(ps);
  }
  const tables = [];
  const tblRe = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g;
  while ((m = tblRe.exec(sXml)) !== null) {
    const rows = [];
    const trRe = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
    let trm;
    while ((trm = trRe.exec(m[1])) !== null) {
      const cells = [];
      const tcRe = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g;
      let tcm;
      while ((tcm = tcRe.exec(trm[1])) !== null) {
        cells.push(extractTextParagraphsFromXml(tcm[1]).join(' '));
      }
      rows.push(cells);
    }
    tables.push(rows);
  }
  const charts = [];
  const relRe = /Target="\.\.\/charts\/(chart\d+\.xml)"/g;
  while ((m = relRe.exec(rXml)) !== null) {
    const parsedChart = parseChartXmlFromPptx(entries[`ppt/charts/${m[1]}`]);
    if (parsedChart) charts.push(parsedChart);
  }
  return { shapes, tables, charts };
}

function parseMoneyOrNumeric(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!s || s === '—' || s === '-') return 0;
  const isNeg = /^[−-]/.test(s) || s.includes('−') || s.startsWith('(');
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits) return 0;
  let val = Number(digits);
  if (/K\b/i.test(s)) val *= 1000;
  if (/M\b/i.test(s)) val *= 1000000;
  return isNeg ? -val : val;
}

const PPTX_MONTH_NAME_MAP = {
  january: { num: '01', short: 'Jan', full: 'January' },
  february: { num: '02', short: 'Feb', full: 'February' },
  march: { num: '03', short: 'Mar', full: 'March' },
  april: { num: '04', short: 'Apr', full: 'April' },
  may: { num: '05', short: 'May', full: 'May' },
  june: { num: '06', short: 'Jun', full: 'June' },
  july: { num: '07', short: 'Jul', full: 'July' },
  august: { num: '08', short: 'Aug', full: 'August' },
  september: { num: '09', short: 'Sep', full: 'September' },
  october: { num: '10', short: 'Oct', full: 'October' },
  november: { num: '11', short: 'Nov', full: 'November' },
  december: { num: '12', short: 'Dec', full: 'December' }
};

function parsePptxBufferToPortalData(buffer, baselineState) {
  const entries = readZipEntries(buffer);
  const slides = {};
  for (let i = 1; i <= 10; i++) {
    slides[i] = parseSlideFromPptxEntries(entries, i);
  }

  const out = JSON.parse(JSON.stringify(baselineState || {}));

  // SLIDE 1: Title, Subtitle, As-Of Date
  const s1Texts = slides[1].shapes.flat();
  const programTitle = s1Texts[0] || out.meta?.programTitle || 'Damien Center GLP-1 Weight Loss Program';
  const subtitle = s1Texts.find(t => /through/i.test(t)) || s1Texts[1] || out.meta?.subtitle || 'Program performance through September 30, 2026';
  const prepLine = s1Texts.find(t => /Prepared by/i.test(t)) || 'Prepared by Bridge Health Hub';
  const preparedBy = prepLine.replace(/^Prepared by\s+/i, '').trim() || 'Bridge Health Hub';

  let asOfDateFormatted = out.meta?.asOfDateFormatted || 'September 30, 2026';
  let asOfDate = out.meta?.asOfDate || '2026-09-30';
  let asOfShort = out.meta?.asOfShort || 'Sep2026';
  let cutoffMonthName = out.meta?.cutoffMonthName || 'September';

  const dateMatch = subtitle.match(/through\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (dateMatch) {
    const mInfo = PPTX_MONTH_NAME_MAP[dateMatch[1].toLowerCase()];
    const dayStr = String(dateMatch[2]).padStart(2, '0');
    const yrStr = dateMatch[3];
    if (mInfo) {
      asOfDateFormatted = `${mInfo.full} ${Number(dateMatch[2])}, ${yrStr}`;
      asOfDate = `${yrStr}-${mInfo.num}-${dayStr}`;
      asOfShort = `${mInfo.short}${yrStr}`;
      cutoffMonthName = mInfo.full;
    }
  }

  // SLIDE 2: Summary, Active Members Chart, KPIs, What You Need To Know
  const s2 = slides[2];
  const s2Chart = s2.charts[0] || {};
  const s2Series = s2Chart.series?.[0] || {};
  const months = s2Series.categories?.length ? s2Series.categories : (out.meta?.months || ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  const activeValues = s2Series.values?.length ? s2Series.values.map(v => Math.round(v)) : (out.slide2_summary?.activeMembersByMonth?.values || []);

  out.meta = {
    ...(out.meta || {}),
    programTitle,
    subtitle,
    preparedBy,
    asOfDate,
    asOfDateFormatted,
    asOfShort,
    cutoffMonthName,
    months
  };

  const s2Flat = s2.shapes.map(arr => arr.join('\n'));
  const s2Headline = s2Flat[1] || out.slide2_summary?.headline || '';

  const findNextShapeValue = (shapesArr, labelRegex) => {
    for (let i = 0; i < shapesArr.length - 1; i++) {
      const txt = shapesArr[i].join(' ').trim();
      if (labelRegex.test(txt)) {
        return {
          label: txt,
          value: shapesArr[i + 1].join(' ').trim(),
          subtext: shapesArr[i + 2] ? shapesArr[i + 2].join(' ').trim() : ''
        };
      }
    }
    return null;
  };

  // SLIDE 3: Program Financials
  const s3 = slides[3];
  const s3Headline = s3.shapes[1]?.join(' ') || out.slide3_financials?.headline || '';
  const s3Footnote = s3.shapes.find(a => a.join(' ').includes('Proceeds ='))?.join(' ') || out.slide3_financials?.footnote || '';
  const s3Chart = s3.charts[0]?.series?.[0] || {};
  const proceedsMonths = s3Chart.categories?.length ? s3Chart.categories : months;
  const proceedsValues = s3Chart.values?.length ? s3Chart.values.map(v => Math.round(v)) : (out.slide3_financials?.monthlyProceeds?.values || []);

  const s3TableRows = s3.tables[0] || [];
  const ytdTable = [];
  for (let r = 1; r < s3TableRows.length; r++) {
    const [item, formatted] = s3TableRows[r];
    if (!item) continue;
    const amount = parseMoneyOrNumeric(formatted);
    let type = 'expense';
    if (/Pharmacy revenue/i.test(item)) type = 'revenue';
    else if (/gross margin/i.test(item)) type = 'subtotal';
    else if (/Membership fees/i.test(item)) type = 'positive';
    else if (/Program proceeds/i.test(item)) type = 'total';
    ytdTable.push({ item: item.trim(), amount, formatted: formatted.trim(), type });
  }

  const gmPerFillMatch = s3Footnote.match(/gross margin per fill:\s*\$?([\d,]+)/i);
  const septemberGrossMarginPerFill = gmPerFillMatch ? Number(gmPerFillMatch[1].replace(/,/g, '')) : (out.slide3_financials?.septemberGrossMarginPerFill || 911);
  const costFillRow = ytdTable.find(r => /Cost to fill/i.test(r.item));
  const costPerFillMatch = (costFillRow?.item || s3Footnote).match(/\$(\d+)\s*(?:per fill|cost to fill)/i);
  const costPerFill = costPerFillMatch ? Number(costPerFillMatch[1]) : 40;
  const totalFillsInPnl = costFillRow && costPerFill > 0 ? Math.round(Math.abs(costFillRow.amount) / costPerFill) : (out.slide3_financials?.totalFillsInPnl || 2034);

  out.slide3_financials = {
    sectionTitle: s3.shapes[0]?.join(' ') || 'PROGRAM FINANCIALS',
    headline: s3Headline,
    monthlyProceeds: {
      title: s3.charts[0]?.title || 'Monthly program proceeds (after ad spend)',
      months: proceedsMonths,
      values: proceedsValues
    },
    ytdTable: ytdTable.length ? ytdTable : out.slide3_financials.ytdTable,
    septemberGrossMarginPerFill,
    costPerFill,
    totalFillsInPnl,
    footnote: s3Footnote
  };

  // SLIDE 8: Medication Mix
  const s8 = slides[8];
  const s8Headline = s8.shapes[1]?.join(' ') || out.slide8_medMix?.headline || '';
  const s8Note = s8.shapes.find(a => a.join(' ').includes('Completed Wegovy'))?.join(' ') || out.slide8_medMix?.note || '';
  const s8Series = s8.charts[0]?.series || [];
  const penSer = s8Series.find(s => /Pen/i.test(s.name)) || s8Series[0] || {};
  const pillSer = s8Series.find(s => /Pill/i.test(s.name)) || s8Series[1] || {};
  const ozSer = s8Series.find(s => /Ozempic/i.test(s.name)) || s8Series[2] || {};
  const medMonths = penSer.categories?.length ? penSer.categories : months;
  const wegovyPen = (penSer.values || []).map(v => Math.round(v));
  const wegovyPill = (pillSer.values || []).map(v => Math.round(v));
  const ozempic = (ozSer.values || []).map(v => Math.round(v));

  const lastIdx = Math.max(0, wegovyPen.length - 1);
  const lastPen = wegovyPen[lastIdx] ?? 411;
  const lastPill = wegovyPill[lastIdx] ?? 256;
  const lastOz = ozempic[lastIdx] ?? 6;
  const lastMedTotal = Math.max(1, lastPen + lastPill + lastOz);

  const penLabelShape = s8.shapes.find(a => /pen fills/i.test(a.join(' ')))?.join(' ') || `Wegovy pen fills, ${months[months.length - 1]}`;
  const pillLabelShape = s8.shapes.find(a => /pill fills/i.test(a.join(' ')))?.join(' ') || `Wegovy pill fills, ${months[months.length - 1]}`;
  const ozLabelShape = s8.shapes.find(a => /Ozempic fills/i.test(a.join(' ')))?.join(' ') || `Ozempic fills, ${months[months.length - 1]}`;

  out.slide8_medMix = {
    sectionTitle: s8.shapes[0]?.join(' ') || 'WHAT ARE PATIENTS FILLING?',
    headline: s8Headline,
    chart: {
      months: medMonths,
      wegovyPen,
      wegovyPill,
      ozempic
    },
    septemberCallouts: [
      { value: lastPen, share: `${((lastPen / lastMedTotal) * 100).toFixed(1)}%`, label: penLabelShape, color: '#154672' },
      { value: lastPill, share: `${((lastPill / lastMedTotal) * 100).toFixed(1)}%`, label: pillLabelShape, color: '#26ABE4' },
      { value: lastOz, share: `${((lastOz / lastMedTotal) * 100).toFixed(1)}%`, label: ozLabelShape, color: '#1BAF7A' }
    ],
    note: s8Note
  };

  // Build Slide 2 KPIs dynamically from Slide 2 + Slide 3 + Slide 8
  const kpiActive = findNextShapeValue(s2.shapes, /^Active members/i);
  const kpiFills = findNextShapeValue(s2.shapes, /^GLP-1 fills/i);
  const kpiProcMo = findNextShapeValue(s2.shapes, /^Program proceeds,\s*(?!YTD)/i);
  const kpiProcYtd = findNextShapeValue(s2.shapes, /^Program proceeds,\s*YTD/i);
  const kpiFirstFill = findNextShapeValue(s2.shapes, /^Sign-ups who filled/i);
  const kpiRefill = findNextShapeValue(s2.shapes, /^1st-fill patients who refilled/i);

  const lastActive = activeValues[activeValues.length - 1] ?? 862;
  const prevActive = activeValues[activeValues.length - 2] ?? 644;
  const prevMonthLabel = months[months.length - 2] || 'Aug';
  const activeMomPct = prevActive > 0 ? (((lastActive - prevActive) / prevActive) * 100).toFixed(1) : '0.0';
  const lastProceeds = proceedsValues[proceedsValues.length - 1] ?? 371214;
  const ytdProceedsRow = ytdTable.find(r => /Program proceeds/i.test(r.item));
  const ytdProceedsExact = ytdProceedsRow ? ytdProceedsRow.amount : 961691;

  const knowHeadingIdx = s2.shapes.findIndex(a => /What you need to know/i.test(a.join(' ')));
  const knowParas = (knowHeadingIdx >= 0 && s2.shapes[knowHeadingIdx + 1]) ? s2.shapes[knowHeadingIdx + 1] : [];
  const defaultKnow = out.slide2_summary?.whatYouNeedToKnow || [];
  const whatYouNeedToKnow = knowParas.length
    ? knowParas.map((p, idx) => {
        const dotIdx = p.indexOf('.');
        const title = dotIdx > 0 ? p.slice(0, dotIdx + 1).trim() : (defaultKnow[idx]?.title || 'Key Insight.');
        let body = dotIdx > 0 ? p.slice(dotIdx + 1).trim() : p.trim();
        if (body && !/[.!?]$/.test(body)) body += '.';
        const fallback = defaultKnow[idx] || { targetView: 'summary', badge: 'Insight' };
        return {
          title,
          body,
          targetView: fallback.targetView || 'summary',
          badge: fallback.badge || 'Insight'
        };
      })
    : defaultKnow;

  out.slide2_summary = {
    sectionTitle: s2.shapes[0]?.join(' ') || 'SUMMARY',
    headline: s2Headline,
    kpis: [
      {
        id: 'active_sep',
        label: kpiActive?.label || `Active members, ${months[months.length - 1]}`,
        value: kpiActive?.value || String(lastActive),
        numericValue: parseMoneyOrNumeric(kpiActive?.value || lastActive),
        subtext: `+${activeMomPct}% vs ${prevMonthLabel} (${prevActive.toLocaleString()})`,
        targetView: 'summary'
      },
      {
        id: 'fills_sep',
        label: kpiFills?.label || `GLP-1 fills, ${months[months.length - 1]}`,
        value: kpiFills?.value || String(lastMedTotal),
        numericValue: parseMoneyOrNumeric(kpiFills?.value || lastMedTotal),
        subtext: `${lastPen} Pen · ${lastPill} Pill · ${lastOz} Ozempic`,
        targetView: 'medmix'
      },
      {
        id: 'proceeds_sep',
        label: kpiProcMo?.label || `Program proceeds, ${months[months.length - 1]}`,
        value: kpiProcMo?.value || `$${Math.round(lastProceeds / 1000)}K`,
        numericValue: lastProceeds,
        subtext: `$${lastProceeds.toLocaleString()} after ad spend`,
        targetView: 'financials'
      },
      {
        id: 'proceeds_ytd',
        label: kpiProcYtd?.label || 'Program proceeds, YTD',
        value: kpiProcYtd?.value || `$${Math.round(ytdProceedsExact / 1000)}K`,
        numericValue: ytdProceedsExact,
        subtext: `$${ytdProceedsExact.toLocaleString()} net of fees & media`,
        targetView: 'financials'
      },
      {
        id: 'first_fill_rate',
        label: kpiFirstFill?.label || 'Sign-ups who filled 1st Rx',
        value: kpiFirstFill?.value || '69%',
        numericValue: parseMoneyOrNumeric(kpiFirstFill?.value || 69),
        subtext: kpiFirstFill?.subtext || `Members joined before ${months[months.length - 1]}`,
        targetView: 'funnel'
      },
      {
        id: 'refill_rate',
        label: kpiRefill?.label || '1st-fill patients who refilled',
        value: kpiRefill?.value || '94%',
        numericValue: parseMoneyOrNumeric(kpiRefill?.value || 94),
        subtext: kpiRefill?.subtext || 'Patients with time to refill',
        targetView: 'refill'
      }
    ],
    activeMembersByMonth: {
      title: 'Membership growth: active members by month',
      subtitle: '(includes members that cancelled in-month)',
      months,
      values: activeValues
    },
    whatYouNeedToKnow
  };

  // SLIDE 4: Patient Sources
  const s4 = slides[4];
  const s4Palette = {
    'EPIC': '#154672',
    'Paid Media': '#26ABE4',
    'Employee': '#1BAF7A',
    'LHD': '#E97132',
    'McGohan Brabender': '#8B5CF6',
    'Other': '#6F7886'
  };
  const s4Chart = s4.charts[0] || {};
  const s4Series = (s4Chart.series || []).map((ser, idx) => ({
    name: ser.name,
    values: (ser.values || []).map(v => Math.round(v)),
    color: s4Palette[ser.name] || Object.values(s4Palette)[idx % 6]
  }));
  const s4Table = [];
  const s4RawTable = s4.tables[0] || [];
  for (let r = 1; r < s4RawTable.length; r++) {
    const row = s4RawTable[r];
    if (!row || !row[0]) continue;
    const source = row[0].trim();
    const sourceKey = source.replace(/\s*\(new since[^)]*\)/i, '').trim();
    const enrolledSept = parseMoneyOrNumeric(row[1]);
    const enrolledYtd = parseMoneyOrNumeric(row[2]);
    const share = (row[3] || '0%').trim();
    const filled1stRx = (row[4] || '0%').trim();
    const refilled1to2 = (row[5] || '—').trim();
    const glp1Fills = parseMoneyOrNumeric(row[6]);
    const grossMarginFmt = (row[7] || '$0').trim();
    const grossMargin = parseMoneyOrNumeric(grossMarginFmt);
    const entry = {
      source,
      ...(sourceKey !== source ? { sourceKey } : {}),
      enrolledSept,
      enrolledYtd,
      share,
      shareNum: parseMoneyOrNumeric(share),
      filled1stRx,
      filled1stRxNum: parseMoneyOrNumeric(filled1stRx),
      refilled1to2,
      refilled1to2Num: refilled1to2 === '—' ? null : parseMoneyOrNumeric(refilled1to2),
      glp1Fills,
      grossMargin,
      grossMarginFmt
    };
    s4Table.push(entry);
  }

  out.slide4_sources = {
    sectionTitle: s4.shapes[0]?.join(' ') || 'WHERE ARE PATIENTS COMING FROM?',
    headline: s4.shapes[1]?.join(' ') || out.slide4_sources?.headline || '',
    chart: {
      title: s4Chart.title || 'New enrollments by source and month',
      months: s4Chart.series?.[0]?.categories || months,
      series: s4Series.length ? s4Series : out.slide4_sources.chart.series
    },
    table: s4Table.length ? s4Table : out.slide4_sources.table,
    footnote: s4.shapes.find(a => a.join(' ').includes('Fill rate uses'))?.join(' ') || out.slide4_sources?.footnote || ''
  };

  // SLIDE 5: Paid Media
  const s5 = slides[5];
  const s5Table = [];
  const s5RawTable = s5.tables[0] || [];
  for (let r = 1; r < s5RawTable.length; r++) {
    const row = s5RawTable[r];
    if (!row || !row[0]) continue;
    const month = row[0].trim();
    const spendFmt = (row[1] || '$0').trim();
    const spend = parseMoneyOrNumeric(spendFmt);
    const signups = parseMoneyOrNumeric(row[2]);
    const spendPerSignup = (row[3] || '—').trim();
    const started = parseMoneyOrNumeric(row[4]);
    const spendPerStarted = (row[5] || '—').trim();
    const fills = parseMoneyOrNumeric(row[6]);
    const marginFmt = (row[7] || '$0').trim();
    const margin = parseMoneyOrNumeric(marginFmt);
    const roas = (row[8] || '').trim();
    const isTotal = /total/i.test(month);
    const item = {
      month,
      spend,
      spendFmt,
      signups,
      spendPerSignup,
      started,
      spendPerStarted,
      fills,
      margin,
      marginFmt,
      roas
    };
    if (roas) item.roasNum = parseMoneyOrNumeric(roas);
    if (isTotal) item.isTotal = true;
    s5Table.push(item);
  }
  const s5TotalRow = s5Table.find(r => r.isTotal) || {};
  const pmSpendKpi = findNextShapeValue(s5.shapes, /^Media spend/i);
  const pmSignupsKpi = findNextShapeValue(s5.shapes, /^Paid Media sign-ups/i);
  const pmStartedKpi = findNextShapeValue(s5.shapes, /^Started therapy/i);
  const pmMarginKpi = findNextShapeValue(s5.shapes, /^Pharmacy gross margin/i);

  out.slide5_paidMedia = {
    sectionTitle: s5.shapes[0]?.join(' ') || 'IS PAID MEDIA PAYING OFF?',
    headline: s5.shapes[1]?.join(' ') || out.slide5_paidMedia?.headline || '',
    kpis: [
      {
        label: pmSpendKpi?.label || 'Media spend, campaign to date',
        value: pmSpendKpi?.value || '$142K',
        exact: s5TotalRow.spendFmt || '$142,033',
        subtext: pmSpendKpi?.subtext || "Jan ‘26 – Sep '26"
      },
      {
        label: pmSignupsKpi?.label || 'Paid Media sign-ups',
        value: pmSignupsKpi?.value || String(s5TotalRow.signups || 414),
        exact: `${s5TotalRow.signups || 414} sign-ups`,
        subtext: pmSignupsKpi?.subtext || '$343 of spend per sign-up'
      },
      {
        label: pmStartedKpi?.label || 'Started therapy',
        value: pmStartedKpi?.value || String(s5TotalRow.started || 243),
        exact: `${s5TotalRow.started || 243} patients`,
        subtext: pmStartedKpi?.subtext || '$584 per patient started'
      },
      {
        label: pmMarginKpi?.label || 'Pharmacy gross margin',
        value: pmMarginKpi?.value || '$658K',
        exact: s5TotalRow.marginFmt || '$658,361',
        subtext: pmMarginKpi?.subtext || '786 fills from these patients'
      }
    ],
    table: s5Table.length ? s5Table : out.slide5_paidMedia.table,
    footnote: s5.shapes.find(a => a.join(' ').includes('Spend from the agency'))?.join(' ') || out.slide5_paidMedia?.footnote || ''
  };

  // SLIDE 6: First-Fill Funnel
  const s6 = slides[6];
  const s6Chart = s6.charts[0] || {};
  const s6Ser = s6Chart.series?.[0] || {};
  const s6Cats = s6Ser.categories || ['Enrolled', 'Saw a provider', 'Prescribed', 'Filled 1st Rx'];
  const s6Vals = (s6Ser.values || [760, 684, 608, 523]).map(v => Math.round(v));
  const enrolledBase = Math.max(1, s6Vals[0] || 760);
  const s6Steps = s6Cats.map((stage, idx) => {
    const patients = s6Vals[idx] ?? 0;
    const prevPts = idx === 0 ? patients : (s6Vals[idx - 1] || 1);
    return {
      stage,
      patients,
      pctOfEnrolled: Math.round((patients / enrolledBase) * 100),
      stepConversion: `${Math.round((patients / prevPts) * 100)}%`
    };
  });
  const s6Dropoffs = [];
  for (const sh of s6.shapes) {
    if (sh.length === 2 && /^\d+$/.test(sh[0].trim())) {
      s6Dropoffs.push({ count: Number(sh[0].trim()), label: sh[1].trim() });
    }
  }
  const timingHeaderIdx = s6.shapes.findIndex(a => /Median time between steps/i.test(a.join(' ')));
  const s6Timing = [];
  if (timingHeaderIdx >= 0) {
    for (let i = timingHeaderIdx + 1; i + 1 < s6.shapes.length; i += 2) {
      const mTxt = s6.shapes[i].join(' ').trim();
      const lTxt = s6.shapes[i + 1].join(' ').trim();
      if (/^\d+$/.test(mTxt) && i + 1 === s6.shapes.length - 1) break;
      s6Timing.push({ metric: mTxt, label: lTxt });
    }
  }

  out.slide6_funnel = {
    sectionTitle: s6.shapes[0]?.join(' ') || 'ARE PATIENTS SEEING A PROVIDER AND FILLING?',
    headline: s6.shapes[1]?.join(' ') || out.slide6_funnel?.headline || '',
    chartTitle: s6Chart.title || out.slide6_funnel?.chartTitle || 'Members who enrolled before September (760 patients)',
    steps: s6Steps,
    dropoffs: s6Dropoffs.length ? s6Dropoffs : out.slide6_funnel.dropoffs,
    timing: s6Timing.length ? s6Timing : out.slide6_funnel.timing
  };

  // SLIDE 7: Refill Persistence
  const s7 = slides[7];
  const s7Chart = s7.charts[0] || {};
  const s7Ser = s7Chart.series?.[0] || {};
  const s7Footnote = s7.shapes.find(a => a.join(' ').includes('Step rates count'))?.join(' ') || out.slide7_refill?.footnote || '';
  const fillCountMatches = [...s7Footnote.matchAll(/Fill\s+\d+\s+([\d,]+)/gi)].map(m => Number(m[1].replace(/,/g, '')));
  const s7StepTable = [];
  const s7RawTable = s7.tables[0] || [];
  for (let r = 1; r < s7RawTable.length; r++) {
    const row = s7RawTable[r];
    if (!row || !row[0]) continue;
    const step = row[0].trim();
    const cameBack = (row[1] || '0%').trim();
    const eligiblePts = parseMoneyOrNumeric(row[2]);
    s7StepTable.push({
      step,
      cameBack,
      cameBackNum: parseMoneyOrNumeric(cameBack),
      eligiblePts,
      lowSample: eligiblePts < 30
    });
  }

  out.slide7_refill = {
    sectionTitle: s7.shapes[0]?.join(' ') || 'ARE PATIENTS REFILLING?',
    headline: s7.shapes[1]?.join(' ') || out.slide7_refill?.headline || '',
    chart: {
      title: s7Chart.title || 'Share of patients who started therapy still filling, by fill number',
      fills: s7Ser.categories || ['Fill 1', 'Fill 2', 'Fill 3', 'Fill 4', 'Fill 5', 'Fill 6', 'Fill 7', 'Fill 8'],
      shareStillFilling: (s7Ser.values || []).map(v => Number(Number(v).toFixed(1))),
      patientCounts: fillCountMatches.length ? fillCountMatches : (out.slide7_refill?.chart?.patientCounts || [670, 494, 311, 203, 118, 68, 41, 24])
    },
    stepTable: s7StepTable.length ? s7StepTable : out.slide7_refill.stepTable,
    footnote: s7Footnote
  };

  // SLIDE 9: Appendix Definitions
  const s9 = slides[9];
  const s9Notes = s9.shapes[2] || out.slide9_appendix?.notes || [];
  out.slide9_appendix = {
    sectionTitle: s9.shapes[0]?.join(' ') || 'APPENDIX',
    headline: s9.shapes[1]?.join(' ') || 'Definitions and data notes',
    notes: s9Notes
  };

  // SLIDE 10: Cohort Retention Matrix
  const s10 = slides[10];
  const s10RawTable = s10.tables[0] || [];
  const s10Cols = s10RawTable[0] || ['Joined', 'Members', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'];
  const s10Rows = [];
  for (let r = 1; r < s10RawTable.length; r++) {
    const row = s10RawTable[r];
    if (!row || !row[0]) continue;
    const obj = {
      joined: row[0].trim(),
      members: parseMoneyOrNumeric(row[1])
    };
    for (let c = 2; c < s10Cols.length; c++) {
      const colName = s10Cols[c].trim();
      obj[colName] = (row[c] || '').trim();
    }
    s10Rows.push(obj);
  }

  out.slide10_retention = {
    sectionTitle: s10.shapes[0]?.join(' ') || 'HOW LONG ARE PATIENTS STAYING?',
    headline: s10.shapes[1]?.join(' ') || 'Appendix – Member retention by month',
    columns: s10Cols,
    rows: s10Rows.length ? s10Rows : out.slide10_retention.rows,
    footnote: s10.shapes.find(a => a.join(' ').includes('Share of each sign-up'))?.join(' ') || out.slide10_retention?.footnote || ''
  };

  return sanitizePortalDataObject(out);
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
    let baseline = loadClientBaseline(clientId);
    if (GCS_STATE_BUCKET) {
      const remotePub = await loadJsonFromGcs(`clients/${clientId}/portal_data.json`);
      if (remotePub && remotePub.meta && remotePub.slide2_summary) {
        baseline = sanitizePortalDataObject(remotePub);
      }
    }
    clientStates[clientId] = baseline;
    return baseline;
  })();

  try {
    return await clientInitPromises[clientId];
  } finally {
    delete clientInitPromises[clientId];
  }
}

async function ensureClientDraftStateLoaded(clientId) {
  if (clientDraftStates[clientId] !== undefined) return clientDraftStates[clientId];
  let draft = loadClientDraftFromDisk(clientId);
  if (!draft && GCS_STATE_BUCKET) {
    const remoteDraft = await loadJsonFromGcs(`clients/${clientId}/portal_data_draft.json`);
    if (remoteDraft && remoteDraft.meta && remoteDraft.slide2_summary) {
      draft = sanitizePortalDataObject(remoteDraft);
    }
  }
  clientDraftStates[clientId] = draft || null;
  return clientDraftStates[clientId];
}

function summarizeReportState(state) {
  if (!state || !state.meta) return null;
  const s2 = state.slide2_summary || {};
  const s3 = state.slide3_financials || {};
  const activeKpi = s2.kpis?.find(k => k.id === 'active_sep');
  const fillsKpi = s2.kpis?.find(k => k.id === 'fills_sep');
  const procValues = s3.monthlyProceeds?.values || [];
  const lastProc = procValues[procValues.length - 1] ?? 0;
  const ytdProcRow = s3.ytdTable?.find(r => /Program proceeds/i.test(r.item));
  return {
    asOfDateFormatted: state.meta.asOfDateFormatted || 'September 30, 2026',
    asOfShort: state.meta.asOfShort || 'Sep2026',
    cutoffMonthName: state.meta.cutoffMonthName || 'September',
    monthsCount: (state.meta.months || []).length,
    activeMembers: activeKpi?.numericValue ?? activeKpi?.value ?? 0,
    activeMembersFmt: activeKpi?.value || String(activeKpi?.numericValue || 0),
    fills: fillsKpi?.numericValue ?? fillsKpi?.value ?? 0,
    fillsFmt: fillsKpi?.value || String(fillsKpi?.numericValue || 0),
    latestMonthlyProceeds: lastProc,
    latestMonthlyProceedsFmt: `$${Number(lastProc || 0).toLocaleString()}`,
    ytdProceedsFmt: ytdProcRow?.formatted || '$961,691',
    stagedFilename: state.meta.stagedFilename || null,
    stagedAt: state.meta.stagedAt || null,
    stagedBy: state.meta.stagedBy || null
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

// Full portal data for authenticated tenant (PowerPoint Slides 1–10 only)
// Supports ?preview=1 strictly for Bridge Super-Admins (bridge_admin) when a staged draft exists
app.get('/api/portal-data', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const isAdmin = isCallerBridgeAdmin(req);
  const draftState = isAdmin ? await ensureClientDraftStateLoaded(clientId) : null;
  const usePreview = Boolean(isAdmin && req.query.preview === '1' && draftState);
  const state = usePreview ? draftState : await ensureClientStateLoaded(clientId);

  if (req.query.silent !== '1') {
    recordAuditEvent(req, 'PORTAL_LOADED', {
      clientId,
      clientName: state.meta?.client || clientId,
      activeView: 'summary',
      previewMode: usePreview
    });
  }
  res.setHeader('X-Bridge-Preview-Mode', usePreview ? '1' : '0');
  res.setHeader('X-Bridge-Has-Draft', draftState ? '1' : '0');
  res.json(state);
});

// ============================================================================
// ADMIN MONTHLY POWERPOINT (.PPTX) UPLOAD, STAGED PREVIEW & PUBLISH API
// STRICT RBAC: ONLY Bridge Super-Admins (bridge_admin) CAN ACCESS
// ============================================================================
app.get('/api/admin/report-status', async (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can view report staging status.' });
  }
  const clientId = req.clientId || 'damien';
  const [published, draft] = await Promise.all([
    ensureClientStateLoaded(clientId),
    ensureClientDraftStateLoaded(clientId)
  ]);
  res.json({
    ok: true,
    clientId,
    published: summarizeReportState(published),
    hasDraft: Boolean(draft),
    draft: draft ? summarizeReportState(draft) : null
  });
});

app.post('/api/admin/upload-pptx', async (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: '/api/admin/upload-pptx', method: 'POST' });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can upload PowerPoint report decks.'
    });
  }
  const clientId = req.clientId || 'damien';
  const { filename, fileBase64 } = req.body || {};
  const cleanName = String(filename || 'Monthly_Program_Dashboard.pptx').trim();
  if (!/\.pptx$/i.test(cleanName)) {
    return res.status(400).json({
      ok: false,
      error: 'Only PowerPoint (.pptx) files are accepted. Excel (.xlsx/.xls) and other file types are rejected.'
    });
  }
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing fileBase64 payload.' });
  }

  let buffer;
  try {
    const rawB64 = fileBase64.includes(',') ? fileBase64.split(',').pop() : fileBase64;
    buffer = Buffer.from(rawB64, 'base64');
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid base64 encoding for .pptx file.' });
  }

  try {
    const publishedState = await ensureClientStateLoaded(clientId);
    const parsedDraft = parsePptxBufferToPortalData(buffer, publishedState);
    parsedDraft.meta = {
      ...(parsedDraft.meta || {}),
      clientId,
      stagedFilename: cleanName,
      stagedAt: new Date().toISOString(),
      stagedBy: req.authenticatedUser
    };

    clientDraftStates[clientId] = parsedDraft;
    try {
      const draftPath = getClientDraftPath(clientId);
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(draftPath, JSON.stringify(parsedDraft, null, 2), 'utf8');
    } catch (e) {
      console.warn('Could not save portal_data_draft.json locally:', e.message);
    }
    if (typeof saveJsonToGcsAsync === 'function') {
      saveJsonToGcsAsync(`clients/${clientId}/portal_data_draft.json`, parsedDraft);
    }

    const summary = summarizeReportState(parsedDraft);
    recordAuditEvent(req, 'PPTX_DRAFT_UPLOADED', {
      filename: cleanName,
      asOfDateFormatted: summary.asOfDateFormatted,
      activeMembers: summary.activeMembers,
      fills: summary.fills,
      ytdProceedsFmt: summary.ytdProceedsFmt
    });

    res.json({
      ok: true,
      message: `Staged '${cleanName}' (${summary.asOfDateFormatted}) in Preview Mode. Client users continue seeing ${publishedState.meta?.asOfDateFormatted || 'the current published report'} until you click Publish.`,
      hasDraft: true,
      draft: summary,
      published: summarizeReportState(publishedState)
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err.message || 'Failed to parse 10-slide PowerPoint deck.'
    });
  }
});

app.post('/api/admin/publish-pptx', async (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: '/api/admin/publish-pptx', method: 'POST' });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can publish staged PowerPoint reports.'
    });
  }
  const clientId = req.clientId || 'damien';
  const draft = await ensureClientDraftStateLoaded(clientId);
  if (!draft) {
    return res.status(400).json({ ok: false, error: 'No staged PowerPoint draft found to publish.' });
  }

  const nextPublished = JSON.parse(JSON.stringify(draft));
  delete nextPublished.meta.stagedFilename;
  delete nextPublished.meta.stagedAt;
  delete nextPublished.meta.stagedBy;

  clientStates[clientId] = nextPublished;
  clientDraftStates[clientId] = null;

  try {
    const pubPath = getClientBaselinePath(clientId);
    fs.mkdirSync(path.dirname(pubPath), { recursive: true });
    fs.writeFileSync(pubPath, JSON.stringify(nextPublished, null, 2), 'utf8');
    if (clientId === 'damien') {
      const legacyPath = path.join(__dirname, 'data', 'portal_data.json');
      fs.writeFileSync(legacyPath, JSON.stringify(nextPublished, null, 2), 'utf8');
    }
    const draftPath = getClientDraftPath(clientId);
    if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  } catch (e) {
    console.warn('Could not write published portal_data.json locally:', e.message);
  }

  if (typeof saveJsonToGcsAsync === 'function') {
    saveJsonToGcsAsync(`clients/${clientId}/portal_data.json`, nextPublished);
    saveJsonToGcsAsync(`clients/${clientId}/portal_data_draft.json`, null);
  }

  const summary = summarizeReportState(nextPublished);
  recordAuditEvent(req, 'PPTX_DRAFT_PUBLISHED', {
    asOfDateFormatted: summary.asOfDateFormatted,
    activeMembers: summary.activeMembers,
    fills: summary.fills,
    ytdProceedsFmt: summary.ytdProceedsFmt
  });

  res.json({
    ok: true,
    message: `Published ${summary.asOfDateFormatted} report to all ${clientId} portal users.`,
    hasDraft: false,
    published: summary
  });
});

app.post('/api/admin/discard-pptx', async (req, res) => {
  if (!isCallerBridgeAdmin(req)) {
    recordAuditEvent(req, 'UNAUTHORIZED_ADMIN_ATTEMPT', { endpoint: '/api/admin/discard-pptx', method: 'POST' });
    return res.status(403).json({
      ok: false,
      error: 'Forbidden: Only Bridge Super-Admins (bridge_admin) can discard staged PowerPoint drafts.'
    });
  }
  const clientId = req.clientId || 'damien';
  const draft = await ensureClientDraftStateLoaded(clientId);
  const discardedAsOf = draft?.meta?.asOfDateFormatted || 'none';
  clientDraftStates[clientId] = null;

  try {
    const draftPath = getClientDraftPath(clientId);
    if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
  } catch (_) {}

  if (typeof saveJsonToGcsAsync === 'function') {
    saveJsonToGcsAsync(`clients/${clientId}/portal_data_draft.json`, null);
  }

  const published = await ensureClientStateLoaded(clientId);
  recordAuditEvent(req, 'PPTX_DRAFT_DISCARDED', { discardedAsOf });

  res.json({
    ok: true,
    message: 'Staged PowerPoint draft discarded. Live portal remains on published report.',
    hasDraft: false,
    published: summarizeReportState(published)
  });
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
  const s9 = state.slide9_appendix || {};
  const s10 = state.slide10_retention || {};

  // 0. Strict Member-Level Privacy Guardrail
  if (isMemberLevelQuery(state, q)) {
    return buildMemberPrivacyGuardrailReply(state, q);
  }

  // Detect whether the user is asking for a broad breakdown/comparison/table vs. a focused/simple question
  const wantsFullBreakdown =
    /\b(break\s*down|breakdown|compare|comparison|table|chart|graph|all\s+months|by\s+month|january\s+to\s+september|jan\s+to\s+sep|every\s+month|full|overview|summary|explain\s+our|reconcil|matrix|across\s+fill|across\s+wegovy)\b/i.test(ql) ||
    (ql.includes('revenue') && ql.includes('proceeds'));

  // 1. Out-of-Deck Granular Queries (Prescribers, Individual Employers, Payers/Savings Cards, Dose Strengths, Worklists)
  if (
    ql.includes('prescriber') || ql.includes('doctor') || ql.includes('townsend') ||
    ql.includes('payer') || ql.includes('savings card') || ql.includes('insurance') ||
    ql.includes('dose') || ql.includes('0.25') || ql.includes('2.4') ||
    ql.includes('worklist') || ql.includes('to-do') || ql.includes('todo') ||
    ql.includes('evansville') || ql.includes('employer group')
  ) {
    if (!wantsFullBreakdown) {
      return {
        question: q,
        answer:
          `**Ask Bridge AI** is powered strictly by the **${meta.programTitle}** executive report deck (Slides 1–10 through ${meta.asOfDateFormatted || 'September 30, 2026'}), which tracks **aggregate** program metrics and does not include granular prescriber names, individual employer companies, third-party insurance/savings cards, milligram dose strengths, or patient worklist queues. You can ask for aggregate **Patient Sources & Channel Economics** (EPIC, Paid Media, Employee, LHD, McGohan Brabender, Other) or **Medication Mix** (Wegovy Pen, Wegovy Pill, Ozempic) at any time.`
      };
    }
    const srcRows = s4.table || [];
    const tableLines = srcRows.map(r =>
      `| **${r.source}** | ${r.enrolledSept} | **${r.enrolledYtd}** | ${r.share} | **${r.filled1stRx}** | ${r.refilled1to2} | ${r.glp1Fills.toLocaleString()} | **${r.grossMarginFmt}** |`
    ).join('\n');
    return {
      question: q,
      answer:
        `### **Executive Report Scope & Aggregate Channel Summary (${meta.client})**\n` +
        `• **Report Scope**: **Ask Bridge AI** is powered strictly by the **${meta.programTitle}** executive report deck (Slides 1–10 through ${meta.asOfDateFormatted || 'September 30, 2026'}). Granular workbook breakouts (such as individual prescribers, specific employer companies, third-party payer/savings cards, milligram dose strengths, or patient worklist queues) are not part of the executive deck.\n` +
        `• **Available Aggregate Channel & Program Analytics**: Below is the full channel enrollment, conversion, and gross margin breakdown from the executive report:\n\n` +
        `| Source | Enrolled Sep | Enrolled YTD | Share | Filled 1st Rx | Refilled 1st→2nd | GLP-1 Fills | Gross Margin |\n` +
        `| --- | --- | --- | --- | --- | --- | --- | --- |\n` +
        `${tableLines}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'YTD Enrollments & GLP-1 Fills by Patient Source',
          labels: srcRows.map(r => r.source),
          datasets: [
            { label: 'Enrolled YTD', data: srcRows.map(r => Number(r.enrolledYtd) || 0), backgroundColor: '#154672' },
            { label: 'GLP-1 Fills', data: srcRows.map(r => Number(r.glp1Fills) || 0), backgroundColor: '#26abe4' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 1B. Concise Direct Answers for Simple / Specific Single-Fact Questions (Zero Word Vomit)
  if (!wantsFullBreakdown) {
    const monthMap = [
      { key: 'jan', full: 'January', idx: 0 },
      { key: 'feb', full: 'February', idx: 1 },
      { key: 'mar', full: 'March', idx: 2 },
      { key: 'apr', full: 'April', idx: 3 },
      { key: 'may', full: 'May', idx: 4 },
      { key: 'jun', full: 'June', idx: 5 },
      { key: 'jul', full: 'July', idx: 6 },
      { key: 'aug', full: 'August', idx: 7 },
      { key: 'sep', full: 'September', idx: 8 }
    ];
    const matchedMonths = monthMap.filter(m => new RegExp(`\\b(${m.key}|${m.full.toLowerCase()})\\b`, 'i').test(ql));

    // Simple cost-to-fill question
    if (ql.includes('cost to fill') || ql.includes('cost per fill') || ql.includes('$40')) {
      const costRow = (s3.ytdTable || []).find(r => r.item.toLowerCase().includes('cost to fill'));
      return {
        question: q,
        answer: `The assumed pharmacy cost to fill for **${meta.client}** is **$${s3.costPerFill || 40} per fill**, totaling **${costRow ? costRow.formatted : '−$81,360'}** across **${(s3.totalFillsInPnl || 2034).toLocaleString()}** YTD GLP-1 fills.`
      };
    }

    // Simple specific fee line-item question (Alpha fees, Bridge fees, Broker commissions, Membership fees)
    if (ql.includes('membership fee')) {
      const feeRow = (s3.ytdTable || []).find(r => r.item === 'Membership fees collected');
      return {
        question: q,
        answer: `YTD membership fees collected for **${meta.client}** totaled **${feeRow ? feeRow.formatted : '$44,164'}** through ${meta.asOfDateFormatted || 'September 30, 2026'}.`
      };
    }
    if (ql.includes('alpha') && ql.includes('fee')) {
      const alphaRow = (s3.ytdTable || []).find(r => r.item === 'Alpha platform fees');
      return {
        question: q,
        answer: `YTD Hello Alpha platform fees for **${meta.client}** totaled **${alphaRow ? alphaRow.formatted : '−$411,745'}** through ${meta.asOfDateFormatted || 'September 30, 2026'}.`
      };
    }
    if (ql.includes('bridge') && ql.includes('fee')) {
      const bridgeRow = (s3.ytdTable || []).find(r => r.item === 'Bridge fees');
      return {
        question: q,
        answer: `YTD Bridge fees for **${meta.client}** totaled **${bridgeRow ? bridgeRow.formatted : '−$195,900'}** through ${meta.asOfDateFormatted || 'September 30, 2026'}.`
      };
    }
    if (ql.includes('broker') && ql.includes('commission')) {
      const commRow = (s3.ytdTable || []).find(r => r.item === 'Broker commissions');
      return {
        question: q,
        answer: `YTD broker commissions for **${meta.client}** totaled **${commRow ? commRow.formatted : '−$10,060'}** through ${meta.asOfDateFormatted || 'September 30, 2026'}.`
      };
    }

    // Simple active members question (for a single month or current/latest cutoff month)
    if (ql.includes('active member') || ql.includes('how many members')) {
      if (matchedMonths.length === 1) {
        const mObj = matchedMonths[0];
        const val = s2.activeMembersByMonth?.values?.[mObj.idx];
        const prevVal = mObj.idx > 0 ? s2.activeMembersByMonth?.values?.[mObj.idx - 1] : null;
        const deltaTxt = (prevVal && val) ? ` (${val >= prevVal ? '+' : ''}${(((val - prevVal) / prevVal) * 100).toFixed(1)}% vs. ${prevVal} in ${monthMap[mObj.idx - 1].full})` : '';
        return {
          question: q,
          answer: `**${meta.client}** had **${val ?? 862} active members** in **${mObj.full} 2026**${deltaTxt}.`
        };
      }
      const kpiActive = s2.kpis?.find(k => k.id === 'active_sep');
      const latestVal = kpiActive?.value || String(s2.activeMembersByMonth?.values?.[s2.activeMembersByMonth.values.length - 1] ?? 862);
      const cutoffMonth = meta.cutoffMonthName || 'September';
      const subTxt = kpiActive?.subtext ? ` (${kpiActive.subtext})` : '';
      return {
        question: q,
        answer: `**${meta.client}** had **${latestVal} active members** in **${cutoffMonth} 2026**${subTxt}.`
      };
    }

    // Simple single-month proceeds question (e.g., "What were the proceeds in August?")
    if (matchedMonths.length === 1 && (ql.includes('proceeds') || ql.includes('profit'))) {
      const mObj = matchedMonths[0];
      const val = s3.monthlyProceeds?.values?.[mObj.idx] || 0;
      const ytdProc = (s3.ytdTable || []).find(r => r.item === 'Program proceeds')?.formatted || '$961,691';
      return {
        question: q,
        answer: `Net program proceeds (after ad spend and fees) for **${meta.client}** in **${mObj.full} 2026** were **$${val.toLocaleString()}** (contributing to **${ytdProc}** YTD).`
      };
    }

    // Simple Paid Media single-metric or single-month question
    if (ql.includes('roas') || ql.includes('return on spend') || ql.includes('paid media') || ql.includes('ad spend') || ql.includes('media spend')) {
      const pmRows = s5.table || [];
      const totalRow = pmRows.find(r => r.isTotal) || pmRows[pmRows.length - 1] || {};
      if (matchedMonths.length === 1) {
        const mObj = matchedMonths[0];
        const mRow = pmRows.find(r => String(r.month || '').toLowerCase() === mObj.key) || {};
        return {
          question: q,
          answer: `In **${mObj.full} 2026**, Paid Media spend was **${mRow.spendFmt || '$0'}**, driving **${mRow.signups ?? 0} sign-ups** (**${mRow.spendPerSignup || '—'}/sign-up**), **${mRow.started ?? 0} therapy starts** (**${mRow.spendPerStarted || '—'}/starter**), **${mRow.fills ?? 0} fills**, and **${mRow.marginFmt || '$0'}** in pharmacy gross margin (**${mRow.roas || '—'}** return on spend).`
        };
      }
      return {
        question: q,
        answer: `Campaign-to-date Paid Media return on spend is **${totalRow.roas || '463%'} (4.63x)**: **${totalRow.spendFmt || '$142,033'}** in total media spend generated **${totalRow.signups || 414} sign-ups** (**${totalRow.spendPerSignup || '$343'}/sign-up**), **${totalRow.started || 243} therapy starts** (**${totalRow.spendPerStarted || '$584'}/starter**), and **${totalRow.marginFmt || '$658,361'}** in pharmacy gross margin across **${totalRow.fills || 786} fills**.`
      };
    }

    // Simple single-medication question (Ozempic, Wegovy pill, Wegovy pen)
    if (ql.includes('ozempic') || ql.includes('pill') || ql.includes('pen')) {
      const mObj = matchedMonths.length === 1 ? matchedMonths[0] : monthMap[8];
      const pen = s8.chart?.wegovyPen?.[mObj.idx] || 0;
      const pill = s8.chart?.wegovyPill?.[mObj.idx] || 0;
      const oz = s8.chart?.ozempic?.[mObj.idx] || 0;
      const tot = pen + pill + oz;
      if (ql.includes('ozempic') && !ql.includes('wegovy')) {
        const share = tot > 0 ? ((oz / tot) * 100).toFixed(1) + '%' : '0%';
        const ytdOz = (s8.chart?.ozempic || []).reduce((a, b) => a + b, 0);
        return {
          question: q,
          answer: `There were **${oz} Ozempic fills** (**${share}** of ${tot} total dispenses) in **${mObj.full} 2026**, and **${ytdOz} Ozempic fills** YTD.`
        };
      }
      if (ql.includes('pill') && !ql.includes('pen')) {
        const share = tot > 0 ? ((pill / tot) * 100).toFixed(1) + '%' : '0%';
        const ytdPill = (s8.chart?.wegovyPill || []).reduce((a, b) => a + b, 0);
        return {
          question: q,
          answer: `There were **${pill} Wegovy pill fills** (**${share}** of ${tot} total dispenses) in **${mObj.full} 2026**, and **${ytdPill} Wegovy pill fills** YTD.`
        };
      }
      if (ql.includes('pen') && !ql.includes('pill')) {
        const share = tot > 0 ? ((pen / tot) * 100).toFixed(1) + '%' : '0%';
        const ytdPen = (s8.chart?.wegovyPen || []).reduce((a, b) => a + b, 0);
        return {
          question: q,
          answer: `There were **${pen} Wegovy pen fills** (**${share}** of ${tot} total dispenses) in **${mObj.full} 2026**, and **${ytdPen} Wegovy pen fills** YTD.`
        };
      }
    }

    // Simple single-channel source question (EPIC, LHD, McGohan Brabender, Employee)
    const srcRows = s4.table || [];
    const singleSourceMatch = [
      { tok: 'epic', match: r => r.source.toLowerCase().includes('epic') },
      { tok: 'lhd', match: r => r.source.toLowerCase().includes('lhd') },
      { tok: 'mcgohan', match: r => r.source.toLowerCase().includes('mcgohan') },
      { tok: 'employee', match: r => r.source.toLowerCase().includes('employee') }
    ].filter(s => ql.includes(s.tok));
    if (singleSourceMatch.length === 1) {
      const sRow = srcRows.find(singleSourceMatch[0].match);
      if (sRow) {
        return {
          question: q,
          answer: `**${sRow.source}** has driven **${sRow.enrolledYtd} YTD enrollments** (**${sRow.enrolledSept}** in September, **${sRow.share}** of program sign-ups), with a **${sRow.filled1stRx} first-fill rate**, **${sRow.refilled1to2} 1st→2nd refill rate**, and **${sRow.grossMarginFmt} in pharmacy gross margin** across **${sRow.glp1Fills.toLocaleString()} GLP-1 fills**.`
        };
      }
    }

    // Simple funnel timing question
    if (ql.includes('timing') || ql.includes('how long') || ql.includes('median time') || ql.includes('hours')) {
      const timingStr = (s6.timing || []).map(t => `**${t.metric}** (${t.label})`).join(', ');
      return {
        question: q,
        answer: `Median step timing in the first-fill funnel is: ${timingStr}.`
      };
    }

    // Simple first-fill rate question
    if (ql.includes('first fill rate') || ql.includes('1st fill rate') || ql.includes('first-fill rate')) {
      const filledStep = (s6.steps || []).find(s => s.stage.toLowerCase().includes('filled')) || { patients: 523, pctOfEnrolled: 69 };
      const enrolledStep = (s6.steps || [])[0] || { patients: 760 };
      return {
        question: q,
        answer: `**${filledStep.pctOfEnrolled}%** of pre-September sign-ups (**${filledStep.patients} of ${enrolledStep.patients} patients**) filled their first GLP-1 prescription.`
      };
    }
  }

  // 2. Paid Media ROI & Monthly Media Cohorts (Slide 5)
  if (
    ql.includes('paid media') || ql.includes('roas') || ql.includes('return on spend') ||
    ql.includes('media spend') || ql.includes('ad spend') || ql.includes('4.63') || ql.includes('463%') ||
    (ql.includes('cohort') && (ql.includes('media') || ql.includes('spend')))
  ) {
    const pmRows = s5.table || [];
    const totalRow = pmRows.find(r => r.isTotal) || pmRows[pmRows.length - 1] || {};
    const monthRows = pmRows.filter(r => !r.isTotal);
    const tableLines = pmRows.map(r =>
      `| **${r.month}** | ${r.spendFmt} | ${r.signups} | ${r.spendPerSignup} | ${r.started} | ${r.spendPerStarted} | ${r.fills} | **${r.marginFmt}** | **${r.roas || '—'}** |`
    ).join('\n');

    return {
      question: q,
      answer:
        `### **Paid Media ROI & Cohort Performance (${meta.client} Through ${meta.asOfDateFormatted || 'Sep 30, 2026'})**\n` +
        `• **Headline**: ${s5.headline || 'Every $1 of media spend has returned $4.63 of pharmacy margin from Paid Media patients.'}\n` +
        `• **Campaign-to-Date Totals**: **${totalRow.spendFmt || '$142,033'}** total media spend across **${totalRow.signups || 414} sign-ups** (**${totalRow.spendPerSignup || '$343'}/sign-up**) and **${totalRow.started || 243} therapy starters** (**${totalRow.spendPerStarted || '$584'}/starter**), generating **${totalRow.marginFmt || '$658,361'}** in pharmacy gross margin across **${totalRow.fills || 786} fills** (**${totalRow.roas || '463%'}** return on spend).\n` +
        `• **Methodology Note**: ${s5.footnote || ''}\n\n` +
        `| Sign-up Month | Media Spend | Sign-ups | Spend / Sign-up | Started Therapy | Spend / Started | Fills to Date | Gross Margin | Return on Spend |\n` +
        `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n` +
        `${tableLines}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'Monthly Paid Media Spend vs. Cumulative Gross Margin ($)',
          labels: monthRows.map(r => r.month),
          datasets: [
            { label: 'Media Spend ($)', data: monthRows.map(r => Number(r.spend) || 0), backgroundColor: '#94a3b8' },
            { label: 'Gross Margin ($)', data: monthRows.map(r => Number(r.margin) || 0), backgroundColor: '#154672' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 3. Patient Sources & Broker Channels (Slide 4)
  if (
    ql.includes('epic') || ql.includes('lhd') || ql.includes('mcgohan') ||
    ql.includes('source') || ql.includes('channel') || ql.includes('broker') ||
    ql.includes('employee') || ql.includes('where are patients')
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
        `• **Headline**: ${s4.headline || 'EPIC and broker partners drove 62% of September enrollments.'}\n` +
        (epicRow.source ? `• **${epicRow.source}**: **${epicRow.enrolledYtd} YTD enrollments** (${epicRow.enrolledSept} in Sep, ${epicRow.share} share), **${epicRow.filled1stRx} first-fill conversion**, **${epicRow.refilled1to2} refill rate**, and **${epicRow.grossMarginFmt} gross margin** across ${epicRow.glp1Fills?.toLocaleString() || 0} fills.\n` : '') +
        (pmRow.source ? `• **${pmRow.source}**: **${pmRow.enrolledYtd} YTD enrollments** (${pmRow.enrolledSept} in Sep, ${pmRow.share} share), **${pmRow.filled1stRx} first-fill conversion**, **${pmRow.refilled1to2} refill rate**, and **${pmRow.grossMarginFmt} gross margin** across ${pmRow.glp1Fills?.toLocaleString() || 0} fills.\n` : '') +
        `• **Note**: ${s4.footnote || ''}\n\n` +
        `| Source | Enrolled Sep | Enrolled YTD | Share | Filled 1st Rx | Refilled 1st→2nd | GLP-1 Fills | Gross Margin |\n` +
        `| --- | --- | --- | --- | --- | --- | --- | --- |\n` +
        `${tableLines}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'YTD Enrollments & GLP-1 Fills by Patient Source',
          labels: srcRows.map(r => r.source),
          datasets: [
            { label: 'Enrolled YTD', data: srcRows.map(r => Number(r.enrolledYtd) || 0), backgroundColor: '#154672' },
            { label: 'GLP-1 Fills', data: srcRows.map(r => Number(r.glp1Fills) || 0), backgroundColor: '#26abe4' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 4. Medication Mix: Wegovy Pen vs. Wegovy Pill vs. Ozempic (Slide 8)
  if (
    ql.includes('wegovy') || ql.includes('ozempic') || ql.includes('pill') ||
    ql.includes('pen') || ql.includes('medication') || ql.includes('drug') || ql.includes('dispense')
  ) {
    const callouts = s8.septemberCallouts || [];
    const calloutLines = callouts.map(c => `• **${c.label}**: **${c.value}** fills in September (**${c.share}** share)`).join('\n');
    const months = s8.chart?.months || [];
    const tableLines = months.map((m, i) => {
      const pen = s8.chart.wegovyPen[i] || 0;
      const pill = s8.chart.wegovyPill[i] || 0;
      const oz = s8.chart.ozempic[i] || 0;
      const tot = pen + pill + oz;
      const pillShare = tot > 0 ? ((pill / tot) * 100).toFixed(1) + '%' : '0.0%';
      return `| **${m}** | ${pen} | ${pill} | ${oz} | **${tot}** | ${pillShare} |`;
    }).join('\n');

    return {
      question: q,
      answer:
        `### **Medication Mix (${meta.client} Through ${meta.asOfDateFormatted || 'Sep 30, 2026'})**\n` +
        `• **Headline**: ${s8.headline || 'Wegovy pill reached 38% of fills in September.'}\n` +
        `${calloutLines}\n\n` +
        `| Month | Wegovy Pen | Wegovy Pill | Ozempic | Total Fills | Wegovy Pill % |\n` +
        `| --- | --- | --- | --- | --- | --- |\n` +
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

  // 5. Cohort Retention Matrix & Refill Persistence (Slide 7 & Slide 10)
  if (
    ql.includes('retention') || ql.includes('m0') || ql.includes('m1') ||
    ql.includes('how long are patients staying') || ql.includes('refill') ||
    ql.includes('fill 1') || ql.includes('fill 2') || ql.includes('persistence')
  ) {
    const refillSteps = (s7.stepTable || []).map(r => `| **${r.step}** | **${r.cameBack}** | ${r.eligiblePts} |`).join('\n');
    const fills = s7.chart?.fills || [];
    const shareStill = s7.chart?.shareStillFilling || [];
    const ptCounts = s7.chart?.patientCounts || [];
    const fillCurveLines = fills.map((f, i) => `• **${f}**: **${shareStill[i]}%** still filling (**${ptCounts[i]}** patients)`).join('\n');
    const retRows = (s10.rows || []).map(r =>
      `| **${r.joined}** | ${r.members} | ${r.M0 || '—'} | ${r.M1 || '—'} | ${r.M2 || '—'} | ${r.M3 || '—'} | ${r.M4 || '—'} | ${r.M5 || '—'} | ${r.M6 || '—'} | ${r.M7 || '—'} | ${r.M8 || '—'} |`
    ).join('\n');

    return {
      question: q,
      answer:
        `### **Refill Persistence & Member Cohort Retention (${meta.client})**\n` +
        `• **Headline**: ${s7.headline || 'Once patients start, more than 9 in 10 come back for each refill.'}\n` +
        `${fillCurveLines}\n\n` +
        `#### **Refill Continuation by Step (45+ Day Cutoff)**\n` +
        `| Refill Step | Came Back | Eligible Patients |\n` +
        `| --- | --- | --- |\n` +
        `${refillSteps}\n\n` +
        `#### **Member Cohort Retention by Joining Month (M0 = Joining Month)**\n` +
        `| Joined | Members | M0 | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 |\n` +
        `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n` +
        `${retRows}\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'Share of Patients Still Filling by Fill Number (%)',
          labels: fills,
          datasets: [
            { label: 'Share Still Filling (%)', data: shareStill, backgroundColor: '#154672' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 6. First-Fill Funnel, Drop-Offs & Median Timing (Slide 6)
  if (
    ql.includes('funnel') || ql.includes('conversion') || ql.includes('drop') ||
    ql.includes('provider') || ql.includes('prescribed') || ql.includes('timing') ||
    ql.includes('median time') || ql.includes('17 hours')
  ) {
    const steps = s6.steps || [];
    const dropoffs = s6.dropoffs || [];
    const timing = s6.timing || [];
    const stepTable = steps.map(s => `| **${s.stage}** | **${s.patients}** | **${s.pctOfEnrolled}%** | ${s.stepConversion || '—'} |`).join('\n');
    const dropLines = dropoffs.map(d => `• **${d.count} patients** ${d.label}`).join('\n');
    const timingLines = timing.map(t => `• **${t.metric}**: ${t.label}`).join('\n');

    return {
      question: q,
      answer:
        `### **First-Fill Conversion Funnel, Drop-Offs & Timing (${meta.client})**\n` +
        `• **Headline**: ${s6.headline || '69% of sign-ups fill their first prescription; the losses happen before the pharmacy.'}\n` +
        `• **Cohort**: ${s6.chartTitle || 'Members who enrolled before September (at least 30 days since enrollment)'}\n\n` +
        `| Funnel Stage | Patients | % of Enrolled | Step Conversion |\n` +
        `| --- | --- | --- | --- |\n` +
        `${stepTable}\n\n` +
        `#### **Drop-Off Breakdown**\n${dropLines}\n\n` +
        `#### **Median Time Between Steps**\n${timingLines}\n\n` +
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

  // 7. Program Definitions, Methodology & Fills Reconciliation (Slide 9)
  if (
    ql.includes('definition') || ql.includes('appendix') || ql.includes('methodology') ||
    ql.includes('reconcil') || ql.includes('1,952') || ql.includes('1952') ||
    ql.includes('unmatched') || ql.includes('alternate id') || ql.includes('data note')
  ) {
    const notes = (s9.notes || []).map((n, idx) => `${idx + 1}. ${n}`).join('\n');
    const pnlFills = s3.totalFillsInPnl || 2034;
    return {
      question: q,
      answer:
        `### **Program Definitions, Methodology & Reconciliation Notes (${meta.client})**\n` +
        `${notes}\n\n` +
        `| Metric / Reconciliation Item | Value / Rule |\n` +
        `| --- | --- |\n` +
        `| **Total GLP-1 Fills in P&L** | **${pnlFills.toLocaleString()}** |\n` +
        `| **Matched Member Fills (8-Char Alternate ID)** | **1,952 (96%)** |\n` +
        `| **Fills With No Patient ID** | **51** |\n` +
        `| **Fills With Unmatched ID** | **20** |\n` +
        `| **Assumed Cost to Fill** | **$40 per fill** |\n` +
        `| **First-Fill Funnel Cutoff** | **Enrolled before September (30+ days)** |\n` +
        `| **Refill Step Rate Cutoff** | **Prior fill 45+ days before Sep 30, 2026** |\n\n` +
        `\`\`\`chart\n` +
        JSON.stringify({
          type: 'bar',
          title: 'GLP-1 Fills Reconciliation (Matched vs. Unmatched)',
          labels: ['Total P&L Fills', 'Matched Member Fills', 'No Patient ID', 'Unmatched ID'],
          datasets: [
            { label: 'GLP-1 Fills', data: [pnlFills, 1952, 51, 20], backgroundColor: '#154672' }
          ]
        }) +
        `\n\`\`\``
    };
  }

  // 8. Financials / Monthly P&L / Proceeds / Revenue / Fees (Slide 3)
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
        `• **Net Program Proceeds (After Ad Spend & Fees)**: **$${sepProceeds.toLocaleString()}** in September (vs. **$${augProceeds.toLocaleString()}** in August) and **${procRow ? procRow.formatted : '$961,691'}** YTD.\n` +
        `• **Formula**: ${s3.footnote || ''}\n\n` +
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

  // 9. Default Executive Overview & Membership Growth (Slide 2)
  const revRow = s3.ytdTable.find(r => r.item === 'Pharmacy revenue');
  const feesRow = s3.ytdTable.find(r => r.item === 'Membership fees collected');
  const procRow = s3.ytdTable.find(r => r.item === 'Program proceeds');
  const sepProceeds = s3.monthlyProceeds.values[s3.monthlyProceeds.values.length - 1];
  const activeSep = s2.kpis.find(k => k.id === 'active_sep')?.value || '862';
  const fillsSep = s2.kpis.find(k => k.id === 'fills_sep')?.value || '673';
  const memMonths = s2.activeMembersByMonth?.months || ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
  const memVals = s2.activeMembersByMonth?.values || [];
  const memTable = memMonths.map((m, i) => `| **${m}** | **${memVals[i] ?? 0}** |`).join('\n');

  return {
    question: q || 'Executive Summary',
    answer:
      `### **${meta.programTitle} (${meta.asOfDateFormatted || 'Through September 30, 2026'})**\n` +
      `• **Headline**: ${s2.headline || ''}\n` +
      `• **Active Members & Fills**: **${activeSep} active members** and **${fillsSep} GLP-1 fills** in September at **${meta.pharmacyPartner}**.\n` +
      `• **Revenue & Net Proceeds**: **${revRow ? revRow.formatted : '$2,336,983'}** YTD pharmacy revenue, **${feesRow ? feesRow.formatted : '$44,164'}** YTD membership fees collected, **$${sepProceeds.toLocaleString()}** September net program proceeds, and **${procRow ? procRow.formatted : '$961,691'}** YTD net program proceeds.\n\n` +
      `| Month | Active Members |\n` +
      `| --- | --- |\n` +
      `${memTable}\n\n` +
      `\`\`\`chart\n` +
      JSON.stringify({
        type: 'bar',
        title: 'Active Members by Month (Jan – Sep 2026)',
        labels: memMonths,
        datasets: [
          { label: 'Active Members', data: memVals, backgroundColor: '#154672' }
        ]
      }) +
      `\n\`\`\``
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
  const meta = state.meta || {};
  if (memberBlockedFlag) {
    const blockedReply = buildMemberPrivacyGuardrailReply(state, question);
    return {
      question,
      clientId: meta.clientId,
      aiPowered: true,
      aiModel: VERTEX_GEMINI_MODEL,
      memberLevelBlocked: true,
      reply: blockedReply.answer,
      answer: blockedReply.answer
    };
  }

  const contextData = buildGeminiDataContext(state);
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

STRICT POWERPOINT-ONLY SCOPE & AGGREGATE PRIVACY RULE:
- Your ENTIRE source of truth is the executive PowerPoint report deck (Slides 1–10) provided in \`contextData\`:
  1. Executive Summary & Monthly Active Membership Growth (Jan–Sep 2026)
  2. Program Financials & YTD P&L + Monthly Net Program Proceeds (after ad spend & fees)
  3. Patient Sources & Channel Economics (EPIC, Paid Media, Employee, LHD, McGohan Brabender, Other)
  4. Paid Media ROI & Monthly Sign-Up Cohort Performance
  5. First-Fill Conversion Funnel (Enrolled -> Saw a provider -> Prescribed -> Filled 1st Rx), Drop-Offs & Median Step Timing
  6. Refill Persistence (Fill 1 through Fill 8) & Step-to-Step Continuation Rates
  7. Medication Mix (Wegovy Pen, Wegovy Pill, Ozempic monthly dispenses & September share)
  8. Program Definitions, Methodology & Fills Reconciliation (1,952 matched member fills out of 2,034 total P&L fills; 51 no ID, 20 unmatched ID; $40/fill cost; 30-day funnel & 45-day refill cutoffs)
  9. Member Cohort Retention Matrix by Joining Month (M0 through M8)
- NEVER invent, guess, or hallucinate numbers outside \`contextData\`.
- If a user asks about granular data not included in the executive PowerPoint report deck (such as individual employer company names, specific prescriber names, third-party insurance/payer/savings cards, milligram dose strengths like 0.25mg vs 2.4mg, or individual patient worklist queues), concisely explain in 1–2 sentences that the portal is powered strictly by the executive report deck and mention what aggregate metrics are available (only include a table/chart if the user explicitly asked for a channel or program breakdown).
- If someone asks to look up a specific member ID or individual patient record, politely explain in 1 sentence that for member privacy, Ask Bridge AI only provides aggregate analytics.

PROPORTIONAL RESPONSE CALIBRATION — ANSWER EXACTLY WHAT WAS ASKED (ZERO WORD VOMIT):
- Tailor your response length and formatting strictly to the scope of the user's question:
  1. **Simple, Direct, Single-Fact Questions** (e.g., "How many active members were there in September?", "What is the cost to fill?", "How many Ozempic fills were in September?", "What was the Paid Media ROAS in June?", "How long does it take from provider visit to prescription?", "How many patients enrolled via LHD in September?"):
     - Answer directly in **1–2 crisp sentences** (under ~45 words) with the exact figure in the very first sentence.
     - **DO NOT** include section headers (\`### ...\`), bullet lists, Markdown pipe tables, or \`\`\`chart\`\`\` blocks for a simple single-fact question.
     - **DO NOT** dump unrequested metrics.
  2. **Multi-Metric, Comparison, Trend, or Full-Breakdown Questions** (e.g., "What are our YTD pharmacy revenue, membership fees, and September and YTD net program proceeds?", "What are our total pharmacy revenue and net program proceeds?", "Compare our EPIC vs Paid Media channels...", "What are the refill persistence rates from Fill 1 to Fill 3, and how does the June cohort retain from M0 to M3?", "Break down our monthly program proceeds"):
     - When asked about overall pharmacy revenue and net program proceeds, cite YTD pharmacy revenue (${ytdRevFmt}), YTD membership fees (${ytdFeesFmt}), September net program proceeds ($${sepProceedsVal.toLocaleString()}), and YTD net program proceeds (${ytdProceedsFmt}).
     - Structure multi-metric / comparison / breakdown answers with:
       a) Concise bullet points answering the specific metrics requested.
       b) A focused **Markdown Pipe Table** (\`| Metric | ... |\`) with only the relevant rows/columns.
       c) An **Interactive Chart Block (\`\`\`chart ... \`\`\`)** using valid JSON Chart.js format:
\`\`\`chart
{"type":"bar","title":"Chart Title Here","labels":["Label 1","Label 2"],"datasets":[{"label":"Series 1","data":[100,200],"backgroundColor":"#2563eb"}]}
\`\`\`
       (Use numeric values only inside \`data\` arrays—no dollar signs or commas).
- Never cite slide numbers ("Slide 3") or raw JSON key names.`;

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

  let cleanReply = rawText.trim();
  const explicitTableOrChart = /\b(table|chart|graph|visual|plot)\b/i.test(String(question || ''));
  if (explicitTableOrChart) {
    const hasTable = /\|[\s:-]+\|/.test(cleanReply);
    let hasValidChart = false;
    const existingChartMatch = cleanReply.match(/```(?:chart|json-chart|chartjs)\s*([\s\S]*?)```/i);
    if (existingChartMatch) {
      try {
        const parsedSpec = JSON.parse(existingChartMatch[1].trim());
        hasValidChart = Boolean(
          parsedSpec &&
          Array.isArray(parsedSpec.labels) && parsedSpec.labels.length > 0 &&
          Array.isArray(parsedSpec.datasets) && parsedSpec.datasets.length > 0 &&
          parsedSpec.datasets.every(ds => Array.isArray(ds.data) && ds.data.length > 0 && ds.data.every(v => typeof v === 'number' && !Number.isNaN(v)))
        );
      } catch (_) {
        hasValidChart = false;
      }
    }
    if (!hasTable || !hasValidChart) {
      const detFallback = answerQuestion(state, `${question} breakdown table chart`).answer || '';
      if (!hasTable) {
        const tblLines = detFallback.split('\n').filter(l => l.trim().startsWith('|') && l.trim().endsWith('|'));
        if (tblLines.length >= 2) {
          cleanReply += `\n\n${tblLines.join('\n')}`;
        }
      }
      if (!hasValidChart) {
        cleanReply = cleanReply.replace(/```(?:chart|json-chart|chartjs)[\s\S]*?```/gi, '').trim();
        const chartMatch = detFallback.match(/```chart[\s\S]*?```/i);
        if (chartMatch) {
          cleanReply += `\n\n${chartMatch[0]}`;
        }
      }
    }
  }
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
  const { question, history, mode, preview } = req.body || {};
  const usePreview = Boolean((preview === true || preview === '1' || req.query.preview === '1') && isCallerBridgeAdmin(req));
  const state = usePreview
    ? ((await ensureClientDraftStateLoaded(clientId)) || (await ensureClientStateLoaded(clientId)))
    : (await ensureClientStateLoaded(clientId));
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
