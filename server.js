const express = require('express');
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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BASELINE_DATA_PATH = path.join(__dirname, 'data', 'portal_data.json');
const STATE_DATA_PATH = path.join(__dirname, 'data', 'runtime_state.json');

function loadBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_DATA_PATH, 'utf8'));
}

let portalState = null;

function initPortalState() {
  if (fs.existsSync(STATE_DATA_PATH)) {
    try {
      portalState = JSON.parse(fs.readFileSync(STATE_DATA_PATH, 'utf8'));
      return;
    } catch (e) {
      console.error('Could not parse runtime_state.json, reloading baseline:', e);
    }
  }
  portalState = loadBaseline();
}

function saveRuntimeState() {
  try {
    fs.writeFileSync(STATE_DATA_PATH, JSON.stringify(portalState, null, 2), 'utf8');
  } catch (e) {
    console.warn('Warning: could not persist runtime_state.json (read-only fs?):', e.message);
  }
}

initPortalState();

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

  return {
    todoTotal: todoRows.length,
    todoUrgent,
    todoHigh,
    todoMonitor,
    todoCompleted,
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

// Health check
app.get('/api/health', (req, res) => {
  const summary = computeWorklistSummary(portalState.worklists);
  res.json({
    status: 'ok',
    service: 'damien-program-portal',
    preparedBy: 'Bridge Health Hub',
    asOfDate: '2026-09-30',
    geminiConfigured: Boolean(getGeminiApiKey()),
    geminiModel: GEMINI_MODEL,
    worklistSummary: summary
  });
});

// Full portal data
app.get('/api/portal-data', (req, res) => {
  const summary = computeWorklistSummary(portalState.worklists);
  res.json({
    ...portalState,
    worklistSummary: summary
  });
});

// Update individual worklist row
app.patch('/api/worklist/:sheet/:id', (req, res) => {
  const { sheet, id } = req.params;
  const updates = req.body || {};
  const wl = portalState.worklists;

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

  const allowedFields = ['Status', 'Date contacted', 'Notes', 'Corrected patient ID', 'Priority', 'Next action'];
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      row[key] = updates[key];
    }
  }

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
      linkedTodoUpdated = todoMatch;
    }
  }

  saveRuntimeState();
  res.json({
    ok: true,
    row,
    linkedTodoUpdated,
    worklistSummary: computeWorklistSummary(wl)
  });
});

// Apply all 21 fuzzy ID fixes in one click
app.post('/api/worklist/apply-fuzzy-fixes', (req, res) => {
  const wl = portalState.worklists;
  let appliedCount = 0;
  let todoLinkedCount = 0;

  for (const row of wl.pharmacyDataFixes.unmatchedRows) {
    if (row.suggestedMatch && row.suggestedMatch.suggestedPatientId) {
      const targetId = row.suggestedMatch.suggestedPatientId;
      row['Corrected patient ID'] = targetId;
      appliedCount++;

      const todoMatch = wl.pharmacyTodo.rows.find(
        t => String(t['Pharmacy patient ID'] || '').toLowerCase() === targetId.toLowerCase()
      );
      if (todoMatch && todoMatch['Status'] === 'Not started') {
        todoMatch['Status'] = 'Filled – ID Corrected';
        todoMatch['Date contacted'] = '2026-10-25';
        todoMatch['Notes'] = `Auto-reconciled with unmatched fill (${row['Patient ID on file']} -> ${targetId}, ${row['Dispensed item']} filled ${row['Date filled']}).`;
        todoLinkedCount++;
      }
    }
  }

  saveRuntimeState();
  res.json({
    ok: true,
    appliedCount,
    todoLinkedCount,
    worklistSummary: computeWorklistSummary(wl)
  });
});

// Reset runtime edits back to baseline
app.post('/api/worklist/reset', (req, res) => {
  portalState = loadBaseline();
  if (fs.existsSync(STATE_DATA_PATH)) {
    try { fs.unlinkSync(STATE_DATA_PATH); } catch (e) {}
  }
  res.json({
    ok: true,
    worklistSummary: computeWorklistSummary(portalState.worklists)
  });
});

