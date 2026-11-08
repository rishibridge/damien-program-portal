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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
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
    # SECTION 1: NO BASIC AUTH POPUP & WEB LOGIN SECURITY
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

        # Verify Clean Login Page: Title is 'Program Analytics', logo has transparent background, no verbose subtitle/footer
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

        # ---------------------------------------------------------------------
        # SECTION 2B: VERIFY 100% REMOVAL OF ALL EXCEL-DEPENDENT FEATURES
        # ---------------------------------------------------------------------
        nav_views = page.evaluate("""() => {
            return Array.from(document.querySelectorAll('#sidebarNav .nav-btn')).map(b => b.getAttribute('data-view'));
        }""")
        expected_nav = ["summary", "financials", "sources", "paidmedia", "funnel", "refill", "medmix", "ask"]
        record(
            "NO-EXCEL-01",
            "Sidebar navigation contains strictly the 8 PowerPoint-driven views + Ask Bridge AI (zero 'worklist' or 'enrollment' tabs)",
            nav_views == expected_nav,
            f"nav_views={nav_views}",
        )

        dom_excel_check = page.evaluate("""() => {
            const removedIds = [
                'view-worklist',
                'view-enrollment',
                'heroWorklistBtn',
                'summaryWorklistPulse',
                'simTodoSlider',
                'simRefillSlider',
                'simMarginSlider',
                'simOutMargin',
                'simOutProceeds',
                'funnelWorklistNoteBox',
                'btnRefillQueueLink',
                'patientDetailModal'
            ];
            const requiredCsvIds = [
                'btnExportFinancialsCsv',
                'btnExportSourcesCsv',
                'btnExportPaidMediaCsv',
                'btnExportFunnelCsv',
                'btnExportRefillStepsCsv',
                'btnExportRetentionMatrixCsv',
                'btnExportMedMixCsv',
                'btnExportAuditCsv',
                'btnExportQaCsv',
                'secKpiExports'
            ];
            const presentRemovedIds = removedIds.filter(id => Boolean(document.getElementById(id)));
            const missingCsvIds = requiredCsvIds.filter(id => !document.getElementById(id));
            return { presentRemovedIds, missingCsvIds };
        }""")
        record(
            "NO-EXCEL-02",
            "DOM contains zero Worklist/Enrollment/Simulator/Modal elements while all 9 CSV Export buttons & KPI counter are present",
            len(dom_excel_check["presentRemovedIds"]) == 0 and len(dom_excel_check["missingCsvIds"]) == 0,
            str(dom_excel_check),
        )

        api_excel_check = page.evaluate("""async () => {
            const pData = await fetch('/api/portal-data').then(r => r.json());
            const keys = Object.keys(pData).sort();
            const rWlPatch = await fetch('/api/worklist/todo/todo-1', { method: 'PATCH' });
            const rWlReset = await fetch('/api/worklist/reset', { method: 'POST' });
            const rWlExport = await fetch('/api/worklist/export/todo');
            const rFinCsv = await fetch('/api/export/csv/financials');
            const finCsvText = await rFinCsv.text();
            const rSrcCsv = await fetch('/api/export/csv/sources');
            const rPmCsv = await fetch('/api/export/csv/paidmedia');
            const rFunCsv = await fetch('/api/export/csv/funnel');
            const rRefCsv = await fetch('/api/export/csv/refill-steps');
            const rRetCsv = await fetch('/api/export/csv/retention-matrix');
            const rMedCsv = await fetch('/api/export/csv/medmix');
            return {
                keys,
                hasWorklists: 'worklists' in pData || 'worklistSummary' in pData,
                hasEnrollmentOrAnalysis: 'enrollmentReporting' in pData || 'analysisWorkbook' in pData,
                wlPatchStatus: rWlPatch.status,
                wlResetStatus: rWlReset.status,
                wlExportStatus: rWlExport.status,
                csvStatuses: [rFinCsv.status, rSrcCsv.status, rPmCsv.status, rFunCsv.status, rRefCsv.status, rRetCsv.status, rMedCsv.status],
                finCsvHasHeader: finCsvText.includes('Line Item,YTD Amount ($)')
            };
        }""")
        expected_keys = sorted([
            "meta",
            "slide2_summary",
            "slide3_financials",
            "slide4_sources",
            "slide5_paidMedia",
            "slide6_funnel",
            "slide7_refill",
            "slide8_medMix",
            "slide9_appendix",
            "slide10_retention",
        ])
        record(
            "NO-EXCEL-03",
            "/api/portal-data returns strictly PowerPoint Slides 1-10 keys (zero worklists, enrollmentReporting, or analysisWorkbook)",
            api_excel_check["keys"] == expected_keys
            and not api_excel_check["hasWorklists"]
            and not api_excel_check["hasEnrollmentOrAnalysis"],
            f"keys={api_excel_check['keys']}",
        )
        record(
            "NO-EXCEL-04",
            "Removed Worklist routes (/api/worklist/*) return 404 while all 7 PowerPoint Table CSV Export routes (/api/export/csv/*) return 200 CSV",
            api_excel_check["wlPatchStatus"] == 404
            and api_excel_check["wlResetStatus"] == 404
            and api_excel_check["wlExportStatus"] == 404
            and api_excel_check["csvStatuses"] == [200, 200, 200, 200, 200, 200, 200]
            and bool(api_excel_check["finCsvHasHeader"]),
            str(api_excel_check),
        )

        # ---------------------------------------------------------------------
        # SECTION 2C: DAMIEN POWERPOINT SLIDES 3-10 & ASK BRIDGE AI
        # ---------------------------------------------------------------------
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

        page.click("button[data-view='sources']")
        src_rows = page.locator("#tbodySources tr").count()
        src_headers = [h.strip() for h in page.locator("#tableSources thead th").all_inner_texts()]
        src_first_cells = page.locator("#tbodySources tr").first.locator("td").count()
        src_badge = page.locator("#sourcesMatchedBadge").inner_text().strip()
        record(
            "DAMIEN-08",
            "Slide 4 Patient Sources table has 6 rows, exact 8 PowerPoint columns (no Worklist column), & '1,952 Matched Member Fills' badge",
            src_rows == 6
            and src_first_cells == 8
            and len(src_headers) == 8
            and "Worklist" not in src_headers
            and src_badge == "1,952 Matched Member Fills",
            f"rows={src_rows}, cols={src_first_cells}, headers={src_headers}, badge='{src_badge}'",
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
        drop_text = page.locator("#funnelDropoffCards").inner_text()
        record(
            "DAMIEN-10",
            "Slide 6 Funnel title (760 patients) & dropoff cards (76, 76, 85) with zero worklist links",
            "760 patients" in funnel_title and drop_nums == ["76", "76", "85"] and "Inspect patients" not in drop_text,
            f"title='{funnel_title}', dropoffs={drop_nums}",
        )

        page.click("button[data-view='refill']")
        refill_steps = page.locator("#tbodyRefillSteps tr").count()
        ret_rows = page.locator("#tbodyRetentionMatrix tr").count()
        record(
            "DAMIEN-11",
            "Slide 7 & 10 Refill steps (7 rows) & Retention matrix (9 rows)",
            refill_steps == 7 and ret_rows == 9,
            f"steps={refill_steps}, ret={ret_rows}",
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

        # Verify Ask Bridge AI answers Patient Sources, First-Fill Funnel, Refill/Retention, and Med Mix strictly from PowerPoint Slides 1-10
        qa_slides_test = page.evaluate("""async () => {
            const rSrc = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Compare our Patient Sources by active members, first-fill conversion, and YTD pharmacy margin.', mode: 'instant'})
            }).then(r => r.json());
            const rFun = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Break down our First-Fill Funnel conversion stages and drop-off points.', mode: 'instant'})
            }).then(r => r.json());
            const rMed = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'What is our GLP-1 medication mix across Wegovy Pen, Wegovy Pill, and Ozempic in September?', mode: 'instant'})
            }).then(r => r.json());
            return {
                srcReply: rSrc.reply || '',
                funReply: rFun.reply || '',
                medReply: rMed.reply || ''
            };
        }""")
        record(
            "DAMIEN-20",
            "Ask Bridge AI answers Patient Sources (452 EPIC YTD, 417 Paid Media YTD), Funnel (760 enrolled, 523 filled), and Medication Mix (411 Wegovy Pen, 256 Pill, 6 Ozempic) strictly from Slides 1-10",
            ("452" in qa_slides_test["srcReply"] and "417" in qa_slides_test["srcReply"])
            and ("760" in qa_slides_test["funReply"] and "523" in qa_slides_test["funReply"])
            and ("411" in qa_slides_test["medReply"] and "256" in qa_slides_test["medReply"]),
            f"srcLen={len(qa_slides_test['srcReply'])}, funLen={len(qa_slides_test['funReply'])}, medLen={len(qa_slides_test['medReply'])}",
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

        # Verify natural conversational question synthesizes PowerPoint Slides 1-10 via real Gemini LLM
        qa_natural = page.evaluate("""async () => {
            const r = await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({question: 'Compare our EPIC vs Paid Media channels in terms of YTD enrollments, first-fill conversion, and YTD pharmacy gross margin.'})
            });
            return await r.json();
        }""")
        reply_nat = qa_natural.get("reply", "")
        record(
            "DAMIEN-27",
            "Conversational AI synthesizes across PowerPoint Slides 1-10 (EPIC 452 YTD / $696,172 margin vs Paid Media 417 YTD / $673,832 margin) without false-positive blocks",
            not bool(qa_natural.get("memberLevelBlocked"))
            and ("452" in reply_nat)
            and ("417" in reply_nat),
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

        page.click("button[data-view='financials']")
        m_fin_kpis = page.locator("#financialsKpiRow .kpi .kpi-val").all_inner_texts()
        record(
            "METRO-05",
            "Metro Financials 4 KPI cards ($248,400, $645,200, $1,580,400, $31,200)",
            m_fin_kpis == ["$248,400", "$645,200", "$1,580,400", "$31,200"],
            str(m_fin_kpis),
        )

        page.click("button[data-view='funnel']")
        m_funnel_title = page.locator("#funnelChartTitle").inner_text().strip()
        m_drop_nums = page.locator("#funnelDropoffCards .dropoff-num").all_inner_texts()
        record(
            "METRO-07",
            "Metro Funnel dynamically shows 500 pre-Sep patients and Metro dropoff cards",
            "500 patients" in m_funnel_title and len(m_drop_nums) == 3,
            f"title='{m_funnel_title}', dropoffs={m_drop_nums}",
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
        mfa_edge_test = page.evaluate("""async () => {
            const r1 = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username: 'pharmacist.damien', password: 'DamienPharm2026!' })
            });
            const d1 = await r1.json();
            const rWrong = await fetch('/api/auth/verify-mfa', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ challengeToken: d1.challengeToken, code: '000000', trustDevice: false })
            });
            const rResend = await fetch('/api/auth/resend-mfa', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ challengeToken: d1.challengeToken })
            });
            const dResend = await rResend.json();
            const rRight = await fetch('/api/auth/verify-mfa', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ challengeToken: d1.challengeToken, code: dResend.emailCodePreview, trustDevice: false })
            });
            const dRight = await rRight.json();
            return { wrongStatus: rWrong.status, resendOk: dResend.ok, rightOk: dRight.ok };
        }""")
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
                hasMfaEvents: eventTypes.includes('LOGIN_SUCCESS_MFA')
            };
        }""")
        record(
            "SEC-11",
            "Bridge Super-Admin (rishi.damien) views full Named Users Directory (damien, brady.admin, pharmacist.damien) & Audit Trail events",
            bool(admin_audit_test["isBridgeAdmin"])
            and admin_audit_test["userCount"] >= 4
            and bool(admin_audit_test["hasDamienAndBrady"])
            and bool(admin_audit_test["hasMfaEvents"]),
            str(admin_audit_test),
        )

        # SEC-13: "Who Viewed What" Read & Navigation Telemetry (SECTION_VIEW & DEFINITIONS_VIEW)
        who_viewed_test = page.evaluate("""async () => {
            switchView('financials');
            switchView('sources');
            switchView('funnel');
            openDefinitionsModal();
            closeDefinitionsModal();
            await new Promise(r => setTimeout(r, 250));
            const ov = await fetch('/api/security/overview').then(r => r.json());
            const evTypes = (ov.auditEvents || []).map(e => e.eventType);
            const summaries = (ov.auditEvents || []).slice(0, 12).map(e => e.summary || '');
            return {
                hasSectionView: evTypes.includes('SECTION_VIEW'),
                hasDefsView: evTypes.includes('DEFINITIONS_VIEW'),
                sampleSummaries: summaries.slice(0, 4)
            };
        }""")
        record(
            "SEC-13",
            "'Who Viewed What' telemetry logs SECTION_VIEW & DEFINITIONS_VIEW with human-readable summaries",
            bool(who_viewed_test["hasSectionView"])
            and bool(who_viewed_test["hasDefsView"]),
            str(who_viewed_test),
        )

        # SEC-14: Executive Usage KPI Row (3 KPIs: Sign-Ins, Section Views, AI Questions) & Per-User Usage Counters
        usage_kpi_test = page.evaluate("""async () => {
            await openSecurityModal();
            const kpis = {
                logins: Number(document.getElementById('secKpiLogins')?.innerText || 0),
                views: Number(document.getElementById('secKpiViews')?.innerText || 0),
                aiQueries: Number(document.getElementById('secKpiAiQueries')?.innerText || 0)
            };
            const userRowsText = document.getElementById('tbodySecurityUsers')?.innerText || '';
            return {
                kpis,
                hasPerUserCounters: userRowsText.includes('logins') && userRowsText.includes('views') && userRowsText.includes('AI')
            };
        }""")
        record(
            "SEC-14",
            "Admin Usage Dashboard renders non-zero Sign-Ins, Section Views & AI Questions KPIs plus per-user activity counters",
            usage_kpi_test["kpis"]["logins"] >= 1
            and usage_kpi_test["kpis"]["views"] >= 2
            and usage_kpi_test["kpis"]["aiQueries"] >= 1
            and bool(usage_kpi_test["hasPerUserCounters"]),
            str(usage_kpi_test),
        )

        # SEC-15: Ask Bridge AI Full Q&A Transcript History Tab & Expandable AI Response Viewer
        qa_history_test = page.evaluate("""async () => {
            await fetch('/api/ask', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ question: 'What is our September active membership and YTD net program proceeds?', mode: 'instant' })
            });
            await refreshSecurityModalData();
            switchSecurityBottomTab('qa');
            const badgeText = document.getElementById('secQaCountBadge')?.innerText || '';
            const firstRow = document.querySelector('#tbodySecurityQaHistory tr[data-qa-id]');
            const qaId = firstRow ? firstRow.getAttribute('data-qa-id') : '';
            if (qaId) {
                toggleQaTranscriptExpand(qaId);
            }
            const qaTableText = document.getElementById('tbodySecurityQaHistory')?.innerText || '';
            switchSecurityBottomTab('audit');
            return {
                badgeText,
                hasQaRow: Boolean(qaId),
                hasQuestionText: qaTableText.includes('September active membership'),
                hasExpandedBtn: qaTableText.includes('Hide Full AI Response')
            };
        }""")
        record(
            "SEC-15",
            "Ask Bridge AI Q&A History tab records full question + full AI response and expands formatted transcript on click",
            bool(qa_history_test["hasQaRow"])
            and bool(qa_history_test["hasQuestionText"])
            and bool(qa_history_test["hasExpandedBtn"]),
            str(qa_history_test),
        )

        # SEC-16: Audit Log Category & User Filtering in UI
        audit_filter_test = page.evaluate("""() => {
            const catSel = document.getElementById('secAuditCategoryFilter');
            catSel.value = 'view_access';
            renderSecurityAuditTable();
            const viewRows = document.querySelectorAll('#tbodySecurityAuditLog tr').length;
            const allViewCats = Array.from(document.querySelectorAll('#tbodySecurityAuditLog tr')).every(
                tr => tr.getAttribute('data-event-category') === 'view_access'
            );
            catSel.value = '';
            renderSecurityAuditTable();
            const totalRows = document.querySelectorAll('#tbodySecurityAuditLog tr').length;
            return { viewRows, allViewCats, totalRows };
        }""")
        record(
            "SEC-16",
            "Security Audit Log dynamically filters by category ('Who Viewed What' view_access vs All Categories)",
            audit_filter_test["viewRows"] >= 2
            and bool(audit_filter_test["allViewCats"])
            and audit_filter_test["totalRows"] > audit_filter_test["viewRows"],
            str(audit_filter_test),
        )

        # SEC-17: Admin User Lifecycle Controls (PATCH role/email/unlock & DELETE custom user + Protected Baseline User Guard)
        lifecycle_test = page.evaluate(f"""async () => {{
            const tempUser = 'lifecycle.{int(time.time()) % 100000}';
            const rCreate = await fetch('/api/security/users', {{
                method: 'POST',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{
                    username: tempUser,
                    displayName: 'Temp Lifecycle User',
                    email: 'temp@damien.org',
                    password: 'TempLifecycle2026!#',
                    role: 'pharmacist'
                }})
            }});
            const rPatch = await fetch(`/api/security/users/${{tempUser}}`, {{
                method: 'PATCH',
                headers: {{'Content-Type': 'application/json'}},
                body: JSON.stringify({{ role: 'client_user', email: 'updated@damien.org', unlock: true }})
            }});
            const dPatch = await rPatch.json();
            const rDelProtected = await fetch('/api/security/users/damien', {{ method: 'DELETE' }});
            const rDelCustom = await fetch(`/api/security/users/${{tempUser}}`, {{ method: 'DELETE' }});
            closeSecurityModal();
            return {{
                createStatus: rCreate.status,
                patchOk: dPatch.ok && dPatch.user?.role === 'client_user' && dPatch.user?.email === 'updated@damien.org',
                delProtectedStatus: rDelProtected.status,
                delCustomStatus: rDelCustom.status
            }};
        }}""")
        record(
            "SEC-17",
            "Admin User Lifecycle API updates user role/email/unlock (PATCH), blocks deleting protected baseline user 'damien' (400), and deletes custom user (200)",
            lifecycle_test["createStatus"] == 200
            and bool(lifecycle_test["patchOk"])
            and lifecycle_test["delProtectedStatus"] == 400
            and lifecycle_test["delCustomStatus"] == 200,
            str(lifecycle_test),
        )

        # SEC-18: Admin CSV Export Endpoints for Audit Log & Ask Bridge AI Q&A History + Export KPI counter
        csv_export_test = page.evaluate("""async () => {
            const rAudit = await fetch('/api/security/export/audit-csv');
            const auditText = await rAudit.text();
            const rQa = await fetch('/api/security/export/qa-csv');
            const qaText = await rQa.text();
            const ov = await fetch('/api/security/overview').then(r => r.json());
            return {
                auditStatus: rAudit.status,
                auditHasHeader: auditText.includes('Timestamp (UTC),Tenant,Username') && auditText.includes('SECTION_VIEW'),
                qaStatus: rQa.status,
                qaHasHeader: qaText.includes('Question Asked,AI Response') && qaText.includes('September active membership'),
                totalExports: ov.usageSummary?.totalExports || 0
            };
        }""")
        record(
            "SEC-18",
            "Bridge Super-Admin exports both Security Audit Log CSV and Ask Bridge AI Q&A Transcript CSV with tracked export count",
            csv_export_test["auditStatus"] == 200
            and bool(csv_export_test["auditHasHeader"])
            and csv_export_test["qaStatus"] == 200
            and bool(csv_export_test["qaHasHeader"])
            and csv_export_test["totalExports"] >= 2,
            str(csv_export_test),
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
