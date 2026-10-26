import argparse
import copy
import datetime
import json
import os
import openpyxl
from pptx import Presentation

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(BASE_DIR, "source_docs")
CLIENTS_DIR = os.path.join(BASE_DIR, "data", "clients")
os.makedirs(CLIENTS_DIR, exist_ok=True)


def fmt_val(v):
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float):
        if v.is_integer():
            return int(v)
        return round(v, 2)
    return str(v).strip() if isinstance(v, str) else v


def edit_distance(s1, s2):
    s1, s2 = s1.lower().strip(), s2.lower().strip()
    if len(s1) < len(s2):
        return edit_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    return previous_row[-1]


def extract_sheet_rows(ws, header_row_idx, start_row_idx, end_row_idx=None):
    max_r = end_row_idx if end_row_idx else ws.max_row
    headers = []
    for c in range(1, ws.max_column + 1):
        h = ws.cell(header_row_idx, c).value
        if h is not None:
            headers.append((c, str(h).strip()))

    rows = []
    for r in range(start_row_idx, max_r + 1):
        first_val = ws.cell(r, 1).value
        second_val = ws.cell(r, 2).value
        if first_val is None and second_val is None:
            continue
        if isinstance(first_val, str) and first_val.strip().lower().startswith("total"):
            continue
        row_dict = {}
        non_empty = False
        for c, h in headers:
            val = fmt_val(ws.cell(r, c).value)
            if val is not None and val != "":
                non_empty = True
            row_dict[h] = val
        if non_empty:
            rows.append(row_dict)
    return [h for _, h in headers], rows


def parse_fixes_sheet_dynamically(ws_fixes):
    """
    Dynamically scans Pharmacy Data Fixes sheet for:
      1. 'Fills with no Patient Alternate ID' section -> header row -> data rows until 'Total' or blank/next section
      2. 'Patient IDs that don't match' section -> header row -> data rows until end of sheet
    """
    no_id_banner_row = None
    no_id_title = "Fills with no Patient Alternate ID"
    unmatched_banner_row = None
    unmatched_title = "Patient IDs that don't match any program member"

    for r in range(1, ws_fixes.max_row + 1):
        val = str(ws_fixes.cell(r, 1).value or "").strip()
        val_lower = val.lower()
        if "fills with no patient alternate id" in val_lower:
            no_id_banner_row = r
            no_id_title = val
        elif "patient ids that don't match" in val_lower or "patient ids that dont match" in val_lower:
            unmatched_banner_row = r
            unmatched_title = val

    if no_id_banner_row is None:
        no_id_banner_row = 4
    if unmatched_banner_row is None:
        unmatched_banner_row = 63

    no_id_header_row = no_id_banner_row + 1
    no_id_end_row = unmatched_banner_row - 1
    for r in range(no_id_header_row + 1, unmatched_banner_row):
        v1 = str(ws_fixes.cell(r, 1).value or "").strip().lower()
        if v1.startswith("total"):
            no_id_end_row = r - 1
            break

    unmatched_header_row = unmatched_banner_row + 1

    fixes_no_id_headers, fixes_no_id = extract_sheet_rows(
        ws_fixes, header_row_idx=no_id_header_row, start_row_idx=no_id_header_row + 1, end_row_idx=no_id_end_row
    )
    fixes_unmatched_headers, fixes_unmatched = extract_sheet_rows(
        ws_fixes, header_row_idx=unmatched_header_row, start_row_idx=unmatched_header_row + 1
    )
    return (
        no_id_title,
        fixes_no_id_headers,
        fixes_no_id,
        unmatched_title,
        fixes_unmatched_headers,
        fixes_unmatched,
    )


