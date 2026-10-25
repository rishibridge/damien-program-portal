import json
import os
import re
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:3099").rstrip("/")


def api_get(path):
    with urllib.request.urlopen(f"{BASE_URL}{path}") as r:
        return r.status, r.read().decode("utf-8"), dict(r.headers)


def has_slide_or_file_ref(text):
    return bool(re.search(r"\bslides?\s*\d|\.(pptx|xlsx)\b", text, re.IGNORECASE))


def run_e2e_suite():
    results = []

    def record(test_id, name, passed, details):
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {test_id}: {name} -> {details}")
        results.append({"id": test_id, "name": name, "passed": passed, "details": details})
        if not passed:
            raise AssertionError(f"{test_id} ({name}) FAILED: {details}")

    # 1. API Health, Gemini Configuration & Reset Baseline
    status, body, _ = api_get("/api/health")
    health = json.loads(body)
    record(
        "E2E-01",
        "Health API, Gemini Configuration & Baseline Counts",
        status == 200
        and health["status"] == "ok"
        and health.get("geminiConfigured") is True
        and health.get("geminiModel") == "gemini-2.5-flash"
        and health["worklistSummary"]["todoTotal"] == 101,
        f"status={status}, geminiConfigured={health.get('geminiConfigured')}, model={health.get('geminiModel')}, todoTotal={health['worklistSummary']['todoTotal']}"
    )

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        console_errors = []
        page_errors = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        page.goto(f"{BASE_URL}/", wait_until="networkidle")

        # 2. Bridge Health Hub Visual Identity & Header
        hero_text = page.locator(".bridge-hero").inner_text()
        computed_navy = page.evaluate("() => getComputedStyle(document.querySelector('.btn-bridge-primary')).backgroundColor")
        record(
            "E2E-02",
            "Bridge Health Hub Brand Style & Program Identity",
            "Damien Center GLP-1 Weight Loss Program" in hero_text
            and "September 30, 2026" in hero_text
            and "Bridge Health Hub" in hero_text
            and computed_navy == "rgb(21, 70, 114)",
            f"hero verified, button bg={computed_navy}"
        )

        # 2.1 Jony Ive Minimalist Design System & CEO Polish Verification
        body_bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
        hero_bg = page.evaluate("() => getComputedStyle(document.querySelector('.bridge-hero')).backgroundColor")
        sidebar_cta_count = page.locator(".sidebar-cta").count()
        sidebar_pills_count = page.locator("#sidebarNav .nav-pill").count()
        full_html = page.content()
        record(
            "E2E-02.1",
            "Jony Ive Minimalist Design System & CEO Polish (Alabaster #F5F5F7, Single Sidebar Action Badge, Zero Jargon/Emojis)",
            body_bg == "rgb(245, 245, 247)"
            and hero_bg == "rgb(255, 255, 255)"
            and sidebar_cta_count == 0
            and sidebar_pills_count == 1
            and "⚡" not in full_html
            and "Yellow = Editable" not in full_html
            and "Reset Demo Edits" not in full_html
            and "25 Cols" not in full_html,
            f"body_bg={body_bg}, hero_bg={hero_bg}, sidebar_pills={sidebar_pills_count}, clean_labels=True"
        )

        # 3. Executive Summary: 6 Headline KPIs + Membership Growth Chart + 6 What You Need to Know items + Dollar Value Pulse
        kpi_text = page.locator("#summaryKpiRow").inner_text()
        know_items = page.locator("#whatYouNeedToKnowList .know-item").count()
        know_text = page.locator("#whatYouNeedToKnowList").inner_text()
        pulse_text = page.locator("#summaryWorklistPulse").inner_text()
        record(
            "E2E-03",
            "Executive Summary KPIs (862, 673, $371K, $962K, 69%, 94%), 6 Takeaways & Dollar Value Pulse ($87,971 / $32,227 / $77,554)",
            all(v in kpi_text for v in ["862", "673", "$371K", "$962K", "69%", "94%"])
            and know_items == 6
            and "$4.63" in know_text
            and "38%" in know_text
            and all(v in pulse_text for v in ["$87,971", "$32,227", "$77,554"]),
            f"6 KPIs, {know_items} takeaways & worklist dollar valuations verified"
        )

        # 4. Program Financials, Expanded CFO YTD P&L Table (COGS, % of Rev, Per Fill) & Interactive Simulator
        page.click("button[data-view='financials']")
        page.wait_for_selector("#view-financials.active")
        fin_text = page.locator("#tableYtdFinancials").inner_text()
        fin_fn = page.locator("#financialsFootnote").inner_text()
        record(
            "E2E-04",
            "CFO YTD P&L Statement ($2,336,983 rev, −$578,358 COGS, $1,758,625 margin [75.3%], $961,691 proceeds [$473/fill])",
            all(x in fin_text for x in [
                "$2,336,983", "−$578,358", "$1,758,625", "75.3%", "$44,164",
                "−$142,033", "−$411,745", "−$195,900", "−$10,060", "−$81,360",
                "$961,691", "41.2%", "$1,149", "$865", "$473"
            ])
            and "$911" in fin_fn,
            "All 10 P&L line items, % of Revenue, and Per-Fill unit economics verified"
        )

        # Test Interactive Simulator on Financials view
        page.evaluate("""() => {
            const s = document.getElementById('simTodoSlider');
            s.value = 100;
            s.dispatchEvent(new Event('input'));
        }""")
        sim_fills = page.locator("#simOutFills").inner_text()
        record(
            "E2E-05",
            "Interactive First-Fill P&L Simulator Reactivity",
            sim_fills == "+125",
            f"Simulator updated incremental fills to {sim_fills}"
        )

        # 5. Patient Acquisition Sources, Pre-Sep Sample Sizes (n) & CFO P&L Reconciliation Footer
        page.click("button[data-view='sources']")
        page.wait_for_selector("#view-sources.active")
        src_text = page.locator("#tableSources").inner_text()
        page.click("#btnSourcesPct")
        page.click("#btnSourcesCount")
        record(
            "E2E-06",
            "Patient Sources Table, Pre-Sep Sample Sizes (332, 324, n=11, n=1) & P&L Reconciliation Tie-Out (1,952 + 82 = 2,034 / $1,758,625)",
            all(x in src_text for x in [
                "EPIC", "452", "332", "$696,172", "Paid Media", "417", "324", "$671,400",
                "LHD", "n=11", "McGohan Brabender", "88%", "n=1", "$160,234", "$107,308",
                "1,952", "$1,681,071", "82", "$77,554", "2,034", "$1,758,625"
            ]),
            "All 6 sources, pre-Sep denominators, low-n flags, and 3-row P&L tie-out verified"
        )

        # 6. Paid Media ROI, Unit Economics Comparison & 11x9 Cohort Table
        page.click("button[data-view='paidmedia']")
        page.wait_for_selector("#view-paidmedia.active")
        pm_kpis = page.locator("#paidMediaKpiRow").inner_text()
        pm_unit = page.locator("#paidMediaUnitEconRow").inner_text()
        pm_tbl = page.locator("#tablePaidMedia").inner_text()
        record(
            "E2E-07",
            "Paid Media KPIs ($142K, 414, 243, $658K), Channel Unit Economics (4.41x net, $12.64 broker/fill) & Cohort Table (463% ROAS)",
            all(x in pm_kpis for x in ["$142K", "414", "$343", "243", "$584", "$658K", "786"])
            and all(x in pm_unit for x in ["$584", "4.41x", "$626,921", "$12.64"])
            and all(x in pm_tbl for x in ["$142,033", "$658,361", "463%", "687%", "531%"]),
            "Paid Media KPIs, CFO channel unit economics strip, and monthly cohort table verified"
        )

        # 7. Provider Visit & First-Fill Funnel + Timing + True Backlog Note
        page.click("button[data-view='funnel']")
        page.wait_for_selector("#view-funnel.active")
        drop_text = page.locator("#funnelDropoffCards").inner_text()
        timing_text = page.locator("#funnelTimingList").inner_text()
        funnel_view_text = page.locator("#view-funnel").inner_text()
        record(
            "E2E-08",
            "Funnel Drop-Offs (76, 76, 85), Median Timing & True Backlog Note (86 truly unfilled + 15 typo-matched)",
            all(x in drop_text for x in ["76", "never completed a provider visit", "saw a provider but were not prescribed", "85", "were prescribed but never filled"])
            and all(x in timing_text for x in ["Under 1 hour", "17 hours", "1 day", "86%"])
            and "86 truly unfilled" in funnel_view_text,
            "Funnel dropoffs, timing, and adjusted backlog note verified"
        )

        # 8. Refill Persistence (45d Cohort Numerator 366/391 + All-Time 494) & Monthly Member Retention Cohort Matrix
        page.click("button[data-view='refill']")
        page.wait_for_selector("#view-refill.active")
        refill_tbl = page.locator("#tableRefillSteps").inner_text()
        refill_fn = page.locator("#refillFootnote").inner_text()
        ret_tbl = page.locator("#tableRetentionMatrix").inner_text()
        record(
            "E2E-09",
            "Refill Persistence (94% = 366 of 391 eligible, 494 all-time, 27d gap) & Cohort Retention Matrix (1,030 Joined)",
            all(x in refill_tbl for x in ["Fill 1 → 2", "94%", "366", "391", "494 pts", "Fill 7 → 8", "95%", "19", "20"])
            and "27 days" in refill_fn
            and all(x in ret_tbl for x in ["Jan", "20", "65%", "Aug", "276", "84%", "Sep", "273"]),
            "Refill 45d cohort numerator/denominator and cohort retention heatmap verified"
        )

        # 9. Medication Mix (Wegovy Pen 411, Wegovy Pill 256, Ozempic 6) & Cold-Chain vs Ambient Split
        page.click("button[data-view='medmix']")
        page.wait_for_selector("#view-medmix.active")
        med_callouts = page.locator("#medMixCalloutList").inner_text()
        med_cold_chain = page.locator("#medMixColdChainBox").inner_text()
        med_tbl = page.locator("#tbodyMedMixMonthly").inner_text()
        record(
            "E2E-10",
            "Medication Mix (411 Pen, 256 Pill [38%], 6 Ozempic = 673) & Cold-Chain (417 [62.0%]) vs. Ambient (256 [38.0%])",
            all(x in med_callouts for x in ["411", "Wegovy pen fills, Sep", "256", "Wegovy pill fills, Sep", "6", "Ozempic fills, Sep"])
            and all(x in med_cold_chain for x in ["417 fills (62.0%)", "256 fills (38.0%)"])
            and "673" in med_tbl,
            "Medication mix callouts, cold-chain vs ambient split, and monthly table verified"
        )

        # 10. Worklist Queue 1: Pharmacy To-Do (101 records, RTS Will-Call Alert, Inline Payer/Rx Date, Priority/Fuzzy filters)
        page.click("button[data-view='worklist']")
        page.wait_for_selector("#view-worklist.active")
        todo_rows_all = page.locator("#tbodyWorklistTodo tr").count()
        todo_table_text = page.locator("#tbodyWorklistTodo").inner_text()
        page.select_option("#todoPriorityFilter", "1 – Urgent: cancellation pending")
        todo_rows_urgent = page.locator("#tbodyWorklistTodo tr").count()
        page.select_option("#todoPriorityFilter", "")
        page.select_option("#todoFuzzyFilter", "fuzzy")
        todo_rows_fuzzy = page.locator("#tbodyWorklistTodo tr").count()
        page.select_option("#todoFuzzyFilter", "")
        record(
            "E2E-11",
            "Worklist Queue 1: Pharmacy To-Do (101 total, 10 Urgent, 15 Fuzzy, RTS Watch Will-Call Alert & Inline Payer)",
            todo_rows_all == 101
            and todo_rows_urgent == 10
            and todo_rows_fuzzy == 15
            and "RTS Watch: Will-Call (8d in stage" in todo_table_text
            and "Payer: Wegovy Savings Card" in todo_table_text,
            f"all={todo_rows_all}, urgent={todo_rows_urgent}, fuzzy={todo_rows_fuzzy}, RTS & inline payer verified"
        )

        # Test 25-column Patient Detail Modal on Pharmacy To-Do (via 'Details' button)
        page.locator("#tbodyWorklistTodo tr").first.locator("button").click()
        page.wait_for_selector("#patientDetailModal.open")
        modal_cols = page.locator("#modalPatientBody .detail-item").count()
        modal_text = page.locator("#modalPatientBody").inner_text()
        page.click("#patientDetailModal button")
        record(
            "E2E-12",
            "Pharmacy To-Do 25-Column Patient Detail Modal ('Details' Button)",
            modal_cols == 25 and "6d3f1831" in modal_text and "Warrick County" in modal_text,
            f"Modal displayed {modal_cols} columns for patient 6d3f1831"
        )

        # 11. Worklist Queue 2: Refill Follow-Up (37 records, status filter, Clinical RPh Consult Flag)
        page.click("#wlTabBtn-refill")
        refill_all = page.locator("#tbodyWorklistRefill tr").count()
        refill_table_text = page.locator("#tbodyWorklistRefill").inner_text()
        page.select_option("#refillStatusFilter", "Active – cancellation pending")
        refill_cancel = page.locator("#tbodyWorklistRefill tr").count()
        page.select_option("#refillStatusFilter", "")
        record(
            "E2E-13",
            "Worklist Queue 2: Refill Follow-Up (37 total, 7 Cancel Pending, RPh Consult Missed >2 Doses Flag)",
            refill_all == 37
            and refill_cancel == 7
            and "RPh Consult: Missed >2 Doses" in refill_table_text,
            f"all={refill_all}, cancel_pending={refill_cancel}, clinical consult flag verified"
        )

        # 12. Worklist Queue 3: Pharmacy Data Fixes (31 Unmatched + 55 No ID = 86, GLP-1 vs Ancillary Tag, Auto-Reconcile)
        page.click("#wlTabBtn-fixes")
        unmatched_cnt = page.locator("#tbodyFixesUnmatched tr").count()
        noid_cnt = page.locator("#tbodyFixesNoId tr").count()
        noid_text = page.locator("#tbodyFixesNoId").inner_text()
        with page.expect_response(lambda r: "/api/portal-data" in r.url and r.status == 200):
            page.click("#btnApplyAllFuzzy")
        page.wait_for_timeout(150)
        populated_fixes = page.evaluate("""() => {
            return Array.from(document.querySelectorAll('#tbodyFixesUnmatched input.edit-cell-input'))
                .filter(el => el.value.trim().length > 0).length;
        }""")
        with page.expect_response(lambda r: "/api/portal-data" in r.url and r.status == 200):
            page.click("#btnResetWorklistEdits")
        page.wait_for_timeout(150)
        record(
            "E2E-14",
            "Worklist Queue 3: Pharmacy Data Fixes (31 Unmatched + 55 No ID = 86, GLP-1 vs Ancillary Tag & Auto-Reconcile 21 Matches)",
            unmatched_cnt == 31
            and noid_cnt == 55
            and populated_fixes == 21
            and "GLP-1 P&L Fill" in noid_text
            and "Non-GLP-1 Ancillary" in noid_text,
            f"unmatched={unmatched_cnt}, noId={noid_cnt}, autoReconciled={populated_fixes}, GLP-1 vs Ancillary verified"
        )

        # 13. Worklist Queue 4: Ended – Never Filled (186 records, stage & finding filters)
        page.click("#wlTabBtn-ended")
        ended_all = page.locator("#tbodyWorklistEnded tr").count()
        page.select_option("#endedStageFilter", "Rx written, not filled")
        ended_rx = page.locator("#tbodyWorklistEnded tr").count()
        page.select_option("#endedFindingFilter", "Ineligible – Medicaid/HIP/Medicare coverage")
        ended_medicaid = page.locator("#tbodyWorklistEnded tr").count()
        page.select_option("#endedStageFilter", "")
        page.select_option("#endedFindingFilter", "")
        record(
            "E2E-15",
            "Worklist Queue 4: Ended – Never Filled (186 total, 47 Rx written not filled, 18 Medicaid/Medicare ineligible)",
            ended_all == 186 and ended_rx == 47 and ended_medicaid == 18,
            f"all={ended_all}, rx_unfilled={ended_rx}, medicaid_ineligible={ended_medicaid}"
        )

        # 14. CSV Export Endpoint Verification
        csv_status, csv_body, csv_headers = api_get("/api/worklist/export/todo")
        record(
            "E2E-16",
            "Worklist CSV Export Endpoint",
            csv_status == 200 and "6d3f1831-b703-40b7-855a-4bc43ea1e285" in csv_body,
            f"CSV status={csv_status}, bytes={len(csv_body)}"
        )

        # 15. Program Definitions & Data Notes Modal (Decoupled from Ask Bridge AI view)
        page.click("button[data-view='ask']")
        page.wait_for_selector("#view-ask.active")
        page.click("#btnOpenDefinitions")
        page.wait_for_selector("#definitionsModal.open")
        appendix_notes = page.locator("#appendixNotesList .know-item").count()
        appendix_text = page.locator("#appendixNotesList").inner_text()
        page.click("#btnCloseDefinitionsModal")
        record(
            "E2E-17",
            "Program Definitions & Data Notes Modal (6 notes, 1,952 of 2,034 fills matched [96%], Decoupled from Chat View)",
            appendix_notes == 6 and "1,952 of 2,034" in appendix_text,
            f"{appendix_notes} program definition cards verified in clean modal"
        )

        # 16. Verify ZERO Slide Number / PPTX / XLSX References Across All 9 Portal Views
        slide_ref_violations = []
        for view_id in ["summary", "financials", "sources", "paidmedia", "funnel", "refill", "medmix", "worklist", "ask"]:
            page.click(f"button[data-view='{view_id}']")
            page.wait_for_selector(f"#view-{view_id}.active")
            visible_text = page.locator("body").inner_text()
            if has_slide_or_file_ref(visible_text):
                slide_ref_violations.append(view_id)
        record(
            "E2E-18",
            "Zero Slide Number or Raw PPTX/XLSX References Across All 9 Views",
            len(slide_ref_violations) == 0,
            f"violations={slide_ref_violations}"
        )

        # 17. Live Google Gemini 2.5 Flash Natural Conversational Q&A ("Ask Bridge AI")
        page.click("button[data-view='ask']")
        page.wait_for_selector("#view-ask.active")

        # Verify initial greeting and that #qaAnswerContainer is a pure chat thread (no KPI cards, charts, or tables)
        initial_thread = page.locator("#qaAnswerContainer").inner_text()
        record(
            "E2E-19.0",
            "Natural Conversational Chat Thread Initialization (Clean Greeting, No Forced KPIs, Charts, or Tables)",
            "What question can I answer?" in initial_thread
            and "410" not in initial_thread
            and page.locator("#qaAnswerContainer canvas").count() == 0
            and page.locator("#qaAnswerContainer table").count() == 0
            and page.locator("#qaAnswerContainer .kpi").count() == 0,
            "Clean greeting ('What question can I answer?') and pure conversation thread verified"
        )

        gemini_qa_scenarios = [
            (
                "Hey there! How is the program doing overall through September, and what are our total YTD program proceeds and pharmacy gross margin?",
                ["961,691", "1,758,625"]
            ),
            (
                "How does EPIC compare to Paid Media on first-fill rates and YTD gross margin?",
                ["77%", "62%", "696,172"]
            ),
            (
                "Which active patients on the Pharmacy To-Do list are in City of Evansville and what medications were they prescribed?",
                ["City of Evansville", "Wegovy"]
            ),
            (
                "How many unlinked fills in Pharmacy Data Fixes fuzzy-match to active To-Do patients?",
                ["21"]
            ),
            (
                "And who are the 3 patients on the Pharmacy To-Do list whose medication is Ready – waiting for pickup?",
                ["30862dd4", "a8f44a1e", "9eb5575e"]
            )
        ]

        for idx, (question, expected_tokens) in enumerate(gemini_qa_scenarios, 1):
            page.fill("#mainAskInput", question)
            with page.expect_response(lambda r: "/api/ask" in r.url and r.status == 200, timeout=30000) as resp_info:
                page.click("#mainAskSubmitBtn")
            resp_json = resp_info.value.json()
            page.wait_for_timeout(120)
            ans_text = page.locator("#qaAnswerContainer").inner_text()
            is_gemini = resp_json.get("aiPowered") is True and resp_json.get("aiModel") == "gemini-2.5-flash"
            tokens_ok = all(tok.lower() in ans_text.lower() for tok in expected_tokens)
            no_slide_ref = not has_slide_or_file_ref(ans_text)
            no_extra_widgets = (
                page.locator("#qaAnswerContainer canvas").count() == 0
                and page.locator("#qaAnswerContainer table").count() == 0
                and page.locator("#qaAnswerContainer .kpi").count() == 0
            )
            record(
                f"E2E-19.{idx}",
                f"Natural Gemini Conversation Turn {idx}: '{question[:50]}...'",
                is_gemini and tokens_ok and no_slide_ref and no_extra_widgets,
                f"aiPowered={is_gemini}, tokens_ok={tokens_ok} ({expected_tokens}), noSlideRef={no_slide_ref}, pureChat={no_extra_widgets}"
            )

        # Verify 'New Conversation' button resets the chat thread cleanly
        page.click("button:has-text('New Conversation')")
        reset_msg_count = page.locator("#qaAnswerContainer .chat-msg").count()
        record(
            "E2E-19.6",
            "New Conversation Button Resets Chat Thread",
            reset_msg_count == 1,
            f"chat messages after reset={reset_msg_count}"
        )

        # 18. Global Topbar Ask Bar Navigation & Live Gemini Conversational Reply
        page.click("button[data-view='summary']")
        page.fill("#topbarAskInput", "How much did Paid Media return per $1 spent and what was total media spend?")
        with page.expect_response(lambda r: "/api/ask" in r.url and r.status == 200, timeout=30000) as top_resp_info:
            page.click("#topbarAskBtn")
        page.wait_for_selector("#view-ask.active")
        page.wait_for_timeout(120)
        top_json = top_resp_info.value.json()
        top_ans = page.locator("#qaAnswerContainer").inner_text()
        record(
            "E2E-20",
            "Global Topbar Ask Bridge AI Search Bar Navigation & Live Conversational Reply",
            top_json.get("aiPowered") is True
            and ("4.63" in top_ans or "463%" in top_ans)
            and not has_slide_or_file_ref(top_ans),
            "Topbar search navigated to Ask view and rendered natural conversational reply"
        )

        # 19. Zero Console / Page Errors
        record(
            "E2E-21",
            "Zero Runtime Console or Page Exceptions",
            len(page_errors) == 0 and len(console_errors) == 0,
            f"page_errors={len(page_errors)}, console_errors={len(console_errors)}"
        )

        browser.close()

    print(f"\n=== ALL {len(results)} E2E TESTS PASSED AGAINST {BASE_URL} ===")


if __name__ == "__main__":
    run_e2e_suite()
