/* Bridge Health Hub — Multi-Client GLP-1 Weight Loss Program Interactive Portal */

let PORTAL_DATA = null;
let CURRENT_VIEW = 'summary';
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

let CURRENT_USER_PROFILE = null;
let ADMIN_PREVIEW_MODE = false;
let LAST_REPORT_STATUS = null;

async function loadPortalDataAndRefreshUI(previewMode = false, silent = false) {
  if (!CURRENT_USER_PROFILE) {
    try {
      const meResp = await fetch('/api/auth/me');
      if (meResp.ok) CURRENT_USER_PROFILE = await meResp.json();
    } catch (_) {}
  }
  ADMIN_PREVIEW_MODE = Boolean(previewMode && CURRENT_USER_PROFILE?.isBridgeAdmin);
  const qs = [];
  if (ADMIN_PREVIEW_MODE) qs.push('preview=1');
  if (silent) qs.push('silent=1');
  const url = '/api/portal-data' + (qs.length ? `?${qs.join('&')}` : '');
  const resp = await fetch(url);
  if (resp.status === 401) {
    window.location.href = '/login';
    return;
  }
  ADMIN_PREVIEW_MODE = resp.headers.get('X-Bridge-Preview-Mode') === '1';
  PORTAL_DATA = await resp.json();
  if (CURRENT_USER_PROFILE?.isBridgeAdmin) {
    try {
      const stResp = await fetch('/api/admin/report-status');
      if (stResp.ok) LAST_REPORT_STATUS = await stResp.json();
    } catch (_) {}
  }
  hydrateShellBranding();
  renderAllViews();
  updateAdminPreviewBannerUI();
}

function updateAdminPreviewBannerUI() {
  const banner = document.getElementById('adminPreviewBanner');
  if (!banner) return;
  if (!CURRENT_USER_PROFILE?.isBridgeAdmin || !LAST_REPORT_STATUS?.hasDraft) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';
  const badge = document.getElementById('adminPreviewModeBadge');
  const txt = document.getElementById('adminPreviewBannerText');
  const btnToggle = document.getElementById('btnBannerTogglePreview');
  const draftSum = LAST_REPORT_STATUS.draft || {};
  const draftAsOf = draftSum.asOfDateFormatted || 'New Report';

  if (ADMIN_PREVIEW_MODE) {
    banner.style.background = 'linear-gradient(90deg,#fffbeb,#fef3c7)';
    banner.style.borderBottom = '2px solid #f59e0b';
    if (badge) {
      badge.textContent = 'PREVIEW MODE (STAGED DRAFT)';
      badge.style.background = '#d97706';
    }
    if (txt) {
      txt.textContent = `Previewing staged report through ${draftAsOf} (${draftSum.activeMembersFmt || draftSum.activeMembers || ''} active members, ${draftSum.fillsFmt || draftSum.fills || ''} fills, ${draftSum.ytdProceedsFmt || ''} YTD proceeds). Client users still see the live published report.`;
    }
    if (btnToggle) {
      btnToggle.textContent = 'Switch to Live Published View';
    }
  } else {
    banner.style.background = 'linear-gradient(90deg,#eff6ff,#dbeafe)';
    banner.style.borderBottom = '2px solid #3b82f6';
    if (badge) {
      badge.textContent = 'STAGED DRAFT READY';
      badge.style.background = '#2563eb';
    }
    if (txt) {
      txt.textContent = `A staged monthly report draft (${draftAsOf}) is ready for review. You are currently viewing the live published report.`;
    }
    if (btnToggle) {
      btnToggle.textContent = 'Enter Preview Mode';
    }
  }
}

