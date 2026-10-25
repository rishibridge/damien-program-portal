import json
import os
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


def run_e2e_suite():
    results = []

    def record(test_id, name, passed, details):
        status = "PASS" if passed else "FAIL"
        print(f"[{status}] {test_id}: {name} -> {details}")
        results.append({"id": test_id, "name": name, "passed": passed, "details": details})
        if not passed:
            raise AssertionError(f"{test_id} ({name}) FAILED: {details}")

    # 1. API Health & Reset Baseline
    status, body, _ = api_get("/api/health")
    health = json.loads(body)
    record(
        "E2E-01",
        "Health API & Baseline Counts",
        status == 200 and health["status"] == "ok" and health["worklistSummary"]["todoTotal"] == 101,
        f"status={status}, summary={health['worklistSummary']}"
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

        # 2. Bridge Health Hub Visual Identity & Slide 1 Header
        hero_text = page.locator(".bridge-hero").inner_text()
        computed_navy = page.evaluate("() => getComputedStyle(document.querySelector('.btn-bridge-primary')).backgroundColor")
        record(
            "E2E-02",
            "Bridge Health Hub Brand Style & Slide 1 Program Identity",
            "Damien Center GLP-1 Weight Loss Program" in hero_text
            and "September 30, 2026" in hero_text
            and "Bridge Health Hub" in hero_text
            and computed_navy == "rgb(21, 70, 114)",
            f"hero verified, button bg={computed_navy}"
        )

        # 3. Slide 2: 6 Headline KPIs + Membership Growth Chart + 6 What You Need to Know items
        kpi_text = page.locator("#summaryKpiRow").inner_text()
        know_items = page.locator("#whatYouNeedToKnowList .know-item").count()
        know_text = page.locator("#whatYouNeedToKnowList").inner_text()
        record(
            "E2E-03",
            "Slide 2 Executive Summary KPIs (862, 673, $371K, $962K, 69%, 94%) & 6 Takeaways",
            all(v in kpi_text for v in ["862", "673", "$371K", "$962K", "69%", "94%"])
            and know_items == 6
            and "$4.63" in know_text
            and "38%" in know_text,
            f"6 KPIs & {know_items} takeaways verified"
        )

        # 4. Slide 3: Program Financials, YTD P&L Table & Interactive Simulator
        page.click("button[data-view='financials']")
        page.wait_for_selector("#view-financials.active")
        fin_text = page.locator("#tableYtdFinancials").inner_text()
        fin_fn = page.locator("#financialsFootnote").inner_text()
        record(
            "E2E-04",
            "Slide 3 Program Financials & YTD P&L Table ($2,336,983 rev, $1,758,625 margin, $961,691 proceeds, $911/fill)",
            all(x in fin_text for x in ["$2,336,983", "$1,758,625", "$44,164", "−$142,033", "−$411,745", "−$195,900", "−$10,060", "−$81,360", "$961,691"])
            and "$911" in fin_fn,
            "All 9 P&L line items and $911 Sep margin/fill verified"
        )

        # Test Interactive Simulator on Slide 3
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

        # 5. Slide 4: Patient Acquisition Sources & Stacked Chart Toggle
        page.click("button[data-view='sources']")
        page.wait_for_selector("#view-sources.active")
        src_text = page.locator("#tableSources").inner_text()
        page.click("#btnSourcesPct")
        page.click("#btnSourcesCount")
        record(
            "E2E-06",
            "Slide 4 Patient Sources Table (EPIC 120/452/$696,172, Paid Media, LHD, McGohan Brabender, Employee, Other)",
            all(x in src_text for x in ["EPIC", "452", "$696,172", "Paid Media", "417", "$671,400", "LHD", "McGohan Brabender", "88%", "$160,234", "$107,308"]),
            "All 6 sources and metrics verified"
        )

        # 6. Slide 5: Paid Media ROI & 11x9 Cohort Table
        page.click("button[data-view='paidmedia']")
        page.wait_for_selector("#view-paidmedia.active")
        pm_kpis = page.locator("#paidMediaKpiRow").inner_text()
        pm_tbl = page.locator("#tablePaidMedia").inner_text()
        record(
            "E2E-07",
            "Slide 5 Paid Media KPIs ($142K, 414, 243, $658K) & Cohort Table (463% ROAS)",
            all(x in pm_kpis for x in ["$142K", "414", "$343", "243", "$584", "$658K", "786"])
            and all(x in pm_tbl for x in ["$142,033", "$658,361", "463%", "687%", "531%"]),
            "Paid Media KPIs and monthly cohort table verified"
        )

        # 7. Slide 6: Provider Visit & First-Fill Funnel + Timing
        page.click("button[data-view='funnel']")
        page.wait_for_selector("#view-funnel.active")
        drop_text = page.locator("#funnelDropoffCards").inner_text()
        timing_text = page.locator("#funnelTimingList").inner_text()
        record(
            "E2E-08",
            "Slide 6 Funnel Drop-Offs (76, 76, 85) & Median Timing (Under 1 hour, 17 hours, 1 day, 86%)",
            all(x in drop_text for x in ["76", "never completed a provider visit", "saw a provider but were not prescribed", "85", "were prescribed but never filled"])
            and all(x in timing_text for x in ["Under 1 hour", "17 hours", "1 day", "86%"]),
            "Funnel dropoffs and timing verified"
        )

        # 8. Slides 7 & 10: Refill Persistence & Monthly Member Retention Cohort Matrix
        page.click("button[data-view='refill']")
        page.wait_for_selector("#view-refill.active")
        refill_tbl = page.locator("#tableRefillSteps").inner_text()
        refill_fn = page.locator("#refillFootnote").inner_text()
        ret_tbl = page.locator("#tableRetentionMatrix").inner_text()
        record(
            "E2E-09",
            "Slides 7 & 10 Refill Persistence (94% on 391 pts, 27d gap) & Cohort Retention Matrix (Jan-Sep M0-M8)",
            all(x in refill_tbl for x in ["Fill 1 → 2", "94%", "391", "Fill 7 → 8", "95%", "20"])
            and "27 days" in refill_fn
            and all(x in ret_tbl for x in ["Jan", "20", "65%", "Aug", "276", "84%", "Sep", "273"]),
            "Refill persistence and Slide 10 retention heatmap verified"
        )

        # 9. Slide 8: Medication Mix (Wegovy Pen 411, Wegovy Pill 256, Ozempic 6)
        page.click("button[data-view='medmix']")
        page.wait_for_selector("#view-medmix.active")
        med_callouts = page.locator("#medMixCalloutList").inner_text()
        med_tbl = page.locator("#tbodyMedMixMonthly").inner_text()
        record(
            "E2E-10",
            "Slide 8 Medication Mix (411 Wegovy Pen, 256 Wegovy Pill [38%], 6 Ozempic = 673 Sep fills)",
            all(x in med_callouts for x in ["411", "Wegovy pen fills, Sep", "256", "Wegovy pill fills, Sep", "6", "Ozempic fills, Sep"])
            and "673" in med_tbl,
            "Medication mix callouts and monthly table verified"
        )

        # 10. Worklist Sheet 1: Pharmacy To-Do (101 records, Priority filter, Fuzzy filter, Inline Edit & 25-Col Modal)
        page.click("button[data-view='worklist']")
        page.wait_for_selector("#view-worklist.active")
        todo_rows_all = page.locator("#tbodyWorklistTodo tr").count()
        page.select_option("#todoPriorityFilter", "1 – Urgent: cancellation pending")
        todo_rows_urgent = page.locator("#tbodyWorklistTodo tr").count()
        page.select_option("#todoPriorityFilter", "")
        page.select_option("#todoFuzzyFilter", "fuzzy")
        todo_rows_fuzzy = page.locator("#tbodyWorklistTodo tr").count()
        page.select_option("#todoFuzzyFilter", "")
        record(
            "E2E-11",
            "Worklist Sheet 1: Pharmacy To-Do (101 total, 10 Urgent cancel-pending, 15 Fuzzy-matched)",
            todo_rows_all == 101 and todo_rows_urgent == 10 and todo_rows_fuzzy == 15,
            f"all={todo_rows_all}, urgent={todo_rows_urgent}, fuzzy={todo_rows_fuzzy}"
        )

        # Test 25-column Patient Detail Modal on Pharmacy To-Do
        page.locator("#tbodyWorklistTodo tr").first.locator("button").click()
        page.wait_for_selector("#patientDetailModal.open")
        modal_cols = page.locator("#modalPatientBody .detail-item").count()
        modal_text = page.locator("#modalPatientBody").inner_text()
        page.click("#patientDetailModal button")
        record(
            "E2E-12",
            "Pharmacy To-Do 25-Column Patient Detail Modal",
            modal_cols == 25 and "6d3f1831" in modal_text and "Warrick County" in modal_text,
            f"Modal displayed {modal_cols} columns for patient 6d3f1831"
        )

        # 11. Worklist Sheet 2: Refill Follow-Up (37 records, status filter)
        page.click("#wlTabBtn-refill")
        refill_all = page.locator("#tbodyWorklistRefill tr").count()
        page.select_option("#refillStatusFilter", "Active – cancellation pending")
        refill_cancel = page.locator("#tbodyWorklistRefill tr").count()
        page.select_option("#refillStatusFilter", "")
        record(
            "E2E-13",
            "Worklist Sheet 2: Refill Follow-Up (37 total, 7 Active – cancellation pending)",
            refill_all == 37 and refill_cancel == 7,
            f"all={refill_all}, cancel_pending={refill_cancel}"
        )

        # 12. Worklist Sheet 3: Pharmacy Data Fixes (31 Unmatched + 55 No ID = 86, plus One-Click Auto-Reconcile)
        page.click("#wlTabBtn-fixes")
        unmatched_cnt = page.locator("#tbodyFixesUnmatched tr").count()
        noid_cnt = page.locator("#tbodyFixesNoId tr").count()
        page.click("#btnApplyAllFuzzy")
        page.wait_for_timeout(400)
        # Verify that Corrected patient ID inputs were populated on unmatched rows
        populated_fixes = page.evaluate("""() => {
            return Array.from(document.querySelectorAll('#tbodyFixesUnmatched input.edit-cell-input'))
                .filter(el => el.value.trim().length > 0).length;
        }""")
        # Reset edits back to clean baseline
        page.click("button:has-text('Reset Demo Edits')")
        page.wait_for_timeout(400)
        record(
            "E2E-14",
            "Worklist Sheet 3: Pharmacy Data Fixes (31 Unmatched + 55 No ID = 86) & Auto-Reconcile 21 Fuzzy Matches",
            unmatched_cnt == 31 and noid_cnt == 55 and populated_fixes == 21,
            f"unmatched={unmatched_cnt}, noId={noid_cnt}, autoReconciled={populated_fixes}"
        )

        # 13. Worklist Sheet 4: Ended – Never Filled (186 records, stage & finding filters)
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
            "Worklist Sheet 4: Ended – Never Filled (186 total, 47 Rx written not filled, 18 Medicaid/Medicare ineligible)",
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

        # 15. Natural Language Q&A ("Ask Bridge AI") Comprehensive Multi-Scenario Testing + Slide 9 Appendix
        page.click("button[data-view='ask']")
        page.wait_for_selector("#view-ask.active")
        appendix_notes = page.locator("#appendixNotesList .know-item").count()
        appendix_text = page.locator("#appendixNotesList").inner_text()
        record(
            "E2E-17",
            "Slide 9 Appendix Definitions & Data Notes (6 notes, 1,952 of 2,034 fills matched [96%])",
            appendix_notes == 6 and "1,952 of 2,034" in appendix_text,
            f"{appendix_notes} appendix definition cards verified"
        )

        qa_scenarios = [
            ("How is Program Proceeds calculated and what is the YTD P&L breakdown?", "$961,691"),
            ("Where are patients coming from and how are EPIC and broker partners performing?", "62%"),
            ("Is paid media paying off and what is the ROAS by sign-up month?", "$4.63"),
            ("Where are patients dropping off in the provider and first-fill funnel?", "523"),
            ("Are patients refilling and how long are patients staying?", "94%"),
            ("What are patients filling in September between Wegovy pill and Wegovy pen?", "256"),
            ("Show me the 10 urgent cancellation-pending patients on the Pharmacy To-Do worklist", "6d3f1831"),
            ("Which unmatched patient IDs in Pharmacy Data Fixes fuzzy-match active patients?", "22d97e56"),
            ("Which employer groups have the most unfilled prescriptions?", "City of Evansville"),
            ("Which prescribers have the most unlinked fills in Pharmacy Data Fixes?", "Fields, Taryn"),
            ("Why did the 186 ended memberships never fill their first prescription?", "Medicaid/HIP/Medicare"),
            ("Find patient 51b6b2a0", "51b6b2a0")
        ]

        for idx, (question, expected_token) in enumerate(qa_scenarios, 1):
            page.fill("#mainAskInput", question)
            page.click("#mainAskSubmitBtn")
            page.wait_for_timeout(200)
            ans_text = page.locator("#qaAnswerContainer").inner_text()
            record(
                f"E2E-18.{idx}",
                f"Ask Bridge AI Q&A Scenario {idx}: '{question[:48]}...'",
                expected_token in ans_text,
                f"Verified token '{expected_token}' in answer"
            )

        # Also test Global Topbar Ask Bar from Summary view
        page.click("button[data-view='summary']")
        page.fill("#topbarAskInput", "How much did Paid Media return per $1 spent?")
        page.click("#topbarAskBtn")
        page.wait_for_selector("#view-ask.active")
        top_ans = page.locator("#qaAnswerContainer").inner_text()
        record(
            "E2E-19",
            "Global Topbar Ask Bridge AI Search Bar Navigation & Response",
            "$4.63" in top_ans and "463%" in top_ans,
            "Topbar search navigated to Ask view and rendered Paid Media ROAS answer"
        )

        # 16. Zero Console / Page Errors
        record(
            "E2E-20",
            "Zero Runtime Console or Page Exceptions",
            len(page_errors) == 0 and len(console_errors) == 0,
            f"page_errors={len(page_errors)}, console_errors={len(console_errors)}"
        )

        browser.close()

    print(f"\n=== ALL {len(results)} E2E TESTS PASSED AGAINST {BASE_URL} ===")


if __name__ == "__main__":
    run_e2e_suite()