def assign_stable_keys_and_fuzzy_links(pharmacy_todo, refill_followup, fixes_no_id, fixes_unmatched, ended_never_filled):
    for i, r in enumerate(pharmacy_todo):
        r["id"] = f"todo-{i+1}"
        alpha_id = str(r.get("Alpha member ID") or r.get("Pharmacy patient ID") or f"row-{i+1}").strip().lower()
        r["stableKey"] = f"todo:{alpha_id}"
        r["Status"] = r.get("Status") or "Not started"
        r["Date contacted"] = r.get("Date contacted") or ""
        r["Notes"] = r.get("Notes") or ""

    for i, r in enumerate(refill_followup):
        r["id"] = f"refill-{i+1}"
        alpha_id = str(r.get("Alpha member ID") or r.get("Pharmacy patient ID") or f"row-{i+1}").strip().lower()
        r["stableKey"] = f"refill:{alpha_id}"
        r["Status"] = r.get("Status") or "Not started"
        r["Date contacted"] = r.get("Date contacted") or ""
        r["Notes"] = r.get("Notes") or ""

    noid_occ = {}
    for i, r in enumerate(fixes_no_id):
        r["id"] = f"fix-noid-{i+1}"
        r["fixType"] = "No Patient Alternate ID"
        r["Corrected patient ID"] = r.get("Corrected patient ID") or ""
        base_sig = f"{r.get('Date filled') or ''}|{r.get('Dispensed item') or ''}|{r.get('Prescriber') or ''}|{r.get('Payer') or ''}".lower()
        noid_occ[base_sig] = noid_occ.get(base_sig, 0) + 1
        r["stableKey"] = f"fixes-noid:{base_sig}|#{noid_occ[base_sig]}"

    unmatched_occ = {}
    for i, r in enumerate(fixes_unmatched):
        r["id"] = f"fix-unmatched-{i+1}"
        r["fixType"] = "Unmatched Patient ID"
        r["Corrected patient ID"] = r.get("Corrected patient ID") or ""
        base_sig = f"{r.get('Patient ID on file') or ''}|{r.get('Date filled') or ''}|{r.get('Dispensed item') or ''}".lower()
        unmatched_occ[base_sig] = unmatched_occ.get(base_sig, 0) + 1
        r["stableKey"] = f"fixes-unmatched:{base_sig}|#{unmatched_occ[base_sig]}"

    for i, r in enumerate(ended_never_filled):
        r["id"] = f"ended-{i+1}"
        alpha_id = str(r.get("Alpha member ID") or r.get("Pharmacy patient ID") or f"row-{i+1}").strip().lower()
        r["stableKey"] = f"ended:{alpha_id}"

    # Compute fuzzy matches strictly against Pharmacy To-Do (dist <= 2)
    todo_by_id = {str(r["Pharmacy patient ID"]).lower(): r for r in pharmacy_todo if r.get("Pharmacy patient ID")}

    for r in fixes_unmatched:
        pid = str(r.get("Patient ID on file") or "").strip().lower()
        best_match = None
        best_dist = 99
        best_source = None
        best_record = None
        if pid and pid != "trinidad":
            for tid, rec in todo_by_id.items():
                d = edit_distance(pid, tid)
                if 0 < d <= 2 and d < best_dist:
                    best_dist = d
                    best_match = rec["Pharmacy patient ID"]
                    best_source = "Pharmacy To-Do"
                    best_record = rec

        if best_match:
            r["suggestedMatch"] = {
                "suggestedPatientId": best_match,
                "editDistance": best_dist,
                "matchedInSheet": best_source,
                "alphaMemberId": best_record.get("Alpha member ID"),
                "rxMedication": best_record.get("Rx medication") or best_record.get("Last item filled"),
                "finding": best_record.get("Pharmacy finding") or best_record.get("Stage") or best_record.get("Membership status"),
            }
        else:
            r["suggestedMatch"] = None

    for t in pharmacy_todo:
        tid = str(t.get("Pharmacy patient ID") or "").lower()
        linked_fixes = []
        for f in fixes_unmatched:
            sm = f.get("suggestedMatch")
            if sm and str(sm["suggestedPatientId"]).lower() == tid:
                linked_fixes.append({
                    "fixId": f["id"],
                    "patientIdOnFile": f["Patient ID on file"],
                    "dateFilled": f["Date filled"],
                    "dispensedItem": f["Dispensed item"],
                    "prescriber": f["Prescriber"],
                    "editDistance": sm["editDistance"],
                })
        t["possibleDataFixes"] = linked_fixes


