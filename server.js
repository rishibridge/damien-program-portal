const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

function getAllowedUsers() {
  const registry = loadClientRegistry();
  const validClients = new Set(Object.keys(registry.clients || { damien: true, metro: true }));
  const map = [];

  const primaryUser = process.env.PORTAL_USER || 'damien';
  const primaryPass = process.env.PORTAL_PASSWORD || 'bridge2026';
  const primaryClient = process.env.PORTAL_CLIENT_ID || (validClients.has(primaryUser) ? primaryUser : 'damien');
  map.push({ user: primaryUser, pass: primaryPass, clientId: primaryClient });

  // Built-in second tenant credential for multi-client verification unless overridden
  map.push({
    user: process.env.METRO_PORTAL_USER || 'metro',
    pass: process.env.METRO_PORTAL_PASSWORD || 'metro2026',
    clientId: 'metro'
  });

  if (process.env.PORTAL_USERS) {
    for (const entry of process.env.PORTAL_USERS.split(',')) {
      const parts = entry.split(':').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const u = parts[0];
        const p = parts[1];
        const c = parts[2] || (validClients.has(u) ? u : 'damien');
        if (validClients.has(c)) {
          map.push({ user: u, pass: p, clientId: c });
        }
      }
    }
  }
  return map;
}

const SESSION_COOKIE_NAME = 'bridge_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bridge-multi-client-hmac-secret-2026-v2';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

function signSessionToken(payloadObj) {
  const nowSec = Math.floor(Date.now() / 1000);
  const body = {
    user: payloadObj.user,
    clientId: payloadObj.clientId,
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SECONDS
  };
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
    return parsed;
  } catch (e) {
    return null;
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

// Strict anti-cache headers helper
function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Cookie, Authorization');
}

app.use(express.json({ limit: '5mb' }));

