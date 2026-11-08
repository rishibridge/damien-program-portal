import base64
import hashlib
import hmac
import json
import struct
import sys
import time
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3100"
DAMIEN_USER = "damien"
DAMIEN_PASS = "bridge2026"
METRO_USER = "metro"
METRO_PASS = "metro2026"


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_get_raw(path, headers=None):
    handlers = [NoRedirectHandler]
    if "localhost" in BASE_URL or "127.0.0.1" in BASE_URL:
        handlers.append(urllib.request.ProxyHandler({}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(f"{BASE_URL}{path}", headers=headers or {})
    try:
        with opener.open(req, timeout=15) as resp:
            return resp.status, dict(resp.headers), resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", errors="replace")


def run_suite():
    results = []

    def record(cid, name, passed, detail=""):
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {cid}: {name}" + (f" -> {detail}" if detail else ""))
        results.append((cid, name, passed, detail))

    print(f"\n=== Running Web-Login & Multi-Client E2E Suite against {BASE_URL} ===\n")

    # -------------------------------------------------------------------------
    # SECTION 1: NO BASIC AUTH POPUP & WEB LOGIN SECURITY (4 checks)
    # -------------------------------------------------------------------------
    code_root, hdrs_root, _ = http_get_raw("/")
    www_auth_root = hdrs_root.get("WWW-Authenticate") or hdrs_root.get("www-authenticate") or ""
    loc_root = hdrs_root.get("Location") or hdrs_root.get("location") or ""
    record(
        "AUTH-01",
        "Unauthenticated GET / redirects (302 -> /login) with ZERO WWW-Authenticate Basic popup header",
        code_root == 302 and "/login" in loc_root and www_auth_root == "",
        f"status={code_root}, Location={loc_root}, WWW-Authenticate='{www_auth_root}'",
    )

    code_api, hdrs_api, _ = http_get_raw("/api/portal-data")
    www_auth_api = hdrs_api.get("WWW-Authenticate") or hdrs_api.get("www-authenticate") or ""
    record(
        "AUTH-02",
        "Unauthenticated GET /api/portal-data returns 401 JSON with ZERO WWW-Authenticate header",
        code_api == 401 and www_auth_api == "",
        f"status={code_api}, WWW-Authenticate='{www_auth_api}'",
    )

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Single standard browser context (NO http_credentials Basic Auth!)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()

        # Navigate to root -> should redirect to /login web form
        page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
        on_login_page = "/login" in page.url and page.locator("#loginUsername").is_visible()
        record(
            "AUTH-03",
            "Visiting root in browser lands on branded /login web form",
            on_login_page,
            f"url={page.url}",
        )

        # Verify Clean Login Page (Item 2): Title is 'Program Analytics', logo has transparent background, no verbose subtitle/footer
        login_ui_check = page.evaluate("""() => {
            const titleText = document.querySelector('.login-title')?.innerText.trim() || '';
            const hasSubtitle = Boolean(document.querySelector('.login-subtitle'));
            const hasFooter = Boolean(document.querySelector('.login-footer'));
            const logoEl = document.querySelector('.login-logo');
            const logoBg = logoEl ? window.getComputedStyle(logoEl).backgroundColor : '';
            const bodyText = document.body.innerText;
            return {
                titleText,
                hasSubtitle,
                hasFooter,
                logoBg,
                hasOldCopy: bodyText.includes('Covered Entity credentials') || bodyText.includes('Protected Covered Entity Environment')
            };
        }""")
        record(
            "AUTH-03B",
            "Clean Login Page: title is 'Program Analytics', logo has transparent background, no subtitle or footer text",
            login_ui_check["titleText"] == "Program Analytics"
            and not login_ui_check["hasSubtitle"]
            and not login_ui_check["hasFooter"]
            and not login_ui_check["hasOldCopy"]
            and login_ui_check["logoBg"] in ("rgba(0, 0, 0, 0)", "transparent"),
            str(login_ui_check),
        )

        # Test invalid credentials on /login form
        page.fill("#loginUsername", "damien")
        page.fill("#loginPassword", "wrongpass")
        page.click("#loginSubmitBtn")
        page.wait_for_selector("#loginError", state="visible", timeout=10000)
        err_msg = page.locator("#loginError").inner_text().strip()
        record(
            "AUTH-04",
            "Submitting wrong password on /login shows inline error message and stays on /login",
            "Invalid Client ID or password" in err_msg and "/login" in page.url,
            f"err='{err_msg}'",
        )

        # ---------------------------------------------------------------------
        # SECTION 2: WEB LOGIN AS DAMIEN (damien / bridge2026 + Mandatory 2-Step MFA)
        # ---------------------------------------------------------------------
        page.fill("#loginUsername", DAMIEN_USER)
        page.fill("#loginPassword", DAMIEN_PASS)
        page.click("#loginSubmitBtn")
        page.wait_for_selector("#mfaForm", state="visible", timeout=15000)
        mfa_code_d = page.locator("#mfaInfoBanner").get_attribute("data-email-code-preview")
        page.fill("#mfaCodeInput", mfa_code_d)
        page.click("#mfaSubmitBtn")
        page.wait_for_selector("#summaryKpiRow .kpi", timeout=20000)

        # Ensure clean baseline for Damien
        page.evaluate("fetch('/api/worklist/reset', {method:'POST'})")
        page.reload(wait_until="networkidle")
        page.wait_for_selector("#summaryKpiRow .kpi", timeout=15000)

        d_title = page.title()
        d_logo = page.locator("#sidebarLogoName").inner_text().strip()
        record(
            "DAMIEN-01",
            "Damien title & sidebar branding ('Damien Program Analytics')",
            "Damien Center GLP-1 Weight Loss Program" in d_title and d_logo == "Damien Program Analytics",
            f"title='{d_title}', logo='{d_logo}'",
        )

        d_badges = [
            page.locator("#badgeClientName").inner_text().strip(),
            page.locator("#badgeTelehealthName").inner_text().strip(),
            page.locator("#badgePharmacyName").inner_text().strip(),
        ]
        record(
            "DAMIEN-02",
            "Damien topbar badges ('Damien Center', 'Hello Alpha', 'Damien Pharmacy') + Sign Out button visible",
            d_badges == ["Damien Center", "Hello Alpha", "Damien Pharmacy"] and page.locator("#btnLogout").is_visible(),
            str(d_badges),
        )

        d_kpis = page.locator("#summaryKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "DAMIEN-03",
            "Slide 2 Summary 6 KPI values ('862', '673', '$371K', '$962K', '69%', '94%')",
            d_kpis == ["862", "673", "$371K", "$962K", "69%", "94%"],
            str(d_kpis),
        )

        d_pulse = page.locator("#summaryWorklistPulse .kpi .kpi-val").all_inner_texts()
        record(
            "DAMIEN-04",
            "Worklist pulse queue counts ('101', '37', '86', '186')",
            d_pulse == ["101", "37", "86", "186"],
            str(d_pulse),
        )

        page.click("button[data-view='financials']")
        fin_kpis = page.locator("#financialsKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "DAMIEN-05",
            "Financials 4 KPI cards ($371,214, $961,691, $2,336,983, $44,164)",
            fin_kpis == ["$371,214", "$961,691", "$2,336,983", "$44,164"],
            str(fin_kpis),
        )

        fin_rows = page.locator("#tbodyYtdFinancials tr").count()
        record("DAMIEN-06", "Slide 3 YTD table has exact 9 rows", fin_rows == 9, f"rows={fin_rows}")

        sim_margin = page.locator("#simOutMargin").inner_text().strip()
        sim_proc = page.locator("#simOutProceeds").inner_text().strip()
        record(
            "DAMIEN-07",
            "Financial simulator default outputs (+$65,325 lift, $1,027,016 projected YTD)",
            sim_margin == "+$65,325" and sim_proc == "$1,027,016",
            f"margin={sim_margin}, proceeds={sim_proc}",
        )

        page.click("button[data-view='sources']")
        src_rows = page.locator("#tbodySources tr").count()
        src_badge = page.locator("#sourcesMatchedBadge").inner_text().strip()
        record(
            "DAMIEN-08",
            "Slide 4 Patient Sources table has 6 rows & '1,952 Matched Member Fills' badge",
            src_rows == 6 and src_badge == "1,952 Matched Member Fills",
            f"rows={src_rows}, badge='{src_badge}'",
        )

        # Verify Enrollment Reporting nav placement (directly below Patient Sources) & functionality
        nav_views = page.evaluate("""() => {
            return Array.from(document.querySelectorAll('#sidebarNav .nav-btn')).map(b => b.getAttribute('data-view'));
        }""")
        src_idx = nav_views.index("sources") if "sources" in nav_views else -1
        enr_idx = nav_views.index("enrollment") if "enrollment" in nav_views else -1
        record(
            "DAMIEN-08B",
            "Enrollment Reporting nav item is positioned directly below Patient Sources",
            src_idx != -1 and enr_idx == src_idx + 1,
            f"nav_views={nav_views}",
        )

        page.click("button[data-view='enrollment']")
        enr_kpis_ytd = page.locator("#enrollmentKpiRow .kpi .kpi-val").all_inner_texts()
        enr_ch_rows = page.locator("#tbodyEnrollmentChannels tr").count()
        enr_emp_rows = page.locator("#tbodyEnrollmentEmployers tr").count()
        record(
            "DAMIEN-08C",
            "Enrollment Reporting default YTD KPIs (1,036 enrolled, 264 disenrolled, 862 active, +837 net, 49.6% broker share), 7 channel rows (6+Total), 39 employer rows",
            enr_kpis_ytd[0] == "1,036"
            and enr_kpis_ytd[1] == "264"
            and enr_kpis_ytd[2] == "862"
            and enr_ch_rows == 7
            and enr_emp_rows == 39,
            f"kpis={enr_kpis_ytd}, ch_rows={enr_ch_rows}, emp_rows={enr_emp_rows}",
        )

        # Filter Enrollment Reporting by Timeframe = Sep
        page.select_option("#enrollTimeframeFilter", "Sep")
        enr_kpis_sep = page.locator("#enrollmentKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "DAMIEN-08D",
            "Enrollment Reporting Timeframe filter 'Sep' updates KPIs (273 enrolled, 91 disenrolled, 862 active, +207 net, 62.3% broker share)",
            enr_kpis_sep == ["273", "91", "862", "+207", "62.3%"],
            f"sep_kpis={enr_kpis_sep}",
        )

        # Filter Enrollment Reporting by Channel = EPIC & Timeframe = YTD
        page.select_option("#enrollTimeframeFilter", "YTD")
        page.select_option("#enrollChannelFilter", "EPIC")
        enr_kpis_epic = page.locator("#enrollmentKpiRow .kpi .kpi-val").all_inner_texts()
        epic_emp_rows = page.locator("#tbodyEnrollmentEmployers tr").count()
        record(
            "DAMIEN-08E",
            "Enrollment Reporting Channel filter 'EPIC' updates KPIs (452 enrolled, 68 disenrolled, 384 active) and filters employers to EPIC groups",
            enr_kpis_epic[0] == "452" and enr_kpis_epic[1] == "68" and enr_kpis_epic[2] == "384" and epic_emp_rows >= 25,
            f"epic_kpis={enr_kpis_epic}, epic_emp_rows={epic_emp_rows}",
        )

        # Search Employer = 'City of Evansville'
        page.select_option("#enrollChannelFilter", "ALL")
        page.fill("#enrollEmployerSearch", "City of Evansville")
        evans_kpis = page.locator("#enrollmentKpiRow .kpi .kpi-val").all_inner_texts()
        evans_rows = page.locator("#tbodyEnrollmentEmployers tr").count()
        page.click("#btnResetEnrollmentFilters")
        record(
            "DAMIEN-08F",
            "Enrollment Reporting Employer search 'City of Evansville' dynamically filters to City of Evansville (80 enrolled, 9 disenrolled, 71 active)",
            evans_rows == 1 and evans_kpis[0] == "80" and evans_kpis[1] == "9" and evans_kpis[2] == "71",
            f"evans_kpis={evans_kpis}, evans_rows={evans_rows}",
        )

        # Verify AllKin Utilization Screenshot UI elements (4 color-coded KPI cards, horizontal channel progress bars, SVG sparklines, Copy Employee Link / Copy HR buttons)
        util_ui_check = page.evaluate("""() => {
            const kpiCards = document.querySelectorAll('#enrollmentKpiRow .util-kpi-card');
            const progBars = document.querySelectorAll('#enrollmentChannelProgressList .channel-progress-item');
            const sparklines = document.querySelectorAll('#tbodyEnrollmentEmployers svg polyline');
            const copyBtns = document.querySelectorAll('#tbodyEnrollmentEmployers .btn-copy-link');
            const hlText = document.getElementById('enrollmentHeadline')?.innerText || '';
            return {
                kpiCount: kpiCards.length,
                progBarCount: progBars.length,
                sparklineCount: sparklines.length,
                copyBtnCount: copyBtns.length,
                hlText
            };
        }""")
        record(
            "DAMIEN-08G",
            "AllKin Utilization UI: 4 KPI cards, 6 horizontal channel progress bars, 39 employer SVG sparklines, and Copy Employee Link / Copy HR buttons",
            util_ui_check["kpiCount"] == 4
            and util_ui_check["progBarCount"] == 6
            and util_ui_check["sparklineCount"] == 39
            and util_ui_check["copyBtnCount"] >= 70
            and "Utilization" in util_ui_check["hlText"],
            str(util_ui_check),
        )

        page.click("button[data-view='paidmedia']")
        pm_kpis = page.locator("#paidMediaKpiRow .kpi .kpi-val").all_inner_texts()
        pm_rows = page.locator("#tbodyPaidMedia tr").count()
        record(
            "DAMIEN-09",
            "Slide 5 Paid Media 4 KPIs ($142K, 414, 243, $658K) & 10 cohort rows",
            pm_kpis == ["$142K", "414", "243", "$658K"] and pm_rows == 10,
            f"kpis={pm_kpis}, rows={pm_rows}",
        )

        page.click("button[data-view='funnel']")
        funnel_title = page.locator("#funnelChartTitle").inner_text().strip()
        drop_nums = page.locator("#funnelDropoffCards .dropoff-num").all_inner_texts()
        record(
            "DAMIEN-10",
            "Slide 6 Funnel title (760 patients) & dropoff cards (76, 76, 85)",
            "760 patients" in funnel_title and drop_nums == ["76", "76", "85"],
            f"title='{funnel_title}', dropoffs={drop_nums}",
        )

        page.click("button[data-view='refill']")
        refill_steps = page.locator("#tbodyRefillSteps tr").count()
        ret_rows = page.locator("#tbodyRetentionMatrix tr").count()
        refill_btn = page.locator("#btnRefillQueueLink").inner_text().strip()
        record(
            "DAMIEN-11",
            "Slide 7 & 10 Refill steps (7 rows), Retention matrix (9 rows), Queue button (37)",
            refill_steps == 7 and ret_rows == 9 and "(37)" in refill_btn,
            f"steps={refill_steps}, ret={ret_rows}, btn='{refill_btn}'",
        )

        page.click("button[data-view='medmix']")
        med_hdr = page.locator("#medMixSeptHeader").inner_text().strip()
        med_vals = page.locator("#medMixCalloutList .timing-val").all_inner_texts()
        record(
            "DAMIEN-12",
            "Slide 8 Med Mix header ('September Dispenses (673)') & callouts (411, 256, 6)",
            med_hdr == "September Dispenses (673)" and med_vals == ["411", "256", "6"],
            f"hdr='{med_hdr}', vals={med_vals}",
        )

        page.click("button[data-view='worklist']")
        todo_rows = page.locator("#tbodyWorklistTodo tr").count()
        prio_opts = page.locator("#todoPriorityFilter option").all_inner_texts()
        record(
            "DAMIEN-13",
            "Worklist To-Do has 101 rows & dynamically populated priority filter options",
            todo_rows == 101 and "All Priorities (101)" in prio_opts[0] and len(prio_opts) == 4,
            f"rows={todo_rows}, opts={prio_opts}",
        )

        page.select_option("#todoFuzzyFilter", "fuzzy")
        fuzzy_todo_rows = page.locator("#tbodyWorklistTodo tr").count()
        page.select_option("#todoFuzzyFilter", "")
        record(
            "DAMIEN-14",
            "Worklist To-Do fuzzy filter shows exact 15 patients with possible Data Fix match",
            fuzzy_todo_rows == 15,
            f"fuzzy_todo_rows={fuzzy_todo_rows}",
        )

        page.click("#wlTabBtn-refill")
        refill_wl_rows = page.locator("#tbodyWorklistRefill tr").count()
        record("DAMIEN-15", "Worklist Refill Follow-Up has 37 rows", refill_wl_rows == 37, f"rows={refill_wl_rows}")

        page.click("#wlTabBtn-fixes")
        unmatched_rows = page.locator("#tbodyFixesUnmatched tr").count()
        noid_rows = page.locator("#tbodyFixesNoId tr").count()
        sep_glp1_badges = page.locator("#tbodyFixesNoId .know-badge").count()
        record(
            "DAMIEN-16",
            "Worklist Data Fixes has 31 Unmatched rows, 55 No-ID rows, and exact 51 'Sep P&L GLP-1 Fill' badges",
            unmatched_rows == 31 and noid_rows == 55 and sep_glp1_badges == 51,
            f"unmatched={unmatched_rows}, noid={noid_rows}, sep_glp1={sep_glp1_badges}",
        )

        page.click("#wlTabBtn-ended")
        ended_wl_rows = page.locator("#tbodyWorklistEnded tr").count()
        ended_kpis = page.locator("#endedStageKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "DAMIEN-17",
            "Worklist Ended – Never Filled has 186 rows & stage KPIs (74, 62, 47, 3)",
            ended_wl_rows == 186 and ended_kpis == ["74", "62", "47", "3"],
            f"rows={ended_wl_rows}, kpis={ended_kpis}",
        )

        page.click("#btnOpenDefinitions")
        def_notes = page.locator("#appendixNotesList .know-item").count()
        page.click("#btnCloseDefinitionsModal")
        record("DAMIEN-18", "Definitions modal displays all 6 Slide 9 notes", def_notes == 6, f"notes={def_notes}")

        page.click("button[data-view='ask']")
        page.fill("#mainAskInput", "What are our YTD pharmacy revenue, membership fees, and September and YTD net program proceeds?")
        page.click("#mainAskSubmitBtn")
        page.wait_for_selector("[data-testid='qa-ai-message']", timeout=60000)
        ai_reply_d = page.locator("[data-testid='qa-ai-message'] .chat-bubble").last.inner_text()
        ai_rich_dom = page.evaluate("""() => {
            const bubble = document.querySelectorAll("[data-testid='qa-ai-message'] .chat-bubble");
            const last = bubble[bubble.length - 1];
            return {
                hasRichWrapper: Boolean(last && last.querySelector('.ai-rich-content')),
                tableCount: last ? last.querySelectorAll('table.ai-rich-table, table').length : 0,
                chartCount: last ? last.querySelectorAll('canvas.ai-inline-chart-canvas').length : 0
            };
        }""")
        record(
            "DAMIEN-19",
            "Ask Bridge AI for Damien cites $2,336,983 revenue, $371,214 Sep proceeds, and $961,691 YTD proceeds",
            ("2,336,983" in ai_reply_d) and ("371,214" in ai_reply_d or "371K" in ai_reply_d) and ("961,691" in ai_reply_d or "962K" in ai_reply_d),
            ai_reply_d[:160].replace("\n", " "),
        )
        record(
            "DAMIEN-19B",
            "Ask Bridge AI renders rich HTML table and interactive Chart.js canvas inside the chat bubble",
            ai_rich_dom["hasRichWrapper"] and (ai_rich_dom["tableCount"] >= 1 or ai_rich_dom["chartCount"] >= 1),
            str(ai_rich_dom),
        )

        # Verify analysisWorkbook A1-A8 structure & zero member-level data in analysisWorkbook
        aw_check = page.evaluate("""async () => {
            const resp = await fetch('/api/portal-data');
            const d = await resp.json();
            const aw = d.analysisWorkbook || {};
            const awStr = JSON.stringify(aw);
            return {
                privacyPolicy: aw.privacyPolicy,
                clientScope: aw.clientScope,
                sepRev: aw.exhibits?.monthlyPnL?.Revenue?.Sep,
                augRev: aw.exhibits?.monthlyPnL?.Revenue?.Aug,
                ytdCanc: aw.exhibits?.cancellationsBySourceMonthly?.find(r => r.source === 'Total')?.YTD,
                sepTracker: aw.exhibits?.activePatientTrackerMonthly?.Sep,
                doseCount: aw.exhibits?.dispensesByDoseMonthly?.length,
                employerCount: aw.alphaAnalytics?.allEmployerGroups?.length,
                topPrescriber: aw.dispenseAnalytics?.byPrescriber?.[0]?.prescriber,
                topPrescriberFills: aw.dispenseAnalytics?.byPrescriber?.[0]?.completedFills,
                topPayer: aw.dispenseAnalytics?.byPrimaryThirdPartyPayer?.[0]?.primaryPayer,
                topPayerFills: aw.dispenseAnalytics?.byPrimaryThirdPartyPayer?.[0]?.completedFills,
                hasUuidOrPatientIdKey: awStr.includes('user_uuid') || awStr.includes('Patient Alternate ID') || awStr.includes('6d3f1831')
            };
        }""")
        record(
            "DAMIEN-20",
            "Analysis.xlsx (A1-A8) aggregate tables loaded in portal_data.json with ZERO member-level IDs",
            aw_check["privacyPolicy"] == "AGGREGATE_ONLY_NO_MEMBER_LEVEL_DATA"
            and aw_check["sepRev"] == 769074.12
            and aw_check["augRev"] == 558672.02
            and aw_check["ytdCanc"] == 264
            and aw_check["sepTracker"] == 862
            and aw_check["doseCount"] == 14
            and aw_check["employerCount"] >= 35
            and aw_check["topPrescriber"] == "Townsend, Fawn"
            and aw_check["topPrescriberFills"] == 402
            and aw_check["topPayer"] == "Wegovy Savings Card"
            and aw_check["topPayerFills"] == 1897
            and not aw_check["hasUuidOrPatientIdKey"],
            str(aw_check),
        )

        # Free-form AI Q&A tests against Analysis.xlsx (both instant/deterministic and full AI endpoint)
        qa_monthly_rev = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'What was our monthly pharmacy revenue in August and September 2026, and what was the gross margin per Rx?'})
            });
            return await r.json();
        }""")
        reply_rev = qa_monthly_rev.get("reply", "")
        record(
            "DAMIEN-21",
            "Ask Bridge AI answers monthly pharmacy revenue ($558,672 Aug, $769,074 Sep) from Analysis.xlsx",
            ("558,672" in reply_rev) and ("769,074" in reply_rev) and ("911" in reply_rev),
            reply_rev[:160].replace("\n", " "),
        )

        qa_doses = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'What is the breakdown of Wegovy and Ozempic dispenses by specific dose strength in September and YTD?'})
            });
            return await r.json();
        }""")
        reply_doses = qa_doses.get("reply", "")
        record(
            "DAMIEN-22",
            "Ask Bridge AI answers dose-level dispenses (Wegovy 0.25mg 400 YTD, Wegovy 0.5mg 332 YTD, Wegovy 1.5mg Tablet 263 YTD)",
            ("400" in reply_doses) and ("332" in reply_doses) and ("263" in reply_doses),
            reply_doses[:160].replace("\n", " "),
        )

        qa_presc = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Who are our top prescribers by completed fills, pharmacy revenue, and margin?'})
            });
            return await r.json();
        }""")
        reply_presc = qa_presc.get("reply", "")
        record(
            "DAMIEN-23",
            "Ask Bridge AI answers prescriber analytics (Townsend 402 fills, Staiger 370, Pedersen 366) from Damien Dispense Data",
            ("Townsend" in reply_presc and "402" in reply_presc) and ("Staiger" in reply_presc and "370" in reply_presc),
            reply_presc[:160].replace("\n", " "),
        )

        qa_payer = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'What is the breakdown of completed fills and revenue by primary and secondary third party payer and savings card?'})
            });
            return await r.json();
        }""")
        reply_payer = qa_payer.get("reply", "")
        record(
            "DAMIEN-24",
            "Ask Bridge AI answers third-party payer & savings card analytics (Wegovy Savings Card 1,897 fills, Connective RX 54, Anthem 38)",
            ("1,897" in reply_payer or "1897" in reply_payer) and ("Connective" in reply_payer) and ("Anthem" in reply_payer),
            reply_payer[:160].replace("\n", " "),
        )

        qa_canc = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'How many membership cancellations have we had in September and YTD by source?'})
            });
            return await r.json();
        }""")
        reply_canc = qa_canc.get("reply", "")
        record(
            "DAMIEN-25",
            "Ask Bridge AI answers membership cancellations by source and month (264 YTD / 25.5%, 91 in Sep / 33.3%, Paid Media 151, EPIC 68)",
            ("264" in reply_canc) and ("91" in reply_canc) and ("151" in reply_canc) and ("68" in reply_canc),
            reply_canc[:160].replace("\n", " "),
        )

        qa_member_block = page.evaluate("""async () => {
            const r1 = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Tell me about patient 6d3f1831'})
            });
            const d1 = await r1.json();
            const r2 = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Can you look up member ID 22d97e56?'})
            });
            const d2 = await r2.json();
            return { d1, d2 };
        }""")
        d1_resp = qa_member_block["d1"]
        d2_resp = qa_member_block["d2"]
        record(
            "DAMIEN-26",
            "Strict Member-Level Privacy Guardrail blocks patient/member ID lookups in AI Q&A and leaks zero member data",
            bool(d1_resp.get("memberLevelBlocked"))
            and bool(d2_resp.get("memberLevelBlocked"))
            and "aggregate" in d1_resp.get("reply", "").lower()
            and "809f5e6d" not in d1_resp.get("reply", "").lower(),
            d1_resp.get("reply", "")[:140].replace("\n", " "),
        )

        # Verify natural conversational question with numbers / 'specific member' phrase is NOT falsely blocked and uses real LLM
        qa_natural = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Compare our EPIC broker channel vs Paid Media in terms of enrollments, disenrollments, active retention, and first-fill conversion. Which employers are driving EPIC growth in August and September?'})
            });
            return await r.json();
        }""")
        reply_nat = qa_natural.get("reply", "")
        record(
            "DAMIEN-27",
            "Conversational AI synthesizes across PPTX & XLSX (EPIC 452 vs Paid Media 417, disenrollments 68 vs 151, City of Evansville 80, Hamilton Center 29) without false-positive blocks",
            not bool(qa_natural.get("memberLevelBlocked"))
            and ("452" in reply_nat)
            and ("417" in reply_nat)
            and ("Evansville" in reply_nat),
            f"aiPowered={qa_natural.get('aiPowered')}, model={qa_natural.get('aiModel')}, reply={reply_nat[:140].replace(chr(10), ' ')}",
        )

        # ---------------------------------------------------------------------
        # SECTION 3: SIGN OUT FROM DAMIEN & SIGN IN AS METRO IN SAME BROWSER!
        # ---------------------------------------------------------------------
        page.click("#btnLogout")
        page.wait_for_selector("#loginUsername", timeout=15000)
        record(
            "AUTH-05",
            "Clicking 'Sign Out' (#btnLogout) clears session and returns to /login in the same browser window",
            "/login" in page.url,
            f"url={page.url}",
        )

        # Log in as Metro Health Center (metro / metro2026 + Mandatory 2-Step MFA) in the exact same browser window!
        page.fill("#loginUsername", METRO_USER)
        page.fill("#loginPassword", METRO_PASS)
        page.click("#loginSubmitBtn")
        page.wait_for_selector("#mfaForm", state="visible", timeout=15000)
        mfa_code_m = page.locator("#mfaInfoBanner").get_attribute("data-email-code-preview")
        page.fill("#mfaCodeInput", mfa_code_m)
        page.click("#mfaSubmitBtn")
        page.wait_for_selector("#summaryKpiRow .kpi", timeout=20000)

        # Ensure clean baseline for Metro
        page.evaluate("fetch('/api/worklist/reset', {method:'POST'})")
        page.reload(wait_until="networkidle")
        page.wait_for_selector("#summaryKpiRow .kpi", timeout=15000)

        m_title = page.title()
        m_logo = page.locator("#sidebarLogoName").inner_text().strip()
        record(
            "METRO-01",
            "Metro title & sidebar branding ('Metro Health Program Analytics')",
            "Metro Health Center GLP-1 Weight Loss Program" in m_title and m_logo == "Metro Health Program Analytics",
            f"title='{m_title}', logo='{m_logo}'",
        )

        m_badges = [
            page.locator("#badgeClientName").inner_text().strip(),
            page.locator("#badgeTelehealthName").inner_text().strip(),
            page.locator("#badgePharmacyName").inner_text().strip(),
        ]
        record(
            "METRO-02",
            "Metro topbar badges ('Metro Health Center', 'Hello Alpha', 'Metro Specialty Pharmacy')",
            m_badges == ["Metro Health Center", "Hello Alpha", "Metro Specialty Pharmacy"],
            str(m_badges),
        )

        m_kpis = page.locator("#summaryKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "METRO-03",
            "Metro Overview 6 KPI cards ('540', '430', '$248K', '$645K', '72%', '95%')",
            m_kpis == ["540", "430", "$248K", "$645K", "72%", "95%"],
            str(m_kpis),
        )

        m_pulse = page.locator("#summaryWorklistPulse .kpi .kpi-val").all_inner_texts()
        record(
            "METRO-04",
            "Metro Worklist pulse queue counts ('42', '18', '37', '60')",
            m_pulse == ["42", "18", "37", "60"],
            str(m_pulse),
        )

        page.click("button[data-view='financials']")
        m_fin_kpis = page.locator("#financialsKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "METRO-05",
            "Metro Financials 4 KPI cards ($248,400, $645,200, $1,580,400, $31,200)",
            m_fin_kpis == ["$248,400", "$645,200", "$1,580,400", "$31,200"],
            str(m_fin_kpis),
        )

        m_todo_max = page.locator("#simTodoSlider").get_attribute("max")
        m_refill_max = page.locator("#simRefillSlider").get_attribute("max")
        m_margin_val = page.locator("#simMarginSlider").input_value()
        record(
            "METRO-06",
            "Metro Financial Simulator bounds dynamically adapt (max=42 To-Do, max=18 Refill, $895 margin/fill)",
            m_todo_max == "42" and m_refill_max == "18" and m_margin_val == "895",
            f"todoMax={m_todo_max}, refillMax={m_refill_max}, margin={m_margin_val}",
        )

        page.click("button[data-view='funnel']")
        m_funnel_title = page.locator("#funnelChartTitle").inner_text().strip()
        m_funnel_note = page.locator("#funnelWorklistNoteBox").inner_text()
        record(
            "METRO-07",
            "Metro Funnel dynamically shows 500 pre-Sep patients and Open Pharmacy To-Do (42)",
            "500 patients" in m_funnel_title and "Open Pharmacy To-Do (42)" in m_funnel_note,
            f"title='{m_funnel_title}'",
        )

        page.click("button[data-view='worklist']")
        m_todo_rows = page.locator("#tbodyWorklistTodo tr").count()
        m_prio_first = page.locator("#todoPriorityFilter option").first.inner_text()
        record(
            "METRO-08",
            "Metro Worklist To-Do has 42 rows & dynamic dropdown 'All Priorities (42)'",
            m_todo_rows == 42 and m_prio_first == "All Priorities (42)",
            f"rows={m_todo_rows}, firstOpt='{m_prio_first}'",
        )

        body_text_m = page.locator("body").inner_text()
        record(
            "METRO-09",
            "Zero 'Damien' strings appear anywhere in Metro Health Center's rendered DOM",
            "damien" not in body_text_m.lower(),
            f"contains_damien={'damien' in body_text_m.lower()}",
        )

        page.click("button[data-view='ask']")
        page.fill("#mainAskInput", "What are our total pharmacy revenue and net program proceeds?")
        page.click("#mainAskSubmitBtn")
        page.wait_for_selector("[data-testid='qa-ai-message']", timeout=60000)
        ai_reply_m = page.locator("[data-testid='qa-ai-message'] .chat-bubble").last.inner_text()
        record(
            "METRO-10",
            "Ask Bridge AI for Metro cites Metro figures ($1,580,400 revenue, $645,200 YTD proceeds) and zero Damien leakage",
            ("1,580,400" in ai_reply_m) and ("645,200" in ai_reply_m or "645K" in ai_reply_m) and ("damien" not in ai_reply_m.lower()),
            ai_reply_m[:160].replace("\n", " "),
        )

        qa_metro_presc = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Who are our top prescribers by completed fills and revenue?'})
            });
            return await r.json();
        }""")
        reply_m_presc = qa_metro_presc.get("reply", "")
        record(
            "METRO-11",
            "Ask Bridge AI for Metro cites Metro prescribers (Vance 520, Rostova 460) with zero Damien leakage",
            ("Vance" in reply_m_presc and "520" in reply_m_presc) and ("Rostova" in reply_m_presc) and ("damien" not in reply_m_presc.lower()),
            reply_m_presc[:160].replace("\n", " "),
        )

        # ---------------------------------------------------------------------
        # SECTION 4: CROSS-TENANT WORKLIST EDIT PERSISTENCE & ISOLATION
        # ---------------------------------------------------------------------
        page.click("button[data-view='worklist']")
        page.click("#wlTabBtn-todo")
        first_row_m = page.locator("#tbodyWorklistTodo tr").first
        first_row_m.locator("select.edit-cell-select").select_option("Contacted patient")
        note_input_m = first_row_m.locator("input[type='text'].edit-cell-input")
        note_input_m.fill("Metro pharmacist verified refill")
        note_input_m.dispatch_event("change")
        page.wait_for_timeout(600)

        page.reload(wait_until="networkidle")
        page.click("button[data-view='worklist']")
        reloaded_row_m = page.locator("#tbodyWorklistTodo tr").first
        persisted_status_m = reloaded_row_m.locator("select.edit-cell-select").input_value()
        persisted_note_m = reloaded_row_m.locator("input[type='text'].edit-cell-input").input_value()
        record(
            "ISO-01",
            "Metro worklist edits persist across page reloads",
            persisted_status_m == "Contacted patient" and persisted_note_m == "Metro pharmacist verified refill",
            f"status='{persisted_status_m}', note='{persisted_note_m}'",
        )

        # Verify query/header spoofing (?clientId=damien) while logged in as Metro is ignored
        spoof_client = page.evaluate(
            "fetch('/api/portal-data?clientId=damien', {headers:{'X-Client-Id':'damien'}}).then(r=>r.json()).then(d=>d.meta.clientId)"
        )
        record(
            "ISO-02",
            "Query/Header tenant spoofing (?clientId=damien) is strictly ignored when logged in as Metro",
            spoof_client == "metro",
            f"returned_clientId='{spoof_client}'",
        )

        # Reset Metro worklist back to clean baseline
        page.click("#btnResetWorklistEdits")
        page.wait_for_timeout(600)
        reset_status_m = page.locator("#tbodyWorklistTodo tr").first.locator("select.edit-cell-select").input_value()
        record(
            "ISO-03",
            "Resetting Metro worklist restores Metro baseline cleanly",
            reset_status_m == "Not started",
            f"reset_status='{reset_status_m}'",
        )

        # ---------------------------------------------------------------------
        # SECTION 5: ENTERPRISE SECURITY, NAMED-USER TRACKING, MFA & GEO-FENCE
        # ---------------------------------------------------------------------
        # SEC-01: HTTP Security Headers & X-Powered-By removal
        _, raw_hdrs, _ = http_get_raw("/login")
        hdrs = {k.lower(): v for k, v in raw_hdrs.items()}
        has_xfo = hdrs.get("x-frame-options", "").upper() == "DENY"
        has_nosniff = hdrs.get("x-content-type-options", "").lower() == "nosniff"
        has_hsts = "max-age=" in hdrs.get("strict-transport-security", "").lower()
        has_csp = "default-src" in hdrs.get("content-security-policy", "").lower()
        no_xpb = "x-powered-by" not in hdrs
        record(
            "SEC-01",
            "HTTP Security Headers enforced (X-Frame-Options: DENY, nosniff, HSTS, CSP, no X-Powered-By)",
            has_xfo and has_nosniff and has_hsts and has_csp and no_xpb,
            f"XFO={hdrs.get('x-frame-options')}, nosniff={hdrs.get('x-content-type-options')}, CSP={bool(has_csp)}",
        )

        # SEC-02: US-Only Geo-Fencing blocks non-US traffic (403 Forbidden)
        geo_status, _, geo_body = http_get_raw("/api/portal-data", headers={"X-Test-Country": "GB"})
        record(
            "SEC-02",
            "US-Only Geo-Fencing blocks non-US requests (X-Test-Country: GB -> 403 Forbidden)",
            geo_status == 403 and "United States" in geo_body,
            f"HTTP {geo_status}, body={geo_body[:100]}",
        )

        # SEC-03: Mandatory MFA (No Turn-Off Checkbox) & Strict Role-Based Access Control (RBAC) for Standard User
        user_badge_txt = page.locator("#badgeCurrentUser").inner_text().strip()
        page.click("#btnOpenSecurityModal")
        page.wait_for_selector("#securityModal.open", timeout=10000)
        page.wait_for_timeout(500)
        rbac_client_check = page.evaluate("""async () => {
            const hasMfaDisableCheckbox = Boolean(document.getElementById('secMyMfaEnabled'));
            const emailReadOnly = document.getElementById('secMyMfaEmail')?.readOnly === true;
            const createFormHidden = document.getElementById('secCreateUserForm')?.style.display === 'none';
            const rCreate = await fetch('/api/security/users', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: 'unauth.user', password: 'StrongVault2026!#' })
            });
            const rEmailEdit = await fetch('/api/security/mfa-config', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email: 'hacker@evil.com' })
            });
            return {
                hasMfaDisableCheckbox,
                emailReadOnly,
                createFormHidden,
                createStatus: rCreate.status,
                emailEditStatus: rEmailEdit.status
            };
        }""")
        record(
            "SEC-03",
            "Mandatory MFA & Strict RBAC: No MFA turn-off checkbox exists, and standard client_user gets 403 Forbidden if attempting to add users or alter MFA email",
            not rbac_client_check["hasMfaDisableCheckbox"]
            and rbac_client_check["emailReadOnly"]
            and rbac_client_check["createFormHidden"]
            and rbac_client_check["createStatus"] == 403
            and rbac_client_check["emailEditStatus"] == 403,
            str(rbac_client_check),
        )
        page.click("#btnCloseSecurityModal")

        # SEC-04: Bridge Super-Admin (rishi.metro) RBAC User Creation & 12-Character Password Complexity Policy
        unique_user = f"pharm.mfa.{int(time.time()) % 100000}"
        user_create_test = page.evaluate(f"""async () => {{
            const rLogin = await fetch('/api/auth/login', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ username: 'rishi.metro', password: 'BridgeMetro2026!' }})
            }});
            const dLogin = await rLogin.json();
            await fetch('/api/auth/verify-mfa', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ challengeToken: dLogin.challengeToken, code: dLogin.emailCodePreview, trustDevice: false }})
            }});
            const rWeak = await fetch('/api/security/users', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{
                    username: '{unique_user}',
                    password: 'short',
                    displayName: 'Clinical Pharmacist MFA Tester',
                    email: 'mfa.tester@bridgehealthhub.com',
                    mfaMethod: 'email'
                }})
            }});
            const dWeak = await rWeak.json();
            const rStrong = await fetch('/api/security/users', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{
                    username: '{unique_user}',
                    password: 'StrongVault2026!#',
                    displayName: 'Clinical Pharmacist MFA Tester',
                    email: 'mfa.tester@bridgehealthhub.com',
                    mfaMethod: 'email'
                }})
            }});
            const dStrong = await rStrong.json();
            return {{ weakStatus: rWeak.status, dWeak, strongStatus: rStrong.status, dStrong }};
        }}""")
        record(
            "SEC-04",
            "Bridge Super-Admin (bridge_admin) can create named users with mandatory MFA & 12-Char Scrypt Password Policy",
            user_create_test["weakStatus"] == 400
            and user_create_test["strongStatus"] == 200
            and bool(user_create_test["dStrong"].get("ok"))
            and bool(user_create_test["dStrong"].get("user", {}).get("mfaEnabled")),
            f"weakStatus={user_create_test['weakStatus']}, strongUser={user_create_test['dStrong'].get('user', {}).get('username')}, mfaEnabled={user_create_test['dStrong'].get('user', {}).get('mfaEnabled')}",
        )

        # SEC-05: Dual-Mode MFA Challenge + 6-Digit Verification + 30-Day Trusted Browser Cookie
        page.click("#btnLogout")
        page.wait_for_selector("#loginUsername", timeout=15000)
        mfa_flow_test = page.evaluate(f"""async () => {{
            const r1 = await fetch('/api/auth/login', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ username: '{unique_user}', password: 'StrongVault2026!#' }})
            }});
            const d1 = await r1.json();
            if (!d1.mfaRequired || !d1.challengeToken) return {{ step1: d1 }};
            const r2 = await fetch('/api/auth/verify-mfa', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{
                    challengeToken: d1.challengeToken,
                    code: d1.emailCodePreview,
                    trustDevice: true
                }})
            }});
            const d2 = await r2.json();
            await fetch('/api/auth/logout', {{ method: 'POST' }});
            const r3 = await fetch('/api/auth/login', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ username: '{unique_user}', password: 'StrongVault2026!#' }})
            }});
            const d3 = await r3.json();
            await fetch('/api/auth/logout', {{ method: 'POST' }});
            return {{ mfaRequiredFirst: d1.mfaRequired, verifyOk: d2.ok, mfaBypassedWithTrustCookie: d3.ok && !d3.mfaRequired }};
        }}""")
        record(
            "SEC-05",
            "Dual-Mode MFA issues 6-digit challenge on first login, verifies code, sets 30-day trust cookie, and skips MFA on trusted repeat login",
            bool(mfa_flow_test.get("mfaRequiredFirst"))
            and bool(mfa_flow_test.get("verifyOk"))
            and bool(mfa_flow_test.get("mfaBypassedWithTrustCookie")),
            str(mfa_flow_test),
        )

        # SEC-06: 5-Attempt Brute-Force Lockout (429 Too Many Requests on 5th failed password attempt)
        lockout_target = f"brute.target.{int(time.time()) % 100000}"
        brute_test = page.evaluate(f"""async () => {{
            const statuses = [];
            let lastBody = null;
            for (let i = 0; i < 5; i++) {{
                const r = await fetch('/api/auth/login', {{
                    method: 'POST',
                    headers: {{'Content-Type': 'application/json'}},
                    body: JSON.stringify({{ username: '{lockout_target}', password: 'WrongPassword' + i }})
                }});
                statuses.push(r.status);
                lastBody = await r.json();
            }}
            return {{ statuses, lastBody }};
        }}""")
        record(
            "SEC-06",
            "5-Attempt Brute-Force Protection locks account for 15 minutes (429 Too Many Requests on 5th failed attempt)",
            brute_test["statuses"] == [401, 401, 401, 401, 429] and bool(brute_test["lastBody"].get("locked")),
            f"statuses={brute_test['statuses']}, msg='{brute_test['lastBody'].get('error')}'",
        )

        # SEC-07: Preserved Tester Logins (damien/bridge2026) display Scannable QR Code on Authenticator App tab & verify real TOTP code
        page.goto(f"{BASE_URL}/login", wait_until="networkidle")
        page.fill("#loginUsername", DAMIEN_USER)
        page.fill("#loginPassword", DAMIEN_PASS)
        page.click("#loginSubmitBtn")
        page.wait_for_selector("#mfaForm", state="visible", timeout=15000)
        has_both_tabs = page.locator("#mfaTabEmail").is_visible() and page.locator("#mfaTabTotp").is_visible()

        # Click Authenticator App tab and verify scannable QR code image & manual Base32 secret are rendered
        page.click("#mfaTabTotp")
        page.wait_for_selector("#mfaTotpQrImg", state="visible", timeout=10000)
        qr_check = page.evaluate("""() => {
            const img = document.getElementById('mfaTotpQrImg');
            const secretEl = document.getElementById('mfaTotpSecretText');
            return {
                hasQrSrc: Boolean(img && img.src && img.src.startsWith('data:image/png;base64,')),
                naturalWidth: img ? img.naturalWidth : 0,
                secretText: secretEl ? secretEl.innerText.trim() : ''
            };
        }""")
        # Generate real 6-digit RFC 6238 TOTP code from the secret shown on screen!
        totp_key = base64.b32decode(qr_check["secretText"].upper())
        totp_counter = struct.pack(">Q", int(time.time()) // 30)
        totp_hmac = hmac.new(totp_key, totp_counter, hashlib.sha1).digest()
        totp_offset = totp_hmac[-1] & 0x0F
        totp_code_int = (
            ((totp_hmac[totp_offset] & 0x7F) << 24)
            | ((totp_hmac[totp_offset + 1] & 0xFF) << 16)
            | ((totp_hmac[totp_offset + 2] & 0xFF) << 8)
            | (totp_hmac[totp_offset + 3] & 0xFF)
        )
        real_totp_6digit = f"{totp_code_int % 1000000:06d}"

        page.fill("#mfaCodeInput", real_totp_6digit)
        page.click("#mfaSubmitBtn")
        page.wait_for_selector("#summaryKpiRow .kpi", timeout=20000)
        damien_user_badge = page.locator("#badgeCurrentUser").inner_text().strip()
        damien_me = page.evaluate("fetch('/api/auth/me').then(r=>r.json())")
        record(
            "SEC-07",
            "Authenticator App tab on /login renders scannable QR code (180x180 PNG) + Base32 key and verifies real 6-digit TOTP code for damien",
            has_both_tabs
            and qr_check["hasQrSrc"]
            and qr_check["naturalWidth"] >= 150
            and len(qr_check["secretText"]) >= 16
            and "damien" in damien_user_badge.lower()
            and damien_me.get("email") == "brady@bridgehealthhub.com",
            f"qrWidth={qr_check['naturalWidth']}, secret='{qr_check['secretText'][:8]}...', totpCode={real_totp_6digit}, email='{damien_me.get('email')}'",
        )

        # SEC-08: Wrong 6-Digit MFA Code Rejection (401) & Resend Email Code Flow
        mfa_edge_test = page.evaluate(f"""async () => {{
            const r1 = await fetch('/api/auth/login', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ username: 'pharmacist.damien', password: 'DamienPharm2026!' }})
            }});
            const d1 = await r1.json();
            const rWrong = await fetch('/api/auth/verify-mfa', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ challengeToken: d1.challengeToken, code: '000000', trustDevice: false }})
            }});
            const rResend = await fetch('/api/auth/resend-mfa', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ challengeToken: d1.challengeToken }})
            }});
            const dResend = await rResend.json();
            const rRight = await fetch('/api/auth/verify-mfa', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ challengeToken: d1.challengeToken, code: dResend.emailCodePreview, trustDevice: false }})
            }});
            const dRight = await rRight.json();
            return {{ wrongStatus: rWrong.status, resendOk: dResend.ok, rightOk: dRight.ok }};
        }}""")
        record(
            "SEC-08",
            "MFA Verification rejects wrong 6-digit code (401) and Resend Email Code (/api/auth/resend-mfa) issues fresh working code",
            mfa_edge_test["wrongStatus"] == 401 and bool(mfa_edge_test["resendOk"]) and bool(mfa_edge_test["rightOk"]),
            str(mfa_edge_test),
        )

        # SEC-09: Password Change Complexity & Reuse Policy (/api/security/change-password)
        pwd_policy_test = page.evaluate("""async () => {
            const rWrongCur = await fetch('/api/security/change-password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ currentPassword: 'WrongCurrentPassword!', newPassword: 'NewStrongVault2026!#' })
            });
            const rWeakNew = await fetch('/api/security/change-password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ currentPassword: 'DamienPharm2026!', newPassword: 'weak' })
            });
            const rSameNew = await fetch('/api/security/change-password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ currentPassword: 'DamienPharm2026!', newPassword: 'DamienPharm2026!' })
            });
            return {
                wrongCurStatus: rWrongCur.status,
                weakNewStatus: rWeakNew.status,
                sameNewStatus: rSameNew.status
            };
        }""")
        record(
            "SEC-09",
            "Password Change API enforces current password check (401), 12-char complexity (400), and prevents reusing current password (400)",
            pwd_policy_test["wrongCurStatus"] == 401
            and pwd_policy_test["weakNewStatus"] == 400
            and pwd_policy_test["sameNewStatus"] == 400,
            str(pwd_policy_test),
        )

        # SEC-10: Named-User Row Edit Attribution ('Updated by' & 'Updated at') in Worklist & Patient Detail Modal
        row_attr_test = page.evaluate("""async () => {
            const pData = await fetch('/api/portal-data').then(r => r.json());
            const firstTodoId = pData.worklists.pharmacyTodo.rows[0].id;
            const rPatch = await fetch(`/api/worklist/todo/${firstTodoId}`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ Status: 'Contacted patient', Notes: 'Verified by named pharmacist' })
            });
            const dPatch = await rPatch.json();
            await fetch('/api/worklist/reset', { method: 'POST' });
            return {
                ok: dPatch.ok,
                updatedBy: dPatch.row?.['Updated by'] || '',
                updatedAt: dPatch.row?.['Updated at'] || ''
            };
        }""")
        record(
            "SEC-10",
            "Worklist row edits automatically stamp 'Updated by' (Named User) and 'Updated at' (ISO timestamp)",
            bool(row_attr_test["ok"])
            and "pharmacist" in row_attr_test["updatedBy"].lower()
            and len(row_attr_test["updatedAt"]) >= 19,
            str(row_attr_test),
        )

        # SEC-11: Bridge Super-Admin (rishi.damien) Full Directory & Audit Trail Visibility
        admin_audit_test = page.evaluate("""async () => {
            const r1 = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: 'rishi.damien', password: 'BridgeDamien2026!' })
            });
            const d1 = await r1.json();
            await fetch('/api/auth/verify-mfa', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ challengeToken: d1.challengeToken, code: d1.emailCodePreview, trustDevice: false })
            });
            const ov = await fetch('/api/security/overview').then(r => r.json());
            const usernames = (ov.users || []).map(u => u.username);
            const eventTypes = (ov.auditEvents || []).map(e => e.eventType);
            return {
                isBridgeAdmin: ov.isBridgeAdmin,
                userCount: usernames.length,
                hasDamienAndBrady: usernames.includes('damien') && usernames.includes('brady.admin'),
                hasMfaAndEditEvents: eventTypes.includes('LOGIN_SUCCESS_MFA') && eventTypes.includes('WORKLIST_ROW_EDIT')
            };
        }""")
        record(
            "SEC-11",
            "Bridge Super-Admin (rishi.damien) views full Named Users Directory (damien, brady.admin, pharmacist.damien) & Audit Trail events",
            bool(admin_audit_test["isBridgeAdmin"])
            and admin_audit_test["userCount"] >= 4
            and bool(admin_audit_test["hasDamienAndBrady"])
            and bool(admin_audit_test["hasMfaAndEditEvents"]),
            str(admin_audit_test),
        )

        # SEC-12: Strict XSS HTML Escaping in formatMarkdownText() & Session Revocation on Logout
        xss_and_logout_test = page.evaluate("""async () => {
            const rendered = formatMarkdownText('<script>window.__xss=1</script><img src=x onerror=alert(1)> **Safe Bold**');
            const hasRawScript = rendered.includes('<script>');
            const hasRawImg = rendered.includes('<img');
            const hasSafeBold = rendered.includes('<strong>Safe Bold</strong>');
            await fetch('/api/auth/logout', { method: 'POST' });
            const rAfterLogout = await fetch('/api/portal-data');
            return {
                hasRawScript,
                hasRawImg,
                hasSafeBold,
                statusAfterLogout: rAfterLogout.status
            };
        }""")
        record(
            "SEC-12",
            "XSS sanitizer escapes raw <script>/<img> tags while preserving safe formatting, and /api/auth/logout immediately revokes session (401)",
            not xss_and_logout_test["hasRawScript"]
            and not xss_and_logout_test["hasRawImg"]
            and bool(xss_and_logout_test["hasSafeBold"])
            and xss_and_logout_test["statusAfterLogout"] == 401,
            str(xss_and_logout_test),
        )

        browser.close()

    passed_count = sum(1 for r in results if r[2])
    total_count = len(results)
    print(f"\n=== SUMMARY: {passed_count}/{total_count} CHECKS PASSED ===\n")
    if passed_count != total_count:
        sys.exit(1)


if __name__ == "__main__":
    run_suite()