def build_damien_portal_data(xlsx_path):
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    todo_headers, pharmacy_todo = extract_sheet_rows(wb["Pharmacy To-Do"], header_row_idx=4, start_row_idx=5)
    refill_headers, refill_followup = extract_sheet_rows(wb["Refill Follow-Up"], header_row_idx=4, start_row_idx=5)
    (
        no_id_title,
        fixes_no_id_headers,
        fixes_no_id,
        unmatched_title,
        fixes_unmatched_headers,
        fixes_unmatched,
    ) = parse_fixes_sheet_dynamically(wb["Pharmacy Data Fixes"])
    ended_headers, ended_never_filled = extract_sheet_rows(
        wb["Ended – Never Filled"], header_row_idx=4, start_row_idx=5
    )

    assign_stable_keys_and_fuzzy_links(
        pharmacy_todo, refill_followup, fixes_no_id, fixes_unmatched, ended_never_filled
    )

    dashboard_data = {
        "meta": {
            "clientId": "damien",
            "shortName": "Damien",
            "programTitle": "Damien Center GLP-1 Weight Loss Program",
            "subtitle": "Program performance through September 30, 2026",
            "preparedBy": "Bridge Health Hub",
            "client": "Damien Center",
            "telehealthPartner": "Hello Alpha",
            "pharmacyPartner": "Damien Pharmacy",
            "asOfDate": "2026-09-30",
            "asOfDateFormatted": "September 30, 2026",
            "asOfShort": "Sep2026",
            "cutoffMonthName": "September",
            "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
        },
        "slide2_summary": {
            "sectionTitle": "SUMMARY",
            "headline": "The program is growing and profitable; the opportunity is getting more sign-ups to a first fill",
            "kpis": [
                {"id": "active_sep", "label": "Active members, Sep", "value": "862", "numericValue": 862, "subtext": "+33.9% vs Aug (644)", "targetView": "summary"},
                {"id": "fills_sep", "label": "GLP-1 fills, Sep", "value": "673", "numericValue": 673, "subtext": "411 Pen · 256 Pill · 6 Ozempic", "targetView": "medmix"},
                {"id": "proceeds_sep", "label": "Program proceeds, Sep", "value": "$371K", "numericValue": 371214, "subtext": "$371,214 after ad spend", "targetView": "financials"},
                {"id": "proceeds_ytd", "label": "Program proceeds, YTD", "value": "$962K", "numericValue": 961691, "subtext": "$961,691 net of fees & media", "targetView": "financials"},
                {"id": "first_fill_rate", "label": "Sign-ups who filled 1st Rx", "value": "69%", "numericValue": 69, "subtext": "Members joined before Sep", "targetView": "funnel"},
                {"id": "refill_rate", "label": "1st-fill patients who refilled", "value": "94%", "numericValue": 94, "subtext": "Patients with time to refill", "targetView": "refill"},
            ],
            "activeMembersByMonth": {
                "title": "Membership growth: active members by month",
                "subtitle": "(includes members that cancelled in-month)",
                "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
                "values": [23, 39, 67, 107, 162, 313, 423, 644, 862],
            },
            "whatYouNeedToKnow": [
                {"title": "Growing and profitable.", "body": "$371K in September proceeds on 673 fills; $962K year to date, after ad spend.", "targetView": "financials", "badge": "$962K YTD"},
                {"title": "EPIC and broker partners are effective.", "body": "Broker partners represented 62% of September enrollments.", "targetView": "sources", "badge": "62% Sep Share"},
                {"title": "Paid media spend is paying off.", "body": "Every $1 of media spend has returned $4.63 of pharmacy margin.", "targetView": "paidmedia", "badge": "4.63x ROAS"},
                {"title": "Drop-off happens before the first fill.", "body": "90% of sign-ups saw a provider, 80% were prescribed, 69% filled.", "targetView": "funnel", "badge": "69% 1st Fill"},
                {"title": "Once patients start, they stay.", "body": "94% came back for a second fill; 87% were still filling at fill 3.", "targetView": "refill", "badge": "94% Refill"},
                {"title": "Wegovy pill utilization is becoming material.", "body": "38% of GLP-1 fills were from the Wegovy pill in September.", "targetView": "medmix", "badge": "38% Wegovy Pill"},
            ],
        },
        "slide3_financials": {
            "sectionTitle": "PROGRAM FINANCIALS",
            "headline": "September program proceeds reached $371K after ad spend, $962K year to date",
            "monthlyProceeds": {
                "title": "Monthly program proceeds (after ad spend)",
                "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
                "values": [10743, 20558, 18756, 25496, 22859, 68562, 166445, 257058, 371214],
            },
            "ytdTable": [
                {"item": "Pharmacy revenue", "amount": 2336983, "formatted": "$2,336,983", "type": "revenue"},
                {"item": "Pharmacy gross margin", "amount": 1758625, "formatted": "$1,758,625", "type": "subtotal"},
                {"item": "Membership fees collected", "amount": 44164, "formatted": "$44,164", "type": "positive"},
                {"item": "Ad spend (media)", "amount": -142033, "formatted": "−$142,033", "type": "expense"},
                {"item": "Alpha platform fees", "amount": -411745, "formatted": "−$411,745", "type": "expense"},
                {"item": "Bridge fees", "amount": -195900, "formatted": "−$195,900", "type": "expense"},
                {"item": "Broker commissions", "amount": -10060, "formatted": "−$10,060", "type": "expense"},
                {"item": "Cost to fill ($40 per fill)", "amount": -81360, "formatted": "−$81,360", "type": "expense"},
                {"item": "Program proceeds", "amount": 961691, "formatted": "$961,691", "type": "total"},
            ],
            "septemberGrossMarginPerFill": 911,
            "costPerFill": 40,
            "totalFillsInPnl": 2034,
            "footnote": "Proceeds = pharmacy gross margin + membership fees − media ad spend − Alpha and Bridge fees − broker commissions − $40 cost to fill. Ad spend is media spend from the agency's reports (agency fees not included). September gross margin per fill: $911.",
        },
        "slide4_sources": {
            "sectionTitle": "WHERE ARE PATIENTS COMING FROM?",
            "headline": "EPIC and broker partners drove 62% of September enrollments",
            "chart": {
                "title": "New enrollments by source and month",
                "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
                "series": [
                    {"name": "EPIC", "values": [0, 0, 0, 0, 0, 87, 80, 165, 120], "color": "#154672"},
                    {"name": "Paid Media", "values": [4, 4, 21, 37, 48, 73, 45, 89, 93], "color": "#26ABE4"},
                    {"name": "Employee", "values": [16, 9, 4, 2, 6, 1, 8, 2, 6], "color": "#1BAF7A"},
                    {"name": "LHD", "values": [0, 0, 0, 0, 0, 0, 0, 11, 43], "color": "#E97132"},
                    {"name": "McGohan Brabender", "values": [0, 0, 0, 0, 0, 0, 0, 1, 7], "color": "#8B5CF6"},
                    {"name": "Other", "values": [0, 3, 5, 8, 10, 5, 5, 8, 4], "color": "#6F7886"},
                ],
            },
            "table": [
                {"source": "EPIC", "enrolledSept": 120, "enrolledYtd": 452, "share": "44%", "shareNum": 44, "filled1stRx": "77%", "filled1stRxNum": 77, "refilled1to2": "93%", "refilled1to2Num": 93, "glp1Fills": 748, "grossMargin": 696172, "grossMarginFmt": "$696,172"},
                {"source": "Paid Media", "enrolledSept": 93, "enrolledYtd": 417, "share": "40%", "shareNum": 40, "filled1stRx": "62%", "filled1stRxNum": 62, "refilled1to2": "92%", "refilled1to2Num": 92, "glp1Fills": 804, "grossMargin": 671400, "grossMarginFmt": "$671,400"},
                {"source": "Employee", "enrolledSept": 6, "enrolledYtd": 54, "share": "5%", "shareNum": 5, "filled1stRx": "67%", "filled1stRxNum": 67, "refilled1to2": "97%", "refilled1to2Num": 97, "glp1Fills": 214, "grossMargin": 160234, "grossMarginFmt": "$160,234"},
                {"source": "LHD  (new since Aug)", "sourceKey": "LHD", "enrolledSept": 43, "enrolledYtd": 54, "share": "5%", "shareNum": 5, "filled1stRx": "76%", "filled1stRxNum": 76, "refilled1to2": "—", "refilled1to2Num": None, "glp1Fills": 41, "grossMargin": 39729, "grossMarginFmt": "$39,729"},
                {"source": "McGohan Brabender  (new since Aug)", "sourceKey": "McGohan Brabender", "enrolledSept": 7, "enrolledYtd": 8, "share": "1%", "shareNum": 1, "filled1stRx": "88%", "filled1stRxNum": 88, "refilled1to2": "—", "refilled1to2Num": None, "glp1Fills": 7, "grossMargin": 6228, "grossMarginFmt": "$6,228"},
                {"source": "Other", "enrolledSept": 4, "enrolledYtd": 48, "share": "5%", "shareNum": 5, "filled1stRx": "66%", "filled1stRxNum": 66, "refilled1to2": "100%", "refilled1to2Num": 100, "glp1Fills": 138, "grossMargin": 107308, "grossMarginFmt": "$107,308"},
            ],
            "footnote": "Fill rate uses members who enrolled before September. Refill rate uses first fills at least 45 days before the as-of date. Paid Media = sign-ups with no referral or coupon code.",
        },
        "slide5_paidMedia": {
            "sectionTitle": "IS PAID MEDIA PAYING OFF?",
            "headline": "Every $1 of media spend has returned $4.63 of pharmacy margin from Paid Media patients",
            "kpis": [
                {"label": "Media spend, campaign to date", "value": "$142K", "exact": "$142,033", "subtext": "Jan ‘26 – Sep '26"},
                {"label": "Paid Media sign-ups", "value": "414", "exact": "414 sign-ups", "subtext": "$343 of spend per sign-up"},
                {"label": "Started therapy", "value": "243", "exact": "243 patients", "subtext": "$584 per patient started"},
                {"label": "Pharmacy gross margin", "value": "$658K", "exact": "$658,361", "subtext": "786 fills from these patients"},
            ],
            "table": [
                {"month": "Jan", "spend": 3092, "spendFmt": "$3,092", "signups": 4, "spendPerSignup": "$773", "started": 3, "spendPerStarted": "$1,031", "fills": 30, "margin": 22017, "marginFmt": "$22,017", "roas": ""},
                {"month": "Feb", "spend": 0, "spendFmt": "$0", "signups": 4, "spendPerSignup": "—", "started": 2, "spendPerStarted": "—", "fills": 5, "margin": 3869, "marginFmt": "$3,869", "roas": ""},
                {"month": "Mar", "spend": 1704, "spendFmt": "$1,704", "signups": 21, "spendPerSignup": "$81", "started": 14, "spendPerStarted": "$122", "fills": 77, "margin": 57100, "marginFmt": "$57,100", "roas": ""},
                {"month": "Apr", "spend": 15089, "spendFmt": "$15,089", "signups": 37, "spendPerSignup": "$408", "started": 26, "spendPerStarted": "$580", "fills": 136, "margin": 103726, "marginFmt": "$103,726", "roas": "687%", "roasNum": 687},
                {"month": "May", "spend": 19629, "spendFmt": "$19,629", "signups": 48, "spendPerSignup": "$409", "started": 27, "spendPerStarted": "$727", "fills": 116, "margin": 93277, "marginFmt": "$93,277", "roas": "496%", "roasNum": 496},
                {"month": "Jun", "spend": 24348, "spendFmt": "$24,348", "signups": 73, "spendPerSignup": "$334", "started": 41, "spendPerStarted": "$594", "fills": 153, "margin": 129385, "marginFmt": "$129,385", "roas": "531%", "roasNum": 531},
                {"month": "Jul", "spend": 24858, "spendFmt": "$24,858", "signups": 45, "spendPerSignup": "$552", "started": 29, "spendPerStarted": "$857", "fills": 80, "margin": 73492, "marginFmt": "$73,492", "roas": "296%", "roasNum": 296},
                {"month": "Aug", "spend": 25529, "spendFmt": "$25,529", "signups": 89, "spendPerSignup": "$287", "started": 57, "spendPerStarted": "$448", "fills": 130, "margin": 120843, "marginFmt": "$120,843", "roas": "473%", "roasNum": 473},
                {"month": "Sep", "spend": 27784, "spendFmt": "$27,784", "signups": 93, "spendPerSignup": "$299", "started": 44, "spendPerStarted": "$631", "fills": 59, "margin": 54652, "marginFmt": "$54,652", "roas": "197%", "roasNum": 197},
                {"month": "2026 total", "spend": 142033, "spendFmt": "$142,033", "signups": 414, "spendPerSignup": "$343", "started": 243, "spendPerStarted": "$584", "fills": 786, "margin": 658361, "marginFmt": "$658,361", "roas": "463%", "roasNum": 463, "isTotal": True},
            ],
            "footnote": "Spend from the agency's Google + Meta reports. Sign-ups are Alpha members with no referral or coupon code; therapy starts, fills and margin come from linking them to Damien Pharmacy fills. Recent months are still building margin (September sign-ups have had at most one fill).",
        },
        "slide6_funnel": {
            "sectionTitle": "ARE PATIENTS SEEING A PROVIDER AND FILLING?",
            "headline": "69% of sign-ups fill their first prescription; the losses happen before the pharmacy",
            "chartTitle": "Members who enrolled before September (760 patients)",
            "steps": [
                {"stage": "Enrolled", "patients": 760, "pctOfEnrolled": 100, "stepConversion": "100%"},
                {"stage": "Saw a provider", "patients": 684, "pctOfEnrolled": 90, "stepConversion": "90%"},
                {"stage": "Prescribed", "patients": 608, "pctOfEnrolled": 80, "stepConversion": "89%"},
                {"stage": "Filled 1st Rx", "patients": 523, "pctOfEnrolled": 69, "stepConversion": "86%"},
            ],
            "dropoffs": [
                {"count": 76, "label": "never completed a provider visit", "filterSheet": "ended", "filterStage": "No provider visit"},
                {"count": 76, "label": "saw a provider but were not prescribed", "filterSheet": "ended", "filterStage": "Saw provider, no Rx"},
                {"count": 85, "label": "were prescribed but never filled", "filterSheet": "todo", "filterStage": "Rx written, not filled"},
            ],
            "timing": [
                {"metric": "Under 1 hour", "label": "Sign-up to provider visit"},
                {"metric": "17 hours", "label": "Visit to prescription"},
                {"metric": "1 day", "label": "Prescription to first fill"},
                {"metric": "86%", "label": "of prescribed patients filled"},
            ],
        },
        "slide7_refill": {
            "sectionTitle": "ARE PATIENTS REFILLING?",
            "headline": "Once patients start, more than 9 in 10 come back for each refill",
            "chart": {
                "title": "Share of patients who started therapy still filling, by fill number",
                "fills": ["Fill 1", "Fill 2", "Fill 3", "Fill 4", "Fill 5", "Fill 6", "Fill 7", "Fill 8"],
                "shareStillFilling": [100.0, 93.6, 87.4, 78.2, 72.7, 70.3, 59.7, 56.7],
                "patientCounts": [670, 494, 311, 203, 118, 68, 41, 24],
            },
            "stepTable": [
                {"step": "Fill 1 → 2", "cameBack": "94%", "cameBackNum": 94, "eligiblePts": 391, "lowSample": False},
                {"step": "Fill 2 → 3", "cameBack": "93%", "cameBackNum": 93, "eligiblePts": 271, "lowSample": False},
                {"step": "Fill 3 → 4", "cameBack": "89%", "cameBackNum": 89, "eligiblePts": 171, "lowSample": False},
                {"step": "Fill 4 → 5", "cameBack": "93%", "cameBackNum": 93, "eligiblePts": 85, "lowSample": False},
                {"step": "Fill 5 → 6", "cameBack": "97%", "cameBackNum": 97, "eligiblePts": 62, "lowSample": False},
                {"step": "Fill 6 → 7", "cameBack": "85%", "cameBackNum": 85, "eligiblePts": 33, "lowSample": False},
                {"step": "Fill 7 → 8", "cameBack": "95%", "cameBackNum": 95, "eligiblePts": 20, "lowSample": True},
            ],
            "footnote": "Step rates count only patients whose fill was at least 45 days before September 30, 2026, so recent starters who haven't had time to refill aren't counted as drop-offs. Typical gap between fills is about 27 days. Gray steps have fewer than 30 eligible patients. Fill counts: Fill 1 670, Fill 2 494, Fill 3 311, Fill 4 203, Fill 5 118, Fill 6 68, Fill 7 41, Fill 8 24 patients.",
        },
        "slide8_medMix": {
            "sectionTitle": "WHAT ARE PATIENTS FILLING?",
            "headline": "Wegovy pill reached 38% of fills in September",
            "chart": {
                "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
                "wegovyPen": [22, 41, 51, 92, 114, 179, 245, 307, 411],
                "wegovyPill": [0, 0, 0, 0, 0, 33, 85, 168, 256],
                "ozempic": [0, 0, 2, 2, 2, 5, 5, 8, 6],
            },
            "septemberCallouts": [
                {"value": 411, "share": "61.1%", "label": "Wegovy pen fills, Sep", "color": "#154672"},
                {"value": 256, "share": "38.0%", "label": "Wegovy pill fills, Sep", "color": "#26ABE4"},
                {"value": 6, "share": "0.9%", "label": "Ozempic fills, Sep", "color": "#1BAF7A"},
            ],
            "note": "Completed Wegovy and Ozempic dispenses at Damien Pharmacy, all patients.",
        },
        "slide9_appendix": {
            "sectionTitle": "APPENDIX",
            "headline": "Definitions and data notes",
            "notes": [
                "Enrollment, visits, prescriptions, cancellations and billing come from the Alpha membership file. Fills, revenue and margin come from the Damien Pharmacy dispense file. Test accounts are excluded.",
                "Patients are linked by the pharmacy's Patient Alternate ID, which is the first 8 characters of the Alpha member ID. 1,952 of 2,034 GLP-1 fills (96%) matched a member; 51 fills had no patient ID and 20 IDs did not match. Unmatched fills count toward revenue and the P&L but not patient-level metrics.",
                "A fill is a completed Wegovy or Ozempic dispense on or before the as-of date. Cancelled and awaiting-pickup transactions are excluded. Gross margin is total pharmacy revenue less acquisition cost.",
                "A member is billed for a month if their membership was active at any point in that month, so a member who cancels in June and terminates in July counts in both months.",
                "Funnel and fill rates use members who enrolled before September so each has had at least 30 days. Refill step rates use fills at least 45 days before the as-of date.",
                "Cost to fill is an assumed $40 per fill. Ad spend is Google + Meta media spend from the agency's paid media reports; agency fees are not included.",
            ],
        },
        "slide10_retention": {
            "sectionTitle": "HOW LONG ARE PATIENTS STAYING?",
            "headline": "Appendix – Member retention by month",
            "columns": ["Joined", "Members", "M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"],
            "rows": [
                {"joined": "Jan", "members": 20, "M0": "100%", "M1": "95%", "M2": "85%", "M3": "70%", "M4": "70%", "M5": "70%", "M6": "70%", "M7": "65%", "M8": "65%"},
                {"joined": "Feb", "members": 16, "M0": "100%", "M1": "88%", "M2": "88%", "M3": "75%", "M4": "63%", "M5": "44%", "M6": "44%", "M7": "38%", "M8": ""},
                {"joined": "Mar", "members": 30, "M0": "90%", "M1": "70%", "M2": "67%", "M3": "63%", "M4": "63%", "M5": "60%", "M6": "40%", "M7": "", "M8": ""},
                {"joined": "Apr", "members": 47, "M0": "100%", "M1": "74%", "M2": "74%", "M3": "68%", "M4": "60%", "M5": "45%", "M6": "", "M7": "", "M8": ""},
                {"joined": "May", "members": 64, "M0": "100%", "M1": "61%", "M2": "53%", "M3": "47%", "M4": "44%", "M5": "", "M6": "", "M7": "", "M8": ""},
                {"joined": "Jun", "members": 166, "M0": "100%", "M1": "73%", "M2": "65%", "M3": "57%", "M4": "", "M5": "", "M6": "", "M7": "", "M8": ""},
                {"joined": "Jul", "members": 138, "M0": "100%", "M1": "78%", "M2": "65%", "M3": "", "M4": "", "M5": "", "M6": "", "M7": "", "M8": ""},
                {"joined": "Aug", "members": 276, "M0": "100%", "M1": "84%", "M2": "", "M3": "", "M4": "", "M5": "", "M6": "", "M7": "", "M8": ""},
                {"joined": "Sep", "members": 273, "M0": "100%", "M1": "", "M2": "", "M3": "", "M4": "", "M5": "", "M6": "", "M7": "", "M8": ""},
            ],
            "footnote": "Share of each sign-up month's members whose membership was still active at the end of each month after joining (M0 = joining month).",
        },
        "worklists": {
            "pharmacyTodo": {
                "title": "Pharmacy To-Do",
                "description": "Owner: Damien Pharmacy. Members with an active membership who have a prescription at Damien Pharmacy that has not been filled. Data through September 30, 2026. Update Status, Date contacted and Notes (yellow) as you work the list.",
                "headers": todo_headers,
                "rows": pharmacy_todo,
            },
            "refillFollowup": {
                "title": "Refill Follow-Up",
                "description": "Owner: Damien Pharmacy. Active members who filled before but have no fill in the last 35+ days (typical gap between fills is ~27 days). Contact to schedule the next fill.",
                "headers": refill_headers,
                "rows": refill_followup,
            },
            "pharmacyDataFixes": {
                "title": "Pharmacy Data Fixes",
                "description": "Owner: Damien Pharmacy. Fills that can't be linked to a program member. Add or correct the Patient Alternate ID (first 8 characters of the Alpha member ID) in the dispense system.",
                "noIdTitle": no_id_title,
                "noIdHeaders": fixes_no_id_headers,
                "noIdRows": fixes_no_id,
                "unmatchedTitle": unmatched_title,
                "unmatchedHeaders": fixes_unmatched_headers,
                "unmatchedRows": fixes_unmatched,
            },
            "endedNeverFilled": {
                "title": "Ended Memberships – Never Filled (reference)",
                "description": "Members whose membership has already ended without a first fill. No action required; use for root-cause review and possible win-back outreach.",
                "headers": ended_headers,
                "rows": ended_never_filled,
            },
        },
    }
    return dashboard_data


