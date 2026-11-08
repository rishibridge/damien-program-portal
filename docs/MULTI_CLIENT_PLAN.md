# Multi-Client (Multi-CE) Architecture & Implementation Plan (v9 — `v2.4.0-multi-client`)

> [!IMPORTANT]
> **New in v9 (`v2.4.0-multi-client`) — Rich AI Formatting (HTML / Tables / Interactive Charts) & AllKin-Style Enrollment Reporting Redesign:**
> 1. **Rich HTML, Tables, KPI Cards & Interactive Charts in Ask Bridge AI Responses (`public/app.js`, `public/styles.css`, `server.js`)**:
>    - Replaced the plain text-only renderer in `public/app.js` with a rich executive renderer (`formatMarkdownText` + `hydrateAiInlineCharts`) that supports:
>      - **Styled Markdown & HTML Tables** (`<table>`, `<thead>`, `<tbody>`, numeric right-alignment, zebra striping, hover highlights)
>      - **Executive KPI Callout Cards & Badges** (inline metric grids and status pills)
>      - **Embedded Interactive Chart.js Charts** (` ```chart ... ``` ` JSON blocks automatically rendered as live interactive `bar`, `line`, `doughnut`, or `horizontalBar` charts inside the AI chat bubble)
>    - Updated `askGeminiWithFullData` and `answerQuestion` in `server.js` so responses automatically include structured **Markdown/HTML comparison tables** and **interactive Chart.js specifications** (` ```chart `) whenever comparing channels, monthly trends, financials, doses, prescribers, payers, or employers.
> 2. **Emulate the Attached 3-Page PDF Screenshot for the Enrollment Reporting Page (`view-enrollment` in `public/index.html`, `public/app.js`, `public/styles.css`)**:
>    - **Header Bar**: `<Client Name> — Utilization` title, date range subtitle (`Jan 2026 – Sep 2026 · Updated Sep 30, 2026`), and top-right **`Export CSV`** button.
>    - **Filter Bar**: Left-aligned `All Channels (6)` dropdown and `All Employers (39)` dropdown + right-aligned segmented timeframe pill buttons (`1M`, `3M`, `6M`, `All`) + synchronized `<select id="enrollTimeframeFilter">`.
>    - **4-Card Utilization KPI Row**:
>      1. **Total Enrolled** — Large green number (`#059669`, e.g. `1,036`), subtitle `Cumulative unique members`
>      2. **Active Members** — Large blue number (`#2563eb`, e.g. `862`), subtitle `Currently enrolled`
>      3. **Disenrolled** — Large dark slate number (`#0f172a`, e.g. `264`), subtitle `Ended subscriptions`
>      4. **Retention Rate** — Large dark slate percentage (`#0f172a`, e.g. `74.5%`), subtitle `Active of total enrolled`
>    - **Monthly Enrollment & Active Trend Card**:
>      - Mode toggle pills (`Trend` | `Top Employers`), granularity pills (`Monthly` | `Quarterly` | `Yearly`), and **`Export Chart CSV`** button.
>      - Legend header with colored indicators (`■ New Enrolled` in green `#16a34a`, `■ Disenrolled` in amber `#d97706`, `— Active Members` in royal blue `#2563eb`) + right-aligned summary (`Jan 2026: 25 → Sep 2026: 862 (+837)`).
>      - Combo Bar + Line Chart with **`Start · 25`** and **`End · 862`** callout badges.
>      - Collapsible **`⌄ View period table (9)`** drawer showing the month-by-month table inside the card.
>    - **By Channel & Broker Card (Horizontal Progress Bars)**:
>      - Header `By Channel & Broker` + **`Export CSV`** button.
>      - Horizontal stacked progress rows for each channel (`EPIC · Broker`, `Paid Media · Direct Outreach`, `Employee · Internal`, `LHD · Broker`, `Other`, `McGohan Brabender · MGB`) showing channel name + code pill on the left, **`384 active / 452 enrolled`** on the right, and a two-tone horizontal progress bar (royal blue `#2563eb` for active, light slate `#cbd5e1` for total enrolled).
>    - **Employer & Channel Breakdown Card (Emulating Pages 1–3 of Screenshot)**:
>      - Header `Employer & Channel Breakdown (39)` + subtitle `Click any employer row to inspect its monthly trend above, or share a dedicated HR report link.` + **`Export CSV`** button.
>      - Search bar (`🔍 Search employers...`) on the left + record filter dropdown (`All Records (39)`) on the right.
>      - Table with exact columns from the screenshot: `EMPLOYER`, `CHANNEL` (pill badge), `MONTHLY TREND` (inline SVG sparkline), `ENROLLED` (green), `DISENROLLED` (amber), `ACTIVE` (blue), and action buttons (`📋 Copy Employee Link` and `📋 Copy HR`).