async function initPortal() {
  try {
    const [resp, meResp] = await Promise.all([
      fetch('/api/portal-data'),
      fetch('/api/auth/me')
    ]);
    if (resp.status === 401 || meResp.status === 401) {
      window.location.href = '/login';
      return;
    }
    PORTAL_DATA = await resp.json();
    if (meResp.ok) {
      CURRENT_USER_PROFILE = await meResp.json();
      const userBadge = document.getElementById('badgeCurrentUser');
      if (userBadge && CURRENT_USER_PROFILE) {
        userBadge.textContent = `${CURRENT_USER_PROFILE.displayName || CURRENT_USER_PROFILE.user} (${CURRENT_USER_PROFILE.user})`;
      }
      if (CURRENT_USER_PROFILE?.isBridgeAdmin) {
        try {
          const stResp = await fetch('/api/admin/report-status');
          if (stResp.ok) LAST_REPORT_STATUS = await stResp.json();
        } catch (_) {}
      }
    }
    hydrateShellBranding();
    renderAllViews();
    updateAdminPreviewBannerUI();
    renderChatThread();
    startIdleAutoLogoffTimer();
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
    const cutoffMonth = meta.cutoffMonthName || 'September';
    heroSubtext.textContent = `${activeVal.toLocaleString()} active ${cutoffMonth} members · ${fillsVal.toLocaleString()} ${cutoffMonth} GLP-1 fills · $${sepProc.toLocaleString()} ${cutoffMonth} proceeds (${ytdProc} YTD)`;
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
  renderAppendixView();
}

const VIEW_TITLES = {
  summary: 'Executive Overview',
  financials: 'Program Financials & P&L',
  sources: 'Patient Sources & Channel Economics',
  paidmedia: 'Paid Media ROI & Cohort Performance',
  funnel: 'First-Fill Conversion Funnel',
  refill: 'Refills & Cohort Retention',
  medmix: 'Medication & Fulfillment Mix',
  ask: 'Ask Bridge AI'
};

function trackClientAuditEvent(eventType, details = {}) {
  try {
    fetch('/api/security/audit-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, details })
    }).catch(() => {});
  } catch (_) {}
}

function switchView(viewId) {
  const resolvedViewId = viewId === 'worklist' ? 'funnel' : viewId;
  const changed = CURRENT_VIEW !== resolvedViewId;
  CURRENT_VIEW = resolvedViewId;
  document.querySelectorAll('#sidebarNav .nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === resolvedViewId);
  });
  document.querySelectorAll('.view').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${resolvedViewId}`);
  });
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl && VIEW_TITLES[resolvedViewId]) {
    titleEl.textContent = VIEW_TITLES[resolvedViewId];
  }
  if (changed) {
    trackClientAuditEvent('SECTION_VIEW', {
      viewId: resolvedViewId,
      viewTitle: VIEW_TITLES[resolvedViewId] || resolvedViewId
    });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    <div class="know-item" onclick="switchView('${item.targetView === 'worklist' ? 'funnel' : item.targetView}')">
      <div class="know-item-text">
        <strong>${item.title}</strong> ${item.body}
      </div>
      <span class="know-badge">${item.badge}</span>
    </div>
  `).join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. PROGRAM FINANCIALS & P&L (Slide 3)
   ═══════════════════════════════════════════════════════════════════════════ */