def build_metro_portal_data(damien_data):
    """
    Creates a realistic second Covered Entity ('Metro Health Center' / 'Metro Pharmacy')
    with distinct KPIs, numbers, employer groups, and patient subsets so multi-tenant
    isolation can be verified end-to-end.
    """
    metro = copy.deepcopy(damien_data)
    metro["meta"] = {
        "clientId": "metro",
        "shortName": "Metro Health",
        "programTitle": "Metro Health Center GLP-1 Weight Loss Program",
        "subtitle": "Program performance through September 30, 2026",
        "preparedBy": "Bridge Health Hub",
        "client": "Metro Health Center",
        "telehealthPartner": "Hello Alpha",
        "pharmacyPartner": "Metro Specialty Pharmacy",
        "asOfDate": "2026-09-30",
        "asOfDateFormatted": "September 30, 2026",
        "asOfShort": "Sep2026",
        "cutoffMonthName": "September",
        "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
    }

    metro["slide2_summary"]["headline"] = "Metro Health GLP-1 enrollment reached 540 active members with $248K in September proceeds"
    metro["slide2_summary"]["kpis"] = [
        {"id": "active_sep", "label": "Active members, Sep", "value": "540", "numericValue": 540, "subtext": "+28.6% vs Aug (420)", "targetView": "summary"},
        {"id": "fills_sep", "label": "GLP-1 fills, Sep", "value": "430", "numericValue": 430, "subtext": "270 Pen · 155 Pill · 5 Ozempic", "targetView": "medmix"},
        {"id": "proceeds_sep", "label": "Program proceeds, Sep", "value": "$248K", "numericValue": 248400, "subtext": "$248,400 after ad spend", "targetView": "financials"},
        {"id": "proceeds_ytd", "label": "Program proceeds, YTD", "value": "$645K", "numericValue": 645200, "subtext": "$645,200 net of fees & media", "targetView": "financials"},
        {"id": "first_fill_rate", "label": "Sign-ups who filled 1st Rx", "value": "72%", "numericValue": 72, "subtext": "Members joined before Sep", "targetView": "funnel"},
        {"id": "refill_rate", "label": "1st-fill patients who refilled", "value": "95%", "numericValue": 95, "subtext": "Patients with time to refill", "targetView": "refill"},
    ]
    metro["slide2_summary"]["activeMembersByMonth"]["values"] = [15, 28, 49, 78, 115, 210, 295, 420, 540]
    metro["slide2_summary"]["whatYouNeedToKnow"] = [
        {"title": "Strong monthly momentum.", "body": "$248K in September proceeds on 430 fills; $645K year to date, after ad spend.", "targetView": "financials", "badge": "$645K YTD"},
        {"title": "Broker partners lead acquisition.", "body": "Regional employer brokers represented 65% of September enrollments.", "targetView": "sources", "badge": "65% Sep Share"},
        {"title": "Paid media efficiency.", "body": "Every $1 of media spend has returned $4.85 of pharmacy margin.", "targetView": "paidmedia", "badge": "4.85x ROAS"},
        {"title": "High first-fill conversion.", "body": "92% of sign-ups saw a provider, 83% were prescribed, 72% filled.", "targetView": "funnel", "badge": "72% 1st Fill"},
        {"title": "95% second-fill retention.", "body": "95% came back for a second fill; 89% were still filling at fill 3.", "targetView": "refill", "badge": "95% Refill"},
        {"title": "Wegovy pill adoption growing.", "body": "36% of GLP-1 fills were from the Wegovy pill in September.", "targetView": "medmix", "badge": "36% Wegovy Pill"},
    ]

    metro["slide3_financials"]["headline"] = "September program proceeds reached $248K after ad spend, $645K year to date"
    metro["slide3_financials"]["monthlyProceeds"]["values"] = [8200, 14500, 16200, 21800, 29400, 52100, 108600, 146000, 248400]
    metro["slide3_financials"]["ytdTable"] = [
        {"item": "Pharmacy revenue", "amount": 1580400, "formatted": "$1,580,400", "type": "revenue"},
        {"item": "Pharmacy gross margin", "amount": 1185300, "formatted": "$1,185,300", "type": "subtotal"},
        {"item": "Membership fees collected", "amount": 31200, "formatted": "$31,200", "type": "positive"},
        {"item": "Ad spend (media)", "amount": -92500, "formatted": "−$92,500", "type": "expense"},
        {"item": "Alpha platform fees", "amount": -278400, "formatted": "−$278,400", "type": "expense"},
        {"item": "Bridge fees", "amount": -138000, "formatted": "−$138,000", "type": "expense"},
        {"item": "Broker commissions", "amount": -7200, "formatted": "−$7,200", "type": "expense"},
        {"item": "Cost to fill ($40 per fill)", "amount": -55200, "formatted": "−$55,200", "type": "expense"},
        {"item": "Program proceeds", "amount": 645200, "formatted": "$645,200", "type": "total"},
    ]
    metro["slide3_financials"]["septemberGrossMarginPerFill"] = 895
    metro["slide3_financials"]["costPerFill"] = 40
    metro["slide3_financials"]["totalFillsInPnl"] = 1380
    metro["slide3_financials"]["footnote"] = "Proceeds = pharmacy gross margin + membership fees − media ad spend − Alpha and Bridge fees − broker commissions − $40 cost to fill. September gross margin per fill: $895."

    metro["slide6_funnel"]["headline"] = "72% of sign-ups fill their first prescription at Metro Specialty Pharmacy"
    metro["slide6_funnel"]["chartTitle"] = "Members who enrolled before September (500 patients)"
    metro["slide6_funnel"]["steps"] = [
        {"stage": "Enrolled", "patients": 500, "pctOfEnrolled": 100, "stepConversion": "100%"},
        {"stage": "Saw a provider", "patients": 460, "pctOfEnrolled": 92, "stepConversion": "92%"},
        {"stage": "Prescribed", "patients": 415, "pctOfEnrolled": 83, "stepConversion": "90%"},
        {"stage": "Filled 1st Rx", "patients": 360, "pctOfEnrolled": 72, "stepConversion": "87%"},
    ]
    metro["slide6_funnel"]["dropoffs"] = [
        {"count": 40, "label": "never completed a provider visit", "filterSheet": "ended", "filterStage": "No provider visit"},
        {"count": 45, "label": "saw a provider but were not prescribed", "filterSheet": "ended", "filterStage": "Saw provider, no Rx"},
        {"count": 55, "label": "were prescribed but never filled", "filterSheet": "todo", "filterStage": "Rx written, not filled"},
    ]

    metro["slide8_medMix"]["headline"] = "Wegovy pill reached 36% of fills at Metro Specialty Pharmacy in September"
    metro["slide8_medMix"]["septemberCallouts"] = [
        {"value": 270, "share": "62.8%", "label": "Wegovy pen fills, Sep", "color": "#154672"},
        {"value": 155, "share": "36.0%", "label": "Wegovy pill fills, Sep", "color": "#26ABE4"},
        {"value": 5, "share": "1.2%", "label": "Ozempic fills, Sep", "color": "#1BAF7A"},
    ]
    metro["slide8_medMix"]["note"] = "Completed Wegovy and Ozempic dispenses at Metro Specialty Pharmacy, all patients."

    metro["slide9_appendix"]["notes"][0] = (
        "Enrollment, visits, prescriptions, cancellations and billing come from the Alpha membership file. "
        "Fills, revenue and margin come from the Metro Specialty Pharmacy dispense file. Test accounts are excluded."
    )

    # Subset worklists for Metro Health (42 To-Do, 18 Refill, 25 No-ID, 12 Unmatched, 60 Ended) and rename Damien strings
    todo_sub = copy.deepcopy(damien_data["worklists"]["pharmacyTodo"]["rows"][:42])
    for r in todo_sub:
        if r.get("Employer group") == "Damien Patient":
            r["Employer group"] = "Metro Health Patient"
        elif r.get("Employer group") == "City of Evansville":
            r["Employer group"] = "Metro Transit Authority"

    refill_sub = copy.deepcopy(damien_data["worklists"]["refillFollowup"]["rows"][:18])
    noid_sub = copy.deepcopy(damien_data["worklists"]["pharmacyDataFixes"]["noIdRows"][:25])
    unmatched_sub = copy.deepcopy(damien_data["worklists"]["pharmacyDataFixes"]["unmatchedRows"][:12])
    ended_sub = copy.deepcopy(damien_data["worklists"]["endedNeverFilled"]["rows"][:60])
    for r in ended_sub:
        if r.get("Employer group") == "Damien Patient":
            r["Employer group"] = "Metro Health Patient"
        elif r.get("Employer group") == "City of Evansville":
            r["Employer group"] = "Metro Transit Authority"

    assign_stable_keys_and_fuzzy_links(todo_sub, refill_sub, noid_sub, unmatched_sub, ended_sub)

    metro["worklists"]["pharmacyTodo"]["description"] = (
        "Owner: Metro Specialty Pharmacy. Members with an active membership who have a prescription at Metro Specialty Pharmacy that has not been filled. Data through September 30, 2026."
    )
    metro["worklists"]["pharmacyTodo"]["rows"] = todo_sub
    metro["worklists"]["refillFollowup"]["description"] = (
        "Owner: Metro Specialty Pharmacy. Active members who filled before but have no fill in the last 35+ days. Contact to schedule the next fill."
    )
    metro["worklists"]["refillFollowup"]["rows"] = refill_sub
    metro["worklists"]["pharmacyDataFixes"]["description"] = (
        "Owner: Metro Specialty Pharmacy. Fills that can't be linked to a program member. Add or correct the Patient Alternate ID in the dispense system."
    )
    metro["worklists"]["pharmacyDataFixes"]["noIdTitle"] = f"Fills with no Patient Alternate ID ({len(noid_sub)})"
    metro["worklists"]["pharmacyDataFixes"]["noIdRows"] = noid_sub
    metro["worklists"]["pharmacyDataFixes"]["unmatchedTitle"] = f"Patient IDs that don't match any program member ({len(unmatched_sub)} fills)"
    metro["worklists"]["pharmacyDataFixes"]["unmatchedRows"] = unmatched_sub
    metro["worklists"]["endedNeverFilled"]["rows"] = ended_sub

    return metro