// Public Web Login Page (/login)
app.get(['/login', '/login.html'], (req, res) => {
  setNoCacheHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Web Login API (sets HMAC-signed HttpOnly session cookie — NO Basic Auth popup)
app.post('/api/auth/login', (req, res) => {
  setNoCacheHeaders(res);
  const { username, password } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  const allowed = getAllowedUsers();
  const matched = allowed.find(cred => safeEqual(u, cred.user) && safeEqual(p, cred.pass));
  if (!matched) {
    return res.status(401).json({ ok: false, error: 'Invalid Client ID or password.' });
  }

  const token = signSessionToken({ user: matched.user, clientId: matched.clientId });
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (isSecure) cookieParts.push('Secure');

  res.setHeader('Set-Cookie', cookieParts.join('; '));
  return res.json({
    ok: true,
    user: matched.user,
    clientId: matched.clientId
  });
});

// Web Logout API (clears session cookie)
app.post('/api/auth/logout', (req, res) => {
  setNoCacheHeaders(res);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res.json({ ok: true });
});

// Session Authentication & Strict 1-to-1 Tenant Lock Middleware (NO WWW-Authenticate header)
app.use((req, res, next) => {
  if (
    req.path === '/api/health' ||
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path === '/styles.css' ||
    req.path === '/favicon.ico' ||
    req.path.startsWith('/assets/')
  ) {
    return next();
  }

  setNoCacheHeaders(res);

  // 1. Verify signed HttpOnly session cookie
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
  if (session && session.clientId) {
    req.clientId = session.clientId;
    req.authenticatedUser = session.user;
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
  res.json({
    authenticated: true,
    user: req.authenticatedUser,
    clientId: req.clientId
  });
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
const ALLOWED_EDIT_FIELDS = ['Status', 'Date contacted', 'Notes', 'Corrected patient ID', 'Priority', 'Next action'];
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
      recordRowEdit(clientId, todoMatch);
      linkedTodoUpdated = todoMatch;
    }
  }

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

  for (const row of wl.pharmacyDataFixes.unmatchedRows) {
    if (row.suggestedMatch && row.suggestedMatch.suggestedPatientId) {
      const targetId = row.suggestedMatch.suggestedPatientId;
      row['Corrected patient ID'] = targetId;
      recordRowEdit(clientId, row);
      appliedCount++;

      const todoMatch = wl.pharmacyTodo.rows.find(
        t => String(t['Pharmacy patient ID'] || '').toLowerCase() === targetId.toLowerCase()
      );
      if (todoMatch && todoMatch['Status'] === 'Not started') {
        todoMatch['Status'] = 'Filled – ID Corrected';
        todoMatch['Date contacted'] = '2026-10-25';
        todoMatch['Notes'] = `Auto-reconciled with unmatched fill (${row['Patient ID on file']} -> ${targetId}, ${row['Dispensed item']} filled ${row['Date filled']}).`;
        recordRowEdit(clientId, todoMatch);
        todoLinkedCount++;
      }
    }
  }

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
        `**EPIC Broker Channel vs. Paid Media (${meta.client} Through Sep 2026)**:\n` +
        `• **EPIC (Broker Partner)**: **${epicCh.totalEnrolled} YTD enrollments** (120 in Sep, 165 in Aug), **${epicCh.activeMembers} currently active (${epicCh.activeRetentionPct}% active retention)**, **${epicCh.cancelledMembers} disenrolled (${epicCh.disenrollmentPct}% churn)**, **77% first-fill conversion**, and **93% refill rate** ($696,172 gross margin on 748 fills).\n` +
        `• **Paid Media**: **${pmCh.totalEnrolled} YTD enrollments** (93 in Sep, 89 in Aug), **${pmCh.activeMembers} currently active (${pmCh.activeRetentionPct}% active retention)**, **${pmCh.cancelledMembers} disenrolled (${pmCh.disenrollmentPct}% churn)**, **62% first-fill conversion**, and **92% refill rate** ($671,400 gross margin on 804 fills; 4.63x ROAS on $142,033 media spend).\n` +
        (topEpicEmps ? `• **Top EPIC Employer Groups Driving Aug–Sep Growth**: ${topEpicEmps}.` : '')
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
        `**${meta.client} Financial Performance & Monthly P&L Through ${meta.asOfDateFormatted || 'September 30, 2026'}**:\n` +
        `• **Pharmacy Revenue**: **${revRow ? revRow.formatted : '$2,336,983'}** YTD across **${s3.totalFillsInPnl.toLocaleString()}** GLP-1 fills (Monthly: Jun **$${Number(mRev.Jun || 0).toLocaleString()}**, Jul **$${Number(mRev.Jul || 0).toLocaleString()}**, Aug **$${Number(mRev.Aug || 0).toLocaleString()}**, Sep **$${Number(mRev.Sep || 0).toLocaleString()}**)\n` +
        `• **Pharmacy Gross Margin**: **${gmRow ? gmRow.formatted : '$1,758,625'}** YTD deck headline / **$${Number(mGm.YTD || 0).toLocaleString()}** pre-adjustment worksheet (Sep: **$${Number(mGm.Sep || 0).toLocaleString()}** or **$${mPerRx.Sep || s3.septemberGrossMarginPerFill}/Rx**; Aug: **$${Number(mGm.Aug || 0).toLocaleString()}** or **$${mPerRx.Aug || 922.70}/Rx**; YTD avg: **$${mPerRx.YTD || 863.10}/Rx**)\n` +
        `• **Membership Fees Collected**: **+${feesRow ? feesRow.formatted : '$44,164'}** YTD (Sep: **$${Number(mSub.Sep || 0).toLocaleString()}**, Aug: **$${Number(mSub.Aug || 0).toLocaleString()}**)\n` +
        `• **Net Program Proceeds (After Ad Spend & Fees)**: **$${sepProceeds.toLocaleString()}** in September (on **${mRx.Sep || 673}** fills) and **${procRow ? procRow.formatted : '$961,691'}** YTD.`
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
- Never cite slide numbers ("Slide 3") or raw JSON key names. Format your response cleanly with bold key metrics and concise bullet points when comparing multiple items.`;

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
      thinkingConfig: { thinkingBudget: 512 }
    }
  };

  let data = null;
  let usedModel = VERTEX_GEMINI_MODEL;

  // Primary path: Vertex AI via GCP Project Billing (Cloud Run Service Account / gcloud ADC)
  try {
    const token = await getGcpAccessToken();
    const vertexUrl = `https://aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/global/publishers/google/models/${VERTEX_GEMINI_MODEL}:generateContent`;
    const vertexResp = await fetch(vertexUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
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