function renderFinancialsView() {
  const s3 = PORTAL_DATA.slide3_financials;

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
  tbody.innerHTML = s4.table.map(row => `
    <tr>
      <td><strong>${row.source}</strong></td>
      <td class="num">${row.enrolledSept}</td>
      <td class="num">${row.enrolledYtd}</td>
      <td class="num">${row.share}</td>
      <td class="num"><strong>${row.filled1stRx}</strong></td>
      <td class="num">${row.refilled1to2}</td>
      <td class="num">${row.glp1Fills.toLocaleString()}</td>
      <td class="num"><strong>${row.grossMarginFmt}</strong></td>
    </tr>
  `).join('');

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
  const hl = document.getElementById('funnelHeadline');
  if (hl && s6.headline) hl.textContent = s6.headline;

  const chartTitle = document.getElementById('funnelChartTitle');
  if (chartTitle && s6.chartTitle) chartTitle.textContent = s6.chartTitle;

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
    <div class="dropoff-card" style="cursor:default">
      <div class="dropoff-num">${d.count}</div>
      <div class="dropoff-lbl">${d.label}</div>
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

  const hl = document.getElementById('refillHeadline');
  if (hl && s7.headline) hl.textContent = s7.headline;

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

function openDefinitionsModal() {
  trackClientAuditEvent('DEFINITIONS_VIEW', { modal: 'Program Definitions & Data Notes' });
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
        history: QA_HISTORY.slice(-10),
        preview: ADMIN_PREVIEW_MODE
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
    let s = String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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
      <div class="chat-bubble">What question can I answer? Ask about program financials, patient sources, paid media ROI, first-fill funnel conversion, refill persistence, cohort retention, or medication mix—I will include tables and interactive charts.</div>
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

/* ═══════════════════════════════════════════════════════════════════════════
   10. ENTERPRISE SECURITY, NAMED USERS, USAGE, AI Q&A HISTORY & AUDIT LOG
   ═══════════════════════════════════════════════════════════════════════════ */
let IDLE_TIMER_HANDLE = null;
const IDLE_TIMEOUT_CLIENT_MS = 30 * 60 * 1000;
let LAST_SECURITY_OVERVIEW = null;
let CURRENT_SEC_BOTTOM_TAB = 'audit';
const EXPANDED_QA_IDS = new Set();

function startIdleAutoLogoffTimer() {
  const resetIdle = () => {
    if (IDLE_TIMER_HANDLE) clearTimeout(IDLE_TIMER_HANDLE);
    IDLE_TIMER_HANDLE = setTimeout(() => {
      logoutPortal();
    }, IDLE_TIMEOUT_CLIENT_MS);
  };
  ['mousemove', 'keydown', 'click', 'scroll'].forEach(evt => {
    window.addEventListener(evt, resetIdle, { passive: true });
  });
  resetIdle();
}

async function openSecurityModal() {
  const modal = document.getElementById('securityModal');
  if (modal) modal.classList.add('open');
  await refreshSecurityModalData();
}

function closeSecurityModal() {
  const modal = document.getElementById('securityModal');
  if (modal) modal.classList.remove('open');
}

function switchSecurityBottomTab(tab) {
  CURRENT_SEC_BOTTOM_TAB = tab === 'qa' ? 'qa' : 'audit';
  const btnAudit = document.getElementById('secBottomTabBtnAudit');
  const btnQa = document.getElementById('secBottomTabBtnQa');
  const panelAudit = document.getElementById('secBottomPanelAudit');
  const panelQa = document.getElementById('secBottomPanelQa');

  if (btnAudit) {
    btnAudit.className = CURRENT_SEC_BOTTOM_TAB === 'audit' ? 'btn-bridge-primary' : 'btn-bridge-outline';
  }
  if (btnQa) {
    btnQa.className = CURRENT_SEC_BOTTOM_TAB === 'qa' ? 'btn-bridge-primary' : 'btn-bridge-outline';
  }
  if (panelAudit) panelAudit.style.display = CURRENT_SEC_BOTTOM_TAB === 'audit' ? 'block' : 'none';
  if (panelQa) panelQa.style.display = CURRENT_SEC_BOTTOM_TAB === 'qa' ? 'block' : 'none';
}

function formatShortTimestamp(iso) {
  if (!iso) return 'Never';
  return String(iso).replace('T', ' ').slice(0, 19) + ' UTC';
}

async function refreshSecurityModalData() {
  try {
    const resp = await fetch('/api/security/overview');
    if (!resp.ok) return;
    const data = await resp.json();
    LAST_SECURITY_OVERVIEW = data;

    const cur = data.currentUser || {};
    const isBridgeAdmin = Boolean(data.isBridgeAdmin);
    CURRENT_USER_PROFILE = {
      ...(CURRENT_USER_PROFILE || {}),
      user: cur.username,
      displayName: cur.displayName,
      role: cur.role,
      isBridgeAdmin
    };
    const userBadge = document.getElementById('badgeCurrentUser');
    if (userBadge && cur.username) {
      userBadge.textContent = `${cur.displayName || cur.username} (${cur.username})`;
    }
    const meUserRec = (data.users || []).find(u => u.username.toLowerCase() === String(cur.username || '').toLowerCase());
    const lbl = document.getElementById('secCurrentUserLabel');
    if (lbl) {
      lbl.textContent = `Signed in as ${cur.displayName || cur.username} (${cur.username}) · Role: ${cur.role || 'client_user'}`;
    }

    // Populate Executive Usage KPI Row
    const us = data.usageSummary || {};
    const elLogins = document.getElementById('secKpiLogins');
    const elOnlineSub = document.getElementById('secKpiOnlineSub');
    const elViews = document.getElementById('secKpiViews');
    const elAiQueries = document.getElementById('secKpiAiQueries');
    const elExports = document.getElementById('secKpiExports');

    if (elLogins) elLogins.textContent = String(us.totalLogins ?? 0);
    if (elOnlineSub) elOnlineSub.textContent = `${us.activeUsersOnline ?? 1} of ${us.totalNamedUsers ?? 1} active now`;
    if (elViews) elViews.textContent = String(us.totalPageAndPatientViews ?? 0);
    if (elAiQueries) elAiQueries.textContent = String(us.totalAiQuestions ?? 0);
    if (elExports) elExports.textContent = String(us.totalExports ?? 0);

    const btnExpAudit = document.getElementById('btnExportAuditCsv');
    const btnExpQa = document.getElementById('btnExportQaCsv');
    if (btnExpAudit) btnExpAudit.style.display = isBridgeAdmin ? 'inline-block' : 'none';
    if (btnExpQa) btnExpQa.style.display = isBridgeAdmin ? 'inline-block' : 'none';

    const mfaSel = document.getElementById('secMyMfaMethod');
    const mfaEmail = document.getElementById('secMyMfaEmail');
    const secretBox = document.getElementById('secMyTotpSecretBox');
    const secretCode = document.getElementById('secMyTotpSecretCode');
    const secretQrImg = document.getElementById('secMyTotpQrImg');
    if (meUserRec) {
      if (mfaSel) mfaSel.value = meUserRec.mfaMethod || 'email';
      if (mfaEmail) {
        mfaEmail.value = meUserRec.email || '';
        mfaEmail.readOnly = !isBridgeAdmin;
        mfaEmail.style.background = isBridgeAdmin ? '#ffffff' : '#f1f5f9';
      }
      if (secretBox && secretCode && meUserRec.totpSecret) {
        secretBox.style.display = 'block';
        secretCode.textContent = meUserRec.totpSecret;
        if (secretQrImg && meUserRec.totpQrDataUrl) {
          secretQrImg.src = meUserRec.totpQrDataUrl;
        }
      }
    }

    const createForm = document.getElementById('secCreateUserForm');
    const rbacNotice = document.getElementById('secRbacNoticeForNonAdmin');
    if (createForm && rbacNotice) {
      createForm.style.display = isBridgeAdmin ? 'grid' : 'none';
      rbacNotice.style.display = isBridgeAdmin ? 'none' : 'block';
    }

    const pptxCard = document.getElementById('secAdminPptxCard');
    if (pptxCard) {
      pptxCard.style.display = isBridgeAdmin ? 'block' : 'none';
      if (isBridgeAdmin) {
        await refreshAdminPptxStatusUI();
      }
    }

    const thActions = document.getElementById('thAdminUserActions');
    if (thActions) thActions.style.display = isBridgeAdmin ? 'table-cell' : 'none';

    const tbodyUsers = document.getElementById('tbodySecurityUsers');
    if (tbodyUsers) {
      tbodyUsers.innerHTML = (data.users || []).map(u => {
        const st = u.usage || {};
        const roleBadgeColor = u.role === 'bridge_admin'
          ? 'background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe'
          : (u.role === 'pharmacist' ? 'background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd' : 'background:#f1f5f9;color:#334155;border:1px solid #cbd5e1');
        const statusDot = st.isLockedOut
          ? `<span class="badge" style="background:#fee2e2;color:#991b1b;font-size:0.65rem">Locked Out</span>`
          : (st.isOnline ? `<span class="badge" style="background:#dcfce7;color:#166534;font-size:0.65rem">Online</span>` : '');
        const lastActStr = st.lastActiveAt ? formatShortTimestamp(st.lastActiveAt).slice(5, 16) + ' UTC' : 'No activity yet';

        const adminBtns = isBridgeAdmin ? `
          <td style="white-space:nowrap">
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              ${st.isLockedOut ? `<button type="button" class="btn-bridge-outline" style="padding:2px 7px;font-size:0.68rem;color:#b91c1c;border-color:#fca5a5" onclick="adminUnlockUserAccount('${escapeAttr(u.username)}')">Unlock</button>` : ''}
              <button type="button" class="btn-bridge-outline" style="padding:2px 7px;font-size:0.68rem" onclick="adminCycleUserRole('${escapeAttr(u.username)}', '${escapeAttr(u.role)}')" title="Cycle Role">Role</button>
              ${!u.isBuiltIn ? `<button type="button" class="btn-bridge-outline" style="padding:2px 7px;font-size:0.68rem;color:#b91c1c" onclick="adminDeleteUserAccount('${escapeAttr(u.username)}')">Remove</button>` : ''}
            </div>
          </td>
        ` : '';

        return `
          <tr data-username="${escapeAttr(u.username)}">
            <td>
              <div><strong>${escapeAttr(u.username)}</strong> ${statusDot}</div>
              <div style="margin-top:2px"><span class="badge" style="font-size:0.65rem;padding:1px 6px;${roleBadgeColor}">${escapeAttr(u.role || 'client_user')}</span></div>
            </td>
            <td>
              <div style="font-weight:600;font-size:0.78rem">${escapeAttr(u.displayName)}</div>
              <div style="font-size:0.73rem;color:#475569">${escapeAttr(u.email || '')}</div>
            </td>
            <td style="font-size:0.72rem;color:#334155">
              <div><strong>${st.loginCount || 0}</strong> logins · <strong>${st.viewCount || 0}</strong> views · <strong>${st.aiQueryCount || 0}</strong> AI</div>
              <div style="color:#64748b;font-size:0.69rem">Last active: ${escapeAttr(lastActStr)}</div>
            </td>
            <td><span style="color:#059669;font-weight:700;font-size:0.75rem">Mandatory (Email / App)</span></td>
            ${adminBtns}
          </tr>
        `;
      }).join('');
    }

    // Populate User Filter Dropdowns for Audit & Q&A Tabs
    const userNames = Array.from(new Set([
      ...(data.users || []).map(u => u.username),
      ...(data.auditEvents || []).map(e => e.user).filter(Boolean),
      ...(data.qaHistory || []).map(q => q.user).filter(Boolean)
    ]));
    const auditUserSel = document.getElementById('secAuditUserFilter');
    if (auditUserSel) {
      const prev = auditUserSel.value;
      auditUserSel.innerHTML = `<option value="">All Users (${userNames.length})</option>` +
        userNames.map(u => `<option value="${escapeAttr(u)}">${escapeAttr(u)}</option>`).join('');
      if (prev && userNames.includes(prev)) auditUserSel.value = prev;
    }
    const qaUserSel = document.getElementById('secQaUserFilter');
    if (qaUserSel) {
      const prev = qaUserSel.value;
      qaUserSel.innerHTML = `<option value="">All Users (${userNames.length})</option>` +
        userNames.map(u => `<option value="${escapeAttr(u)}">${escapeAttr(u)}</option>`).join('');
      if (prev && userNames.includes(prev)) qaUserSel.value = prev;
    }

    renderSecurityAuditTable();
    renderSecurityQaHistoryTable();
  } catch (err) {
    console.error('Error loading security overview:', err);
  }
}

function renderSecurityAuditTable() {
  if (!LAST_SECURITY_OVERVIEW) return;
  const allEvents = LAST_SECURITY_OVERVIEW.auditEvents || [];
  const catFilter = document.getElementById('secAuditCategoryFilter')?.value || '';
  const userFilter = (document.getElementById('secAuditUserFilter')?.value || '').toLowerCase();
  const q = (document.getElementById('secAuditSearchInput')?.value || '').toLowerCase().trim();

  const filtered = allEvents.filter(ev => {
    if (catFilter && ev.category !== catFilter) return false;
    if (userFilter && String(ev.user || '').toLowerCase() !== userFilter) return false;
    if (q) {
      const hay = `${ev.user} ${ev.displayName} ${ev.eventType} ${ev.summary || ''} ${JSON.stringify(ev.details || {})}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const badge = document.getElementById('secAuditCountBadge');
  if (badge) badge.textContent = `${filtered.length} Events`;

  const tbodyAudit = document.getElementById('tbodySecurityAuditLog');
  if (!tbodyAudit) return;

  const catBadgeStyle = (cat) => {
    if (cat === 'view_access') return 'background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd';
    if (cat === 'ai_qa') return 'background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe';
    return '';
  };

  tbodyAudit.innerHTML = filtered.map(ev => {
    const ts = ev.timestamp ? ev.timestamp.replace('T', ' ').slice(0, 19) + ' UTC' : '—';
    const summaryText = ev.summary || '';
    const detailsStr = ev.details ? JSON.stringify(ev.details) : '';
    return `
      <tr data-event-type="${escapeAttr(ev.eventType)}" data-event-category="${escapeAttr(ev.category || '')}">
        <td style="white-space:nowrap;font-size:0.73rem;color:#475569">${escapeAttr(ts)}</td>
        <td>
          <strong>${escapeAttr(ev.displayName || ev.user)}</strong>
          <div style="color:#64748b;font-size:0.7rem">(${escapeAttr(ev.user)})</div>
        </td>
        <td><span class="know-badge" style="${catBadgeStyle(ev.category)}">${escapeAttr(ev.eventType)}</span></td>
        <td style="font-size:0.73rem">${escapeAttr(ev.ip || '')} (${escapeAttr(ev.country || 'US')})</td>
        <td style="font-size:0.74rem;color:#1e293b;max-width:340px">
          <div style="font-weight:600">${escapeAttr(summaryText)}</div>
          <div style="font-size:0.69rem;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeAttr(detailsStr)}">${escapeAttr(detailsStr)}</div>
        </td>
      </tr>
    `;
  }).join('');
}

function toggleQaTranscriptExpand(qaId) {
  if (EXPANDED_QA_IDS.has(qaId)) EXPANDED_QA_IDS.delete(qaId);
  else EXPANDED_QA_IDS.add(qaId);
  renderSecurityQaHistoryTable();
}

function renderSecurityQaHistoryTable() {
  if (!LAST_SECURITY_OVERVIEW) return;
  const allQa = LAST_SECURITY_OVERVIEW.qaHistory || [];
  const userFilter = (document.getElementById('secQaUserFilter')?.value || '').toLowerCase();
  const q = (document.getElementById('secQaSearchInput')?.value || '').toLowerCase().trim();

  const filtered = allQa.filter(item => {
    if (userFilter && String(item.user || '').toLowerCase() !== userFilter) return false;
    if (q) {
      const hay = `${item.user} ${item.displayName} ${item.question} ${item.answer} ${item.aiModel}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const badge = document.getElementById('secQaCountBadge');
  if (badge) badge.textContent = `${filtered.length} Questions`;

  const tbodyQa = document.getElementById('tbodySecurityQaHistory');
  if (!tbodyQa) return;

  if (filtered.length === 0) {
    tbodyQa.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#64748b;padding:18px">No Ask Bridge AI questions recorded matching filter.</td></tr>`;
    return;
  }

  tbodyQa.innerHTML = filtered.map(item => {
    const ts = item.timestamp ? item.timestamp.replace('T', ' ').slice(0, 19) + ' UTC' : '—';
    const isExpanded = EXPANDED_QA_IDS.has(item.id);
    const ansPreview = String(item.answer || '').replace(/\s+/g, ' ').slice(0, 180);
    const answerHtml = isExpanded
      ? `<div style="margin-top:8px;padding:10px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;font-size:0.76rem">${formatMarkdownText(item.answer, false)}</div>`
      : `<div style="margin-top:4px;font-size:0.74rem;color:#475569">${escapeAttr(ansPreview)}${String(item.answer || '').length > 180 ? '...' : ''}</div>`;

    return `
      <tr data-qa-id="${escapeAttr(item.id)}">
        <td style="white-space:nowrap;font-size:0.73rem;color:#475569;vertical-align:top">${escapeAttr(ts)}</td>
        <td style="vertical-align:top">
          <strong>${escapeAttr(item.displayName || item.user)}</strong>
          <div style="color:#64748b;font-size:0.7rem">(${escapeAttr(item.user)})</div>
        </td>
        <td style="vertical-align:top;max-width:480px">
          <div style="font-weight:700;color:#0f172a;font-size:0.78rem">Q: ${escapeAttr(item.question)}</div>
          ${answerHtml}
          <button type="button" class="btn-bridge-outline" style="margin-top:6px;padding:2px 8px;font-size:0.69rem" onclick="toggleQaTranscriptExpand('${escapeAttr(item.id)}')">
            ${isExpanded ? 'Hide Full AI Response' : 'View Full AI Response'}
          </button>
        </td>
        <td style="vertical-align:top;font-size:0.72rem;white-space:nowrap">
          <span class="know-badge">${escapeAttr(item.aiModel || 'gemini')}</span>
          <div style="color:#64748b;margin-top:4px">${item.latencyMs ? `${item.latencyMs} ms` : ''}</div>
        </td>
      </tr>
    `;
  }).join('');
}

async function adminUnlockUserAccount(username) {
  try {
    const resp = await fetch(`/api/security/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlock: true })
    });
    if (resp.ok) {
      await refreshSecurityModalData();
    }
  } catch (err) {
    console.error('Error unlocking user:', err);
  }
}

async function adminCycleUserRole(username, currentRole) {
  const order = ['pharmacist', 'client_user', 'bridge_admin'];
  const nextRole = order[(order.indexOf(currentRole) + 1) % order.length];
  try {
    const resp = await fetch(`/api/security/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: nextRole })
    });
    if (resp.ok) {
      await refreshSecurityModalData();
    }
  } catch (err) {
    console.error('Error updating user role:', err);
  }
}

async function adminDeleteUserAccount(username) {
  try {
    const resp = await fetch(`/api/security/users/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    });
    if (resp.ok) {
      await refreshSecurityModalData();
    }
  } catch (err) {
    console.error('Error deleting user:', err);
  }
}

async function saveMyMfaSettings() {
  const mfaMethod = document.getElementById('secMyMfaMethod')?.value || 'email';
  const emailInput = document.getElementById('secMyMfaEmail');
  const payload = { mfaMethod };
  if (emailInput && !emailInput.readOnly && emailInput.value.trim()) {
    payload.email = emailInput.value.trim();
  }
  try {
    const resp = await fetch('/api/security/mfa-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      await refreshSecurityModalData();
    }
  } catch (err) {
    console.error('Error saving MFA config:', err);
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('secCurrentPassword').value;
  const newPassword = document.getElementById('secNewPassword').value;
  const msgEl = document.getElementById('secPasswordMsg');
  try {
    const resp = await fetch('/api/security/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      msgEl.style.color = '#059669';
      msgEl.textContent = 'Password updated!';
      document.getElementById('secCurrentPassword').value = '';
      document.getElementById('secNewPassword').value = '';
      await refreshSecurityModalData();
    } else {
      msgEl.style.color = '#b91c1c';
      msgEl.textContent = data.error || 'Failed to update password';
    }
  } catch (err) {
    msgEl.style.color = '#b91c1c';
    msgEl.textContent = 'Error updating password';
  }
}

async function handleCreateNamedUser(e) {
  e.preventDefault();
  const username = document.getElementById('newUserUsername').value.trim();
  const displayName = document.getElementById('newUserDisplayName').value.trim();
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole')?.value || 'pharmacist';
  const msgEl = document.getElementById('newUserMsg');
  try {
    const resp = await fetch('/api/security/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        displayName,
        email,
        password,
        role,
        mfaMethod: 'email'
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      msgEl.style.color = '#059669';
      msgEl.textContent = `Created ${data.user.username}!`;
      document.getElementById('newUserUsername').value = '';
      document.getElementById('newUserDisplayName').value = '';
      document.getElementById('newUserEmail').value = '';
      document.getElementById('newUserPassword').value = '';
      await refreshSecurityModalData();
    } else {
      msgEl.style.color = '#b91c1c';
      msgEl.textContent = data.error || 'Failed to create user';
    }
  } catch (err) {
    msgEl.style.color = '#b91c1c';
    msgEl.textContent = 'Error creating user';
  }
}

function exportSecurityAuditCsv() {
  window.location.href = '/api/security/export/audit-csv';
}

function exportSecurityQaCsv() {
  window.location.href = '/api/security/export/qa-csv';
}

function exportPortalTableCsv(tableKey) {
  const qs = ADMIN_PREVIEW_MODE ? '?preview=1' : '';
  window.location.href = `/api/export/csv/${encodeURIComponent(tableKey || 'financials')}${qs}`;
}

async function refreshAdminPptxStatusUI() {
  try {
    const resp = await fetch('/api/admin/report-status');
    if (!resp.ok) return;
    const status = await resp.json();
    LAST_REPORT_STATUS = status;
    updateAdminPreviewBannerUI();
    const pub = status.published || {};
    const draft = status.draft || null;

    const liveTitle = document.getElementById('pptxLiveSummaryTitle');
    const liveMetrics = document.getElementById('pptxLiveSummaryMetrics');
    if (liveTitle) liveTitle.textContent = `Through ${pub.asOfDateFormatted || 'September 30, 2026'}`;
    if (liveMetrics) {
      liveMetrics.textContent = `${pub.activeMembersFmt || pub.activeMembers || 0} active members · ${pub.fillsFmt || pub.fills || 0} fills · ${pub.ytdProceedsFmt || '$961,691'} YTD proceeds`;
    }

    const draftBox = document.getElementById('pptxDraftSummaryBox');
    const draftTitle = document.getElementById('pptxDraftSummaryTitle');
    const draftMetrics = document.getElementById('pptxDraftSummaryMetrics');
    const stagedBadge = document.getElementById('pptxStagedBadge');
    const actionBtns = document.getElementById('pptxDraftActionBtns');

    if (status.hasDraft && draft) {
      if (draftBox) {
        draftBox.style.background = '#fffbeb';
        draftBox.style.borderColor = '#f59e0b';
      }
      if (draftTitle) {
        draftTitle.style.color = '#92400e';
        draftTitle.textContent = `Through ${draft.asOfDateFormatted} (${draft.stagedFilename || 'Staged Report'})`;
      }
      if (draftMetrics) {
        draftMetrics.style.color = '#78350f';
        draftMetrics.textContent = `${draft.activeMembersFmt || draft.activeMembers || 0} active members · ${draft.fillsFmt || draft.fills || 0} fills · ${draft.ytdProceedsFmt || ''} YTD proceeds`;
      }
      if (stagedBadge) {
        stagedBadge.style.background = '#fef3c7';
        stagedBadge.style.color = '#92400e';
        stagedBadge.style.borderColor = '#f59e0b';
        stagedBadge.textContent = ADMIN_PREVIEW_MODE ? 'Previewing Staged Draft' : 'Staged Draft Ready';
      }
      if (actionBtns) actionBtns.style.display = 'flex';
    } else {
      if (draftBox) {
        draftBox.style.background = '#f8fafc';
        draftBox.style.borderColor = '#e2e8f0';
      }
      if (draftTitle) {
        draftTitle.style.color = '#64748b';
        draftTitle.textContent = 'No draft staged';
      }
      if (draftMetrics) {
        draftMetrics.style.color = '#64748b';
        draftMetrics.textContent = 'Upload a monthly report file below to preview before publishing';
      }
      if (stagedBadge) {
        stagedBadge.style.background = '#e0f2fe';
        stagedBadge.style.color = '#0369a1';
        stagedBadge.style.borderColor = '#bae6fd';
        stagedBadge.textContent = 'Live Report Only';
      }
      if (actionBtns) actionBtns.style.display = 'none';
    }
  } catch (err) {
    console.error('Error loading report status:', err);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read selected file.'));
    reader.readAsDataURL(file);
  });
}

async function handleUploadStagePptx() {
  const fileInput = document.getElementById('pptxFileInput');
  const msgEl = document.getElementById('pptxUploadStatusMsg');
  const btn = document.getElementById('btnUploadStagePptx');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    if (msgEl) {
      msgEl.style.color = '#b91c1c';
      msgEl.textContent = 'Please select a monthly report file first.';
    }
    return;
  }
  const file = fileInput.files[0];
  if (!/\.pptx$/i.test(file.name)) {
    if (msgEl) {
      msgEl.style.color = '#b91c1c';
      msgEl.textContent = 'Unsupported report file format.';
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Staging Report...';
    }
    if (msgEl) {
      msgEl.style.color = '#2563eb';
      msgEl.textContent = `Reading and validating '${file.name}'...`;
    }
    const fileBase64 = await readFileAsBase64(file);
    const resp = await fetch('/api/admin/upload-pptx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        fileBase64
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      if (msgEl) {
        msgEl.style.color = '#b91c1c';
        msgEl.textContent = data.error || 'Failed to stage monthly report.';
      }
      return;
    }

    if (msgEl) {
      msgEl.style.color = '#059669';
      msgEl.textContent = data.message || 'Staged monthly report in Preview Mode!';
    }
    fileInput.value = '';
    // Automatically switch admin session into Preview Mode so they can inspect all pages immediately
    await loadPortalDataAndRefreshUI(true, true);
    await refreshSecurityModalData();
  } catch (err) {
    if (msgEl) {
      msgEl.style.color = '#b91c1c';
      msgEl.textContent = err.message || 'Error uploading monthly report file.';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Upload & Stage Preview';
    }
  }
}

async function enterAdminPreviewAndCloseModal() {
  await loadPortalDataAndRefreshUI(true, true);
  closeSecurityModal();
}

async function toggleAdminPreviewMode() {
  const nextMode = !ADMIN_PREVIEW_MODE;
  await loadPortalDataAndRefreshUI(nextMode, true);
}

async function publishStagedPptxDraft() {
  const msgEl = document.getElementById('pptxUploadStatusMsg');
  try {
    const resp = await fetch('/api/admin/publish-pptx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      if (msgEl) {
        msgEl.style.color = '#b91c1c';
        msgEl.textContent = data.error || 'Failed to publish staged report.';
      }
      return;
    }
    if (msgEl) {
      msgEl.style.color = '#059669';
      msgEl.textContent = data.message || 'Published report to all users!';
    }
    await loadPortalDataAndRefreshUI(false, true);
    await refreshSecurityModalData();
  } catch (err) {
    console.error('Error publishing PPTX draft:', err);
  }
}

async function discardStagedPptxDraft() {
  const msgEl = document.getElementById('pptxUploadStatusMsg');
  try {
    const resp = await fetch('/api/admin/discard-pptx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      if (msgEl) {
        msgEl.style.color = '#b91c1c';
        msgEl.textContent = data.error || 'Failed to discard draft.';
      }
      return;
    }
    if (msgEl) {
      msgEl.style.color = '#475569';
      msgEl.textContent = data.message || 'Staged draft discarded.';
    }
    await loadPortalDataAndRefreshUI(false, true);
    await refreshSecurityModalData();
  } catch (err) {
    console.error('Error discarding PPTX draft:', err);
  }
}

window.addEventListener('DOMContentLoaded', initPortal);