// CSV Export for any worklist sheet
app.get('/api/worklist/export/:sheet', (req, res) => {
  const { sheet } = req.params;
  const wl = portalState.worklists;
  let headers = [];
  let rows = [];
  let filename = `Damien_Worklist_${sheet}_Sep2026.csv`;

  if (sheet === 'todo') {
    headers = wl.pharmacyTodo.headers;
    rows = wl.pharmacyTodo.rows;
    filename = 'Damien_Pharmacy_To_Do_Sep2026.csv';
  } else if (sheet === 'refill') {
    headers = wl.refillFollowup.headers;
    rows = wl.refillFollowup.rows;
    filename = 'Damien_Refill_Follow_Up_Sep2026.csv';
  } else if (sheet === 'fixes-noid') {
    headers = wl.pharmacyDataFixes.noIdHeaders;
    rows = wl.pharmacyDataFixes.noIdRows;
    filename = 'Damien_Pharmacy_Data_Fixes_NoID_Sep2026.csv';
  } else if (sheet === 'fixes-unmatched') {
    headers = [...wl.pharmacyDataFixes.unmatchedHeaders, 'Suggested Match ID'];
    rows = wl.pharmacyDataFixes.unmatchedRows.map(r => ({
      ...r,
      'Suggested Match ID': r.suggestedMatch ? r.suggestedMatch.suggestedPatientId : ''
    }));
    filename = 'Damien_Pharmacy_Data_Fixes_Unmatched_Sep2026.csv';
  } else if (sheet === 'ended') {
    headers = wl.endedNeverFilled.headers;
    rows = wl.endedNeverFilled.rows;
    filename = 'Damien_Ended_Never_Filled_Sep2026.csv';
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
// NATURAL-LANGUAGE ANALYTICS & WORKLIST Q&A ENGINE (/api/ask)
// ============================================================================
function answerQuestion(rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ql = q.toLowerCase();
  const wl = portalState.worklists;
  const summary = computeWorklistSummary(wl);

  // 1. Check if the user is asking about a specific Patient ID, Alpha Member ID, Employer Group, or Prescriber
  const allTodo = wl.pharmacyTodo.rows;
  const allRefill = wl.refillFollowup.rows;
  const allNoId = wl.pharmacyDataFixes.noIdRows;
  const allUnmatched = wl.pharmacyDataFixes.unmatchedRows;
  const allEnded = wl.endedNeverFilled.rows;

  // Check for specific 6-8 char patient ID or UUID token in the question
  const tokens = ql.split(/[\s,?;:!()'"]+/).filter(t => t.length >= 4);
  const stopWords = new Set([
    'what', 'where', 'when', 'which', 'who', 'whom', 'whose', 'why', 'how', 'many', 'much',
    'show', 'tell', 'give', 'list', 'find', 'search', 'about', 'from', 'with', 'without',
    'have', 'does', 'were', 'been', 'this', 'that', 'these', 'those', 'their', 'there',
    'program', 'damien', 'bridge', 'health', 'alpha', 'member', 'members', 'patient', 'patients',
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

  // Direct patient ID match across all sheets (only for hex/UUID tokens or known non-hex ID 'trinidad')
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
      const rowsOut = [];
      matchedTodo.forEach(r => rowsOut.push([
        'Pharmacy To-Do', r['Pharmacy patient ID'], r['Priority'], r['Pharmacy finding'],
        r['Rx medication'] || '—', r['Patient source'] || '—', r['Employer group'] || '—', r['Status']
      ]));
      matchedRefill.forEach(r => rowsOut.push([
        'Refill Follow-Up', r['Pharmacy patient ID'], r['Membership status'], `${r['Days since last fill']}d since fill`,
        r['Last item filled'] || '—', r['Patient source'] || '—', `${r['GLP-1 fills to date']} fills`, r['Status']
      ]));
      matchedUnmatched.forEach(r => rowsOut.push([
        'Pharmacy Data Fixes', r['Patient ID on file'], 'Unmatched ID',
        r.suggestedMatch ? `Suggested: ${r.suggestedMatch.suggestedPatientId}` : 'No match',
        r['Dispensed item'] || '—', r['Prescriber'] || '—', r['Date filled'] || '—', r['Corrected patient ID'] || 'Pending'
      ]));
      matchedEnded.forEach(r => rowsOut.push([
        'Ended – Never Filled', r['Pharmacy patient ID'], r['Stage'], r['Pharmacy finding'] || '—',
        '—', r['Patient source'] || '—', r['Employer group'] || '—', `Ended ${r['Membership ended']}`
      ]));

      return {
        question: q,
        category: 'Patient & Worklist Lookup',
        sourceCitation: 'Pharmacy Operations Worklist (All 4 Queues)',
        targetView: 'worklist',
        headline: `Found ${totalHits} record(s) matching "${tok}" across operational worklists`,
        answer: `I searched all 410 operational records across **Pharmacy To-Do**, **Refill Follow-Up**, **Pharmacy Data Fixes**, and **Ended – Never Filled** for \`${tok}\`. Here are the matching records and their recommended next actions:`,
        kpis: [
          { label: 'Pharmacy To-Do Hits', value: String(matchedTodo.length) },
          { label: 'Refill Follow-Up Hits', value: String(matchedRefill.length) },
          { label: 'Data Fix Hits', value: String(matchedUnmatched.length) },
          { label: 'Ended Member Hits', value: String(matchedEnded.length) }
        ],
        table: {
          headers: ['Queue', 'Patient ID', 'Priority / Stage', 'Finding / Detail', 'Medication', 'Source / Prescriber', 'Group / Date', 'Status'],
          rows: rowsOut
        }
      };
    }
  }

  // 2. Fuzzy ID / Unmatched Patient ID / Data Fixes questions
  if (
    ql.includes('fuzzy') || ql.includes('unmatched') || ql.includes('data fix') ||
    ql.includes('alternate id') || ql.includes('don\'t match') || ql.includes('dont match') ||
    ql.includes('typo') || (ql.includes('link') && ql.includes('fill')) || ql.includes('no patient id')
  ) {
    const fuzzyRows = allUnmatched.filter(r => r.suggestedMatch);
    return {
      question: q,
      category: 'Pharmacy Data Fixes & ID Reconciliation',
      sourceCitation: 'Program Data Notes & Pharmacy Data Fixes Queue (86 records)',
      targetView: 'worklist',
      targetSubtab: 'fixes',
      headline: '86 Unlinked Records in Pharmacy Data Fixes — 21 Fills Have a Possible 1–2 Character Typo Match in Pharmacy To-Do',
      answer:
        `Per **Program Data Definitions**, **1,952 of 2,034 GLP-1 fills (96%)** matched an Alpha member via the 8-character Patient Alternate ID (**51 fills had no patient ID** and **20 IDs did not match**). In the **Pharmacy Data Fixes** worklist, there are **86 unlinked records**:\n` +
        `• **55 rows** have **no Patient Alternate ID** on file (**51** completed GLP-1 fills through Sep 30, plus **2** waiting for pickup, **1** Oct 5 fill, and **1** non-GLP-1 Sertraline dispense).\n` +
        `• **31 fills** (labeled *21 IDs, 31 fills* in the worklist header, across **20 unique IDs** on file) do not exactly match any program member.\n\n` +
        `**Possible Typo Matches to Verify**: Comparing the unmatched IDs against the **Pharmacy To-Do** list (edit distance ≤ 2) surfaces **21 fills across 15 patient IDs** that are possible 1–2 character hex typos of active **Pharmacy To-Do** patients to verify (e.g., \`22d97e56\` → \`22d97e66\`, \`069630f\` → \`0696370f\`, \`cd7dd8d0\` → \`cf7dd8d0\`, \`d95ad4b\` → \`d695ad4b\`).`,
      kpis: [
        { label: 'Matched GLP-1 Fills', value: '1,952 / 2,034 (96%)' },
        { label: 'Fills w/ No Patient ID', value: '55 rows (51 Sep GLP-1)' },
        { label: 'Unmatched ID Fills', value: '31 fills (20 unique IDs)' },
        { label: 'Possible Typo Matches', value: `${fuzzyRows.length} fills (15 pts)` }
      ],
      chart: {
        type: 'bar',
        title: 'Pharmacy Data Fixes Breakdown (86 Records)',
        labels: ['No Patient Alternate ID', 'Unmatched ID (Possible To-Do Match)', 'Unmatched ID (Other/External)'],
        datasets: [{ label: 'Fill Records', data: [55, 21, 10], backgroundColor: ['#154672', '#26ABE4', '#94A3B8'] }]
      },
      table: {
        headers: ['ID on File (Typo)', 'Suggested To-Do Patient ID', 'Edit Dist', 'Date Filled', 'Dispensed Item', 'To-Do Rx Written', 'Prescriber'],
        rows: fuzzyRows.map(r => [
          r['Patient ID on file'],
          r.suggestedMatch.suggestedPatientId,
          String(r.suggestedMatch.editDistance),
          r['Date filled'],
          r['Dispensed item'],
          r.suggestedMatch.rxMedication || '—',
          r['Prescriber']
        ])
      }
    };
  }

  // 3. Employer group questions
  if (ql.includes('employer') || ql.includes('evansville') || ql.includes('warrick') || ql.includes('hamilton') || ql.includes('harsha') || ql.includes('company') || ql.includes('companies')) {
    const groupCountsTodo = {};
    allTodo.forEach(r => {
      const g = r['Employer group'] || 'Unlisted / Individual';
      groupCountsTodo[g] = (groupCountsTodo[g] || 0) + 1;
    });
    const groupCountsEnded = {};
    allEnded.forEach(r => {
      const g = r['Employer group'] || 'Unlisted / Individual';
      groupCountsEnded[g] = (groupCountsEnded[g] || 0) + 1;
    });
    const allGroups = Array.from(new Set([...Object.keys(groupCountsTodo), ...Object.keys(groupCountsEnded)]))
      .filter(g => g !== 'Unlisted / Individual')
      .map(g => ({
        group: g,
        todo: groupCountsTodo[g] || 0,
        ended: groupCountsEnded[g] || 0,
        total: (groupCountsTodo[g] || 0) + (groupCountsEnded[g] || 0)
      }))
      .sort((a, b) => b.total - a.total);

    return {
      question: q,
      category: 'Employer Group Analytics',
      sourceCitation: 'Pharmacy Operations Worklist (Pharmacy To-Do & Ended – Never Filled)',
      targetView: 'worklist',
      targetSubtab: 'todo',
      headline: `Employer Group Breakdown Across Unfilled & Ended Memberships (${allGroups.length} Named Employer Groups)`,
      answer:
        `Across the **Pharmacy To-Do** (101 active unfilled patients, 59 with named employer groups) and **Ended – Never Filled** (186 churned members, 40 with named employer groups) queues, the top employer groups with unfilled prescriptions are **City of Evansville** (${groupCountsTodo['City of Evansville'] || 0} active To-Do, ${groupCountsEnded['City of Evansville'] || 0} ended), **Damien Patient** (${groupCountsTodo['Damien Patient'] || 0} active To-Do, ${groupCountsEnded['Damien Patient'] || 0} ended), **Hamilton Center** (${groupCountsTodo['Hamilton Center'] || 0} active To-Do), and **Harsha Behavioral Health** (${groupCountsTodo['Harsha Behavioral Health'] || 0} active To-Do).`,
      kpis: [
        { label: 'Named Employer Groups', value: String(allGroups.length) },
        { label: 'To-Do w/ Employer Group', value: '59 / 101 pts' },
        { label: 'Top Group (City of Evansville)', value: `${groupCountsTodo['City of Evansville'] || 0} To-Do · ${groupCountsEnded['City of Evansville'] || 0} Ended` },
        { label: 'Damien Patient Group', value: `${groupCountsTodo['Damien Patient'] || 0} To-Do · ${groupCountsEnded['Damien Patient'] || 0} Ended` }
      ],
      chart: {
        type: 'bar',
        title: 'Top 10 Employer Groups by Unfilled To-Do & Ended Memberships',
        labels: allGroups.slice(0, 10).map(g => g.group),
        datasets: [
          { label: 'Active Pharmacy To-Do', data: allGroups.slice(0, 10).map(g => g.todo), backgroundColor: '#26ABE4' },
          { label: 'Ended – Never Filled', data: allGroups.slice(0, 10).map(g => g.ended), backgroundColor: '#154672' }
        ]
      },
      table: {
        headers: ['Employer Group', 'Active Pharmacy To-Do', 'Ended – Never Filled', 'Combined Patients'],
        rows: allGroups.map(g => [g.group, String(g.todo), String(g.ended), String(g.total)])
      }
    };
  }

  // 4. Prescriber questions
  if (ql.includes('prescriber') || ql.includes('doctor') || ql.includes('fields') || ql.includes('pedersen') || ql.includes('staiger') || ql.includes('townsend') || ql.includes('votypka')) {
    const prescCounts = {};
    [...allNoId, ...allUnmatched].forEach(r => {
      const p = r['Prescriber'] || 'Unknown';
      if (!prescCounts[p]) prescCounts[p] = { noId: 0, unmatched: 0, total: 0 };
      if (r.fixType === 'No Patient Alternate ID') prescCounts[p].noId++;
      else prescCounts[p].unmatched++;
      prescCounts[p].total++;
    });
    const sorted = Object.entries(prescCounts).sort((a, b) => b[1].total - a[1].total);
    return {
      question: q,
      category: 'Prescriber Analytics (Pharmacy Data Fixes)',
      sourceCitation: 'Pharmacy Data Fixes Queue (86 unlinked fills)',
      targetView: 'worklist',
      targetSubtab: 'fixes',
      headline: `Unlinked Pharmacy Fills by Prescriber (${sorted.length} Prescribers across 86 Fills)`,
      answer:
        `In **Pharmacy Data Fixes**, the 86 unlinked fills (55 missing a Patient Alternate ID and 31 with an unmatched ID) were written by **${sorted.length} prescribers**, led by **Fields, Taryn** (${prescCounts['Fields, Taryn']?.total || 0} fills), **Staiger, Lydia** (${prescCounts['Staiger, Lydia']?.total || 0} fills), **Pedersen, Martha** (${prescCounts['Pedersen, Martha']?.total || 0} fills), and **Townsend, Fawn** (${prescCounts['Townsend, Fawn']?.total || 0} fills).`,
      kpis: sorted.slice(0, 4).map(([name, c]) => ({ label: name, value: `${c.total} fills (${c.noId} No ID, ${c.unmatched} Unmatched)` })),
      chart: {
        type: 'bar',
        title: 'Unlinked Fills by Prescriber',
        labels: sorted.map(s => s[0]),
        datasets: [
          { label: 'No Patient ID (55)', data: sorted.map(s => s[1].noId), backgroundColor: '#154672' },
          { label: 'Unmatched ID (31)', data: sorted.map(s => s[1].unmatched), backgroundColor: '#26ABE4' }
        ]
      },
      table: {
        headers: ['Prescriber', 'No Patient ID Fills', 'Unmatched ID Fills', 'Total Unlinked Fills'],
        rows: sorted.map(([name, c]) => [name, String(c.noId), String(c.unmatched), String(c.total)])
      }
    };
  }

  // 5. Urgent / Cancellation Pending / Pharmacy To-Do questions
  if (ql.includes('urgent') || ql.includes('cancellation') || ql.includes('todo') || ql.includes('to-do') || ql.includes('action') || (ql.includes('active') && ql.includes('unfilled'))) {
    const urgentRows = allTodo.filter(r => String(r['Priority'] || '').startsWith('1'));
    return {
      question: q,
      category: 'Pharmacy To-Do Operational Worklist',
      sourceCitation: 'Pharmacy To-Do Queue (101 active members)',
      targetView: 'worklist',
      targetSubtab: 'todo',
      headline: '101 Active Patients Waiting for First Fill — 10 Urgent (Cancellation Pending), 83 High Priority, 8 New',
      answer:
        `The **Pharmacy To-Do** worklist contains **101 active members** with an unfilled prescription at Damien Pharmacy through September 30, 2026 (representing **$16,160/mo** in active $160 Alpha membership fees):\n` +
        `• **Priority 1 – Urgent: cancellation pending (10 patients)**: Active members who have already requested cancellation while waiting for their first fill (7 have *"No transaction on file"*, 3 have *"Cancelled – no reason recorded"*).\n` +
        `• **Priority 2 – High (83 patients)**: Active members waiting 7–54 days in stage.\n` +
        `• **Priority 4 – New: monitor (8 patients)**: Recently prescribed members (0–6 days in stage).\n` +
        `• **By Pharmacy Finding**: **89** have *No transaction on file*, **9** have *Cancelled – no reason recorded*, and **3** are *Ready – waiting for pickup*!`,
      kpis: [
        { label: '1 – Urgent (Cancel Pending)', value: '10 patients' },
        { label: '2 – High Priority', value: '83 patients' },
        { label: '4 – New: Monitor', value: '8 patients' },
        { label: 'Ready Waiting for Pickup', value: '3 patients' }
      ],
      chart: {
        type: 'bar',
        title: 'Pharmacy To-Do (101 Active Patients) by Finding & Priority',
        labels: ['No transaction on file (89)', 'Cancelled – no reason (9)', 'Ready for pickup (3)', 'Urgent: Cancel Pending (10)', 'High Priority (83)', 'New: Monitor (8)'],
        datasets: [{ label: 'Patients', data: [89, 9, 3, 10, 83, 8], backgroundColor: ['#154672', '#E97132', '#1BAF7A', '#EF4444', '#26ABE4', '#64748B'] }]
      },
      table: {
        headers: ['Patient ID', 'Priority', 'Pharmacy Finding', 'Medication', 'Days in Stage', 'Source', 'Employer Group', 'Cancel Requested'],
        rows: urgentRows.map(r => [
          r['Pharmacy patient ID'],
          r['Priority'],
          r['Pharmacy finding'],
          r['Rx medication'],
          String(r['Days in this stage']),
          r['Patient source'] || '—',
          r['Employer group'] || '—',
          r['Cancellation requested'] || '—'
        ])
      }
    };
  }

  // 6. Ended – Never Filled / Churn root-cause questions
  if (ql.includes('ended') || ql.includes('never filled') || ql.includes('churn') || ql.includes('win-back') || ql.includes('win back') || ql.includes('ineligible') || ql.includes('medicaid')) {
    return {
      question: q,
      category: 'Ended Memberships – Root-Cause & Win-Back Analysis',
      sourceCitation: 'Ended – Never Filled Queue (186 members)',
      targetView: 'worklist',
      targetSubtab: 'ended',
      headline: '186 Ended Memberships Never Reached a First Fill — 74 No Visit, 62 No Rx, 47 Unfilled at Pharmacy, 3 Outside Pharmacy',
      answer:
        `The **Ended – Never Filled** queue tracks **186 members** whose membership ended without a first fill:\n` +
        `• **No provider visit (74 members / 39.8%)**: Signed up (mostly Paid Media) but never completed an Alpha provider visit.\n` +
        `• **Saw provider, no Rx (62 members / 33.3%)**: Completed a visit but did not receive a GLP-1 prescription.\n` +
        `• **Rx written, not filled (47 members / 25.3%)**: Prescribed to Damien Pharmacy but never completed a fill:\n` +
        `   – **18** were *Ineligible – Medicaid/HIP/Medicare coverage*\n` +
        `   – **14** had *No transaction on file*\n` +
        `   – **10** had *Cancelled – no reason recorded*\n` +
        `   – **5** had *No response – medication returned to stock*\n` +
        `• **Rx sent to outside pharmacy (3 members / 1.6%)**.\n` +
        `• **By Source**: Paid Media (110), EPIC (50), Employee (13), Other (10), LHD (2), McGohan Brabender (1).`,
      kpis: [
        { label: 'No Provider Visit', value: '74 (39.8%)' },
        { label: 'Saw Provider, No Rx', value: '62 (33.3%)' },
        { label: 'Rx Written, Not Filled', value: '47 (25.3%)' },
        { label: 'Medicaid/Medicare Ineligible', value: '18 of 47 Rx' }
      ],
      chart: {
        type: 'bar',
        title: 'Ended – Never Filled (186 Members) by Stage & Pharmacy Finding',
        labels: ['No provider visit', 'Saw provider, no Rx', 'Rx: Medicaid/Medicare Ineligible', 'Rx: No transaction on file', 'Rx: Cancelled no reason', 'Rx: Returned to stock', 'Rx sent outside'],
        datasets: [{ label: 'Ended Members', data: [74, 62, 18, 14, 10, 5, 3], backgroundColor: ['#154672', '#26ABE4', '#EF4444', '#F59E0B', '#8B5CF6', '#EC4899', '#64748B'] }]
      },
      table: {
        headers: ['Stage / Finding', 'Ended Members', 'Share of 186', 'Win-Back / Operational Opportunity'],
        rows: [
          ['No provider visit', '74', '39.8%', 'Automated SMS/email onboarding nudge within 24h of sign-up'],
          ['Saw provider, no Rx', '62', '33.3%', 'Clinical eligibility pre-screening & lab completion follow-up'],
          ['Rx written – Medicaid/HIP/Medicare', '18', '9.7%', 'Upfront government-payer exclusion check at intake'],
          ['Rx written – No transaction on file', '14', '7.5%', 'Reconcile against 86 unlinked fills in Pharmacy Data Fixes'],
          ['Rx written – Cancelled no reason', '10', '5.4%', 'Require cancellation reason code & coverage troubleshooting'],
          ['Rx written – Returned to stock', '5', '2.7%', 'Proactive delivery scheduling outreach'],
          ['Rx sent to outside pharmacy', '3', '1.6%', 'Default pharmacy routing lock to Damien Pharmacy']
        ]
      }
    };
  }

  // 7. Refill Follow-Up worklist OR Refill Persistence / Retention questions
  if (ql.includes('refill') || ql.includes('35+') || ql.includes('overdue') || ql.includes('27 days') || ql.includes('45 days') || ql.includes('persistence') || ql.includes('retention') || ql.includes('staying') || ql.includes('cohort')) {
    const s7 = portalState.slide7_refill;
    return {
      question: q,
      category: 'Refill Persistence, Cohort Retention & Overdue Refill Worklist',
      sourceCitation: 'Refill & Retention Analytics & Refill Follow-Up Queue (37 patients)',
      targetView: 'refill',
      headline: '94% of 1st-Fill Patients Refill (More Than 9 in 10 at Every Step) — 37 Active Patients Currently 35+ Days Overdue',
      answer:
        `**Therapy Persistence**:\n` +
        `• Once patients start therapy, **94% return for Fill 2** (391 eligible patients) and **87.4% are still filling at Fill 3**.\n` +
        `• Step-to-step continuation stays between **85% and 97%** through Fill 8 (counting patients whose prior fill was ≥45 days before Sep 30, 2026; typical gap between fills is **~27 days**).\n` +
        `• Fill counts by number: Fill 1 (**670**), Fill 2 (**494**), Fill 3 (**311**), Fill 4 (**203**), Fill 5 (**118**), Fill 6 (**68**), Fill 7 (**41**), Fill 8 (**24**).\n\n` +
        `**Member Retention by Month**:\n` +
        `• January cohort (20 members) retained **95% at M1**, **70% at M3–M6**, and **65% at M8**; August cohort (276 members) retained **84% at M1**.\n\n` +
        `**Refill Follow-Up Worklist**:\n` +
        `• **37 active members** have gone **36 to 56+ days** since their last fill without a refill (**30 Active**, **7 Active – cancellation pending**; **22 EPIC**, **10 Paid Media**, **4 Other**, **1 Employee**).`,
      kpis: [
        { label: 'Fill 1 → 2 Refill Rate', value: '94% (391 eligible)' },
        { label: 'Still Filling at Fill 3', value: '87.4% (311 pts)' },
        { label: 'Typical Gap Between Fills', value: '~27 days' },
        { label: 'Overdue Refill Worklist', value: '37 active patients' }
      ],
      chart: {
        type: 'bar',
        title: 'Share of Patients Who Started Therapy Still Filling (%)',
        labels: s7.chart.fills,
        datasets: [{ label: '% Still Filling', data: s7.chart.shareStillFilling, backgroundColor: '#26ABE4' }]
      },
      table: {
        headers: ['Refill Step', 'Came Back (%)', 'Eligible Patients (≥45d)', 'Total Patients at Target Fill'],
        rows: s7.stepTable.map((r, i) => [
          r.step,
          r.cameBack,
          `${r.eligiblePts}${r.lowSample ? ' (<30 sample)' : ''}`,
          `${s7.chart.patientCounts[i + 1]} pts`
        ])
      }
    };
  }

  // 8. Financials / P&L / Proceeds / Cost / Fees / Margin questions
  if (ql.includes('financial') || ql.includes('proceeds') || ql.includes('p&l') || ql.includes('pnl') || ql.includes('revenue') || ql.includes('profit') || ql.includes('fee') || ql.includes('commission') || ql.includes('962k') || ql.includes('371k') || ql.includes('911') || ql.includes('cost to fill')) {
    const s3 = portalState.slide3_financials;
    return {
      question: q,
      category: 'Program Financials & YTD P&L',
      sourceCitation: 'Program Financials & P&L',
      targetView: 'financials',
      headline: 'September Net Program Proceeds Reached $371,214 ($371K) — $961,691 ($962K) YTD on $2,336,983 Pharmacy Revenue',
      answer:
        `**Program Revenue & Net Proceeds Through September 30, 2026**:\n` +
        `• **Pharmacy revenue (YTD)**: **$2,336,983** (across 2,034 completed GLP-1 fills)\n` +
        `• **Membership fees collected (YTD)**: **+$44,164**\n` +
        `• **Net Program Proceeds (September)**: **$371,214** ($371K after ad spend, up 44.4% from **$257,058** in August on 673 September fills; monthly top-line pharmacy revenue is not broken out separately by month)\n` +
        `• **Net Program Proceeds (YTD)**: **$961,691** ($962K net after **−$142,033** media ad spend, **−$411,745** Alpha platform fees, **−$195,900** Bridge fees, **−$10,060** broker commissions, and **−$81,360** fill cost at $40/fill).`,
      kpis: [
        { label: 'Program Proceeds (Sep)', value: '$371,214 ($371K)' },
        { label: 'Program Proceeds (YTD)', value: '$961,691 ($962K)' },
        { label: 'Pharmacy Revenue (YTD)', value: '$2,336,983' },
        { label: 'Membership Fees (YTD)', value: '$44,164' }
      ],
      chart: {
        type: 'bar',
        title: 'Monthly Program Proceeds After Ad Spend ($)',
        labels: s3.monthlyProceeds.months,
        datasets: [{ label: 'Program Proceeds ($)', data: s3.monthlyProceeds.values, backgroundColor: '#154672' }]
      },
      table: {
        headers: ['YTD P&L Line Item', 'Amount'],
        rows: s3.ytdTable.map(r => [r.item, r.formatted])
      }
    };
  }

  // 9. Paid Media / ROAS / Ad Spend / Marketing questions
  if (ql.includes('paid media') || ql.includes('media') || ql.includes('roas') || ql.includes('ad spend') || ql.includes('4.63') || ql.includes('463%') || ql.includes('142k') || ql.includes('google') || ql.includes('meta') || ql.includes('paying off')) {
    const s5 = portalState.slide5_paidMedia;
    return {
      question: q,
      category: 'Paid Media ROI & Cohort Performance',
      sourceCitation: 'Paid Media ROI & Cohort Analytics',
      targetView: 'paidmedia',
      headline: 'Every $1 of Media Spend Returned $4.63 of Pharmacy Gross Margin (463% ROAS Across 414 Sign-Ups)',
      answer:
        `**Paid Media Campaign-to-Date Performance (Jan–Sep 2026)**:\n` +
        `• **Total Media Spend**: **$142,033** ($142K from agency Google + Meta reports)\n` +
        `• **Paid Media Sign-Ups**: **414** members (sign-ups with no referral or coupon code) at **$343 spend per sign-up**\n` +
        `• **Started Therapy**: **243** patients at **$584 spend per patient started**\n` +
        `• **Pharmacy Gross Margin**: **$658,361** ($658K) across **786 fills** — a **463% return on spend ($4.63 margin per $1 spent)**.\n` +
        `• Mature spring/summer cohorts have already generated **496% to 687% return on spend** (Apr: 687%, Jun: 531%, May: 496%, Aug: 473%), while September sign-ups (197% ROAS so far) have had time for at most one fill.`,
      kpis: s5.kpis.map(k => ({ label: k.label, value: `${k.value} (${k.subtext})` })),
      chart: {
        type: 'bar',
        title: 'Paid Media Spend vs. Cumulative Pharmacy Gross Margin by Sign-Up Month',
        labels: s5.table.filter(r => !r.isTotal).map(r => r.month),
        datasets: [
          { label: 'Media Spend ($)', data: s5.table.filter(r => !r.isTotal).map(r => r.spend), backgroundColor: '#154672' },
          { label: 'Gross Margin to Date ($)', data: s5.table.filter(r => !r.isTotal).map(r => r.margin), backgroundColor: '#26ABE4' }
        ]
      },
      table: {
        headers: ['Sign-Up Month', 'Media Spend', 'Sign-Ups', 'Spend / Sign-Up', 'Started Therapy', 'Spend / Started', 'Fills to Date', 'Gross Margin', 'Return on Spend'],
        rows: s5.table.map(r => [r.month, r.spendFmt, String(r.signups), r.spendPerSignup, String(r.started), r.spendPerStarted, String(r.fills), r.marginFmt, r.roas || '—'])
      }
    };
  }

  // 10. Patient Acquisition Sources / EPIC / Brokers / LHD / McGohan Brabender
  if (ql.includes('source') || ql.includes('epic') || ql.includes('broker') || ql.includes('lhd') || ql.includes('mcgohan') || ql.includes('employee') || ql.includes('where are patients coming') || ql.includes('62%') || ql.includes('channel')) {
    const s4 = portalState.slide4_sources;
    return {
      question: q,
      category: 'Patient Acquisition & Referral Sources',
      sourceCitation: 'Patient Acquisition & Partner Channels',
      targetView: 'sources',
      headline: 'EPIC and Broker Partners Drove 62% of September Enrollments (170 of 273 Sign-Ups) With 76%–88% First-Fill Rates',
      answer:
        `**Enrollment & Conversion by Patient Source**:\n` +
        `• **EPIC**: **120** enrolled in Sep (**452 YTD**, **44% share**) — **77% filled 1st Rx**, **93% refilled 1st→2nd**, generating **748 GLP-1 fills** and **$696,172 gross margin**.\n` +
        `• **Paid Media**: **93** enrolled in Sep (**417 YTD**, **40% share**) — **62% filled 1st Rx**, **92% refilled**, generating **804 fills** and **$671,400 gross margin**.\n` +
        `• **LHD (new since Aug)**: **43** enrolled in Sep (**54 YTD**, **5% share**) — **76% filled 1st Rx**, **41 fills**, **$39,729 gross margin**.\n` +
        `• **McGohan Brabender (new since Aug)**: **7** enrolled in Sep (**8 YTD**, **1% share**) — **88% filled 1st Rx**, **7 fills**, **$6,228 gross margin**.\n` +
        `• **Employee**: **6** enrolled in Sep (**54 YTD**, **5% share**) — **67% filled 1st Rx**, **97% refilled**, **214 fills**, **$160,234 gross margin**.\n` +
        `• **Other**: **4** enrolled in Sep (**48 YTD**, **5% share**) — **66% filled 1st Rx**, **100% refilled**, **138 fills**, **$107,308 gross margin**.\n` +
        `• Combined broker partners (**EPIC 120 + LHD 43 + McGohan Brabender 7 = 170**) accounted for **62.3% of all 273 September enrollments**!`,
      kpis: [
        { label: 'Broker Partner Share (Sep)', value: '62% (170 / 273)' },
        { label: 'EPIC YTD Margin & Fills', value: '$696,172 (748 fills)' },
        { label: 'Paid Media YTD Margin & Fills', value: '$671,400 (804 fills)' },
        { label: 'Highest 1st-Fill Rate', value: 'McGohan (88%) & EPIC (77%)' }
      ],
      chart: {
        type: 'bar',
        title: 'YTD Enrollments & First-Fill Rate (%) by Source',
        labels: s4.table.map(r => r.sourceKey || r.source),
        datasets: [
          { label: 'Enrolled YTD', data: s4.table.map(r => r.enrolledYtd), backgroundColor: '#154672' },
          { label: 'Enrolled in Sept', data: s4.table.map(r => r.enrolledSept), backgroundColor: '#26ABE4' }
        ]
      },
      table: {
        headers: ['Source', 'Enrolled in Sept', 'Enrolled YTD', 'YTD Share', 'Filled 1st Rx', 'Refilled 1st → 2nd', 'GLP-1 Fills', 'Gross Margin'],
        rows: s4.table.map(r => [r.source, String(r.enrolledSept), String(r.enrolledYtd), r.share, r.filled1stRx, r.refilled1to2, String(r.glp1Fills), r.grossMarginFmt])
      }
    };
  }

  // 11. Funnel / Drop-off / Provider Visit / Timing questions
  if (ql.includes('funnel') || ql.includes('drop-off') || ql.includes('dropoff') || ql.includes('drop off') || ql.includes('provider') || ql.includes('prescribed') || ql.includes('69%') || ql.includes('760') || ql.includes('median time') || ql.includes('how fast') || ql.includes('17 hours')) {
    const s6 = portalState.slide6_funnel;
    return {
      question: q,
      category: 'Provider Visit & First-Fill Conversion Funnel',
      sourceCitation: 'Provider & First-Fill Funnel Analytics',
      targetView: 'funnel',
      headline: '69% of Pre-September Sign-Ups (523 of 760) Filled Their First Prescription — 237 Total Drop-Offs Across 3 Stages',
      answer:
        `**Pre-September Cohort Conversion Funnel (760 Members Enrolled Before Sep)**:\n` +
        `• **Enrolled**: **760 patients (100%)**\n` +
        `• **Saw a provider**: **684 patients (90%)** → **76 lost** (*never completed a provider visit*)\n` +
        `• **Prescribed**: **608 patients (80%)** → **76 lost** (*saw a provider but were not prescribed*)\n` +
        `• **Filled 1st Rx**: **523 patients (69%)** → **85 lost** (*were prescribed but never filled*; **86% of prescribed patients filled**).\n\n` +
        `**Median Velocity Between Steps**:\n` +
        `• Sign-up to provider visit: **Under 1 hour**\n` +
        `• Visit to prescription: **17 hours**\n` +
        `• Prescription to first fill: **1 day**`,
      kpis: [
        { label: 'Overall 1st-Fill Conversion', value: '69% (523 / 760)' },
        { label: 'Prescribed Who Filled', value: '86% (523 / 608)' },
        { label: 'Pre-Pharmacy Losses', value: '152 pts (76 visit + 76 Rx)' },
        { label: 'Prescribed Never Filled', value: '85 pts' }
      ],
      chart: {
        type: 'bar',
        title: 'Patient Conversion Funnel (Members Enrolled Before Sep = 760)',
        labels: s6.steps.map(s => `${s.stage} (${s.pctOfEnrolled}%)`),
        datasets: [{ label: 'Patients', data: s6.steps.map(s => s.patients), backgroundColor: ['#154672', '#1E6091', '#26ABE4', '#1BAF7A'] }]
      },
      table: {
        headers: ['Funnel Step', 'Patients Reached', '% of Enrolled', 'Step Drop-Off', 'Median Time from Prior Step'],
        rows: [
          ['1. Enrolled (Pre-Sep)', '760', '100%', '—', 'Baseline'],
          ['2. Saw a provider', '684', '90%', '−76 never completed visit', 'Under 1 hour'],
          ['3. Prescribed', '608', '80%', '−76 saw provider, not prescribed', '17 hours'],
          ['4. Filled 1st Rx', '523', '69%', '−85 prescribed, never filled (86% filled)', '1 day']
        ]
      }
    };
  }

  // 12. Medication Mix / Wegovy Pill vs Pen vs Ozempic
  if (ql.includes('wegovy') || ql.includes('ozempic') || ql.includes('pill') || ql.includes('pen') || ql.includes('medication') || ql.includes('drug') || ql.includes('38%') || ql.includes('what are patients filling') || ql.includes('mix')) {
    const s8 = portalState.slide8_medMix;
    return {
      question: q,
      category: 'Medication Mix & Product Utilization',
      sourceCitation: 'Medication Mix & Utilization Analytics',
      targetView: 'medmix',
      headline: 'Wegovy Pill Reached 38% of All GLP-1 Fills in September (256 of 673 Fills), Up From 0 Before June',
      answer:
        `**GLP-1 Medication Mix at Damien Pharmacy**:\n` +
        `• In **September 2026 (673 total fills)**:\n` +
        `   – **Wegovy Pen**: **411 fills (61.1%)**\n` +
        `   – **Wegovy Pill (Tablet)**: **256 fills (38.0%)**\n` +
        `   – **Ozempic**: **6 fills (0.9%)**\n` +
        `• **Wegovy Pill Trajectory**: Introduced in June with **33 fills (15.2%)**, growing rapidly to **85 fills in July (25.4%)**, **168 fills in August (34.8%)**, and **256 fills in September (38.0%)**.\n` +
        `• **YTD Total Dispenses (2,034 fills)**: **1,462 Wegovy Pen (71.9%)**, **542 Wegovy Pill (26.6%)**, and **30 Ozempic (1.5%)**.`,
      kpis: [
        { label: 'Wegovy Pen (Sep)', value: '411 fills (61.1%)' },
        { label: 'Wegovy Pill (Sep)', value: '256 fills (38.0%)' },
        { label: 'Ozempic (Sep)', value: '6 fills (0.9%)' },
        { label: 'Total Sep GLP-1 Fills', value: '673 fills' }
      ],
      chart: {
        type: 'bar',
        title: 'Monthly GLP-1 Fills by Product (Jan–Sep 2026)',
        labels: s8.chart.months,
        datasets: [
          { label: 'Wegovy Pen', data: s8.chart.wegovyPen, backgroundColor: '#154672' },
          { label: 'Wegovy Pill', data: s8.chart.wegovyPill, backgroundColor: '#26ABE4' },
          { label: 'Ozempic', data: s8.chart.ozempic, backgroundColor: '#1BAF7A' }
        ]
      },
      table: {
        headers: ['Month', 'Wegovy Pen', 'Wegovy Pill', 'Ozempic', 'Total Monthly Fills', 'Wegovy Pill Share'],
        rows: s8.chart.months.map((m, i) => {
          const pen = s8.chart.wegovyPen[i];
          const pill = s8.chart.wegovyPill[i];
          const oz = s8.chart.ozempic[i];
          const tot = pen + pill + oz;
          return [m, String(pen), String(pill), String(oz), String(tot), `${((pill / tot) * 100).toFixed(1)}%`];
        })
      }
    };
  }

  // 13. Definitions / Data Notes / Appendix / Matching Rules
  if (ql.includes('definition') || ql.includes('appendix') || ql.includes('rule') || ql.includes('how are patients linked') || ql.includes('billed') || ql.includes('test account')) {
    const s9 = portalState.slide9_appendix;
    return {
      question: q,
      category: 'Program Definitions & Data Reconciliation Rules',
      sourceCitation: 'Program Definitions & Data Notes',
      targetView: 'ask',
      headline: 'Program Definitions, Data Sources & Member-to-Pharmacy Linking Rules',
      answer: s9.notes.map((n, i) => `${i + 1}. ${n}`).join('\n\n'),
      kpis: [
        { label: 'Member Match Rate', value: '96% (1,952 / 2,034 fills)' },
        { label: 'Unmatched Fills in P&L', value: '51 no ID + 20 unmatched IDs' },
        { label: 'Funnel Lookback Rule', value: 'Enrolled ≥30d (Pre-Sep)' },
        { label: 'Refill Eligibility Rule', value: 'Prior fill ≥45d before Sep 30' }
      ],
      table: {
        headers: ['Rule / Metric Area', 'Official Program Definition'],
        rows: [
          ['Data Sources', 'Alpha membership file (enrollment, visits, Rx, cancellations, billing) + Damien Pharmacy dispense file (fills, revenue, margin). Test accounts excluded.'],
          ['Patient ID Linking', 'First 8 characters of Alpha member ID = Pharmacy Patient Alternate ID. 1,952 of 2,034 fills (96%) matched.'],
          ['Fill Definition', 'Completed Wegovy or Ozempic dispense on or before Sep 30, 2026. Cancelled & awaiting-pickup excluded.'],
          ['Billing Rule', 'Billed for a month if active at any point in that month (e.g., cancels in June and terminates in July counts in both).'],
          ['Funnel & Refill Windows', 'First-fill funnel uses pre-September sign-ups (≥30d). Refill step rates use fills ≥45d before as-of date.'],
          ['Cost & Ad Spend', 'Assumed $40 cost per fill. Google + Meta media spend from agency reports (agency fees excluded).']
        ]
      }
    };
  }

  // 14. Default comprehensive Executive Summary response (covers general overview, growth, KPIs, and top opportunities)
  const s2 = portalState.slide2_summary;
  return {
    question: q || 'Executive Summary & Key Takeaways',
    category: 'Executive Program Summary',
    sourceCitation: 'Executive Summary & Pharmacy Operations Worklist',
    targetView: 'summary',
    headline: 'Damien Center GLP-1 Program: 862 Active Members, 673 Sep Fills, $371K Sep Proceeds ($962K YTD)',
    answer:
      `**Executive Summary (Through September 30, 2026)**:\n` +
      `• **Growing & Profitable**: Active membership grew **37x** from **23 in Jan** to **862 in Sep** (+33.9% MoM). Program proceeds reached **$371,214 ($371K)** in September on **673 fills**, and **$961,691 ($962K) YTD** after ad spend and fees.\n` +
      `• **Partner Channels**: **EPIC and broker partners** (EPIC, LHD, McGohan Brabender) drove **62% of September enrollments** with 76%–88% first-fill conversion.\n` +
      `• **Paid Media ROI**: **$142,033** in Google + Meta spend generated **414 sign-ups**, **243 therapy starters**, and **$658,361 in pharmacy gross margin** (**$4.63 return per $1 spent / 463% ROAS**).\n` +
      `• **Core Opportunity — First Fill**: **69% of pre-September sign-ups** filled their 1st Rx (**90%** saw a provider, **80%** were prescribed, **69%** filled). Once started, **94% refill**.\n` +
      `• **Immediate Operational Action (Worklist)**: There are **101 active patients** on the **Pharmacy To-Do** list (**10 urgent with cancellation pending**), **37 overdue refills**, and **86 unlinked pharmacy fills** (**21 of which fuzzy-match directly to active To-Do patients**).`,
    kpis: s2.kpis.map(k => ({ label: k.label, value: k.value })),
    chart: {
      type: 'bar',
      title: 'Active Members & Monthly Program Proceeds ($K) Trend',
      labels: s2.activeMembersByMonth.months,
      datasets: [
        { label: 'Active Members', data: s2.activeMembersByMonth.values, backgroundColor: '#26ABE4' },
        { label: 'Program Proceeds ($K)', data: portalState.slide3_financials.monthlyProceeds.values.map(v => Math.round(v / 1000)), backgroundColor: '#154672' }
      ]
    },
    table: {
      headers: ['Key Executive Takeaway', 'Headline Metric', 'Strategic Detail'],
      rows: s2.whatYouNeedToKnow.map(w => [w.title, w.badge, w.body])
    }
  };
}

function countByField(rows, field) {
  const counts = {};
  for (const r of rows) {
    const val = r[field] !== null && r[field] !== undefined && r[field] !== '' ? String(r[field]) : 'Unlisted / None';
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

function buildGeminiDataContext(question) {
  const wl = portalState.worklists;
  const todoRows = wl.pharmacyTodo.rows;
  const refillRows = wl.refillFollowup.rows;
  const noIdRows = wl.pharmacyDataFixes.noIdRows;
  const unmatchedRows = wl.pharmacyDataFixes.unmatchedRows;
  const endedRows = wl.endedNeverFilled.rows;

  // Dynamic keyword search across all 410 worklist rows
  const ql = String(question || '').toLowerCase();
  const stop = new Set([
    'what', 'where', 'when', 'which', 'who', 'whom', 'whose', 'why', 'how', 'many', 'much',
    'show', 'tell', 'give', 'list', 'find', 'search', 'about', 'from', 'with', 'without',
    'have', 'does', 'were', 'been', 'this', 'that', 'these', 'those', 'their', 'there',
    'program', 'damien', 'bridge', 'health', 'alpha', 'member', 'members', 'patient', 'patients',
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
    meta: portalState.meta,
    executiveSummary: portalState.slide2_summary,
    programFinancials: portalState.slide3_financials,
    patientSources: portalState.slide4_sources,
    paidMediaRoi: portalState.slide5_paidMedia,
    conversionFunnel: portalState.slide6_funnel,
    refillPersistence: portalState.slide7_refill,
    medicationMix: portalState.slide8_medMix,
    programDefinitions: portalState.slide9_appendix,
    cohortRetention: portalState.slide10_retention,
    worklistSummary: computeWorklistSummary(wl),
    worklistAggregations: {
      pharmacyTodo_101_ActivePatients: {
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
      refillFollowup_37_OverduePatients: {
        byMembershipStatus: countByField(refillRows, 'Membership status'),
        byPatientSource: countByField(refillRows, 'Patient source'),
        byLastItemFilled: countByField(refillRows, 'Last item filled'),
        byFillsToDate: countByField(refillRows, 'GLP-1 fills to date'),
        all37Records: refillRows.map(r => ({
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
      pharmacyDataFixes_86_UnlinkedFills: {
        noIdCount: noIdRows.length,
        unmatchedCount: unmatchedRows.length,
        noIdByPrescriber: countByField(noIdRows, 'Prescriber'),
        noIdByPayer: countByField(noIdRows, 'Payer'),
        noIdByDispensedItem: countByField(noIdRows, 'Dispensed item'),
        unmatchedByPrescriber: countByField(unmatchedRows, 'Prescriber'),
        combinedByPrescriber: countByField([...noIdRows, ...unmatchedRows], 'Prescriber'),
        all31UnmatchedRecordsWithFuzzySuggestions: unmatchedRows.map(r => ({
          patientIdOnFile: r['Patient ID on file'],
          dateFilled: r['Date filled'],
          dispensedItem: r['Dispensed item'],
          prescriber: r['Prescriber'],
          status: r['Transaction status'],
          correctedPatientId: r['Corrected patient ID'],
          suggestedFuzzyMatchInTodo: r.suggestedMatch
        }))
      },
      endedNeverFilled_186_ChurnedMembers: {
        byStage: countByField(endedRows, 'Stage'),
        byPharmacyFinding: countByField(endedRows, 'Pharmacy finding'),
        byPatientSource: countByField(endedRows, 'Patient source'),
        byEmployerGroup: countByField(endedRows, 'Employer group')
      }
    },
    matchingRecordsForQuery: matchedRecords
  };
}

async function askGeminiWithFullData(question, history = []) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('No GEMINI_API_KEY / GOOGLE_API_KEY configured');
  }

  const contextData = buildGeminiDataContext(question);

  const systemInstruction = `You are a knowledgeable, warm, and direct healthcare analytics colleague at Bridge Health Hub supporting the Damien Center GLP-1 Weight Loss Program (data through September 30, 2026).

You are having a natural, human-like back-and-forth conversation with a teammate. Nothing more, nothing less.

HOW TO SPEAK:
- Write like a real, thoughtful human colleague in a chat conversation — natural, clear, conversational, and direct.
- Do NOT output rigid report headers, category labels, source citations, slide numbers (never say "Slide 3", "Slide 9", etc.), file extensions (.pptx, .xlsx), or robotic meta-descriptions of your dataset size (e.g., don't say "I have the Damien Center GLP-1 program metrics and all 410 worklist records right here").
- Match the length and tone to what the person actually asked:
  - If they greet you or ask a quick conversational question, reply naturally in a couple of sentences.
  - If they ask a specific question about program financials, partner channels, paid media ROI, the conversion funnel, refills, medication mix, or specific patients/employers/prescribers on the worklist, give a clear, accurate, conversational answer grounded in the exact numbers and patient IDs from the data.
- You have full access to both the program performance analytics (862 active members in Sep, 673 Sep fills, $371,214 Sep net program proceeds, $961,691 YTD net program proceeds, $2,336,983 YTD pharmacy revenue, $44,164 YTD membership fees collected, EPIC & broker partners driving 62% of Sep sign-ups with 77% EPIC first-fill rate vs 62% for Paid Media, $4.63 return per $1 media spend / 463% ROAS on $142,033 spend, 69% pre-Sep first-fill conversion [523 of 760], 94% Fill 1->2 refill rate, 38% Wegovy pill share [256 of 673 Sep fills]) and all operational worklist records (101 Pharmacy To-Do, 37 Refill Follow-Up, 86 Pharmacy Data Fixes [55 missing an ID, of which 51 are completed GLP-1 fills through Sep 30; plus 31 unmatched-ID fills across 20 unique IDs on file, of which 21 fills have a possible 1-2 character typo match to 15 active To-Do patients to verify], and 186 Ended – Never Filled).
- When discussing financials, always cite the exact source figures for top-line Pharmacy Revenue ($2,336,983 YTD across 2,034 fills), Membership Fees Collected ($44,164 YTD), and Net Program Proceeds ($371,214 in September on 673 fills; $961,691 YTD) rather than gross margin (and note that top-line pharmacy revenue is reported on a full YTD basis rather than broken out by single month).
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

  const userPrompt = `[Reference Data Context for this turn: ${JSON.stringify(contextData)}]\n\nUser message: ${question}`;
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
    aiPowered: true,
    aiModel: GEMINI_MODEL,
    reply: cleanReply,
    answer: cleanReply
  };
}

app.post('/api/ask', async (req, res) => {
  const { question, history, mode } = req.body || {};
  const q = String(question || '').trim() || 'How is the program performing through September 2026?';

  if (getGeminiApiKey() && mode !== 'instant') {
    try {
      const geminiResult = await askGeminiWithFullData(q, history);
      return res.json(geminiResult);
    } catch (err) {
      console.error('Gemini API error, falling back to deterministic engine:', err.message);
    }
  }

  const fallback = answerQuestion(q);
  res.json({
    question: q,
    aiPowered: false,
    aiModel: 'deterministic-fallback',
    reply: fallback.answer,
    answer: fallback.answer
  });
});

app.listen(PORT, () => {
  console.log(`Damien Center GLP-1 Program Portal running on http://localhost:${PORT} (Gemini Configured: ${Boolean(getGeminiApiKey())}, Model: ${GEMINI_MODEL})`);
});


