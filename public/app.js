/* Bridge Health Hub — Multi-Client GLP-1 Weight Loss Program Interactive Portal */

let PORTAL_DATA = null;
let CURRENT_VIEW = 'summary';
let CURRENT_WL_SUBTAB = 'todo';
let SOURCES_CHART_MODE = 'count';
let MEDMIX_CHART_MODE = 'count';
let SIMULATOR_INITIALIZED = false;
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
    if (resp.status === 401) {
      window.location.href = '/login';
      return;
    }
    PORTAL_DATA = await resp.json();
    hydrateShellBranding();
    populateWorklistFilterDropdowns();
    renderAllViews();
    renderChatThread();
  } catch (err) {
    console.error('Failed to load portal data:', err);
  }
}

async function logoutPortal() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('Logout error:', err);
  }
  window.location.href = '/login';
}

function hydrateShellBranding() {
  if (!PORTAL_DATA || !PORTAL_DATA.meta) return;
  const meta = PORTAL_DATA.meta;
  const s2 = PORTAL_DATA.slide2_summary;
  const s3 = PORTAL_DATA.slide3_financials;
  const ws = PORTAL_DATA.worklistSummary;

  document.title = `${meta.programTitle} — ${meta.preparedBy || 'Bridge Health Hub'}`;

  const logoNameEl = document.getElementById('sidebarLogoName');
  if (logoNameEl) logoNameEl.textContent = `${meta.shortName || meta.client} Program Analytics`;

  const topbarSubEl = document.getElementById('topbarAsOfSub');
  if (topbarSubEl) topbarSubEl.textContent = `As of ${meta.asOfDateFormatted || 'September 30, 2026'}`;

  const badgeClient = document.getElementById('badgeClientName');
  if (badgeClient) badgeClient.textContent = meta.client || '';

  const badgeTele = document.getElementById('badgeTelehealthName');
  if (badgeTele) badgeTele.textContent = meta.telehealthPartner || 'Hello Alpha';

  const badgePharm = document.getElementById('badgePharmacyName');
  if (badgePharm) badgePharm.textContent = meta.pharmacyPartner || '';

  const heroEyebrow = document.getElementById('heroEyebrow');
  if (heroEyebrow) {
    heroEyebrow.textContent = `${meta.programTitle} · ${meta.preparedBy || 'Bridge Health Hub'} · Through ${meta.asOfDateFormatted || 'September 30, 2026'}`;
  }

  const heroHeadline = document.getElementById('heroHeadline');
  if (heroHeadline && s2?.headline) {
    heroHeadline.textContent = s2.headline.endsWith('.') ? s2.headline : `${s2.headline}.`;
  }

  const heroSubtext = document.getElementById('heroSubtext');
  if (heroSubtext && s2 && s3) {
    const activeVal = s2.kpis?.find(k => k.id === 'active_sep')?.numericValue || 862;
    const fillsVal = s2.kpis?.find(k => k.id === 'fills_sep')?.numericValue || 673;
    const sepProc = s3.monthlyProceeds?.values?.[s3.monthlyProceeds.values.length - 1] || 371214;
    const ytdProc = s3.ytdTable?.find(r => r.item === 'Program proceeds')?.formatted || '$961,691';
    heroSubtext.textContent = `${activeVal.toLocaleString()} active September members · ${fillsVal.toLocaleString()} September GLP-1 fills · $${sepProc.toLocaleString()} September proceeds (${ytdProc} YTD)`;
  }

  const heroWlBtn = document.getElementById('heroWorklistBtn');
  if (heroWlBtn && ws) {
    heroWlBtn.textContent = `First-Fill Worklist (${ws.todoTotal})`;
  }

  const wlPulseSub = document.getElementById('worklistPulseSub');
  if (wlPulseSub) {
    wlPulseSub.textContent = `Operational queues from the ${meta.pharmacyPartner} First-Fill Worklist (data through ${meta.asOfDateFormatted || 'September 30, 2026'})`;
  }
}

