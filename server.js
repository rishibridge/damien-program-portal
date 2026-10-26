const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
    if (k && !process.env[k]) process.env[k] = v;
  }
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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

// Strict anti-cache headers helper
function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization');
}

// HTTP Basic Authentication & Strict 1-to-1 Tenant Lock Middleware
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();

  setNoCacheHeaders(res);

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const base64Credentials = authHeader.slice(6).trim();
    const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    if (sepIdx !== -1) {
      const username = decoded.slice(0, sepIdx);
      const password = decoded.slice(sepIdx + 1);
      const allowed = getAllowedUsers();
      const matched = allowed.find(cred => safeEqual(username, cred.user) && safeEqual(password, cred.pass));
      if (matched) {
        // Strictly lock req.clientId from credential mapping only (ignore any query/header/body clientId)
        req.clientId = matched.clientId;
        req.authenticatedUser = matched.user;
        return next();
      }
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Bridge Health Program Analytics", charset="UTF-8"');
  return res.status(401).send('Authentication required');
});

app.use(express.json({ limit: '5mb' }));
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

async function getGcpAccessToken() {
  const resp = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!resp.ok) {
    throw new Error(`Metadata token HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.access_token;
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
    geminiConfigured: Boolean(getGeminiApiKey()),
    geminiModel: GEMINI_MODEL
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
// TENANT-ISOLATED NATURAL-LANGUAGE ANALYTICS & WORKLIST Q&A ENGINE (/api/ask)
// ============================================================================
function countByField(rows, field) {
  const counts = {};
  for (const r of rows) {
    const val = r[field] !== null && r[field] !== undefined && r[field] !== '' ? String(r[field]) : 'Unlisted / None';
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

function answerQuestion(state, rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ql = q.toLowerCase();
  const wl = state.worklists;
  const meta = state.meta || {};
  const summary = computeWorklistSummary(wl);

  const allTodo = wl.pharmacyTodo.rows;
  const allRefill = wl.refillFollowup.rows;
  const allNoId = wl.pharmacyDataFixes.noIdRows;
  const allUnmatched = wl.pharmacyDataFixes.unmatchedRows;
  const allEnded = wl.endedNeverFilled.rows;
  const totalWlRecords = allTodo.length + allRefill.length + allNoId.length + allUnmatched.length + allEnded.length;

  const tokens = ql.split(/[\s,?;:!()'"]+/).filter(t => t.length >= 4);
  const stopWords = new Set([
    'what', 'where', 'when', 'which', 'who', 'whom', 'whose', 'why', 'how', 'many', 'much',
    'show', 'tell', 'give', 'list', 'find', 'search', 'about', 'from', 'with', 'without',
    'have', 'does', 'were', 'been', 'this', 'that', 'these', 'those', 'their', 'there',
    'program', 'damien', 'metro', 'bridge', 'health', 'alpha', 'member', 'members', 'patient', 'patients',
    'fill', 'fills', 'first', 'refill', 'refills', 'month', 'months', 'september', 'august',
    'july', 'june', 'total', 'proceeds', 'revenue', 'margin', 'spend', 'media', 'paid',
    'epic', 'broker', 'partners', 'source', 'sources', 'wegovy', 'ozempic', 'pill', 'pen',
    'worklist', 'todo', 'to-do', 'urgent', 'cancellation', 'pending', 'cancelled', 'status',
    'fixes', 'unmatched', 'alternate', 'ended', 'never', 'filled', 'funnel', 'provider',
    'visit', 'prescribed', 'retention', 'cohort', 'staying', 'long', 'employer', 'group',
    'groups', 'prescriber', 'prescribers', 'payer', 'payers', 'cost', 'fees', 'commission',
    'commissions', 'gross', 'return', 'roas', 'started', 'therapy', 'step', 'steps', 'time',
    'median', 'between', 'rate', 'rates', 'share', 'table', 'chart', 'data', 'notes', 'appendix'
  ]);

  // 1. Direct patient ID match across all sheets
  for (const tok of tokens) {
    if (stopWords.has(tok)) continue;
    const isIdCandidate = (/[0-9]/.test(tok) && /^[0-9a-z-]{6,}$/.test(tok)) || tok === 'trinidad';
    if (!isIdCandidate) continue;
    const matchedTodo = allTodo.filter(r =>
      String(r['Pharmacy patient ID'] || '').toLowerCase().includes(tok) ||
      String(r['Alpha member ID'] || '').toLowerCase().includes(tok)
    );
    const matchedRefill = allRefill.filter(r =>
      String(r['Pharmacy patient ID'] || '').toLowerCase().includes(tok) ||
      String(r['Alpha member ID'] || '').toLowerCase().includes(tok)
    );
    const matchedUnmatched = allUnmatched.filter(r =>
      String(r['Patient ID on file'] || '').toLowerCase().includes(tok) ||
      (r.suggestedMatch && String(r.suggestedMatch.suggestedPatientId).toLowerCase().includes(tok))
    );
    const matchedEnded = allEnded.filter(r =>
      String(r['Pharmacy patient ID'] || '').toLowerCase().includes(tok) ||
      String(r['Alpha member ID'] || '').toLowerCase().includes(tok)
    );

    const totalHits = matchedTodo.length + matchedRefill.length + matchedUnmatched.length + matchedEnded.length;
    if (totalHits > 0 && totalHits <= 15) {
      return {
        question: q,
        answer: `I searched all ${totalWlRecords} operational records for **${meta.client}** across **Pharmacy To-Do**, **Refill Follow-Up**, **Pharmacy Data Fixes**, and **Ended – Never Filled** for \`${tok}\` and found **${totalHits} matching record(s)**.`
      };
    }
  }

  // 2. Fuzzy ID / Unmatched Patient ID / Data Fixes
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

  // 3. Employer group questions
  if (ql.includes('employer') || ql.includes('evansville') || ql.includes('warrick') || ql.includes('hamilton') || ql.includes('harsha') || ql.includes('company') || ql.includes('companies')) {
    const groupCountsTodo = countByField(allTodo, 'Employer group');
    const topGroups = Object.entries(groupCountsTodo)
      .filter(([g]) => g !== 'Unlisted / None')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([g, c]) => `**${g}** (${c} active To-Do)`)
      .join(', ');
    return {
      question: q,
      answer: `Across **${meta.client}**'s **Pharmacy To-Do** (${summary.todoTotal} active unfilled patients) and **Ended – Never Filled** (${summary.endedTotal} members) queues, the top employer groups are ${topGroups || 'individual enrollees'}.`
    };
  }

  // 4. Financials / P&L / Proceeds / Revenue
  if (ql.includes('financial') || ql.includes('proceeds') || ql.includes('p&l') || ql.includes('pnl') || ql.includes('revenue') || ql.includes('profit') || ql.includes('fee') || ql.includes('commission') || ql.includes('962k') || ql.includes('371k') || ql.includes('911') || ql.includes('cost to fill')) {
    const s3 = state.slide3_financials;
    const revRow = s3.ytdTable.find(r => r.item === 'Pharmacy revenue');
    const feesRow = s3.ytdTable.find(r => r.item === 'Membership fees collected');
    const procRow = s3.ytdTable.find(r => r.item === 'Program proceeds');
    const sepProceeds = s3.monthlyProceeds.values[s3.monthlyProceeds.values.length - 1];
    return {
      question: q,
      answer:
        `**${meta.client} Revenue & Net Proceeds Through ${meta.asOfDateFormatted || 'September 30, 2026'}**:\n` +
        `• **Pharmacy revenue (YTD)**: **${revRow ? revRow.formatted : '$2,336,983'}** (across ${s3.totalFillsInPnl.toLocaleString()} completed GLP-1 fills)\n` +
        `• **Membership fees collected (YTD)**: **+${feesRow ? feesRow.formatted : '$44,164'}**\n` +
        `• **Net Program Proceeds (September)**: **$${sepProceeds.toLocaleString()}** (after ad spend; monthly top-line pharmacy revenue is not broken out separately by month)\n` +
        `• **Net Program Proceeds (YTD)**: **${procRow ? procRow.formatted : '$961,691'}** net of platform fees, media spend, broker commissions, and $${s3.costPerFill}/fill dispensing cost.`
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

function buildGeminiDataContext(state, question) {
  const wl = state.worklists;
  const todoRows = wl.pharmacyTodo.rows;
  const refillRows = wl.refillFollowup.rows;
  const noIdRows = wl.pharmacyDataFixes.noIdRows;
  const unmatchedRows = wl.pharmacyDataFixes.unmatchedRows;
  const endedRows = wl.endedNeverFilled.rows;

  const ql = String(question || '').toLowerCase();
  const stop = new Set([
    'what', 'where', 'when', 'which', 'who', 'whom', 'whose', 'why', 'how', 'many', 'much',
    'show', 'tell', 'give', 'list', 'find', 'search', 'about', 'from', 'with', 'without',
    'have', 'does', 'were', 'been', 'this', 'that', 'these', 'those', 'their', 'there',
    'program', 'damien', 'metro', 'bridge', 'health', 'alpha', 'member', 'members', 'patient', 'patients',
    'fill', 'fills', 'first', 'refill', 'refills', 'month', 'months', 'september', 'total',
    'worklist', 'todo', 'to-do', 'status', 'stage', 'source', 'sources', 'prescribed', 'filled',
    'between', 'the', 'and', 'for', 'are', 'was', 'not', 'all', 'any', 'can', 'you', 'our'
  ]);
  const kwTokens = ql.split(/[\s,?;:!()'"]+/).filter(t => t.length >= 3 && !stop.has(t));

  const matchedRecords = [];
  if (kwTokens.length > 0) {
    const scanSheet = (sheetName, rows) => {
      for (const r of rows) {
        const hay = JSON.stringify(r).toLowerCase();
        if (kwTokens.some(tok => hay.includes(tok))) {
          matchedRecords.push({ queue: sheetName, record: r });
          if (matchedRecords.length >= 35) break;
        }
      }
    };
    scanSheet('Pharmacy To-Do', todoRows);
    if (matchedRecords.length < 35) scanSheet('Refill Follow-Up', refillRows);
    if (matchedRecords.length < 35) scanSheet('Pharmacy Data Fixes (Unmatched ID)', unmatchedRows);
    if (matchedRecords.length < 35) scanSheet('Pharmacy Data Fixes (No ID)', noIdRows);
    if (matchedRecords.length < 35) scanSheet('Ended – Never Filled', endedRows);
  }

  return {
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
        byStatus: countByField(todoRows, 'Status'),
        urgentCancellationPendingPatients: todoRows
          .filter(r => String(r['Priority'] || '').startsWith('1'))
          .map(r => ({
            patientId: r['Pharmacy patient ID'],
            alphaMemberId: r['Alpha member ID'],
            priority: r['Priority'],
            finding: r['Pharmacy finding'],
            medication: r['Rx medication'],
            daysSinceSignup: r['Days since sign-up'],
            daysInStage: r['Days in this stage'],
            source: r['Patient source'],
            employerGroup: r['Employer group'],
            cancellationRequested: r['Cancellation requested'],
            pharmacyNote: r['Pharmacy note'],
            status: r['Status']
          })),
        readyWaitingForPickupPatients: todoRows
          .filter(r => r['Pharmacy finding'] === 'Ready – waiting for pickup')
          .map(r => ({
            patientId: r['Pharmacy patient ID'],
            medication: r['Rx medication'],
            source: r['Patient source'],
            employerGroup: r['Employer group'],
            transactionDate: r['Transaction date']
          }))
      },
      refillFollowup_OverduePatients: {
        totalCount: refillRows.length,
        byMembershipStatus: countByField(refillRows, 'Membership status'),
        byPatientSource: countByField(refillRows, 'Patient source'),
        byLastItemFilled: countByField(refillRows, 'Last item filled'),
        byFillsToDate: countByField(refillRows, 'GLP-1 fills to date'),
        allRecords: refillRows.map(r => ({
          patientId: r['Pharmacy patient ID'],
          membershipStatus: r['Membership status'],
          fillsToDate: r['GLP-1 fills to date'],
          lastFill: r['Last fill'],
          daysSinceLastFill: r['Days since last fill'],
          lastItemFilled: r['Last item filled'],
          source: r['Patient source'],
          cancellationRequested: r['Cancellation requested']
        }))
      },
      pharmacyDataFixes_UnlinkedFills: {
        noIdCount: noIdRows.length,
        unmatchedCount: unmatchedRows.length,
        noIdByPrescriber: countByField(noIdRows, 'Prescriber'),
        noIdByPayer: countByField(noIdRows, 'Payer'),
        noIdByDispensedItem: countByField(noIdRows, 'Dispensed item'),
        unmatchedByPrescriber: countByField(unmatchedRows, 'Prescriber'),
        combinedByPrescriber: countByField([...noIdRows, ...unmatchedRows], 'Prescriber'),
        allUnmatchedRecordsWithFuzzySuggestions: unmatchedRows.map(r => ({
          patientIdOnFile: r['Patient ID on file'],
          dateFilled: r['Date filled'],
          dispensedItem: r['Dispensed item'],
          prescriber: r['Prescriber'],
          status: r['Transaction status'],
          correctedPatientId: r['Corrected patient ID'],
          suggestedFuzzyMatchInTodo: r.suggestedMatch
        }))
      },
      endedNeverFilled_ChurnedMembers: {
        totalCount: endedRows.length,
        byStage: countByField(endedRows, 'Stage'),
        byPharmacyFinding: countByField(endedRows, 'Pharmacy finding'),
        byPatientSource: countByField(endedRows, 'Patient source'),
        byEmployerGroup: countByField(endedRows, 'Employer group')
      }
    },
    matchingRecordsForQuery: matchedRecords
  };
}

async function askGeminiWithFullData(state, question, history = []) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('No GEMINI_API_KEY / GOOGLE_API_KEY configured');
  }

  const contextData = buildGeminiDataContext(state, question);
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

  const systemInstruction = `You are a knowledgeable, warm, and direct healthcare analytics colleague at Bridge Health Hub supporting the ${meta.programTitle || 'GLP-1 Weight Loss Program'} for ${meta.client || 'our client'} and ${meta.pharmacyPartner || 'the pharmacy'} (data through ${meta.asOfDateFormatted || 'September 30, 2026'}).

You are having a natural, human-like back-and-forth conversation with a teammate. Nothing more, nothing less.

HOW TO SPEAK:
- Write like a real, thoughtful human colleague in a chat conversation — natural, clear, conversational, and direct.
- Do NOT output rigid report headers, category labels, source citations, slide numbers (never say "Slide 3", "Slide 9", etc.), file extensions (.pptx, .xlsx), or robotic meta-descriptions of your dataset size.
- Match the length and tone to what the person actually asked:
  - If they greet you or ask a quick conversational question, reply naturally in a couple of sentences.
  - If they ask a specific question about program financials, partner channels, paid media ROI, the conversion funnel, refills, medication mix, or specific patients/employers/prescribers on the worklist, give a clear, accurate, conversational answer grounded in the exact numbers and patient IDs from ${meta.client}'s data.
- You have full access to both ${meta.client}'s program performance analytics (${activeSep} active members in Sep, ${fillsSep} Sep fills, $${sepProceedsVal.toLocaleString()} Sep net program proceeds, ${ytdProceedsFmt} YTD net program proceeds, ${ytdRevFmt} YTD pharmacy revenue across ${s3.totalFillsInPnl?.toLocaleString() || '2,034'} fills, ${ytdFeesFmt} YTD membership fees collected) and all operational worklist records for ${meta.pharmacyPartner} (${ws.todoTotal} Pharmacy To-Do, ${ws.refillTotal} Refill Follow-Up, ${ws.fixesTotal} Pharmacy Data Fixes [${ws.fixesNoIdTotal} missing an ID and ${ws.fixesUnmatchedTotal} unmatched-ID fills, of which ${ws.fuzzySuggestedCount} fills have a possible 1-2 character typo match to ${ws.todoWithFuzzyCount} active To-Do patients to verify], and ${ws.endedTotal} Ended – Never Filled).
- When discussing financials, always cite the exact source figures for top-line Pharmacy Revenue (${ytdRevFmt} YTD across ${s3.totalFillsInPnl?.toLocaleString() || '2,034'} fills), Membership Fees Collected (${ytdFeesFmt} YTD), and Net Program Proceeds ($${sepProceedsVal.toLocaleString()} in September on ${fillsSep} fills; ${ytdProceedsFmt} YTD) rather than gross margin (and note that top-line pharmacy revenue is reported on a full YTD basis rather than broken out by single month).
- Output plain conversational text (you may use simple bolding for key numbers or short bullet points only when listing multiple items, just like a human would in Slack or Teams).`;

  const conversationTurns = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-10)) {
      if (h && h.question && h.answer) {
        conversationTurns.push({ role: 'user', parts: [{ text: String(h.question) }] });
        conversationTurns.push({ role: 'model', parts: [{ text: String(h.answer) }] });
      }
    }
  }

  const userPrompt = `[Reference Data Context for ${meta.client}: ${JSON.stringify(contextData)}]\n\nUser message: ${question}`;
  conversationTurns.push({ role: 'user', parts: [{ text: userPrompt }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: conversationTurns,
    generationConfig: {
      temperature: 0.3,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Empty response from Gemini API');
  }

  const cleanReply = rawText.trim();
  return {
    question,
    clientId: meta.clientId,
    aiPowered: true,
    aiModel: GEMINI_MODEL,
    reply: cleanReply,
    answer: cleanReply
  };
}

app.post('/api/ask', async (req, res) => {
  const clientId = req.clientId || 'damien';
  const state = await ensureClientStateLoaded(clientId);
  const { question, history, mode } = req.body || {};
  const q = String(question || '').trim() || 'How is the program performing through September 2026?';

  if (getGeminiApiKey() && mode !== 'instant') {
    try {
      const geminiResult = await askGeminiWithFullData(state, q, history);
      return res.json(geminiResult);
    } catch (err) {
      console.error('Gemini API error, falling back to deterministic engine:', err.message);
    }
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
  console.log(`Bridge Multi-Client GLP-1 Program Portal running on http://localhost:${PORT} (Gemini: ${Boolean(getGeminiApiKey())}, GCS Bucket: ${GCS_STATE_BUCKET || 'local-fallback'})`);
});
