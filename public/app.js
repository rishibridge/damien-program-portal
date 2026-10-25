/* Damien Center GLP-1 Weight Loss Program — Bridge Health Hub Interactive Portal */

let PORTAL_DATA = null;
let CURRENT_VIEW = 'summary';
let CURRENT_WL_SUBTAB = 'todo';
let SOURCES_CHART_MODE = 'count';
let MEDMIX_CHART_MODE = 'count';
const QA_HISTORY = [];

const CHARTS = {};

function destroyChart(key) {
  if (CHARTS[key]) {
    CHARTS[key].destroy();
    delete CHARTS[key];
  }
}

async function initPortal() {
  try {
    const resp = await fetch('/api/portal-data');
    PORTAL_DATA = await resp.json();
    renderAllViews();
    renderChatThread();
  } catch (err) {
    console.error('Failed to load portal data:', err);
  }
}

function renderAllViews() {
  if (!PORTAL_DATA) return;
  renderSummaryView();
  renderFinancialsView();
  renderSourcesView();
  renderPaidMediaView();
  renderFunnelView();
  renderRefillAndRetentionView();
  renderMedMixView();
  renderWorklistsView();
  renderAppendixView();
  updateWorklistBadges();
}

function switchView(viewId) {
  CURRENT_VIEW = viewId;
  document.querySelectorAll('#sidebarNav .nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
  });
  document.querySelectorAll('.view').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${viewId}`);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openWorklistWithFilter(subtab, opts = {}) {
  switchView('worklist');
  switchWorklistSubtab(subtab);
  if (subtab === 'todo') {
    document.getElementById('todoPriorityFilter').value = opts.priority || '';
    document.getElementById('todoFindingFilter').value = opts.finding || '';
    document.getElementById('todoSourceFilter').value = opts.source || '';
    document.getElementById('todoFuzzyFilter').value = opts.fuzzy || '';
    document.getElementById('todoSearchInput').value = opts.search || '';
    renderTodoTable();
  } else if (subtab === 'ended') {
    document.getElementById('endedStageFilter').value = opts.stage || '';
    document.getElementById('endedFindingFilter').value = opts.finding || '';
    document.getElementById('endedSourceFilter').value = opts.source || '';
    renderEndedTable();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. EXECUTIVE SUMMARY (Slides 1 & 2)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderSummaryView() {
  const s2 = PORTAL_DATA.slide2_summary;
  const kpiContainer = document.getElementById('summaryKpiRow');
  kpiContainer.innerHTML = s2.kpis.map(k => `
    <div class="kpi" onclick="switchView('${k.targetView}')" data-testid="kpi-${k.id}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-val">${k.value}</div>
      <div class="kpi-sub">${k.subtext}</div>
    </div>
  `).join('');

  // Membership Growth Chart
  destroyChart('membershipGrowth');
  const ctx = document.getElementById('chartMembershipGrowth').getContext('2d');
  CHARTS.membershipGrowth = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s2.activeMembersByMonth.months,
      datasets: [{
        label: 'Active members',
        data: s2.activeMembersByMonth.values,
        backgroundColor: s2.activeMembersByMonth.values.map((_, i) => i === 8 ? '#154672' : '#26abe4'),
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => `Active members: ${c.raw.toLocaleString()}`
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(15, 23, 42, 0.05)' } },
        x: { grid: { display: false } }
      }
    }
  });

  // What You Need to Know
  const knowEl = document.getElementById('whatYouNeedToKnowList');
  knowEl.innerHTML = s2.whatYouNeedToKnow.map(item => `
    <div class="know-item" onclick="switchView('${item.targetView}')">
      <div class="know-item-text">
        <strong>${item.title}</strong> ${item.body}
      </div>
      <span class="know-badge">${item.badge}</span>
    </div>
  `).join('');

  renderWorklistPulseCards();
}

function renderWorklistPulseCards() {
  const ws = PORTAL_DATA.worklistSummary;
  const el = document.getElementById('summaryWorklistPulse');
  if (!el || !ws) return;
  el.innerHTML = `
    <div class="kpi" onclick="openWorklistWithFilter('todo', {priority:'1 – Urgent: cancellation pending'})">
      <div class="kpi-label">Pharmacy To-Do</div>
      <div class="kpi-val">${ws.todoTotal}</div>
      <div class="kpi-sub"><strong>${ws.todoUrgent} Urgent (Cancel Pending)</strong> · ${ws.todoCompleted} Worked</div>
    </div>
    <div class="kpi" onclick="openWorklistWithFilter('refill')">
      <div class="kpi-label">Refill Follow-Up</div>
      <div class="kpi-val">${ws.refillTotal}</div>
      <div class="kpi-sub">${ws.refillPendingCancel} Cancel Pending · ${ws.refillCompleted} Contacted</div>
    </div>
    <div class="kpi" onclick="openWorklistWithFilter('fixes')">
      <div class="kpi-label">Pharmacy Data Fixes</div>
      <div class="kpi-val">${ws.fixesTotal}</div>
      <div class="kpi-sub">${ws.fixesNoIdTotal} No ID · ${ws.fixesUnmatchedTotal} Unmatched (<strong>${ws.fuzzySuggestedCount} Fuzzy-Matched</strong>)</div>
    </div>
    <div class="kpi" onclick="openWorklistWithFilter('ended')">
      <div class="kpi-label">Ended – Never Filled</div>
      <div class="kpi-val">${ws.endedTotal}</div>
      <div class="kpi-sub">74 No Visit · 62 No Rx · 47 Unfilled · 3 Outside</div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. PROGRAM FINANCIALS & P&L SIMULATOR (Slide 3)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderFinancialsView() {
  const s3 = PORTAL_DATA.slide3_financials;

  destroyChart('monthlyProceeds');
  const ctx = document.getElementById('chartMonthlyProceeds').getContext('2d');
  CHARTS.monthlyProceeds = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s3.monthlyProceeds.months,
      datasets: [{
        label: 'Monthly program proceeds ($)',
        data: s3.monthlyProceeds.values,
        backgroundColor: s3.monthlyProceeds.values.map((_, i) => i === 8 ? '#154672' : '#26abe4'),
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => `Program proceeds: $${c.raw.toLocaleString()}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'K' }
        },
        x: { grid: { display: false } }
      }
    }
  });

  const tbody = document.getElementById('tbodyYtdFinancials');
  tbody.innerHTML = s3.ytdTable.map(row => {
    const trClass = row.type === 'total' ? 'total-row' : (row.type === 'subtotal' ? 'subtotal-row' : '');
    const valClass = row.type === 'expense' ? 'num expense-val' : 'num';
    return `<tr class="${trClass}"><td>${row.item}</td><td class="${valClass}">${row.formatted}</td></tr>`;
  }).join('');

  document.getElementById('financialsFootnote').textContent = s3.footnote;
  updateFinancialSimulator();
}

function updateFinancialSimulator() {
  const todoCaptured = Number(document.getElementById('simTodoSlider').value);
  const refillCaptured = Number(document.getElementById('simRefillSlider').value);
  const marginPerFill = Number(document.getElementById('simMarginSlider').value);

  document.getElementById('simTodoVal').textContent = `${todoCaptured} patients`;
  document.getElementById('simRefillVal').textContent = `${refillCaptured} patients`;
  document.getElementById('simMarginVal').textContent = `$${marginPerFill} / fill`;

  const extraFills = todoCaptured + refillCaptured;
  const extraGrossMargin = extraFills * marginPerFill;
  const extraFillCost = extraFills * 40;
  const netLift = extraGrossMargin - extraFillCost;
  const newYtdProceeds = 961691 + netLift;

  document.getElementById('simOutFills').textContent = `+${extraFills}`;
  document.getElementById('simOutMargin').textContent = `+$${extraGrossMargin.toLocaleString()}`;
  document.getElementById('simOutProceeds').textContent = `$${newYtdProceeds.toLocaleString()}`;
  document.getElementById('simOutDelta').textContent = `+$${netLift.toLocaleString()} net proceeds lift (after $40/fill cost)`;
}

function resetFinancialSimulator() {
  document.getElementById('simTodoSlider').value = 50;
  document.getElementById('simRefillSlider').value = 25;
  document.getElementById('simMarginSlider').value = 911;
  updateFinancialSimulator();
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. WHERE ARE PATIENTS COMING FROM? (Slide 4)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderSourcesView() {
  const s4 = PORTAL_DATA.slide4_sources;
  renderSourcesChart();

  const tbody = document.getElementById('tbodySources');
  tbody.innerHTML = s4.table.map(row => {
    const key = row.sourceKey || row.source;
    return `
      <tr>
        <td><strong>${row.source}</strong></td>
        <td class="num">${row.enrolledSept}</td>
        <td class="num">${row.enrolledYtd}</td>
        <td class="num">${row.share}</td>
        <td class="num"><strong>${row.filled1stRx}</strong></td>
        <td class="num">${row.refilled1to2}</td>
        <td class="num">${row.glp1Fills.toLocaleString()}</td>
        <td class="num"><strong>${row.grossMarginFmt}</strong></td>
        <td>
          <button class="btn-bridge-outline" style="padding:4px 10px;font-size:0.74rem" onclick="openWorklistWithFilter('todo', {source:'${key}'})">
            View To-Do
          </button>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('sourcesFootnote').textContent = s4.footnote;
}

function setSourcesChartMode(mode) {
  SOURCES_CHART_MODE = mode;
  renderSourcesChart();
}

function renderSourcesChart() {
  const s4 = PORTAL_DATA.slide4_sources;
  destroyChart('sourcesStacked');
  const ctx = document.getElementById('chartSourcesStacked').getContext('2d');

  const monthTotals = s4.chart.months.map((_, mIdx) =>
    s4.chart.series.reduce((acc, s) => acc + (s.values[mIdx] || 0), 0)
  );

  const datasets = s4.chart.series.map(s => ({
    label: s.name,
    data: s.values.map((v, mIdx) => {
      if (SOURCES_CHART_MODE === 'pct') {
        return monthTotals[mIdx] ? Number(((v / monthTotals[mIdx]) * 100).toFixed(1)) : 0;
      }
      return v;
    }),
    backgroundColor: s.color,
    borderRadius: 2
  }));

  CHARTS.sourcesStacked = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s4.chart.months,
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' }
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          beginAtZero: true,
          max: SOURCES_CHART_MODE === 'pct' ? 100 : undefined,
          ticks: {
            callback: v => SOURCES_CHART_MODE === 'pct' ? v + '%' : v
          }
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. IS PAID MEDIA PAYING OFF? (Slide 5)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderPaidMediaView() {
  const s5 = PORTAL_DATA.slide5_paidMedia;

  const kpiRow = document.getElementById('paidMediaKpiRow');
  kpiRow.innerHTML = s5.kpis.map(k => `
    <div class="kpi">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-val">${k.value}</div>
      <div class="kpi-sub">${k.subtext}</div>
    </div>
  `).join('');

  const monthlyRows = s5.table.filter(r => !r.isTotal);
  destroyChart('paidMediaRoi');
  const ctx = document.getElementById('chartPaidMediaRoi').getContext('2d');
  CHARTS.paidMediaRoi = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: monthlyRows.map(r => r.month),
      datasets: [
        {
          label: 'Media spend ($)',
          data: monthlyRows.map(r => r.spend),
          backgroundColor: '#154672',
          borderRadius: 4
        },
        {
          label: 'Gross margin to date ($)',
          data: monthlyRows.map(r => r.margin),
          backgroundColor: '#26abe4',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'K' }
        },
        x: { grid: { display: false } }
      }
    }
  });

  const tbody = document.getElementById('tbodyPaidMedia');
  tbody.innerHTML = s5.table.map(r => `
    <tr class="${r.isTotal ? 'total-row' : ''}">
      <td>${r.month}</td>
      <td class="num">${r.spendFmt}</td>
      <td class="num">${r.signups}</td>
      <td class="num">${r.spendPerSignup}</td>
      <td class="num">${r.started}</td>
      <td class="num">${r.spendPerStarted}</td>
      <td class="num">${r.fills}</td>
      <td class="num">${r.marginFmt}</td>
      <td class="num"><strong>${r.roas}</strong></td>
    </tr>
  `).join('');

  document.getElementById('paidMediaFootnote').textContent = s5.footnote;
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. ARE PATIENTS SEEING A PROVIDER AND FILLING? (Slide 6)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderFunnelView() {
  const s6 = PORTAL_DATA.slide6_funnel;

  destroyChart('funnelBars');
  const ctx = document.getElementById('chartFunnelBars').getContext('2d');
  CHARTS.funnelBars = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s6.steps.map(s => `${s.stage} (${s.pctOfEnrolled}%)`),
      datasets: [{
        label: 'Patients',
        data: s6.steps.map(s => s.patients),
        backgroundColor: ['#154672', '#1f629c', '#26abe4', '#64748b'],
        borderRadius: 6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, max: 800, grid: { color: 'rgba(15, 23, 42, 0.05)' } },
        y: { grid: { display: false } }
      }
    }
  });

  const dropoffContainer = document.getElementById('funnelDropoffCards');
  dropoffContainer.innerHTML = s6.dropoffs.map(d => `
    <div class="dropoff-card" onclick="openWorklistWithFilter('${d.filterSheet}', {stage:'${d.filterStage}'})">
      <div class="dropoff-num">${d.count}</div>
      <div class="dropoff-lbl">${d.label}</div>
      <div style="margin-top:8px;font-size:0.73rem;color:var(--bridge-navy);font-weight:600">Inspect patients</div>
    </div>
  `).join('');

  const timingList = document.getElementById('funnelTimingList');
  timingList.innerHTML = s6.timing.map(t => `
    <div class="timing-step">
      <span class="timing-lbl">${t.label}</span>
      <span class="timing-val">${t.metric}</span>
    </div>
  `).join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. ARE PATIENTS REFILLING? & COHORT RETENTION (Slides 7 & 10)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderRefillAndRetentionView() {
  const s7 = PORTAL_DATA.slide7_refill;
  const s10 = PORTAL_DATA.slide10_retention;

  destroyChart('refillPersistence');
  const ctx = document.getElementById('chartRefillPersistence').getContext('2d');
  CHARTS.refillPersistence = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s7.chart.fills,
      datasets: [{
        label: 'Share of starters still filling (%)',
        data: s7.chart.shareStillFilling,
        backgroundColor: s7.chart.shareStillFilling.map((_, i) => i >= 6 ? '#94a3b8' : '#26abe4'),
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${c.raw}% still filling (${s7.chart.patientCounts[c.dataIndex]} patients)`
          }
        }
      },
      scales: {
        y: { beginAtZero: true, max: 105, ticks: { callback: v => v + '%' } },
        x: { grid: { display: false } }
      }
    }
  });

  document.getElementById('refillFootnote').textContent = s7.footnote;

  const tbodySteps = document.getElementById('tbodyRefillSteps');
  tbodySteps.innerHTML = s7.stepTable.map((row, idx) => `
    <tr style="${row.lowSample ? 'color:#64748b;background:#f8fafc' : ''}">
      <td><strong>${row.step}</strong></td>
      <td class="num"><strong>${row.cameBack}</strong></td>
      <td class="num">${row.eligiblePts}</td>
      <td class="num">${s7.chart.patientCounts[idx + 1]} pts</td>
    </tr>
  `).join('');

  // Slide 10 Cohort Retention Heatmap
  const theadRet = document.getElementById('theadRetentionMatrix');
  theadRet.innerHTML = `<tr>${s10.columns.map((c, i) => `<th class="${i >= 1 ? 'num' : ''}">${c}</th>`).join('')}</tr>`;

  const tbodyRet = document.getElementById('tbodyRetentionMatrix');
  tbodyRet.innerHTML = s10.rows.map(r => {
    const mCells = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'].map(mKey => {
      const val = r[mKey] || '';
      if (!val) return '<td class="num" style="color:#cbd5e1">—</td>';
      const num = parseInt(val, 10);
      const alpha = Math.max(0.12, Math.min(0.85, (num - 30) / 80));
      const bg = `rgba(38, 171, 228, ${alpha.toFixed(2)})`;
      const color = num >= 75 ? '#0e2841' : '#131820';
      return `<td class="heat-cell" style="background:${bg};color:${color}">${val}</td>`;
    }).join('');
    return `<tr><td><strong>${r.joined}</strong></td><td class="num">${r.members}</td>${mCells}</tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. WHAT ARE PATIENTS FILLING? (Slide 8)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderMedMixView() {
  const s8 = PORTAL_DATA.slide8_medMix;
  renderMedMixChart();

  const calloutList = document.getElementById('medMixCalloutList');
  calloutList.innerHTML = s8.septemberCallouts.map(c => `
    <div class="timing-step">
      <div>
        <div class="timing-lbl">${c.label}</div>
        <div style="font-size:0.74rem;color:var(--muted)">${c.share} of September GLP-1 fills</div>
      </div>
      <span class="timing-val">${c.value}</span>
    </div>
  `).join('');

  document.getElementById('medMixNote').textContent = s8.note;

  const tbody = document.getElementById('tbodyMedMixMonthly');
  tbody.innerHTML = s8.chart.months.map((m, i) => {
    const pen = s8.chart.wegovyPen[i];
    const pill = s8.chart.wegovyPill[i];
    const oz = s8.chart.ozempic[i];
    const tot = pen + pill + oz;
    const pillShare = tot > 0 ? ((pill / tot) * 100).toFixed(0) + '%' : '0%';
    return `
      <tr>
        <td><strong>${m}</strong></td>
        <td class="num">${pen}</td>
        <td class="num">${pill}</td>
        <td class="num">${oz}</td>
        <td class="num"><strong>${tot}</strong></td>
        <td class="num">${pillShare}</td>
      </tr>
    `;
  }).join('');
}

function setMedMixChartMode(mode) {
  MEDMIX_CHART_MODE = mode;
  renderMedMixChart();
}

function renderMedMixChart() {
  const s8 = PORTAL_DATA.slide8_medMix;
  destroyChart('medMix');
  const ctx = document.getElementById('chartMedMix').getContext('2d');

  const totals = s8.chart.months.map((_, i) =>
    s8.chart.wegovyPen[i] + s8.chart.wegovyPill[i] + s8.chart.ozempic[i]
  );

  const conv = (arr) => arr.map((v, i) =>
    MEDMIX_CHART_MODE === 'pct' ? Number(((v / totals[i]) * 100).toFixed(1)) : v
  );

  CHARTS.medMix = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s8.chart.months,
      datasets: [
        { label: 'Wegovy Pen', data: conv(s8.chart.wegovyPen), backgroundColor: '#154672' },
        { label: 'Wegovy Pill', data: conv(s8.chart.wegovyPill), backgroundColor: '#26abe4' },
        { label: 'Ozempic', data: conv(s8.chart.ozempic), backgroundColor: '#94a3b8' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: {
          stacked: true,
          beginAtZero: true,
          max: MEDMIX_CHART_MODE === 'pct' ? 100 : undefined,
          ticks: { callback: v => MEDMIX_CHART_MODE === 'pct' ? v + '%' : v }
        }
      }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. INTERACTIVE FIRST-FILL & OPS WORKLIST (All 4 Excel Sheets)
   ═══════════════════════════════════════════════════════════════════════════ */
function switchWorklistSubtab(subtab) {
  CURRENT_WL_SUBTAB = subtab;
  ['todo', 'refill', 'fixes', 'ended'].forEach(key => {
    const btn = document.getElementById(`wlTabBtn-${key}`);
    const panel = document.getElementById(`wlSubtab-${key}`);
    if (btn) btn.classList.toggle('active', key === subtab);
    if (panel) panel.style.display = key === subtab ? 'block' : 'none';
  });
}

function updateWorklistBadges() {
  const ws = PORTAL_DATA.worklistSummary;
  if (!ws) return;
  document.getElementById('badgeCountTodo').textContent = ws.todoTotal;
  document.getElementById('badgeCountRefill').textContent = ws.refillTotal;
  document.getElementById('badgeCountFixes').textContent = ws.fixesTotal;
  document.getElementById('badgeCountEnded').textContent = ws.endedTotal;
  renderWorklistPulseCards();
}

function renderWorklistsView() {
  const wl = PORTAL_DATA.worklists;
  document.getElementById('descPharmacyTodo').textContent = wl.pharmacyTodo.description;
  document.getElementById('descRefillFollowup').textContent = wl.refillFollowup.description;
  document.getElementById('descEndedNeverFilled').textContent = wl.endedNeverFilled.description;

  renderTodoTable();
  renderRefillTable();
  renderFixesTables();
  renderEndedTable();
}

function renderTodoTable() {
  const rows = PORTAL_DATA.worklists.pharmacyTodo.rows;
  const q = (document.getElementById('todoSearchInput')?.value || '').toLowerCase().trim();
  const prio = document.getElementById('todoPriorityFilter')?.value || '';
  const finding = document.getElementById('todoFindingFilter')?.value || '';
  const source = document.getElementById('todoSourceFilter')?.value || '';
  const fuzzy = document.getElementById('todoFuzzyFilter')?.value || '';

  const filtered = rows.filter(r => {
    if (prio && r['Priority'] !== prio) return false;
    if (finding && r['Pharmacy finding'] !== finding) return false;
    if (source && r['Patient source'] !== source) return false;
    if (fuzzy === 'fuzzy' && (!r.possibleDataFixes || r.possibleDataFixes.length === 0)) return false;
    if (q) {
      const hay = JSON.stringify(r).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  document.getElementById('todoFilteredCountBadge').textContent = `Showing ${filtered.length} of ${rows.length}`;

  const statusOptions = ['Not started', 'In progress', 'Contacted patient', 'Filled – ID Corrected', 'Filled', 'Cancelled by patient'];

  const tbody = document.getElementById('tbodyWorklistTodo');
  tbody.innerHTML = filtered.map(r => {
    const pStr = String(r['Priority'] || '');
    const pClass = pStr.startsWith('1') ? 'prio-1' : (pStr.startsWith('2') ? 'prio-2' : 'prio-4');
    const hasFuzzy = r.possibleDataFixes && r.possibleDataFixes.length > 0;
    const fuzzyHtml = hasFuzzy
      ? `<div style="margin-top:4px"><span class="fuzzy-badge" onclick="switchWorklistSubtab('fixes')" title="Typo ID ${r.possibleDataFixes[0].patientIdOnFile} filled ${r.possibleDataFixes[0].dispensedItem}">Match in Fixes (${r.possibleDataFixes[0].patientIdOnFile})</span></div>`
      : '';

    return `
      <tr data-row-id="${r.id}">
        <td><span class="prio-badge ${pClass}">${pStr}</span></td>
        <td>
          <strong>${r['Pharmacy patient ID']}</strong>
          <div style="font-size:0.7rem;color:var(--muted)">${r['Membership status'] || ''}</div>
          ${fuzzyHtml}
        </td>
        <td>
          <select class="edit-cell-select" onchange="updateWorklistCell('todo', '${r.id}', 'Status', this.value)">
            ${statusOptions.map(opt => `<option value="${opt}" ${r['Status'] === opt ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="date" class="edit-cell-input" value="${(r['Date contacted'] || '').slice(0, 10)}" onchange="updateWorklistCell('todo', '${r.id}', 'Date contacted', this.value)" />
        </td>
        <td>
          <input type="text" class="edit-cell-input" placeholder="Add pharmacy note..." value="${escapeAttr(r['Notes'] || '')}" onchange="updateWorklistCell('todo', '${r.id}', 'Notes', this.value)" />
        </td>
        <td>
          <strong>${r['Pharmacy finding'] || '—'}</strong>
          <div style="font-size:0.72rem;color:var(--muted);max-width:230px">${r['Pharmacy note'] || ''}</div>
        </td>
        <td>${r['Rx medication'] || '—'}</td>
        <td class="num">${r['Days in this stage'] ?? '—'}d</td>
        <td>
          <strong>${r['Patient source'] || '—'}</strong>
          <div style="font-size:0.72rem;color:var(--muted)">${r['Employer group'] || ''}</div>
        </td>
        <td>
          <button class="btn-bridge-outline" style="padding:4px 9px;font-size:0.73rem" onclick="openPatientModal('todo', '${r.id}')">25 Cols</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderRefillTable() {
  const rows = PORTAL_DATA.worklists.refillFollowup.rows;
  const q = (document.getElementById('refillSearchInput')?.value || '').toLowerCase().trim();
  const mStatus = document.getElementById('refillStatusFilter')?.value || '';
  const source = document.getElementById('refillSourceFilter')?.value || '';

  const filtered = rows.filter(r => {
    if (mStatus && r['Membership status'] !== mStatus) return false;
    if (source && r['Patient source'] !== source) return false;
    if (q && !JSON.stringify(r).toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById('refillFilteredCountBadge').textContent = `Showing ${filtered.length} of ${rows.length}`;
  const statusOptions = ['Not started', 'Contacted – Refill Scheduled', 'Left Voicemail / Text', 'Refilled', 'Discontinued'];

  const tbody = document.getElementById('tbodyWorklistRefill');
  tbody.innerHTML = filtered.map(r => {
    const isCancel = String(r['Membership status'] || '').includes('cancellation');
    return `
      <tr data-row-id="${r.id}">
        <td><strong>${r['Pharmacy patient ID']}</strong></td>
        <td><span class="prio-badge ${isCancel ? 'prio-1' : 'prio-4'}">${r['Membership status']}</span></td>
        <td>
          <select class="edit-cell-select" onchange="updateWorklistCell('refill', '${r.id}', 'Status', this.value)">
            ${statusOptions.map(opt => `<option value="${opt}" ${r['Status'] === opt ? 'selected' : ''}>${opt}</option>`).join('')}
          </select>
        </td>
        <td>
          <input type="date" class="edit-cell-input" value="${(r['Date contacted'] || '').slice(0, 10)}" onchange="updateWorklistCell('refill', '${r.id}', 'Date contacted', this.value)" />
        </td>
        <td>
          <input type="text" class="edit-cell-input" placeholder="Refill outreach notes..." value="${escapeAttr(r['Notes'] || '')}" onchange="updateWorklistCell('refill', '${r.id}', 'Notes', this.value)" />
        </td>
        <td class="num"><strong>${r['GLP-1 fills to date']}</strong></td>
        <td>${r['Last fill'] || '—'}</td>
        <td class="num"><strong style="color:#c2410c">${r['Days since last fill']}d</strong></td>
        <td>${r['Last item filled'] || '—'}</td>
        <td>${r['Patient source'] || '—'}</td>
        <td>
          <button class="btn-bridge-outline" style="padding:4px 9px;font-size:0.73rem" onclick="openPatientModal('refill', '${r.id}')">13 Cols</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderFixesTables() {
  const unmatchedRows = PORTAL_DATA.worklists.pharmacyDataFixes.unmatchedRows;
  const noIdRows = PORTAL_DATA.worklists.pharmacyDataFixes.noIdRows;
  const qNoId = (document.getElementById('fixesNoIdSearch')?.value || '').toLowerCase().trim();

  const tbodyUnmatched = document.getElementById('tbodyFixesUnmatched');
  tbodyUnmatched.innerHTML = unmatchedRows.map(r => {
    const sm = r.suggestedMatch;
    const suggestionHtml = sm
      ? `<span class="fuzzy-badge" onclick="updateWorklistCell('fixes-unmatched', '${r.id}', 'Corrected patient ID', '${sm.suggestedPatientId}')">
           Apply ${sm.suggestedPatientId} (${sm.matchedInSheet}, dist=${sm.editDistance})
         </span>`
      : `<span style="color:var(--muted);font-size:0.76rem">Manual lookup required</span>`;

    return `
      <tr data-row-id="${r.id}">
        <td><strong style="color:#c23434">${r['Patient ID on file']}</strong></td>
        <td>${suggestionHtml}</td>
        <td>${r['Date filled'] || '—'}</td>
        <td>${r['Dispensed item'] || '—'}</td>
        <td>${r['Prescriber'] || '—'}</td>
        <td>${r['Transaction status'] || '—'}</td>
        <td>
          <input type="text" class="edit-cell-input" placeholder="8-char Alpha ID..." value="${escapeAttr(r['Corrected patient ID'] || '')}" onchange="updateWorklistCell('fixes-unmatched', '${r.id}', 'Corrected patient ID', this.value)" />
        </td>
      </tr>
    `;
  }).join('');

  const filteredNoId = noIdRows.filter(r => !qNoId || JSON.stringify(r).toLowerCase().includes(qNoId));
  const tbodyNoId = document.getElementById('tbodyFixesNoId');
  tbodyNoId.innerHTML = filteredNoId.map(r => `
    <tr data-row-id="${r.id}">
      <td>${r['Date filled'] || '—'}</td>
      <td><strong>${r['Dispensed item'] || '—'}</strong></td>
      <td>${r['Prescriber'] || '—'}</td>
      <td>${r['Payer'] || '—'}</td>
      <td>${r['Transaction status'] || '—'}</td>
      <td>
        <input type="text" class="edit-cell-input" placeholder="Enter 8-char Patient ID..." value="${escapeAttr(r['Corrected patient ID'] || '')}" onchange="updateWorklistCell('fixes-noid', '${r.id}', 'Corrected patient ID', this.value)" />
      </td>
    </tr>
  `).join('');
}

function setEndedStageFilter(stage) {
  document.getElementById('endedStageFilter').value = stage;
  renderEndedTable();
}

function renderEndedTable() {
  const rows = PORTAL_DATA.worklists.endedNeverFilled.rows;
  const q = (document.getElementById('endedSearchInput')?.value || '').toLowerCase().trim();
  const stage = document.getElementById('endedStageFilter')?.value || '';
  const finding = document.getElementById('endedFindingFilter')?.value || '';
  const source = document.getElementById('endedSourceFilter')?.value || '';

  const filtered = rows.filter(r => {
    if (stage && r['Stage'] !== stage) return false;
    if (finding && r['Pharmacy finding'] !== finding) return false;
    if (source && r['Patient source'] !== source) return false;
    if (q && !JSON.stringify(r).toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById('endedFilteredCountBadge').textContent = `Showing ${filtered.length} of ${rows.length}`;
  const tbody = document.getElementById('tbodyWorklistEnded');
  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td><strong>${r['Pharmacy patient ID']}</strong></td>
      <td><span class="prio-badge prio-4">${r['Stage']}</span></td>
      <td>${r['Pharmacy finding'] || '—'}</td>
      <td>${(r['Signed up'] || '').slice(0, 10)}</td>
      <td>${(r['Cancellation requested'] || '').slice(0, 10)}</td>
      <td>${(r['Membership ended'] || '').slice(0, 10)}</td>
      <td><strong>${r['Patient source'] || '—'}</strong></td>
      <td>${r['Employer group'] || '—'}</td>
      <td style="font-size:0.75rem;color:var(--text-secondary);max-width:260px">${r['Pharmacy note'] || '—'}</td>
    </tr>
  `).join('');
}

async function updateWorklistCell(sheet, id, field, value) {
  try {
    const resp = await fetch(`/api/worklist/${sheet}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value })
    });
    const data = await resp.json();
    if (data.ok) {
      // Update local state
      const wl = PORTAL_DATA.worklists;
      let arr = null;
      if (sheet === 'todo') arr = wl.pharmacyTodo.rows;
      else if (sheet === 'refill') arr = wl.refillFollowup.rows;
      else if (sheet === 'fixes-noid') arr = wl.pharmacyDataFixes.noIdRows;
      else if (sheet === 'fixes-unmatched') arr = wl.pharmacyDataFixes.unmatchedRows;
      if (arr) {
        const idx = arr.findIndex(r => r.id === id);
        if (idx !== -1) arr[idx] = data.row;
      }
      if (data.linkedTodoUpdated) {
        const tIdx = wl.pharmacyTodo.rows.findIndex(r => r.id === data.linkedTodoUpdated.id);
        if (tIdx !== -1) wl.pharmacyTodo.rows[tIdx] = data.linkedTodoUpdated;
        renderTodoTable();
      }
      if (sheet === 'fixes-unmatched' || sheet === 'fixes-noid') {
        renderFixesTables();
      }
      PORTAL_DATA.worklistSummary = data.worklistSummary;
      updateWorklistBadges();
    }
  } catch (err) {
    console.error('Failed to update worklist cell:', err);
  }
}

async function applyAllFuzzyFixes() {
  try {
    const resp = await fetch('/api/worklist/apply-fuzzy-fixes', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      const fresh = await fetch('/api/portal-data');
      PORTAL_DATA = await fresh.json();
      renderWorklistsView();
      updateWorklistBadges();
    }
  } catch (err) {
    console.error('Failed to apply fuzzy fixes:', err);
  }
}

async function resetAllWorklistEdits() {
  try {
    await fetch('/api/worklist/reset', { method: 'POST' });
    const fresh = await fetch('/api/portal-data');
    PORTAL_DATA = await fresh.json();
    renderWorklistsView();
    updateWorklistBadges();
  } catch (err) {
    console.error('Failed to reset worklist edits:', err);
  }
}

function exportCurrentWorklistCsv() {
  const map = {
    todo: 'todo',
    refill: 'refill',
    fixes: 'fixes-unmatched',
    ended: 'ended'
  };
  const sheet = map[CURRENT_WL_SUBTAB] || 'todo';
  window.location.href = `/api/worklist/export/${sheet}`;
}

function openPatientModal(sheet, id) {
  const wl = PORTAL_DATA.worklists;
  const rows = sheet === 'todo' ? wl.pharmacyTodo.rows : wl.refillFollowup.rows;
  const headers = sheet === 'todo' ? wl.pharmacyTodo.headers : wl.refillFollowup.headers;
  const row = rows.find(r => r.id === id);
  if (!row) return;

  document.getElementById('modalSheetEyebrow').textContent = sheet === 'todo' ? 'PHARMACY TO-DO · ALL 25 COLUMNS' : 'REFILL FOLLOW-UP · ALL 13 COLUMNS';
  document.getElementById('modalPatientTitle').textContent = `Patient ${row['Pharmacy patient ID']} (${row['Alpha member ID']})`;

  const body = document.getElementById('modalPatientBody');
  body.innerHTML = headers.map(h => `
    <div class="detail-item">
      <div class="detail-item-lbl">${h}</div>
      <div class="detail-item-val">${row[h] !== null && row[h] !== undefined && row[h] !== '' ? row[h] : '—'}</div>
    </div>
  `).join('');

  document.getElementById('patientDetailModal').classList.add('open');
}

function closePatientModal() {
  document.getElementById('patientDetailModal').classList.remove('open');
}

/* ═══════════════════════════════════════════════════════════════════════════
   9. ASK BRIDGE AI (NATURAL CONVERSATION) & DATA DEFINITIONS
   ═══════════════════════════════════════════════════════════════════════════ */
function renderAppendixView() {
  const s9 = PORTAL_DATA.slide9_appendix;
  const list = document.getElementById('appendixNotesList');
  list.innerHTML = s9.notes.map((n, i) => `
    <div class="know-item" style="cursor:default">
      <div class="know-item-text"><strong>Note ${i + 1}:</strong> ${n}</div>
      <span class="know-badge">Data Note</span>
    </div>
  `).join('');
}

function clearQaConversation() {
  QA_HISTORY.length = 0;
  renderChatThread();
}

async function handleTopbarAsk(e) {
  e.preventDefault();
  const input = document.getElementById('topbarAskInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  switchView('ask');
  await executeAskQuestion(q);
}

async function handleMainAskSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('mainAskInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  await executeAskQuestion(q);
}

async function askPresetQuestion(q) {
  await executeAskQuestion(q);
}

async function executeAskQuestion(questionText) {
  const submitBtn = document.getElementById('mainAskSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
  }

  renderChatThread(questionText);

  try {
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: questionText,
        history: QA_HISTORY.slice(-10)
      })
    });
    const ans = await resp.json();
    const replyText = ans.reply || ans.answer || '';
    QA_HISTORY.push({
      question: questionText,
      answer: replyText,
      aiPowered: ans.aiPowered,
      aiModel: ans.aiModel
    });
    renderChatThread();
  } catch (err) {
    console.error('Ask Bridge AI error:', err);
    QA_HISTORY.push({
      question: questionText,
      answer: 'Sorry, I ran into a connection issue while checking that. Could you try asking again?'
    });
    renderChatThread();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send';
    }
  }
}

function formatMarkdownText(raw) {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:0.86em">$1</code>');
}

function renderChatThread(pendingUserQuestion = null) {
  const container = document.getElementById('qaAnswerContainer');
  if (!container) return;

  const greetingHtml = `
    <div class="chat-msg chat-msg-ai">
      <div class="chat-sender">Bridge AI</div>
      <div class="chat-bubble">Hi! I have the Damien Center GLP-1 program metrics and all 410 pharmacy worklist records right here. What would you like to look into?</div>
    </div>
  `;

  const turnsHtml = QA_HISTORY.map(turn => `
    <div class="chat-msg chat-msg-user">
      <div class="chat-sender">You</div>
      <div class="chat-bubble">${formatMarkdownText(turn.question)}</div>
    </div>
    <div class="chat-msg chat-msg-ai" data-testid="qa-ai-message">
      <div class="chat-sender">Bridge AI</div>
      <div class="chat-bubble">${formatMarkdownText(turn.answer)}</div>
    </div>
  `).join('');

  const pendingHtml = pendingUserQuestion
    ? `
      <div class="chat-msg chat-msg-user">
        <div class="chat-sender">You</div>
        <div class="chat-bubble">${formatMarkdownText(pendingUserQuestion)}</div>
      </div>
      <div class="chat-msg chat-msg-ai">
        <div class="chat-sender">Bridge AI</div>
        <div class="chat-bubble chat-typing">Thinking...</div>
      </div>
    `
    : '';

  container.innerHTML = greetingHtml + turnsHtml + pendingHtml;
  container.scrollTop = container.scrollHeight;
}

function escapeAttr(s) {
  return String(s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.addEventListener('DOMContentLoaded', initPortal);

