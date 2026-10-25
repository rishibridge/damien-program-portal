import os
import json
import datetime
import urllib.request
import openpyxl

PROJ_DIR = r"C:\Users\rishi\.gemini\antigravity\scratch\damien-program-portal"
XLSX_PATH = os.path.join(PROJ_DIR, "source_docs", "Damien_First_Fill_Worklist_Sep2026.xlsx")
DATA_DIR = os.path.join(PROJ_DIR, "data")
ASSETS_DIR = os.path.join(PROJ_DIR, "public", "assets")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(ASSETS_DIR, exist_ok=True)

# 1. Download Bridge Health Hub logo
logo_path = os.path.join(ASSETS_DIR, "logo.png")
try:
    req = urllib.request.Request(
        "https://www.bridgehealthhub.com/assets/images/logo.png",
        headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        with open(logo_path, "wb") as f:
            f.write(resp.read())
    print("Downloaded Bridge Health Hub logo:", os.path.getsize(logo_path), "bytes")
except Exception as e:
    print("Warning: could not download logo:", e)

def fmt_val(v):
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        if isinstance(v, datetime.datetime) and (v.hour != 0 or v.minute != 0 or v.second != 0):
            return v.strftime("%Y-%m-%d %H:%M:%S")
        return v.strftime("%Y-%m-%d")
    if isinstance(v, str):
        return v.replace("\xa0", " ").strip()
    return v

def levenshtein(s1, s2):
    if len(s1) < len(s2):
        return levenshtein(s2, s1)
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

wb = openpyxl.load_workbook(XLSX_PATH, data_only=True)

# Sheet 1: Pharmacy To-Do
sh_todo = wb["Pharmacy To-Do"]
todo_headers = [fmt_val(sh_todo.cell(4, c).value) for c in range(1, sh_todo.max_column + 1)]
pharmacy_todo = []
for r in range(5, sh_todo.max_row + 1):
    vals = [fmt_val(sh_todo.cell(r, c).value) for c in range(1, sh_todo.max_column + 1)]
    if any(v is not None for v in vals):
        item = {"id": f"todo-{r-4}", "rowNumber": r}
        for h, v in zip(todo_headers, vals):
            item[h] = v
        pharmacy_todo.append(item)

# Sheet 2: Refill Follow-Up
sh_refill = wb["Refill Follow-Up"]
refill_headers = [fmt_val(sh_refill.cell(4, c).value) for c in range(1, sh_refill.max_column + 1)]
refill_followup = []
for r in range(5, sh_refill.max_row + 1):
    vals = [fmt_val(sh_refill.cell(r, c).value) for c in range(1, sh_refill.max_column + 1)]
    if any(v is not None for v in vals):
        item = {"id": f"refill-{r-4}", "rowNumber": r}
        for h, v in zip(refill_headers, vals):
            item[h] = v
        refill_followup.append(item)

# Sheet 4: Ended – Never Filled
sh_ended = wb["Ended – Never Filled"]
ended_headers = [fmt_val(sh_ended.cell(4, c).value) for c in range(1, sh_ended.max_column + 1)]
ended_never_filled = []
for r in range(5, sh_ended.max_row + 1):
    vals = [fmt_val(sh_ended.cell(r, c).value) for c in range(1, sh_ended.max_column + 1)]
    if any(v is not None for v in vals):
        item = {"id": f"ended-{r-4}", "rowNumber": r}
        for h, v in zip(ended_headers, vals):
            item[h] = v
        ended_never_filled.append(item)

# Collect all known member IDs across Pharmacy To-Do, Refill Follow-Up, and Ended - Never Filled for fuzzy matching
known_patients = {}
for item in pharmacy_todo:
    pid = item.get("Pharmacy patient ID")
    if pid:
        known_patients[pid] = {
            "pharmacyPatientId": pid,
            "alphaMemberId": item.get("Alpha member ID"),
            "sheet": "Pharmacy To-Do",
            "rxMedication": item.get("Rx medication"),
            "rxWritten": item.get("Rx written"),
            "patientSource": item.get("Patient source"),
            "employerGroup": item.get("Employer group"),
            "priority": item.get("Priority")
        }
for item in refill_followup:
    pid = item.get("Pharmacy patient ID")
    if pid and pid not in known_patients:
        known_patients[pid] = {
            "pharmacyPatientId": pid,
            "alphaMemberId": item.get("Alpha member ID"),
            "sheet": "Refill Follow-Up",
            "rxMedication": item.get("Last item filled"),
            "rxWritten": item.get("Last fill"),
            "patientSource": item.get("Patient source"),
            "employerGroup": None,
            "priority": item.get("Membership status")
        }
for item in ended_never_filled:
    pid = item.get("Pharmacy patient ID")
    if pid and pid not in known_patients:
        known_patients[pid] = {
            "pharmacyPatientId": pid,
            "alphaMemberId": item.get("Alpha member ID"),
            "sheet": "Ended – Never Filled",
            "rxMedication": None,
            "rxWritten": item.get("Signed up"),
            "patientSource": item.get("Patient source"),
            "employerGroup": item.get("Employer group"),
            "priority": item.get("Stage")
        }

# Sheet 3: Pharmacy Data Fixes
sh_fixes = wb["Pharmacy Data Fixes"]
# Table A: rows 6..60 (headers at row 5)
fixes_no_id_headers = [fmt_val(sh_fixes.cell(5, c).value) for c in range(1, 7)]
fixes_no_id = []
for r in range(6, 61):
    vals = [fmt_val(sh_fixes.cell(r, c).value) for c in range(1, 7)]
    if any(v is not None for v in vals):
        item = {"id": f"fix-noid-{r-5}", "rowNumber": r, "fixType": "No Patient Alternate ID"}
        for h, v in zip(fixes_no_id_headers, vals):
            item[h] = v
        fixes_no_id.append(item)

# Table B: rows 65..95 (headers at row 64)
fixes_unmatched_headers = [fmt_val(sh_fixes.cell(64, c).value) for c in range(1, 7)]
fixes_unmatched = []
for r in range(65, sh_fixes.max_row + 1):
    vals = [fmt_val(sh_fixes.cell(r, c).value) for c in range(1, 7)]
    if any(v is not None for v in vals):
        item = {"id": f"fix-unmatched-{r-64}", "rowNumber": r, "fixType": "Unmatched Patient ID"}
        for h, v in zip(fixes_unmatched_headers, vals):
            item[h] = v
        # Compute fuzzy match against known_patients
        raw_id = str(item.get("Patient ID on file") or "").strip().lower()
        best_match = None
        best_dist = 999
        for k_pid, k_info in known_patients.items():
            d = levenshtein(raw_id, k_pid.lower())
            if d <= 2 and d < best_dist:
                best_dist = d
                best_match = {
                    "suggestedPatientId": k_pid,
                    "alphaMemberId": k_info["alphaMemberId"],
                    "editDistance": d,
                    "matchedInSheet": k_info["sheet"],
                    "rxMedication": k_info["rxMedication"],
                    "patientSource": k_info["patientSource"]
                }
        item["suggestedMatch"] = best_match
        fixes_unmatched.append(item)

# Also tag Pharmacy To-Do items that have a fuzzy match in Pharmacy Data Fixes
matched_by_target = {}
for fix in fixes_unmatched:
    sm = fix.get("suggestedMatch")
    if sm and sm.get("suggestedPatientId"):
        t_pid = sm["suggestedPatientId"]
        matched_by_target.setdefault(t_pid, []).append({
            "fixId": fix["id"],
            "patientIdOnFile": fix.get("Patient ID on file"),
            "dateFilled": fix.get("Date filled"),
            "dispensedItem": fix.get("Dispensed item"),
            "prescriber": fix.get("Prescriber"),
            "editDistance": sm["editDistance"]
        })

for item in pharmacy_todo:
    pid = item.get("Pharmacy patient ID")
    item["possibleDataFixes"] = matched_by_target.get(pid, [])

# Build complete dashboard data from the 10 PPTX slides
dashboard_data = {
    "meta": {
        "programTitle": "Damien Center GLP-1 Weight Loss Program",
        "subtitle": "Program performance through September 30, 2026",
        "preparedBy": "Bridge Health Hub",
        "client": "Damien Center",
        "telehealthPartner": "Hello Alpha",
        "pharmacyPartner": "Damien Pharmacy",
        "asOfDate": "2026-09-30",
        "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]
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
            {"id": "refill_rate", "label": "1st-fill patients who refilled", "value": "94%", "numericValue": 94, "subtext": "Patients with time to refill", "targetView": "refill"}
        ],
        "activeMembersByMonth": {
            "title": "Membership growth: active members by month",
            "subtitle": "(includes members that cancelled in-month)",
            "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
            "values": [23, 39, 67, 107, 162, 313, 423, 644, 862]
        },
        "whatYouNeedToKnow": [
            {"title": "Growing and profitable.", "body": "$371K in September proceeds on 673 fills; $962K year to date, after ad spend.", "targetView": "financials", "badge": "$962K YTD"},
            {"title": "EPIC and broker partners are effective.", "body": "Broker partners represented 62% of September enrollments.", "targetView": "sources", "badge": "62% Sep Share"},
            {"title": "Paid media spend is paying off.", "body": "Every $1 of media spend has returned $4.63 of pharmacy margin.", "targetView": "paidmedia", "badge": "4.63x ROAS"},
            {"title": "Drop-off happens before the first fill.", "body": "90% of sign-ups saw a provider, 80% were prescribed, 69% filled.", "targetView": "funnel", "badge": "69% 1st Fill"},
            {"title": "Once patients start, they stay.", "body": "94% came back for a second fill; 87% were still filling at fill 3.", "targetView": "refill", "badge": "94% Refill"},
            {"title": "Wegovy pill utilization is becoming material.", "body": "38% of GLP-1 fills were from the Wegovy pill in September.", "targetView": "medmix", "badge": "38% Wegovy Pill"}
        ]
    },
    "slide3_financials": {
        "sectionTitle": "PROGRAM FINANCIALS",
        "headline": "September program proceeds reached $371K after ad spend, $962K year to date",
        "monthlyProceeds": {
            "title": "Monthly program proceeds (after ad spend)",
            "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
            "values": [10743, 20558, 18756, 25496, 22859, 68562, 166445, 257058, 371214]
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
            {"item": "Program proceeds", "amount": 961691, "formatted": "$961,691", "type": "total"}
        ],
        "septemberGrossMarginPerFill": 911,
        "costPerFill": 40,
        "totalFillsInPnl": 2034,
        "footnote": "Proceeds = pharmacy gross margin + membership fees − media ad spend − Alpha and Bridge fees − broker commissions − $40 cost to fill. Ad spend is media spend from the agency's reports (agency fees not included). September gross margin per fill: $911."
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
                {"name": "Other", "values": [0, 3, 5, 8, 10, 5, 5, 8, 4], "color": "#6F7886"}
            ]
        },
        "table": [
            {"source": "EPIC", "enrolledSept": 120, "enrolledYtd": 452, "share": "44%", "shareNum": 44, "filled1stRx": "77%", "filled1stRxNum": 77, "refilled1to2": "93%", "refilled1to2Num": 93, "glp1Fills": 748, "grossMargin": 696172, "grossMarginFmt": "$696,172"},
            {"source": "Paid Media", "enrolledSept": 93, "enrolledYtd": 417, "share": "40%", "shareNum": 40, "filled1stRx": "62%", "filled1stRxNum": 62, "refilled1to2": "92%", "refilled1to2Num": 92, "glp1Fills": 804, "grossMargin": 671400, "grossMarginFmt": "$671,400"},
            {"source": "Employee", "enrolledSept": 6, "enrolledYtd": 54, "share": "5%", "shareNum": 5, "filled1stRx": "67%", "filled1stRxNum": 67, "refilled1to2": "97%", "refilled1to2Num": 97, "glp1Fills": 214, "grossMargin": 160234, "grossMarginFmt": "$160,234"},
            {"source": "LHD  (new since Aug)", "sourceKey": "LHD", "enrolledSept": 43, "enrolledYtd": 54, "share": "5%", "shareNum": 5, "filled1stRx": "76%", "filled1stRxNum": 76, "refilled1to2": "—", "refilled1to2Num": None, "glp1Fills": 41, "grossMargin": 39729, "grossMarginFmt": "$39,729"},
            {"source": "McGohan Brabender  (new since Aug)", "sourceKey": "McGohan Brabender", "enrolledSept": 7, "enrolledYtd": 8, "share": "1%", "shareNum": 1, "filled1stRx": "88%", "filled1stRxNum": 88, "refilled1to2": "—", "refilled1to2Num": None, "glp1Fills": 7, "grossMargin": 6228, "grossMarginFmt": "$6,228"},
            {"source": "Other", "enrolledSept": 4, "enrolledYtd": 48, "share": "5%", "shareNum": 5, "filled1stRx": "66%", "filled1stRxNum": 66, "refilled1to2": "100%", "refilled1to2Num": 100, "glp1Fills": 138, "grossMargin": 107308, "grossMarginFmt": "$107,308"}
        ],
        "footnote": "Fill rate uses members who enrolled before September. Refill rate uses first fills at least 45 days before the as-of date. Paid Media = sign-ups with no referral or coupon code."
    },
    "slide5_paidMedia": {
        "sectionTitle": "IS PAID MEDIA PAYING OFF?",
        "headline": "Every $1 of media spend has returned $4.63 of pharmacy margin from Paid Media patients",
        "kpis": [
            {"label": "Media spend, campaign to date", "value": "$142K", "exact": "$142,033", "subtext": "Jan ‘26 – Sep '26"},
            {"label": "Paid Media sign-ups", "value": "414", "exact": "414 sign-ups", "subtext": "$343 of spend per sign-up"},
            {"label": "Started therapy", "value": "243", "exact": "243 patients", "subtext": "$584 per patient started"},
            {"label": "Pharmacy gross margin", "value": "$658K", "exact": "$658,361", "subtext": "786 fills from these patients"}
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
            {"month": "2026 total", "spend": 142033, "spendFmt": "$142,033", "signups": 414, "spendPerSignup": "$343", "started": 243, "spendPerStarted": "$584", "fills": 786, "margin": 658361, "marginFmt": "$658,361", "roas": "463%", "roasNum": 463, "isTotal": True}
        ],
        "footnote": "Spend from the agency's Google + Meta reports. Sign-ups are Alpha members with no referral or coupon code; therapy starts, fills and margin come from linking them to Damien Pharmacy fills. Recent months are still building margin (September sign-ups have had at most one fill)."
    },
    "slide6_funnel": {
        "sectionTitle": "ARE PATIENTS SEEING A PROVIDER AND FILLING?",
        "headline": "69% of sign-ups fill their first prescription; the losses happen before the pharmacy",
        "chartTitle": "Members who enrolled before September (760 patients)",
        "steps": [
            {"stage": "Enrolled", "patients": 760, "pctOfEnrolled": 100, "stepConversion": "100%"},
            {"stage": "Saw a provider", "patients": 684, "pctOfEnrolled": 90, "stepConversion": "90%"},
            {"stage": "Prescribed", "patients": 608, "pctOfEnrolled": 80, "stepConversion": "89%"},
            {"stage": "Filled 1st Rx", "patients": 523, "pctOfEnrolled": 69, "stepConversion": "86%"}
        ],
        "dropoffs": [
            {"count": 76, "label": "never completed a provider visit", "filterSheet": "ended", "filterStage": "No provider visit"},
            {"count": 76, "label": "saw a provider but were not prescribed", "filterSheet": "ended", "filterStage": "Saw provider, no Rx"},
            {"count": 85, "label": "were prescribed but never filled", "filterSheet": "todo", "filterStage": "Rx written, not filled"}
        ],
        "timing": [
            {"metric": "Under 1 hour", "label": "Sign-up to provider visit"},
            {"metric": "17 hours", "label": "Visit to prescription"},
            {"metric": "1 day", "label": "Prescription to first fill"},
            {"metric": "86%", "label": "of prescribed patients filled"}
        ]
    },
    "slide7_refill": {
        "sectionTitle": "ARE PATIENTS REFILLING?",
        "headline": "Once patients start, more than 9 in 10 come back for each refill",
        "chart": {
            "title": "Share of patients who started therapy still filling, by fill number",
            "fills": ["Fill 1", "Fill 2", "Fill 3", "Fill 4", "Fill 5", "Fill 6", "Fill 7", "Fill 8"],
            "shareStillFilling": [100.0, 93.6, 87.4, 78.2, 72.7, 70.3, 59.7, 56.7],
            "patientCounts": [670, 494, 311, 203, 118, 68, 41, 24]
        },
        "stepTable": [
            {"step": "Fill 1 → 2", "cameBack": "94%", "cameBackNum": 94, "eligiblePts": 391, "lowSample": False},
            {"step": "Fill 2 → 3", "cameBack": "93%", "cameBackNum": 93, "eligiblePts": 271, "lowSample": False},
            {"step": "Fill 3 → 4", "cameBack": "89%", "cameBackNum": 89, "eligiblePts": 171, "lowSample": False},
            {"step": "Fill 4 → 5", "cameBack": "93%", "cameBackNum": 93, "eligiblePts": 85, "lowSample": False},
            {"step": "Fill 5 → 6", "cameBack": "97%", "cameBackNum": 97, "eligiblePts": 62, "lowSample": False},
            {"step": "Fill 6 → 7", "cameBack": "85%", "cameBackNum": 85, "eligiblePts": 33, "lowSample": False},
            {"step": "Fill 7 → 8", "cameBack": "95%", "cameBackNum": 95, "eligiblePts": 20, "lowSample": True}
        ],
        "footnote": "Step rates count only patients whose fill was at least 45 days before September 30, 2026, so recent starters who haven't had time to refill aren't counted as drop-offs. Typical gap between fills is about 27 days. Gray steps have fewer than 30 eligible patients. Fill counts: Fill 1 670, Fill 2 494, Fill 3 311, Fill 4 203, Fill 5 118, Fill 6 68, Fill 7 41, Fill 8 24 patients."
    },
    "slide8_medMix": {
        "sectionTitle": "WHAT ARE PATIENTS FILLING?",
        "headline": "Wegovy pill reached 38% of fills in September",
        "chart": {
            "months": ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"],
            "wegovyPen": [22, 41, 51, 92, 114, 179, 245, 307, 411],
            "wegovyPill": [0, 0, 0, 0, 0, 33, 85, 168, 256],
            "ozempic": [0, 0, 2, 2, 2, 5, 5, 8, 6]
        },
        "septemberCallouts": [
            {"value": 411, "share": "61.1%", "label": "Wegovy pen fills, Sep", "color": "#154672"},
            {"value": 256, "share": "38.0%", "label": "Wegovy pill fills, Sep", "color": "#26ABE4"},
            {"value": 6, "share": "0.9%", "label": "Ozempic fills, Sep", "color": "#1BAF7A"}
        ],
        "note": "Completed Wegovy and Ozempic dispenses at Damien Pharmacy, all patients."
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
            "Cost to fill is an assumed $40 per fill. Ad spend is Google + Meta media spend from the agency's paid media reports; agency fees are not included."
        ]
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
            {"joined": "Sep", "members": 273, "M0": "100%", "M1": "", "M2": "", "M3": "", "M4": "", "M5": "", "M6": "", "M7": "", "M8": ""}
        ],
        "footnote": "Share of each sign-up month's members whose membership was still active at the end of each month after joining (M0 = joining month)."
    },
    "worklists": {
        "pharmacyTodo": {
            "title": "Pharmacy To-Do",
            "description": "Owner: Damien Pharmacy. Members with an active membership who have a prescription at Damien Pharmacy that has not been filled. Data through September 30, 2026. Update Status, Date contacted and Notes (yellow) as you work the list.",
            "headers": todo_headers,
            "rows": pharmacy_todo
        },
        "refillFollowup": {
            "title": "Refill Follow-Up",
            "description": "Owner: Damien Pharmacy. Active members who filled before but have no fill in the last 35+ days (typical gap between fills is ~27 days). Contact to schedule the next fill.",
            "headers": refill_headers,
            "rows": refill_followup
        },
        "pharmacyDataFixes": {
            "title": "Pharmacy Data Fixes",
            "description": "Owner: Damien Pharmacy. Fills that can't be linked to a program member. Add or correct the Patient Alternate ID (first 8 characters of the Alpha member ID) in the dispense system.",
            "noIdTitle": "Fills with no Patient Alternate ID (55)",
            "noIdHeaders": fixes_no_id_headers,
            "noIdRows": fixes_no_id,
            "unmatchedTitle": "Patient IDs that don't match any program member (21 IDs, 31 fills)",
            "unmatchedHeaders": fixes_unmatched_headers,
            "unmatchedRows": fixes_unmatched
        },
        "endedNeverFilled": {
            "title": "Ended Memberships – Never Filled (reference)",
            "description": "Members whose membership has already ended without a first fill. No action required; use for root-cause review and possible win-back outreach.",
            "headers": ended_headers,
            "rows": ended_never_filled
        }
    }
}

out_file = os.path.join(DATA_DIR, "portal_data.json")
with open(out_file, "w", encoding="utf-8") as f:
    json.dump(dashboard_data, f, indent=2, ensure_ascii=False)

print(f"Saved {out_file} ({os.path.getsize(out_file)} bytes)")
print(f"Counts -> Todo: {len(pharmacy_todo)}, Refill: {len(refill_followup)}, Fixes(NoID): {len(fixes_no_id)}, Fixes(Unmatched): {len(fixes_unmatched)}, Ended: {len(ended_never_filled)}")
fuzzy_matches = [r for r in fixes_unmatched if r.get("suggestedMatch")]
print(f"Fuzzy matches automatically detected in Unmatched IDs: {len(fuzzy_matches)} rows")
for m in fuzzy_matches:
    print(" ", m["Patient ID on file"], "->", m["suggestedMatch"])