def main():
    parser = argparse.ArgumentParser(description="Ingest client PPTX + XLSX into data/clients/<clientId>/portal_data.json")
    parser.add_argument("--client", default="all", help="Client ID to ingest (damien, metro, or all)")
    parser.add_argument("--xlsx", default=os.path.join(SOURCE_DIR, "Damien_First_Fill_Worklist_Sep2026.xlsx"))
    args = parser.parse_args()

    damien_data = build_damien_portal_data(args.xlsx)
    damien_dir = os.path.join(CLIENTS_DIR, "damien")
    os.makedirs(damien_dir, exist_ok=True)
    damien_out = os.path.join(damien_dir, "portal_data.json")
    with open(damien_out, "w", encoding="utf-8") as f:
        json.dump(damien_data, f, indent=2, ensure_ascii=False)
    print(f"Saved Damien baseline -> {damien_out}")

    # Also update legacy data/portal_data.json for backward compatibility
    legacy_out = os.path.join(BASE_DIR, "data", "portal_data.json")
    with open(legacy_out, "w", encoding="utf-8") as f:
        json.dump(damien_data, f, indent=2, ensure_ascii=False)

    metro_data = build_metro_portal_data(damien_data)
    metro_dir = os.path.join(CLIENTS_DIR, "metro")
    os.makedirs(metro_dir, exist_ok=True)
    metro_out = os.path.join(metro_dir, "portal_data.json")
    with open(metro_out, "w", encoding="utf-8") as f:
        json.dump(metro_data, f, indent=2, ensure_ascii=False)
    print(f"Saved Metro Health baseline -> {metro_out}")

    registry = {
        "defaultClientId": "damien",
        "clients": {
            "damien": damien_data["meta"],
            "metro": metro_data["meta"],
        },
    }
    registry_out = os.path.join(CLIENTS_DIR, "registry.json")
    with open(registry_out, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)
    print(f"Saved client registry -> {registry_out}")


if __name__ == "__main__":
    main()