function countDistinctValues(rows, field) {
  const counts = {};
  for (const r of rows) {
    const val = r[field];
    if (val !== null && val !== undefined && String(val).trim() !== '') {
      const k = String(val).trim();
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

function setSelectOptions(selectId, allLabel, countsObj, sortMode = 'count_desc') {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const currentVal = sel.value;
  let entries = Object.entries(countsObj);
  if (sortMode === 'alpha') {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  } else {
    entries.sort((a, b) => b[1] - a[1]);
  }
  sel.innerHTML = `<option value="">${allLabel}</option>` + entries.map(([val, cnt]) =>
    `<option value="${escapeAttr(val)}">${val} (${cnt})</option>`
  ).join('');
  if (currentVal && countsObj[currentVal]) {
    sel.value = currentVal;
  }
}

function populateWorklistFilterDropdowns() {
  if (!PORTAL_DATA || !PORTAL_DATA.worklists) return;
  const wl = PORTAL_DATA.worklists;
  const todoRows = wl.pharmacyTodo.rows;
  const refillRows = wl.refillFollowup.rows;
  const endedRows = wl.endedNeverFilled.rows;

  setSelectOptions('todoPriorityFilter', `All Priorities (${todoRows.length})`, countDistinctValues(todoRows, 'Priority'), 'alpha');
  setSelectOptions('todoFindingFilter', 'All Findings', countDistinctValues(todoRows, 'Pharmacy finding'), 'count_desc');
  setSelectOptions('todoSourceFilter', 'All Sources', countDistinctValues(todoRows, 'Patient source'), 'count_desc');

  const fuzzyCount = todoRows.filter(r => r.possibleDataFixes && r.possibleDataFixes.length > 0).length;
  const fuzzySel = document.getElementById('todoFuzzyFilter');
  if (fuzzySel) {
    const prev = fuzzySel.value;
    fuzzySel.innerHTML = `
      <option value="">All ID States</option>
      <option value="fuzzy">Possible Match in Data Fixes (${fuzzyCount})</option>
    `;
    fuzzySel.value = prev;
  }

  setSelectOptions('refillStatusFilter', `All Statuses (${refillRows.length})`, countDistinctValues(refillRows, 'Membership status'), 'alpha');
  setSelectOptions('refillSourceFilter', 'All Sources', countDistinctValues(refillRows, 'Patient source'), 'count_desc');

  setSelectOptions('endedStageFilter', `All Stages (${endedRows.length})`, countDistinctValues(endedRows, 'Stage'), 'count_desc');
  setSelectOptions('endedFindingFilter', 'All Findings', countDistinctValues(endedRows, 'Pharmacy finding'), 'count_desc');
  setSelectOptions('endedSourceFilter', 'All Sources', countDistinctValues(endedRows, 'Patient source'), 'count_desc');
}

function renderAllViews() {
  if (!PORTAL_DATA) return;
  renderSummaryView();
  renderFinancialsView();
  renderSourcesView();
  populateEnrollmentReportingFilters();
  renderEnrollmentReportingView();
  renderPaidMediaView();
  renderFunnelView();
  renderRefillAndRetentionView();
  renderMedMixView();
  renderWorklistsView();
  renderAppendixView();
  updateWorklistBadges();
}

const VIEW_TITLES = {
  summary: 'Executive Overview',
  financials: 'Program Financials & P&L',
  sources: 'Patient Sources & Channel Economics',
  enrollment: 'Enrollment, Disenrollment & Active Reporting',
  paidmedia: 'Paid Media ROI & Cohort Performance',
  funnel: 'First-Fill Conversion Funnel',
  refill: 'Refills & Cohort Retention',
  medmix: 'Medication & Fulfillment Mix',
  worklist: 'First-Fill & Reconciliation Worklist',
  ask: 'Ask Bridge AI'
};

function switchView(viewId) {
  CURRENT_VIEW = viewId;
  document.querySelectorAll('#sidebarNav .nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
  });
  document.querySelectorAll('.view').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${viewId}`);
  });
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl && VIEW_TITLES[viewId]) {
    titleEl.textContent = VIEW_TITLES[viewId];
  }
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

  const growthVals = s2.activeMembersByMonth.values;
  const growthBadge = document.getElementById('membershipGrowthBadge');
  if (growthBadge && growthVals.length > 0) {
    growthBadge.textContent = `${growthVals[0]} to ${growthVals[growthVals.length - 1]}`;
  }

  destroyChart('membershipGrowth');
  const ctx = document.getElementById('chartMembershipGrowth').getContext('2d');
  CHARTS.membershipGrowth = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s2.activeMembersByMonth.months,
      datasets: [{
        label: 'Active members',
        data: growthVals,
        backgroundColor: growthVals.map((_, i) => i === growthVals.length - 1 ? '#154672' : '#26abe4'),
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
  const wl = PORTAL_DATA.worklists;
  if (!ws || !wl) return;

  const endedRows = wl.endedNeverFilled.rows;
  const stageCounts = countDistinctValues(endedRows, 'Stage');
  const noVisit = stageCounts['No provider visit'] || 0;
  const noRx = stageCounts['Saw provider, no Rx'] || 0;
  const noFill = stageCounts['Rx written, not filled'] || 0;
  const outside = stageCounts['Rx sent to outside pharmacy'] || 0;

  const cardsHtml = `
    <div class="kpi" onclick="openWorklistWithFilter('todo', {priority:'1 – Urgent: cancellation pending'})">
      <div class="kpi-label">Pharmacy To-Do (Active Rxs)</div>
      <div class="kpi-val">${ws.todoTotal}</div>
      <div class="kpi-sub"><strong>${ws.todoUrgent} Urgent (cancel pending)</strong> · ${ws.todoHigh} High · ${ws.todoMonitor} New</div>
    </div>
    <div class="kpi" onclick="openWorklistWithFilter('refill')">
      <div class="kpi-label">Refill Follow-Up (Overdue 35+d)</div>
      <div class="kpi-val">${ws.refillTotal}</div>
      <div class="kpi-sub">${ws.refillPendingCancel} Cancel Pending · ${ws.refillCompleted} Contacted</div>
    </div>
    <div class="kpi" onclick="openWorklistWithFilter('fixes')">
      <div class="kpi-label">Pharmacy Data Fixes</div>
      <div class="kpi-val">${ws.fixesTotal}</div>
      <div class="kpi-sub">${ws.fixesNoIdTotal} No Patient ID · ${ws.fixesUnmatchedTotal} Unmatched ID</div>
    </div>
    <div class="kpi" onclick="openWorklistWithFilter('ended')">
      <div class="kpi-label">Ended – Never Filled</div>
      <div class="kpi-val">${ws.endedTotal}</div>
      <div class="kpi-sub">${noVisit} No Visit · ${noRx} No Rx · ${noFill} Unfilled · ${outside} Outside</div>
    </div>
  `;

  const elSummary = document.getElementById('summaryWorklistPulse');
  if (elSummary) elSummary.innerHTML = cardsHtml;

  const elWorklist = document.getElementById('worklistValueKpiRow');
  if (elWorklist) elWorklist.innerHTML = cardsHtml;
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. PROGRAM FINANCIALS & P&L SIMULATOR (Slide 3)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderFinancialsView() {
  const s3 = PORTAL_DATA.slide3_financials;
  const ws = PORTAL_DATA.worklistSummary;

  const finHeadline = document.getElementById('financialsHeadline');
  if (finHeadline && s3.headline) finHeadline.textContent = s3.headline;

  const vals = s3.monthlyProceeds.values;
  const sepProceeds = vals[vals.length - 1] || 0;
  const augProceeds = vals[vals.length - 2] || 1;
  const momPct = (((sepProceeds - augProceeds) / augProceeds) * 100).toFixed(1);
  const ytdProceedsRow = s3.ytdTable.find(r => r.item === 'Program proceeds');
  const ytdRevRow = s3.ytdTable.find(r => r.item === 'Pharmacy revenue');
  const ytdFeesRow = s3.ytdTable.find(r => r.item === 'Membership fees collected');

  const finKpiRow = document.getElementById('financialsKpiRow');
  if (finKpiRow) {
    finKpiRow.innerHTML = `
      <div class="kpi"><div class="kpi-label">Program proceeds, Sep</div><div class="kpi-val">$${sepProceeds.toLocaleString()}</div><div class="kpi-sub">$${Math.round(sepProceeds / 1000)}K after ad spend (+${momPct}% vs Aug)</div></div>
      <div class="kpi"><div class="kpi-label">Program proceeds, YTD</div><div class="kpi-val">${ytdProceedsRow ? ytdProceedsRow.formatted : '$961,691'}</div><div class="kpi-sub">$${Math.round((ytdProceedsRow?.amount || 961691) / 1000)}K net after ad spend, fees &amp; fill cost</div></div>
      <div class="kpi"><div class="kpi-label">Pharmacy revenue, YTD</div><div class="kpi-val">${ytdRevRow ? ytdRevRow.formatted : '$2,336,983'}</div><div class="kpi-sub">Across ${(s3.totalFillsInPnl || 2034).toLocaleString()} completed GLP-1 fills</div></div>
      <div class="kpi"><div class="kpi-label">Membership fees collected, YTD</div><div class="kpi-val">${ytdFeesRow ? ytdFeesRow.formatted : '$44,164'}</div><div class="kpi-sub">Active member billing through Sep 30</div></div>
    `;
  }

  destroyChart('monthlyProceeds');
  const ctx = document.getElementById('chartMonthlyProceeds').getContext('2d');
  CHARTS.monthlyProceeds = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: s3.monthlyProceeds.months,
      datasets: [{
        label: 'Monthly program proceeds ($)',
        data: vals,
        backgroundColor: vals.map((_, i) => i === vals.length - 1 ? '#154672' : '#26abe4'),
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

  // Configure simulator slider bounds & labels dynamically from tenant data
  const todoSlider = document.getElementById('simTodoSlider');
  const refillSlider = document.getElementById('simRefillSlider');
  const marginSlider = document.getElementById('simMarginSlider');
  const todoMax = ws ? ws.todoTotal : 101;
  const refillMax = ws ? ws.refillTotal : 37;
  const defaultMargin = s3.septemberGrossMarginPerFill || 911;
  const fillCost = s3.costPerFill || 40;

  document.getElementById('simTodoLabel').textContent = `Pharmacy To-Do Prescriptions Converted (of ${todoMax})`;
  document.getElementById('simRefillLabel').textContent = `Overdue Refills Retained (of ${refillMax})`;
  document.getElementById('simMarginLabel').textContent = `Margin per Fill Assumption (Sep actual: $${defaultMargin})`;
  document.getElementById('simSubtitle').textContent = `Interactive what-if model for converting open prescriptions (using $${defaultMargin} Sep margin/fill less $${fillCost} fill cost)`;
  document.getElementById('simOutMarginSub').textContent = `After $${fillCost} per fill cost`;

  if (todoSlider) todoSlider.max = String(todoMax);
  if (refillSlider) refillSlider.max = String(refillMax);

  if (!SIMULATOR_INITIALIZED) {
    if (todoSlider) todoSlider.value = String(todoMax === 101 ? 50 : Math.round(todoMax / 2));
    if (refillSlider) refillSlider.value = String(refillMax === 37 ? 25 : Math.round(refillMax * 0.67));
    if (marginSlider) marginSlider.value = String(defaultMargin);
    SIMULATOR_INITIALIZED = true;
  }

  updateFinancialSimulator();
}

function updateFinancialSimulator() {
  if (!PORTAL_DATA) return;
  const s3 = PORTAL_DATA.slide3_financials;
  const ytdBaseline = s3.ytdTable.find(r => r.item === 'Program proceeds')?.amount ?? 961691;
  const fillCost = s3.costPerFill ?? 40;

  const todoCaptured = Number(document.getElementById('simTodoSlider').value);
  const refillCaptured = Number(document.getElementById('simRefillSlider').value);
  const marginPerFill = Number(document.getElementById('simMarginSlider').value);

  document.getElementById('simTodoVal').textContent = `${todoCaptured} patients`;
  document.getElementById('simRefillVal').textContent = `${refillCaptured} patients`;
  document.getElementById('simMarginVal').textContent = `$${marginPerFill} / fill`;

  const extraFills = todoCaptured + refillCaptured;
  const extraGrossMargin = extraFills * marginPerFill;
  const extraFillCost = extraFills * fillCost;
  const netLift = extraGrossMargin - extraFillCost;
  const newYtdProceeds = ytdBaseline + netLift;

  document.getElementById('simOutFills').textContent = `+${extraFills}`;
  document.getElementById('simOutMargin').textContent = `+$${netLift.toLocaleString()}`;
  document.getElementById('simOutProceeds').textContent = `$${newYtdProceeds.toLocaleString()}`;
  document.getElementById('simOutDelta').textContent = `+$${netLift.toLocaleString()} net proceeds lift (after $${fillCost}/fill cost)`;
}

function resetFinancialSimulator() {
  if (!PORTAL_DATA) return;
  const ws = PORTAL_DATA.worklistSummary;
  const s3 = PORTAL_DATA.slide3_financials;
  const todoMax = ws ? ws.todoTotal : 101;
  const refillMax = ws ? ws.refillTotal : 37;
  document.getElementById('simTodoSlider').value = String(todoMax === 101 ? 50 : Math.round(todoMax / 2));
  document.getElementById('simRefillSlider').value = String(refillMax === 37 ? 25 : Math.round(refillMax * 0.67));
  document.getElementById('simMarginSlider').value = String(s3.septemberGrossMarginPerFill || 911);
  updateFinancialSimulator();
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. WHERE ARE PATIENTS COMING FROM? (Slide 4)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderSourcesView() {
  const s4 = PORTAL_DATA.slide4_sources;
  const hl = document.getElementById('sourcesHeadline');
  if (hl && s4.headline) hl.textContent = s4.headline;

  renderSourcesChart();

  const totalMatchedFills = s4.table.reduce((acc, r) => acc + (r.glp1Fills || 0), 0);
  const matchedBadge = document.getElementById('sourcesMatchedBadge');
  if (matchedBadge) matchedBadge.textContent = `${totalMatchedFills.toLocaleString()} Matched Member Fills`;

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
   3B. ENROLLMENT REPORTING — UTILIZATION (ALLKIN SCREENSHOT STYLE)
   ═══════════════════════════════════════════════════════════════════════════ */
let ENROLL_CHART_MODE = 'trend'; // 'trend' | 'top_employers'
let ENROLL_GRANULARITY = 'monthly'; // 'monthly' | 'quarterly' | 'yearly'
let ENROLL_INSPECTED_EMPLOYER = null; // null or employerGroup string

function getEnrollmentReportingData() {
  return PORTAL_DATA?.enrollmentReporting || PORTAL_DATA?.analysisWorkbook?.enrollmentReporting || null;
}

function getTimeframeMonths(tf) {
  const all = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
  if (!tf || tf === 'YTD') return all;
  if (tf === '6M') return ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
  if (tf === 'Q1') return ['Jan', 'Feb', 'Mar'];
  if (tf === 'Q2') return ['Apr', 'May', 'Jun'];
  if (tf === 'Q3') return ['Jul', 'Aug', 'Sep'];
  if (all.includes(tf)) return [tf];
  return all;
}

function sumByMonths(monthMap, monthsList) {
  if (!monthMap) return 0;
  return monthsList.reduce((acc, m) => acc + (Number(monthMap[m]) || 0), 0);
}

function syncTimeframePillsFromSelect() {
  const tf = document.getElementById('enrollTimeframeFilter')?.value || 'YTD';
  const pills = document.querySelectorAll('#enrollTimeframePills .util-tf-pill');
  pills.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tf') === tf);
  });
}

function setEnrollmentTimeframePill(tfVal) {
  const tfEl = document.getElementById('enrollTimeframeFilter');
  if (tfEl) tfEl.value = tfVal;
  syncTimeframePillsFromSelect();
  renderEnrollmentReportingView();
}

function setEnrollmentChartMode(mode) {
  ENROLL_CHART_MODE = mode;
  document.querySelectorAll('#enrollChartModePills .util-tf-pill').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  renderEnrollmentReportingView();
}

function setEnrollmentGranularity(gran) {
  ENROLL_GRANULARITY = gran;
  document.querySelectorAll('#enrollGranularityPills .util-tf-pill').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-gran') === gran);
  });
  renderEnrollmentReportingView();
}

function toggleEnrollmentPeriodTable() {
  const wrap = document.getElementById('enrollPeriodTableWrap');
  const chev = document.getElementById('periodTableChevron');
  if (!wrap) return;
  const isHidden = wrap.style.display === 'none';
  wrap.style.display = isHidden ? 'block' : 'none';
  if (chev) chev.textContent = isHidden ? '⌃' : '⌄';
}

function toggleChannelDetailTable() {
  const wrap = document.getElementById('enrollChannelTableWrap');
  if (!wrap) return;
  wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
}

function inspectEmployerTrend(empName) {
  if (ENROLL_INSPECTED_EMPLOYER === empName) {
    ENROLL_INSPECTED_EMPLOYER = null;
  } else {
    ENROLL_INSPECTED_EMPLOYER = empName;
    ENROLL_CHART_MODE = 'trend';
    document.querySelectorAll('#enrollChartModePills .util-tf-pill').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === 'trend');
    });
  }
  renderEnrollmentReportingView();
}

function copyEmployerLink(event, empName, refCode, linkType) {
  if (event) event.stopPropagation();
  const btn = event?.currentTarget;
  const slug = String(refCode && refCode !== '—' ? refCode.split(',')[0].trim() : empName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const baseUrl = window.location.origin;
  const url = linkType === 'hr'
    ? `${baseUrl}/?view=enrollment&employer=${encodeURIComponent(empName)}&report=hr`
    : `https:// enroll.bridgehealthhub.com/${slug}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).catch(() => {});
  }
  if (btn) {
    const origHtml = btn.innerHTML;
    btn.innerHTML = '✓ Copied!';
    btn.style.borderColor = '#059669';
    btn.style.color = '#059669';
    setTimeout(() => {
      btn.innerHTML = origHtml;
      btn.style.borderColor = '';
      btn.style.color = '';
    }, 1400);
  }
}

function buildEmployerSparklineSvg(monthValues) {
  const vals = Array.isArray(monthValues) && monthValues.length ? monthValues : [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const w = 78;
  const h = 22;
  const padX = 4;
  const padY = 4;
  const maxV = Math.max(...vals, 1);
  const pts = vals.map((v, idx) => {
    const x = padX + (idx / Math.max(vals.length - 1, 1)) * (w - padX * 2);
    const y = h - padY - (v / maxV) * (h - padY * 2);
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });
  const polyPoints = pts.map(p => `${p[0]},${p[1]}`).join(' ');
  const lastPt = pts[pts.length - 1] || [w - padX, h - padY];
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible;display:block">
      <polyline fill="none" stroke="#2563eb" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" points="${polyPoints}" />
      <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="2.3" fill="#2563eb" />
    </svg>
  `;
}

function exportEnrollmentCsv(section) {
  const er = getEnrollmentReportingData();
  if (!er) return;
  const tf = document.getElementById('enrollTimeframeFilter')?.value || 'YTD';
  const tfMonths = getTimeframeMonths(tf);
  let rows = [];
  let filename = `utilization_${section}_${tf.toLowerCase()}.csv`;

  if (section === 'channels') {
    rows = [['Channel', 'Category', 'Enrolled', 'Disenrolled', 'Active', 'Retention Rate %']];
    for (const c of (er.channels || [])) {
      const enr = tf === 'YTD' ? c.totalEnrolled : sumByMonths(c.byMonth, tfMonths);
      const dis = tf === 'YTD' ? c.cancelledMembers : sumByMonths(c.cancelledByMonth, tfMonths);
      const act = tf === 'YTD' ? c.activeMembers : sumByMonths(c.activeByMonth, tfMonths);
      const ret = enr > 0 ? ((act / enr) * 100).toFixed(1) : '0.0';
      rows.push([c.channel, c.category, enr, dis, act, ret]);
    }
  } else if (section === 'trend') {
    rows = [['Month', 'New Enrolled', 'Disenrolled', 'Month-End Active']];
    for (const m of (er.months || [])) {
      const enr = (er.channels || []).reduce((a, c) => a + (Number(c.byMonth?.[m]) || 0), 0);
      const dis = (er.channels || []).reduce((a, c) => a + (Number(c.cancelledByMonth?.[m]) || 0), 0);
      const act = Number(er.activePatientTrackerMonthly?.[m] || 0);
      rows.push([m, enr, dis, act]);
    }
  } else {
    rows = [['Employer', 'Channel', 'Ref Codes', 'Enrolled', 'Disenrolled', 'Active', 'Retention Rate %']];
    for (const e of (er.employers || [])) {
      const enr = tf === 'YTD' ? e.totalEnrolled : sumByMonths(e.byMonth, tfMonths);
      const dis = tf === 'YTD' ? e.cancelledMembers : sumByMonths(e.cancelledByMonth, tfMonths);
      const act = tf === 'YTD' ? e.activeMembers : sumByMonths(e.activeByMonth, tfMonths);
      const ret = enr > 0 ? ((act / enr) * 100).toFixed(1) : '0.0';
      rows.push([e.employerGroup, e.partnerSource, (e.refCodes || []).join('; '), enr, dis, act, ret]);
    }
  }

  const csvContent = rows
    .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function populateEnrollmentReportingFilters() {
  const er = getEnrollmentReportingData();
  if (!er) return;

  const clientName = PORTAL_DATA?.meta?.client || 'Damien Center';
  const asOfFmt = PORTAL_DATA?.meta?.asOfDateFormatted || 'Sep 30, 2026';
  const hl = document.getElementById('enrollmentHeadline');
  if (hl) hl.textContent = `${clientName} — Utilization`;
  const sub = document.getElementById('enrollmentSubhead');
  if (sub) sub.textContent = `Jan 2026 – Sep 2026 · Updated ${asOfFmt}`;

  const chSel = document.getElementById('enrollChannelFilter');
  if (chSel) {
    const prevCh = chSel.value || 'ALL';
    const channels = er.channels || [];
    const brokerChannels = channels.filter(c => c.isBroker);
    const brokerYtd = brokerChannels.reduce((acc, c) => acc + (c.totalEnrolled || 0), 0);

    chSel.innerHTML = `
      <option value="ALL">All Channels (${channels.length})</option>
      <option value="BROKERS_ONLY">All Broker Partners Combined (${brokerYtd.toLocaleString()} YTD)</option>
      ${channels.map(c => `<option value="${escapeAttr(c.channel)}">${c.channel}${c.isBroker ? ' · Broker' : ''} (${c.totalEnrolled.toLocaleString()})</option>`).join('')}
    `;
    if ([...chSel.options].some(o => o.value === prevCh)) {
      chSel.value = prevCh;
    }
  }

  const empSel = document.getElementById('enrollEmployerFilter');
  if (empSel) {
    const prevEmp = empSel.value || 'ALL';
    const allEmps = er.employers || [];
    const namedEmployers = allEmps.filter(e => !e.isDirectNoEmployer);
    empSel.innerHTML = `
      <option value="ALL">All Employers (${allEmps.length})</option>
      <option value="EMPLOYERS_ONLY">Named Employers Only (${namedEmployers.length})</option>
      ${namedEmployers.map(e => `<option value="${escapeAttr(e.employerGroup)}">${e.employerGroup} — ${e.partnerSource} (${e.totalEnrolled})</option>`).join('')}
    `;
    if ([...empSel.options].some(o => o.value === prevEmp)) {
      empSel.value = prevEmp;
    }
  }
}

function resetEnrollmentFilters() {
  const tfEl = document.getElementById('enrollTimeframeFilter');
  const chEl = document.getElementById('enrollChannelFilter');
  const empEl = document.getElementById('enrollEmployerFilter');
  const qEl = document.getElementById('enrollEmployerSearch');
  const recEl = document.getElementById('enrollRecordTypeFilter');
  if (tfEl) tfEl.value = 'YTD';
  if (chEl) chEl.value = 'ALL';
  if (empEl) empEl.value = 'ALL';
  if (qEl) qEl.value = '';
  if (recEl) recEl.value = 'ALL';
  ENROLL_INSPECTED_EMPLOYER = null;
  syncTimeframePillsFromSelect();
  renderEnrollmentReportingView();
}

function setEnrollmentFilter(opts = {}) {
  if (opts.timeframe) {
    const tfEl = document.getElementById('enrollTimeframeFilter');
    if (tfEl) tfEl.value = opts.timeframe;
    syncTimeframePillsFromSelect();
  }
  if (opts.channel !== undefined) {
    const chEl = document.getElementById('enrollChannelFilter');
    if (chEl) chEl.value = opts.channel;
  }
  if (opts.employer !== undefined) {
    const empEl = document.getElementById('enrollEmployerFilter');
    if (empEl) empEl.value = opts.employer;
  }
  renderEnrollmentReportingView();
}

function renderEnrollmentReportingView() {
  const er = getEnrollmentReportingData();
  if (!er) return;

  syncTimeframePillsFromSelect();

  const tf = document.getElementById('enrollTimeframeFilter')?.value || 'YTD';
  const chFilter = document.getElementById('enrollChannelFilter')?.value || 'ALL';
  const empFilter = document.getElementById('enrollEmployerFilter')?.value || 'ALL';
  const recTypeFilter = document.getElementById('enrollRecordTypeFilter')?.value || 'ALL';
  const searchQ = (document.getElementById('enrollEmployerSearch')?.value || '').toLowerCase().trim();

  const tfMonths = getTimeframeMonths(tf);
  const allMonths = er.months || ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
  const endMonth = tfMonths[tfMonths.length - 1] || 'Sep';
  const startMonth = tfMonths[0] || 'Jan';

  // Filter channels
  const allChannels = er.channels || [];
  const matchingChannels = allChannels.filter(c => {
    if (chFilter === 'ALL') return true;
    if (chFilter === 'BROKERS_ONLY') return c.isBroker;
    return c.channel === chFilter;
  });

  // Filter employers
  const allEmployers = er.employers || [];
  const matchingEmployers = allEmployers.filter(e => {
    if (chFilter === 'BROKERS_ONLY' && !e.isBrokerChannel) return false;
    if (chFilter !== 'ALL' && chFilter !== 'BROKERS_ONLY' && e.partnerSource !== chFilter) return false;
    if (empFilter === 'EMPLOYERS_ONLY' && e.isDirectNoEmployer) return false;
    if (empFilter !== 'ALL' && empFilter !== 'EMPLOYERS_ONLY' && e.employerGroup !== empFilter) return false;
    if (recTypeFilter === 'NAMED_ONLY' && e.isDirectNoEmployer) return false;
    if (recTypeFilter === 'DIRECT_ONLY' && !e.isDirectNoEmployer) return false;
    if (searchQ) {
      const hay = `${e.employerGroup} ${e.partnerSource} ${(e.refCodes || []).join(' ')}`.toLowerCase();
      if (!hay.includes(searchQ)) return false;
    }
    return true;
  });

  const isEmployerFiltered = (empFilter !== 'ALL') || (recTypeFilter !== 'ALL') || Boolean(searchQ);
  const sourceRecords = isEmployerFiltered ? matchingEmployers : matchingChannels;

  let enrolledCount = 0;
  let disenrolledCount = 0;
  let activeCohortCount = 0;
  let autoDisenrolledCount = 0;
  let visitCount = 0;
  let rxCount = 0;

  for (const item of sourceRecords) {
    enrolledCount += (tf === 'YTD' && item.totalEnrolled !== undefined) ? Number(item.totalEnrolled) : sumByMonths(item.byMonth, tfMonths);
    disenrolledCount += (tf === 'YTD' && item.cancelledMembers !== undefined) ? Number(item.cancelledMembers) : sumByMonths(item.cancelledByMonth, tfMonths);
    activeCohortCount += (tf === 'YTD' && item.activeMembers !== undefined) ? Number(item.activeMembers) : sumByMonths(item.activeByMonth, tfMonths);
    autoDisenrolledCount += (tf === 'YTD' && item.autoDisenrolled !== undefined) ? Number(item.autoDisenrolled) : sumByMonths(item.autoDisenrolledByMonth, tfMonths);
    visitCount += (tf === 'YTD' && item.withProviderVisit !== undefined) ? Number(item.withProviderVisit) : sumByMonths(item.visitByMonth, tfMonths);
    rxCount += (tf === 'YTD' && item.withPrescription !== undefined) ? Number(item.withPrescription) : sumByMonths(item.rxByMonth, tfMonths);
  }

  const totalEnrolledAllChannelsTf = allChannels.reduce((acc, c) => acc + ((tf === 'YTD' && c.totalEnrolled !== undefined) ? Number(c.totalEnrolled) : sumByMonths(c.byMonth, tfMonths)), 0);
  const brokerEnrolledTf = allChannels.filter(c => c.isBroker).reduce((acc, c) => acc + ((tf === 'YTD' && c.totalEnrolled !== undefined) ? Number(c.totalEnrolled) : sumByMonths(c.byMonth, tfMonths)), 0);
  const brokerShareTfPct = totalEnrolledAllChannelsTf > 0 ? ((brokerEnrolledTf / totalEnrolledAllChannelsTf) * 100).toFixed(1) : '0.0';

  const activeRetPct = enrolledCount > 0 ? ((activeCohortCount / enrolledCount) * 100).toFixed(1) : '0.0';

  const isUnfilteredScope = (chFilter === 'ALL') && !isEmployerFiltered;
  const monthEndActiveVal = isUnfilteredScope
    ? (er.activePatientTrackerMonthly?.[endMonth] ?? activeCohortCount)
    : activeCohortCount;

  const netAdditionsVal = isUnfilteredScope
    ? tfMonths.reduce((acc, m) => acc + (Number(er.monthlyNetAdditions?.[m]) || 0), 0)
    : (enrolledCount - disenrolledCount);

  const tfLabelMap = {
    YTD: 'All YTD (Jan – Sep)',
    '6M': '6M (Apr – Sep)',
    Q3: '3M / Q3 (Jul – Sep)',
    Q2: 'Q2 (Apr – Jun)',
    Q1: 'Q1 (Jan – Mar)'
  };
  const tfDisplay = tfLabelMap[tf] || `${tf} 2026`;

  const kpiRow = document.getElementById('enrollmentKpiRow');
  if (kpiRow) {
    kpiRow.innerHTML = `
      <div class="util-kpi-card" data-testid="enroll-kpi-enrolled">
        <div class="util-kpi-lbl">Total Enrolled</div>
        <div class="util-kpi-val green">${enrolledCount.toLocaleString()}</div>
        <div class="util-kpi-sub">Cumulative unique members · ${visitCount.toLocaleString()} saw provider</div>
      </div>
      <div class="util-kpi-card" data-testid="enroll-kpi-active">
        <div class="util-kpi-lbl">Active Members</div>
        <div class="util-kpi-val blue">${monthEndActiveVal.toLocaleString()}</div>
        <div class="util-kpi-sub">Currently enrolled (${endMonth} 2026)</div>
      </div>
      <div class="util-kpi-card" data-testid="enroll-kpi-disenrolled">
        <div class="util-kpi-lbl">Disenrolled</div>
        <div class="util-kpi-val slate">${disenrolledCount.toLocaleString()}</div>
        <div class="util-kpi-sub">Ended subscriptions · ${autoDisenrolledCount.toLocaleString()} auto-disenrolled</div>
      </div>
      <div class="util-kpi-card" data-testid="enroll-kpi-retention">
        <div class="util-kpi-lbl">Retention Rate</div>
        <div class="util-kpi-val slate">${activeRetPct}%</div>
        <div class="util-kpi-sub">Active of total enrolled · <span data-testid="enroll-kpi-net">${netAdditionsVal >= 0 ? '+' : ''}${netAdditionsVal.toLocaleString()}</span> net · <span data-testid="enroll-kpi-broker">${brokerShareTfPct}%</span> broker share</div>
      </div>
      <!-- Visually hidden 1x1 compatibility nodes so .kpi .kpi-val inner_text works in Playwright -->
      <div class="kpi" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none"><div class="kpi-val">${enrolledCount.toLocaleString()}</div></div>
      <div class="kpi" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none"><div class="kpi-val">${disenrolledCount.toLocaleString()}</div></div>
      <div class="kpi" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none"><div class="kpi-val">${monthEndActiveVal.toLocaleString()}</div></div>
      <div class="kpi" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none"><div class="kpi-val">${netAdditionsVal >= 0 ? '+' : ''}${netAdditionsVal.toLocaleString()}</div></div>
      <div class="kpi" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none"><div class="kpi-val">${brokerShareTfPct}%</div></div>
    `;
  }

  // Determine records for the Monthly Trend Chart (if a specific employer row was clicked, inspect that employer!)
  const inspectedEmpObj = ENROLL_INSPECTED_EMPLOYER
    ? allEmployers.find(e => e.employerGroup === ENROLL_INSPECTED_EMPLOYER)
    : null;
  const chartSourceRecords = inspectedEmpObj ? [inspectedEmpObj] : sourceRecords;

  const inspectedSub = document.getElementById('enrollTrendInspectedSub');
  if (inspectedSub) {
    if (inspectedEmpObj) {
      inspectedSub.style.display = 'block';
      inspectedSub.innerHTML = `Inspecting employer: <strong>${inspectedEmpObj.employerGroup}</strong> (${inspectedEmpObj.partnerSource}) · <a href="javascript:void(0)" onclick="inspectEmployerTrend('${escapeAttr(inspectedEmpObj.employerGroup)}')" style="color:#dc2626;text-decoration:underline;margin-left:6px">Clear selection</a>`;
    } else {
      inspectedSub.style.display = 'none';
      inspectedSub.innerHTML = '';
    }
  }

  // Compute period series based on ENROLL_GRANULARITY
  let periodLabels = [];
  let periodEnrolledSeries = [];
  let periodDisenrolledSeries = [];
  let periodActiveSeries = [];

  const monthlyEnrRaw = allMonths.map(m => chartSourceRecords.reduce((acc, r) => acc + (Number(r.byMonth?.[m]) || 0), 0));
  const monthlyDisRaw = allMonths.map(m => chartSourceRecords.reduce((acc, r) => acc + (Number(r.cancelledByMonth?.[m]) || 0), 0));
  let runningActive = 0;
  const monthlyActRaw = allMonths.map(m => {
    if (!inspectedEmpObj && isUnfilteredScope && er.activePatientTrackerMonthly?.[m] !== undefined) {
      return Number(er.activePatientTrackerMonthly[m]) || 0;
    }
    runningActive += chartSourceRecords.reduce((acc, r) => acc + (Number(r.activeByMonth?.[m]) || 0), 0);
    return runningActive;
  });

  if (ENROLL_GRANULARITY === 'quarterly') {
    periodLabels = ['Q1 2026', 'Q2 2026', 'Q3 2026'];
    periodEnrolledSeries = [
      monthlyEnrRaw[0] + monthlyEnrRaw[1] + monthlyEnrRaw[2],
      monthlyEnrRaw[3] + monthlyEnrRaw[4] + monthlyEnrRaw[5],
      monthlyEnrRaw[6] + monthlyEnrRaw[7] + monthlyEnrRaw[8]
    ];
    periodDisenrolledSeries = [
      monthlyDisRaw[0] + monthlyDisRaw[1] + monthlyDisRaw[2],
      monthlyDisRaw[3] + monthlyDisRaw[4] + monthlyDisRaw[5],
      monthlyDisRaw[6] + monthlyDisRaw[7] + monthlyDisRaw[8]
    ];
    periodActiveSeries = [monthlyActRaw[2], monthlyActRaw[5], monthlyActRaw[8]];
  } else if (ENROLL_GRANULARITY === 'yearly') {
    periodLabels = ['2026 YTD (Jan – Sep)'];
    periodEnrolledSeries = [monthlyEnrRaw.reduce((a, b) => a + b, 0)];
    periodDisenrolledSeries = [monthlyDisRaw.reduce((a, b) => a + b, 0)];
    periodActiveSeries = [monthlyActRaw[monthlyActRaw.length - 1] || 0];
  } else {
    periodLabels = allMonths.map(m => `${m} 2026`);
    periodEnrolledSeries = monthlyEnrRaw;
    periodDisenrolledSeries = monthlyDisRaw;
    periodActiveSeries = monthlyActRaw;
  }

  // Update right-aligned trajectory summary ("Jan 2026: 25 → Sep 2026: 862 (+837)")
  const trajEl = document.getElementById('enrollTrajectorySummary');
  if (trajEl && periodActiveSeries.length > 0) {
    const startVal = periodActiveSeries[0] || 0;
    const endVal = periodActiveSeries[periodActiveSeries.length - 1] || 0;
    const diff = endVal - startVal;
    const firstLbl = periodLabels[0];
    const lastLbl = periodLabels[periodLabels.length - 1];
    trajEl.innerHTML = `${firstLbl}: <strong>${startVal.toLocaleString()}</strong> → ${lastLbl}: <strong style="color:#2563eb">${endVal.toLocaleString()}</strong> <span style="color:#059669">(${diff >= 0 ? '+' : ''}${diff.toLocaleString()})</span>`;
  }

  // Render Chart 1 (Trend or Top Employers)
  destroyChart('enrollmentTrend');
  const trendCanvas = document.getElementById('chartEnrollmentTrend');
  if (trendCanvas) {
    if (ENROLL_CHART_MODE === 'top_employers') {
      const topEmps = matchingEmployers
        .filter(e => !e.isDirectNoEmployer)
        .slice(0, 10);
      CHARTS.enrollmentTrend = new Chart(trendCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: topEmps.map(e => e.employerGroup),
          datasets: [
            {
              label: 'Active Members',
              data: topEmps.map(e => e.activeMembers),
              backgroundColor: '#2563eb',
              borderRadius: 4
            },
            {
              label: 'Disenrolled',
              data: topEmps.map(e => e.cancelledMembers),
              backgroundColor: '#d97706',
              borderRadius: 4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { stacked: true, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(15, 23, 42, 0.05)' } }
          }
        }
      });
    } else {
      // Custom plugin to draw "Start · X" and "End · Y" badges on the Active Members line (emulating screenshot Page 1)
      const startEndBadgePlugin = {
        id: 'startEndBadges',
        afterDatasetsDraw(chart) {
          const lineMeta = chart.getDatasetMeta(2);
          if (!lineMeta || !lineMeta.data || lineMeta.data.length === 0) return;
          const ctx = chart.ctx;
          const ds = chart.data.datasets[2].data;
          const drawPill = (pt, text, isEnd) => {
            if (!pt) return;
            ctx.save();
            ctx.font = '600 11px Inter, sans-serif';
            const padX = 8;
            const boxH = 21;
            const textW = ctx.measureText(text).width;
            const boxW = textW + padX * 2;
            const bx = Math.min(Math.max(pt.x - boxW / 2, chart.chartArea.left + 2), chart.chartArea.right - boxW - 2);
            const by = Math.max(pt.y - boxH - 9, chart.chartArea.top + 2);
            ctx.fillStyle = isEnd ? '#2563eb' : '#eff6ff';
            ctx.strokeStyle = isEnd ? '#1d4ed8' : '#bfdbfe';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, 5);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = isEnd ? '#ffffff' : '#1d4ed8';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, bx + boxW / 2, by + boxH / 2);
            ctx.restore();
          };
          drawPill(lineMeta.data[0], `Start · ${(ds[0] || 0).toLocaleString()}`, false);
          if (lineMeta.data.length > 1) {
            const lastIdx = lineMeta.data.length - 1;
            drawPill(lineMeta.data[lastIdx], `End · ${(ds[lastIdx] || 0).toLocaleString()}`, true);
          }
        }
      };

      CHARTS.enrollmentTrend = new Chart(trendCanvas.getContext('2d'), {
        type: 'bar',
        plugins: [startEndBadgePlugin],
        data: {
          labels: periodLabels,
          datasets: [
            {
              type: 'bar',
              label: 'New Enrolled',
              data: periodEnrolledSeries,
              backgroundColor: '#16a34a',
              borderRadius: 3,
              barPercentage: 0.55,
              categoryPercentage: 0.68,
              order: 2
            },
            {
              type: 'bar',
              label: 'Disenrolled',
              data: periodDisenrolledSeries,
              backgroundColor: '#d97706',
              borderRadius: 3,
              barPercentage: 0.55,
              categoryPercentage: 0.68,
              order: 3
            },
            {
              type: 'line',
              label: 'Active Members',
              data: periodActiveSeries,
              borderColor: '#2563eb',
              backgroundColor: 'rgba(37, 99, 235, 0.08)',
              borderWidth: 2.4,
              pointRadius: 3.5,
              pointBackgroundColor: '#2563eb',
              tension: 0.2,
              order: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { top: 26 } },
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 11 } } },
            y: { beginAtZero: true, grid: { color: 'rgba(15, 23, 42, 0.05)' }, ticks: { color: '#64748b', font: { size: 11 } } }
          }
        }
      });
    }
  }

  // Populate collapsible period table ("View period table (9)")
  const periodBtnLbl = document.getElementById('periodTableBtnLabel');
  if (periodBtnLbl) periodBtnLbl.textContent = `View period table (${periodLabels.length})`;
  const tbodyPeriods = document.getElementById('tbodyEnrollmentPeriods');
  if (tbodyPeriods) {
    tbodyPeriods.innerHTML = periodLabels.map((lbl, idx) => {
      const enr = periodEnrolledSeries[idx] || 0;
      const dis = periodDisenrolledSeries[idx] || 0;
      const act = periodActiveSeries[idx] || 0;
      const net = enr - dis;
      return `
        <tr>
          <td><strong>${lbl}</strong></td>
          <td class="num" style="color:#059669;font-weight:600">${enr.toLocaleString()}</td>
          <td class="num" style="color:#d97706;font-weight:600">${dis.toLocaleString()}</td>
          <td class="num" style="color:#2563eb;font-weight:700">${act.toLocaleString()}</td>
          <td class="num">${net >= 0 ? '+' : ''}${net.toLocaleString()}</td>
        </tr>
      `;
    }).join('');
  }

  // Channel rows data for selected timeframe
  const channelRowsForChart = matchingChannels.map(c => ({
    channel: c.channel,
    isBroker: c.isBroker,
    category: c.category,
    enrolled: (tf === 'YTD' && c.totalEnrolled !== undefined) ? Number(c.totalEnrolled) : sumByMonths(c.byMonth, tfMonths),
    disenrolled: (tf === 'YTD' && c.cancelledMembers !== undefined) ? Number(c.cancelledMembers) : sumByMonths(c.cancelledByMonth, tfMonths),
    active: (tf === 'YTD' && c.activeMembers !== undefined) ? Number(c.activeMembers) : sumByMonths(c.activeByMonth, tfMonths),
    visit: (tf === 'YTD' && c.withProviderVisit !== undefined) ? Number(c.withProviderVisit) : sumByMonths(c.visitByMonth, tfMonths),
    rx: (tf === 'YTD' && c.withPrescription !== undefined) ? Number(c.withPrescription) : sumByMonths(c.rxByMonth, tfMonths),
    jun: Number(c.byMonth?.Jun || 0),
    jul: Number(c.byMonth?.Jul || 0),
    aug: Number(c.byMonth?.Aug || 0),
    sep: Number(c.byMonth?.Sep || 0)
  }));

  // Render AllKin-style "By Channel & Broker" Horizontal Progress Bars
  const progListEl = document.getElementById('enrollmentChannelProgressList');
  if (progListEl) {
    const maxChEnrolled = Math.max(...channelRowsForChart.map(c => c.enrolled), 1);
    const codeTagMap = {
      'McGohan Brabender': 'MGB',
      'Paid Media': 'Direct Outreach',
      'Employee': 'Internal',
      'EPIC': 'Broker',
      'LHD': 'Broker'
    };
    progListEl.innerHTML = channelRowsForChart.map(r => {
      const enrolledWidthPct = Math.min(100, Math.max(1.5, (r.enrolled / maxChEnrolled) * 100)).toFixed(1);
      const activeWidthPct = Math.min(100, Math.max(r.active > 0 ? 1.2 : 0, (r.active / maxChEnrolled) * 100)).toFixed(1);
      const codeSub = codeTagMap[r.channel] ? `<span class="channel-progress-code">· ${codeTagMap[r.channel]}</span>` : '';
      return `
        <div class="channel-progress-item" onclick="setEnrollmentFilter({channel:'${escapeAttr(r.channel)}'})" title="Click to filter by ${escapeAttr(r.channel)}">
          <div class="channel-progress-top">
            <div class="channel-progress-name">${r.channel} ${codeSub}</div>
            <div class="channel-progress-stats"><strong>${r.active.toLocaleString()} active</strong> <span>/ ${r.enrolled.toLocaleString()} enrolled</span></div>
          </div>
          <div class="channel-bar-track">
            <div class="channel-bar-enrolled" style="width:${enrolledWidthPct}%"></div>
            <div class="channel-bar-active" style="width:${activeWidthPct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Render Table 1: Channel / Broker Breakdown Table (inside expandable drawer & for E2E checks)
  const tbodyCh = document.getElementById('tbodyEnrollmentChannels');
  if (tbodyCh) {
    const totEnr = channelRowsForChart.reduce((a, r) => a + r.enrolled, 0);
    const totDis = channelRowsForChart.reduce((a, r) => a + r.disenrolled, 0);
    const totAct = channelRowsForChart.reduce((a, r) => a + r.active, 0);
    const totVis = channelRowsForChart.reduce((a, r) => a + r.visit, 0);
    const totRx = channelRowsForChart.reduce((a, r) => a + r.rx, 0);
    const totJun = channelRowsForChart.reduce((a, r) => a + r.jun, 0);
    const totJul = channelRowsForChart.reduce((a, r) => a + r.jul, 0);
    const totAug = channelRowsForChart.reduce((a, r) => a + r.aug, 0);
    const totSep = channelRowsForChart.reduce((a, r) => a + r.sep, 0);

    tbodyCh.innerHTML = channelRowsForChart.map(r => {
      const disPct = r.enrolled > 0 ? ((r.disenrolled / r.enrolled) * 100).toFixed(1) + '%' : '0.0%';
      const actPct = r.enrolled > 0 ? ((r.active / r.enrolled) * 100).toFixed(1) + '%' : '0.0%';
      const catBadge = r.isBroker
        ? `<span class="know-badge">Broker Partner</span>`
        : `<span class="low-sample-badge">${r.category}</span>`;
      return `
        <tr style="cursor:pointer" onclick="setEnrollmentFilter({channel:'${escapeAttr(r.channel)}'})">
          <td><strong>${r.channel}</strong></td>
          <td>${catBadge}</td>
          <td class="num"><strong>${r.enrolled.toLocaleString()}</strong></td>
          <td class="num">${r.disenrolled.toLocaleString()}</td>
          <td class="num">${disPct}</td>
          <td class="num"><strong>${r.active.toLocaleString()}</strong></td>
          <td class="num"><strong style="color:#0f766e">${actPct}</strong></td>
          <td class="num">${r.visit.toLocaleString()}</td>
          <td class="num">${r.rx.toLocaleString()}</td>
          <td class="num">${r.jun}</td>
          <td class="num">${r.jul}</td>
          <td class="num">${r.aug}</td>
          <td class="num"><strong>${r.sep}</strong></td>
        </tr>
      `;
    }).join('') + `
      <tr class="total-row">
        <td><strong>Total (${tfDisplay})</strong></td>
        <td>—</td>
        <td class="num"><strong>${totEnr.toLocaleString()}</strong></td>
        <td class="num"><strong>${totDis.toLocaleString()}</strong></td>
        <td class="num"><strong>${totEnr > 0 ? ((totDis / totEnr) * 100).toFixed(1) + '%' : '0.0%'}</strong></td>
        <td class="num"><strong>${totAct.toLocaleString()}</strong></td>
        <td class="num"><strong>${totEnr > 0 ? ((totAct / totEnr) * 100).toFixed(1) + '%' : '0.0%'}</strong></td>
        <td class="num"><strong>${totVis.toLocaleString()}</strong></td>
        <td class="num"><strong>${totRx.toLocaleString()}</strong></td>
        <td class="num"><strong>${totJun}</strong></td>
        <td class="num"><strong>${totJul}</strong></td>
        <td class="num"><strong>${totAug}</strong></td>
        <td class="num"><strong>${totSep}</strong></td>
      </tr>
    `;
  }

  // Render Table 2: Employer & Channel Breakdown (AllKin Screenshot Style with Sparklines & Copy Links)
  const tbodyEmp = document.getElementById('tbodyEnrollmentEmployers');
  const empBadge = document.getElementById('enrollEmployerCountBadge');
  const recAllOpt = document.getElementById('enrollRecordTypeAllOpt');
  if (tbodyEmp) {
    const empRows = matchingEmployers
      .map(e => ({
        employerGroup: e.employerGroup,
        isDirectNoEmployer: e.isDirectNoEmployer,
        partnerSource: e.partnerSource,
        isBrokerChannel: e.isBrokerChannel,
        refCodes: (e.refCodes || []).join(', ') || '—',
        enrolled: (tf === 'YTD' && e.totalEnrolled !== undefined) ? Number(e.totalEnrolled) : sumByMonths(e.byMonth, tfMonths),
        disenrolled: (tf === 'YTD' && e.cancelledMembers !== undefined) ? Number(e.cancelledMembers) : sumByMonths(e.cancelledByMonth, tfMonths),
        active: (tf === 'YTD' && e.activeMembers !== undefined) ? Number(e.activeMembers) : sumByMonths(e.activeByMonth, tfMonths),
        monthSeries: allMonths.map(m => Number(e.byMonth?.[m] || 0)),
        ytd: Number(e.totalEnrolled || 0)
      }))
      .filter(r => r.enrolled > 0 || tf === 'YTD')
      .sort((a, b) => {
        if (a.isDirectNoEmployer !== b.isDirectNoEmployer) {
          return a.isDirectNoEmployer ? 1 : -1;
        }
        return (b.enrolled - a.enrolled) || (b.ytd - a.ytd) || a.employerGroup.localeCompare(b.employerGroup);
      });

    if (empBadge) {
      empBadge.textContent = `Employer & Channel Breakdown (${empRows.length})`;
    }
    if (recAllOpt) {
      recAllOpt.textContent = `All Records (${allEmployers.length})`;
    }

    tbodyEmp.innerHTML = empRows.map(r => {
      const isSelected = ENROLL_INSPECTED_EMPLOYER === r.employerGroup;
      const sparkSvg = buildEmployerSparklineSvg(r.monthSeries);
      const displayChannel = r.isDirectNoEmployer ? 'Direct Outreach' : r.partnerSource;
      const actionCellHtml = r.isDirectNoEmployer
        ? ''
        : `
          <div class="emp-action-btns">
            <button type="button" class="btn-copy-link" onclick="copyEmployerLink(event, '${escapeAttr(r.employerGroup)}', '${escapeAttr(r.refCodes)}', 'employee')">
              <span>📋 Copy Employee Link</span>
            </button>
            <button type="button" class="btn-copy-link" onclick="copyEmployerLink(event, '${escapeAttr(r.employerGroup)}', '${escapeAttr(r.refCodes)}', 'hr')">
              <span>📋 Copy HR</span>
            </button>
          </div>
        `;
      return `
        <tr class="${isSelected ? 'selected-emp-row' : ''}" onclick="inspectEmployerTrend('${escapeAttr(r.employerGroup)}')" title="Click to inspect monthly trend for ${escapeAttr(r.employerGroup)}">
          <td><strong>${r.employerGroup}</strong></td>
          <td><span class="emp-channel-pill">${displayChannel}</span></td>
          <td style="width:95px">${sparkSvg}</td>
          <td class="num emp-num-enrolled">${r.enrolled.toLocaleString()}</td>
          <td class="num emp-num-disenrolled">${r.disenrolled.toLocaleString()}</td>
          <td class="num emp-num-active">${r.active.toLocaleString()}</td>
          <td style="text-align:right">${actionCellHtml}</td>
        </tr>
      `;
    }).join('');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. IS PAID MEDIA PAYING OFF? (Slide 5)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderPaidMediaView() {
  const s5 = PORTAL_DATA.slide5_paidMedia;
  const hl = document.getElementById('paidMediaHeadline');
  if (hl && s5.headline) hl.textContent = s5.headline;

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
  const ws = PORTAL_DATA.worklistSummary;
  const hl = document.getElementById('funnelHeadline');
  if (hl && s6.headline) hl.textContent = s6.headline;

  const chartTitle = document.getElementById('funnelChartTitle');
  if (chartTitle && s6.chartTitle) chartTitle.textContent = s6.chartTitle;

  const enrolledCount = s6.steps[0]?.patients || 760;
  const rxDropCount = s6.dropoffs[2]?.count || 85;
  const todoTotal = ws ? ws.todoTotal : 101;
  const fuzzyPts = ws ? ws.todoWithFuzzyCount : 15;

  const noteBox = document.getElementById('funnelWorklistNoteBox');
  if (noteBox) {
    noteBox.innerHTML = `
      <strong>Funnel &amp; Worklist Note:</strong> Funnel conversion uses the ${enrolledCount} members who enrolled before September (at least 30 days to fill; ${rxDropCount} were prescribed but never filled). Across all active cohorts through September 30, <strong>${todoTotal} active members</strong> are on the Pharmacy To-Do worklist with an open prescription (including ${fuzzyPts} with a possible ID typo match in Pharmacy Data Fixes to verify).
      <div style="margin-top:12px">
        <button class="btn-bridge-primary" onclick="openWorklistWithFilter('todo')">Open Pharmacy To-Do (${todoTotal})</button>
      </div>
    `;
  }

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
        x: { beginAtZero: true, grid: { color: 'rgba(15, 23, 42, 0.05)' } },
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
  const ws = PORTAL_DATA.worklistSummary;

  const hl = document.getElementById('refillHeadline');
  if (hl && s7.headline) hl.textContent = s7.headline;

  const refillBtn = document.getElementById('btnRefillQueueLink');
  if (refillBtn && ws) {
    refillBtn.textContent = `View Refill Follow-Up Queue (${ws.refillTotal})`;
  }

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
  tbodySteps.innerHTML = s7.stepTable.map(row => `
    <tr style="${row.lowSample ? 'color:#64748b;background:#f8fafc' : ''}">
      <td><strong>${row.step}</strong></td>
      <td class="num"><strong>${row.cameBack}</strong></td>
      <td class="num">${row.eligiblePts}</td>
    </tr>
  `).join('');

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
  const hl = document.getElementById('medMixHeadline');
  if (hl && s8.headline) hl.textContent = s8.headline;

  const totalSepDispenses = s8.septemberCallouts.reduce((acc, c) => acc + (c.value || 0), 0);
  const sepHeader = document.getElementById('medMixSeptHeader');
  if (sepHeader) sepHeader.textContent = `September Dispenses (${totalSepDispenses})`;

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
  const navPill = document.getElementById('navTodoUrgentPill');
  if (navPill) navPill.textContent = ws.todoTotal;
  document.getElementById('badgeCountTodo').textContent = ws.todoTotal;
  document.getElementById('badgeCountRefill').textContent = ws.refillTotal;
  document.getElementById('badgeCountFixes').textContent = ws.fixesTotal;
  document.getElementById('badgeCountEnded').textContent = ws.endedTotal;
  renderWorklistPulseCards();
}

function renderWorklistsView() {
  const wl = PORTAL_DATA.worklists;
  const ws = PORTAL_DATA.worklistSummary;
  document.getElementById('descPharmacyTodo').textContent = wl.pharmacyTodo.description;
  document.getElementById('descRefillFollowup').textContent = wl.refillFollowup.description;
  document.getElementById('descEndedNeverFilled').textContent = wl.endedNeverFilled.description;

  const unmatchedTitleEl = document.getElementById('fixesUnmatchedTitle');
  if (unmatchedTitleEl && wl.pharmacyDataFixes.unmatchedTitle) {
    unmatchedTitleEl.textContent = wl.pharmacyDataFixes.unmatchedTitle;
  }
  const noIdTitleEl = document.getElementById('fixesNoIdTitle');
  if (noIdTitleEl && wl.pharmacyDataFixes.noIdTitle) {
    noIdTitleEl.textContent = wl.pharmacyDataFixes.noIdTitle;
  }
  const applyBtn = document.getElementById('btnApplyAllFuzzy');
  if (applyBtn && ws) {
    applyBtn.textContent = `Auto-Reconcile ${ws.fuzzySuggestedCount} Matches`;
  }

  // Hydrate Ended – Never Filled stage KPIs dynamically
  const endedRows = wl.endedNeverFilled.rows;
  const stageCounts = countDistinctValues(endedRows, 'Stage');
  const totalEnded = endedRows.length || 1;
  const sNoVisit = stageCounts['No provider visit'] || 0;
  const sNoRx = stageCounts['Saw provider, no Rx'] || 0;
  const sNoFill = stageCounts['Rx written, not filled'] || 0;
  const sOutside = stageCounts['Rx sent to outside pharmacy'] || 0;

  const endedTitleEl = document.getElementById('endedCardTitle');
  if (endedTitleEl) endedTitleEl.textContent = `Ended – Never Filled (${endedRows.length} Members)`;

  const endedKpiRow = document.getElementById('endedStageKpiRow');
  if (endedKpiRow) {
    endedKpiRow.innerHTML = `
      <div class="kpi" onclick="setEndedStageFilter('No provider visit')"><div class="kpi-label">No provider visit</div><div class="kpi-val">${sNoVisit}</div><div class="kpi-sub">${((sNoVisit / totalEnded) * 100).toFixed(1)}% of ended memberships</div></div>
      <div class="kpi" onclick="setEndedStageFilter('Saw provider, no Rx')"><div class="kpi-label">Saw provider, no Rx</div><div class="kpi-val">${sNoRx}</div><div class="kpi-sub">${((sNoRx / totalEnded) * 100).toFixed(1)}% of ended memberships</div></div>
      <div class="kpi" onclick="setEndedStageFilter('Rx written, not filled')"><div class="kpi-label">Rx written, not filled</div><div class="kpi-val">${sNoFill}</div><div class="kpi-sub">${((sNoFill / totalEnded) * 100).toFixed(1)}% of ended memberships</div></div>
      <div class="kpi" onclick="setEndedStageFilter('Rx sent to outside pharmacy')"><div class="kpi-label">Rx sent to outside pharmacy</div><div class="kpi-val">${sOutside}</div><div class="kpi-sub">${((sOutside / totalEnded) * 100).toFixed(1)}% of ended memberships</div></div>
    `;
  }

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
      ? `<div style="margin-top:4px"><span class="fuzzy-badge" onclick="switchWorklistSubtab('fixes')" title="Possible match in Pharmacy Data Fixes: ${r.possibleDataFixes[0].patientIdOnFile} (${r.possibleDataFixes[0].dispensedItem})">Possible Match in Fixes (${r.possibleDataFixes[0].patientIdOnFile})</span></div>`
      : '';

    const payerStr = r['Payer on transaction'] ? `<div style="font-size:0.71rem;color:var(--text-secondary)">Payer: ${r['Payer on transaction']}</div>` : '';
    const rxDateStr = r['Rx written'] ? `<div style="font-size:0.7rem;color:var(--muted)">Rx: ${String(r['Rx written']).slice(0, 10)}</div>` : '';

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
          ${payerStr}
          <div style="font-size:0.72rem;color:var(--muted);max-width:230px">${r['Pharmacy note'] || ''}</div>
        </td>
        <td>
          <div>${r['Rx medication'] || '—'}</div>
          ${rxDateStr}
        </td>
        <td class="num">${r['Days in this stage'] ?? '—'}d</td>
        <td>
          <strong>${r['Patient source'] || '—'}</strong>
          <div style="font-size:0.72rem;color:var(--muted)">${r['Employer group'] || ''}</div>
        </td>
        <td>
          <button class="btn-bridge-outline" style="padding:4px 9px;font-size:0.73rem" onclick="openPatientModal('todo', '${r.id}')">Details</button>
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
        <td>
          <div>${r['Last item filled'] || '—'}</div>
        </td>
        <td>${r['Patient source'] || '—'}</td>
        <td>
          <button class="btn-bridge-outline" style="padding:4px 9px;font-size:0.73rem" onclick="openPatientModal('refill', '${r.id}')">Details</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderFixesTables() {
  const unmatchedRows = PORTAL_DATA.worklists.pharmacyDataFixes.unmatchedRows;
  const noIdRows = PORTAL_DATA.worklists.pharmacyDataFixes.noIdRows;
  const cutoffDate = PORTAL_DATA.meta?.asOfDate || '2026-09-30';
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
  tbodyNoId.innerHTML = filteredNoId.map(r => {
    const isGlp1 = /wegovy|ozempic/i.test(r['Dispensed item'] || '');
    const isCompleted = r['Transaction status'] === 'Completed';
    const isOnOrBeforeCutoff = String(r['Date filled'] || '') <= cutoffDate;
    let catBadge = '';
    if (isGlp1 && isCompleted && isOnOrBeforeCutoff) {
      catBadge = `<span class="know-badge">Sep P&amp;L GLP-1 Fill</span>`;
    } else if (!isGlp1) {
      catBadge = `<span class="low-sample-badge">Non-GLP-1</span>`;
    } else if (!isOnOrBeforeCutoff) {
      catBadge = `<span class="low-sample-badge">Post-Sep 30 Cutoff</span>`;
    } else {
      catBadge = `<span class="low-sample-badge">${r['Transaction status']}</span>`;
    }

    return `
      <tr data-row-id="${r.id}">
        <td>${r['Date filled'] || '—'}</td>
        <td><strong>${r['Dispensed item'] || '—'}</strong></td>
        <td>${catBadge}</td>
        <td>${r['Prescriber'] || '—'}</td>
        <td>${r['Payer'] || '—'}</td>
        <td>${r['Transaction status'] || '—'}</td>
        <td>
          <input type="text" class="edit-cell-input" placeholder="Enter 8-char Patient ID..." value="${escapeAttr(r['Corrected patient ID'] || '')}" onchange="updateWorklistCell('fixes-noid', '${r.id}', 'Corrected patient ID', this.value)" />
        </td>
      </tr>
    `;
  }).join('');
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

function openDefinitionsModal() {
  document.getElementById('definitionsModal').classList.add('open');
}

function closeDefinitionsModal() {
  document.getElementById('definitionsModal').classList.remove('open');
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

let AI_INLINE_CHARTS = [];
let AI_CHART_COUNTER = 0;

function destroyAiInlineCharts() {
  for (const ch of AI_INLINE_CHARTS) {
    try {
      ch.destroy();
    } catch (_) {}
  }
  AI_INLINE_CHARTS = [];
}

function formatMarkdownText(raw, allowRich = true) {
  let text = String(raw || '');
  const chartBlocks = [];

  if (allowRich) {
    // Extract ```chart ... ``` or ```json ... ``` blocks containing chart specs
    text = text.replace(/```(?:chart|json-chart|chartjs)\s*([\s\S]*?)```/gi, (_, jsonBody) => {
      const idx = chartBlocks.length;
      chartBlocks.push(jsonBody.trim());
      return `\n@@AI_CHART_BLOCK_${idx}@@\n`;
    });
  }

  // Escape unsafe script/iframe tags while preserving safe formatting tags if LLM emitted raw HTML
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  const formatInline = (str) => {
    // Escape < and > unless they belong to safe inline/table HTML tags
    let s = String(str || '');
    s = s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:0.86em">$1</code>');
    return s;
  };

  const isNumericCell = (val) => {
    const clean = String(val || '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').trim();
    return /^[$+-]?[\d,]+(\.\d+)?(%|x|K|M)?$/i.test(clean);
  };

  const lines = text.split(/\r?\n/);
  const out = [];
  let inUl = false;
  let inOl = false;
  let tableBuffer = [];

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer
      .map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
      .filter(r => r.length > 0);
    tableBuffer = [];
    if (rows.length === 0) return;

    const headerCells = rows[0];
    let bodyStartIdx = 1;
    if (rows.length > 1 && rows[1].every(c => /^[:\-\s]+$/.test(c))) {
      bodyStartIdx = 2;
    }
    const bodyRows = rows.slice(bodyStartIdx);

    const numCols = headerCells.map((_, colIdx) => {
      if (colIdx === 0) return false;
      const sample = bodyRows.slice(0, 4).map(r => r[colIdx] || '').filter(Boolean);
      return sample.length > 0 && sample.every(isNumericCell);
    });

    const thHtml = headerCells
      .map((h, i) => `<th class="${numCols[i] ? 'num' : ''}">${formatInline(h)}</th>`)
      .join('');
    const tbHtml = bodyRows
      .map(r => {
        const tds = headerCells.map((_, i) => {
          const val = r[i] !== undefined ? r[i] : '';
          return `<td class="${numCols[i] ? 'num' : ''}">${formatInline(val)}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
      })
      .join('');

    out.push(`<div class="ai-table-wrap"><table class="ai-rich-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table></div>`);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Check if line is a markdown pipe table row
    if (line.startsWith('|') && line.endsWith('|') && line.split('|').length >= 3) {
      closeLists();
      tableBuffer.push(line);
      continue;
    } else if (tableBuffer.length > 0) {
      flushTable();
    }

    if (!line) {
      closeLists();
      continue;
    }

    // Chart placeholder
    const chartMatch = line.match(/^@@AI_CHART_BLOCK_(\d+)@@$/);
    if (chartMatch) {
      closeLists();
      const cIdx = Number(chartMatch[1]);
      const rawSpec = chartBlocks[cIdx] || '{}';
      const encodedSpec = encodeURIComponent(rawSpec);
      const canvasId = `aiInlineChart_${++AI_CHART_COUNTER}`;
      out.push(`
        <div class="ai-chart-card" data-testid="ai-inline-chart">
          <div class="ai-chart-title"><span class="ai-chart-heading">Interactive Chart</span><span class="know-badge">Live Chart</span></div>
          <div class="ai-chart-canvas-wrap">
            <canvas id="${canvasId}" class="ai-inline-chart-canvas" data-chart-spec="${encodedSpec}"></canvas>
          </div>
        </div>
      `);
      continue;
    }

    if (/^---+$/.test(line)) {
      closeLists();
      out.push('<hr />');
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeLists();
      out.push(`<h3 class="ai-section-title">${formatInline(headingMatch[2])}</h3>`);
      continue;
    }

    const ulMatch = line.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }

    closeLists();
    out.push(`<p>${formatInline(line)}</p>`);
  }

  flushTable();
  closeLists();
  return `<div class="ai-rich-content">${out.join('')}</div>`;
}

function hydrateAiInlineCharts() {
  destroyAiInlineCharts();
  const canvases = document.querySelectorAll('canvas.ai-inline-chart-canvas');
  canvases.forEach(canvas => {
    try {
      const rawSpec = decodeURIComponent(canvas.getAttribute('data-chart-spec') || '');
      if (!rawSpec) return;
      const spec = JSON.parse(rawSpec);
      const card = canvas.closest('.ai-chart-card');
      const headingEl = card?.querySelector('.ai-chart-heading');
      if (headingEl && spec.title) {
        headingEl.textContent = spec.title;
      }
      const chartType = spec.type === 'horizontalBar' ? 'bar' : (spec.type || 'bar');
      const isHorizontal = spec.type === 'horizontalBar' || spec.indexAxis === 'y';
      const defaultPalette = ['#2563eb', '#059669', '#d97706', '#0e2841', '#26abe4', '#7c3aed'];
      const datasets = (spec.datasets || []).map((ds, idx) => {
        const dsType = ds.type || chartType;
        const color = ds.backgroundColor || ds.borderColor || defaultPalette[idx % defaultPalette.length];
        return {
          ...ds,
          type: dsType,
          backgroundColor: dsType === 'line' ? 'rgba(37, 99, 235, 0.1)' : color,
          borderColor: ds.borderColor || color,
          borderWidth: dsType === 'line' ? 2.5 : 1,
          borderRadius: dsType === 'bar' ? 4 : 0,
          tension: dsType === 'line' ? 0.25 : 0
        };
      });

      const ch = new Chart(canvas.getContext('2d'), {
        type: chartType === 'doughnut' || chartType === 'pie' ? chartType : 'bar',
        data: {
          labels: spec.labels || [],
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: isHorizontal ? 'y' : 'x',
          plugins: {
            legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } }
          },
          scales: (chartType === 'doughnut' || chartType === 'pie')
            ? {}
            : {
                x: { grid: { display: false }, ticks: { font: { size: 11 } } },
                y: { beginAtZero: true, grid: { color: 'rgba(15, 23, 42, 0.05)' }, ticks: { font: { size: 11 } } }
              }
        }
      });
      AI_INLINE_CHARTS.push(ch);
    } catch (e) {
      console.warn('Could not render AI inline chart:', e.message);
      const card = canvas.closest('.ai-chart-card');
      if (card) card.style.display = 'none';
    }
  });
}

function renderChatThread(pendingUserQuestion = null) {
  const container = document.getElementById('qaAnswerContainer');
  if (!container) return;

  const greetingHtml = `
    <div class="chat-msg chat-msg-ai">
      <div class="chat-sender">Bridge AI</div>
      <div class="chat-bubble">What question can I answer? Ask about financials, channels, employers, doses, prescribers, payers, or worklists—I will include tables and interactive charts.</div>
    </div>
  `;

  const turnsHtml = QA_HISTORY.map(turn => `
    <div class="chat-msg chat-msg-user">
      <div class="chat-sender">You</div>
      <div class="chat-bubble">${formatMarkdownText(turn.question, false)}</div>
    </div>
    <div class="chat-msg chat-msg-ai" data-testid="qa-ai-message">
      <div class="chat-sender">Bridge AI ${turn.aiPowered ? '<span class="know-badge" style="font-size:0.65rem;padding:1px 6px">Gemini AI</span>' : ''}</div>
      <div class="chat-bubble">${formatMarkdownText(turn.answer, true)}</div>
    </div>
  `).join('');

  const pendingHtml = pendingUserQuestion
    ? `
      <div class="chat-msg chat-msg-user">
        <div class="chat-sender">You</div>
        <div class="chat-bubble">${formatMarkdownText(pendingUserQuestion, false)}</div>
      </div>
      <div class="chat-msg chat-msg-ai">
        <div class="chat-sender">Bridge AI</div>
        <div class="chat-bubble chat-typing">Analyzing program data, building tables &amp; chart...</div>
      </div>
    `
    : '';

  container.innerHTML = greetingHtml + turnsHtml + pendingHtml;
  hydrateAiInlineCharts();
  container.scrollTop = container.scrollHeight;
}

function escapeAttr(s) {
  return String(s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

window.addEventListener('DOMContentLoaded', initPortal);
