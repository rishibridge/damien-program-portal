import argparse
import collections
import copy
import datetime
import json
import os
import openpyxl
from pptx import Presentation

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(BASE_DIR, "source_docs")
CLIENTS_DIR = os.path.join(BASE_DIR, "data", "clients")
DEFAULT_ANALYSIS_XLSX = r"C:\Users\rishi\OneDrive - Bridge Helath Hub Inc\Bridge Health\Active Projects\Dashboard\September 2026 Analysis.xlsx"
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
        raw_pid_on_file = str(r.get("Patient ID on file") or "").strip()
        # Automatically mask any alphabetic / non-hex patient name accidentally entered as a Patient ID
        if raw_pid_on_file and not any(ch.isdigit() for ch in raw_pid_on_file):
            r["Patient ID on file"] = "[Masked Non-Hex ID]"
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
        if pid and not pid.startswith("[masked") and any(ch.isdigit() for ch in pid):
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


def _num(v, default=0.0):
    if v is None or v == "":
        return default
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 2)
    except Exception:
        return default


def parse_damien_analysis_workbook(analysis_xlsx_path):
    """
    Extracts strictly AGGREGATE, NON-MEMBER-LEVEL analytics from 'September 2026 Analysis.xlsx'
    scoped 100% to Damien Center (Damien Exhibits, Damien Dispense Data, Lookups, and
    Alpha Data rows where plan_name == 'damien-health-membership').
    Zero member UUIDs, zero Patient Alternate IDs, and zero individual member/claim rows are included.
    """
    if not analysis_xlsx_path or not os.path.exists(analysis_xlsx_path):
        print(f"[WARN] Analysis workbook not found at {analysis_xlsx_path}; skipping analysisWorkbook extraction.")
        return None

    wb = openpyxl.load_workbook(analysis_xlsx_path, data_only=True)
    ws_ex = wb["Damien Exhibits"]
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]

    def read_monthly_row(r_idx, is_pct=False):
        vals = {}
        for idx, m in enumerate(months):
            raw = ws_ex.cell(r_idx, 2 + idx).value
            if is_pct and isinstance(raw, (int, float)):
                vals[m] = f"{round(float(raw) * 100, 1)}%"
            else:
                vals[m] = _num(raw, 0)
        ytd_raw = ws_ex.cell(r_idx, 11).value
        if is_pct and isinstance(ytd_raw, (int, float)):
            vals["YTD"] = f"{round(float(ytd_raw) * 100, 1)}%"
        else:
            vals["YTD"] = _num(ytd_raw, 0)
        return vals

    # A1: Total Enrollments by Source & Month (Rows 5..12)
    enrollments_by_source = []
    for r_idx in range(5, 12):
        label = str(ws_ex.cell(r_idx, 1).value or "").strip()
        if label:
            enrollments_by_source.append({"source": label, **read_monthly_row(r_idx)})
    broker_share_monthly = read_monthly_row(12, is_pct=True)

    # A2: Membership Cancellations by Source & Month (Rows 16..23)
    cancellations_by_source = []
    for r_idx in range(16, 23):
        label = str(ws_ex.cell(r_idx, 1).value or "").strip()
        if label:
            norm_label = "Total" if label.lower() in ("grand total", "total") else label
            cancellations_by_source.append({"source": norm_label, **read_monthly_row(r_idx)})
    cancellation_pct_of_enrolled = read_monthly_row(23, is_pct=True)

    # A3: Active Patient Tracker & Monthly Net Additions (Rows 28..29)
    active_tracker = {m: _num(ws_ex.cell(28, 2 + i).value, 0) for i, m in enumerate(months)}
    net_additions = {m: _num(ws_ex.cell(29, 2 + i).value, 0) for i, m in enumerate(months)}

    # A4: Notable Enrollments by Employer Group by Month (Rows 34..47)
    notable_employers_monthly = []
    for r_idx in range(34, 48):
        label = str(ws_ex.cell(r_idx, 1).value or "").strip()
        if label:
            notable_employers_monthly.append({"employerGroup": label, **read_monthly_row(r_idx)})

    # A5: Dispenses by Drug & Specific Dose Strength by Month (Rows 52..65)
    dispenses_by_dose_monthly = []
    for r_idx in range(52, 66):
        label = str(ws_ex.cell(r_idx, 1).value or "").strip()
        if label:
            dispenses_by_dose_monthly.append({"medicationDose": label, **read_monthly_row(r_idx)})

    # A6: Full Monthly P&L & Unit Economics (Rows 82..92 transposed + Rows 96..105 Margin/Rx)
    pnl_cols = {}
    for c_idx in range(2, 12):
        col_name = str(ws_ex.cell(82, c_idx).value or "").strip()
        if col_name:
            pnl_cols[c_idx] = col_name

    monthly_pnl = {col_name: {} for col_name in pnl_cols.values()}
    for r_idx in range(83, 93):
        m_label = str(ws_ex.cell(r_idx, 1).value or "").strip()
        if m_label == "Sept":
            m_label = "Sep"
        if m_label:
            for c_idx, col_name in pnl_cols.items():
                monthly_pnl[col_name][m_label] = _num(ws_ex.cell(r_idx, c_idx).value, 0)

    margin_per_rx = {}
    for r_idx in range(96, 106):
        m_label = str(ws_ex.cell(r_idx, 1).value or "").strip()
        if m_label == "Sept":
            m_label = "Sep"
        elif m_label == "Grand Total":
            m_label = "YTD"
        if m_label:
            margin_per_rx[m_label] = _num(ws_ex.cell(r_idx, 2).value, 0)
    monthly_pnl["Gross Margin per Rx"] = margin_per_rx

    # Lookups sheet (Ref Code -> Employer & Partner, Coupon -> Partner)
    ws_lu = wb["Lookups"]
    ref_code_lookups = []
    coupon_lookups = []
    for r_idx in range(3, ws_lu.max_row + 1):
        rc = ws_lu.cell(r_idx, 2).value
        emp = ws_lu.cell(r_idx, 3).value
        partner = ws_lu.cell(r_idx, 4).value
        if rc and emp:
            ref_code_lookups.append({
                "refCode": str(rc).strip(),
                "employerName": str(emp).strip(),
                "partnerName": str(partner or "").strip(),
            })
        cc = ws_lu.cell(r_idx, 6).value
        c_partner = ws_lu.cell(r_idx, 7).value
        if cc and c_partner:
            coupon_lookups.append({
                "couponCode": str(cc).strip(),
                "partnerName": str(c_partner).strip(),
            })

    # A7: Alpha Data (strictly aggregate-only, filtered to plan_name == 'damien-health-membership')
    ws_alpha = wb["Alpha Data"]
    alpha_headers = [str(ws_alpha.cell(1, c).value or "").strip() for c in range(1, ws_alpha.max_column + 1)]
    employer_stats = collections.defaultdict(lambda: {
        "totalEnrolled": 0,
        "activeMembers": 0,
        "cancelledMembers": 0,
        "autoDisenrolled": 0,
        "withProviderVisit": 0,
        "withPrescription": 0,
        "byMonth": collections.Counter(),
        "cancelledByStartMonth": collections.Counter(),
        "activeByStartMonth": collections.Counter(),
        "autoDisenrolledByStartMonth": collections.Counter(),
        "visitByStartMonth": collections.Counter(),
        "rxByStartMonth": collections.Counter(),
        "partnerSource": "",
        "refCodes": set(),
    })
    channel_stats = collections.defaultdict(lambda: {
        "totalEnrolled": 0,
        "activeMembers": 0,
        "cancelledMembers": 0,
        "autoDisenrolled": 0,
        "withProviderVisit": 0,
        "withPrescription": 0,
        "byMonth": collections.Counter(),
        "cancelledByStartMonth": collections.Counter(),
        "activeByStartMonth": collections.Counter(),
        "autoDisenrolledByStartMonth": collections.Counter(),
        "visitByStartMonth": collections.Counter(),
        "rxByStartMonth": collections.Counter(),
    })
    coupon_counts = collections.Counter()
    ref_code_counts = collections.Counter()
    prescribed_drug_counts = collections.Counter()
    cancel_by_start_month = collections.Counter()
    total_damien_alpha_rows = 0
    non_test_damien_rows = 0
    test_damien_rows = 0
    total_cancelled = 0
    total_auto_disenrolled = 0
    total_with_visit = 0
    total_with_rx = 0

    for r_idx in range(2, ws_alpha.max_row + 1):
        row = {alpha_headers[c - 1]: ws_alpha.cell(r_idx, c).value for c in range(1, len(alpha_headers) + 1)}
        if row.get("plan_name") != "damien-health-membership":
            continue
        total_damien_alpha_rows += 1
        is_test = bool(row.get("test_user")) and str(row.get("test_user")).lower() not in ("0", "false", "none")
        if is_test:
            test_damien_rows += 1
        else:
            non_test_damien_rows += 1

        raw_emp = row.get("Reference Code Group")
        emp_group = str(raw_emp).strip() if (raw_emp is not None and str(raw_emp).strip() not in ("", "None")) else "Direct / Paid Media (No Employer Code)"
        p_source = str(row.get("Patient Source") or "Other").strip()
        if p_source in ("", "None"):
            p_source = "Other"
        rc = str(row.get("ref_code") or "").strip()
        cc = str(row.get("coupon_code_used") or "").strip()
        start_dt = row.get("subscription_start_time")
        start_month = start_dt.strftime("%b") if isinstance(start_dt, (datetime.datetime, datetime.date)) else str(row.get("Start Month") or "")
        if start_month == "Sept":
            start_month = "Sep"
        is_cancelled = row.get("subscription_cancellation_time") is not None
        is_auto_dis = str(row.get("auto-disenrolled") or "").strip().lower() in ("1", "true", "yes")

        vh_raw = row.get("visit_history")
        has_visit = False
        if vh_raw and str(vh_raw).strip() not in ("", "[]", "null", "None"):
            has_visit = True

        ph_raw = row.get("prescription_history")
        has_rx = False
        if ph_raw and str(ph_raw).strip() not in ("", "[]", "null", "None"):
            has_rx = True
            try:
                ph_list = json.loads(str(ph_raw))
                if isinstance(ph_list, list):
                    for item in ph_list:
                        if isinstance(item, dict) and item.get("name"):
                            prescribed_drug_counts[str(item["name"]).strip()] += 1
            except Exception:
                pass

        if is_cancelled:
            total_cancelled += 1
            if start_month:
                cancel_by_start_month[start_month] += 1
        if is_auto_dis:
            total_auto_disenrolled += 1
        if has_visit:
            total_with_visit += 1
        if has_rx:
            total_with_rx += 1
        if cc and cc.lower() != "none":
            coupon_counts[cc] += 1
        if rc and rc.lower() != "none":
            ref_code_counts[rc] += 1

        st = employer_stats[emp_group]
        st["totalEnrolled"] += 1
        if is_cancelled:
            st["cancelledMembers"] += 1
            if start_month:
                st["cancelledByStartMonth"][start_month] += 1
        else:
            st["activeMembers"] += 1
            if start_month:
                st["activeByStartMonth"][start_month] += 1
        if is_auto_dis:
            st["autoDisenrolled"] += 1
            if start_month:
                st["autoDisenrolledByStartMonth"][start_month] += 1
        if has_visit:
            st["withProviderVisit"] += 1
            if start_month:
                st["visitByStartMonth"][start_month] += 1
        if has_rx:
            st["withPrescription"] += 1
            if start_month:
                st["rxByStartMonth"][start_month] += 1
        if start_month:
            st["byMonth"][start_month] += 1
        st["partnerSource"] = p_source
        if rc and rc.lower() != "none":
            st["refCodes"].add(rc)

        cst = channel_stats[p_source]
        cst["totalEnrolled"] += 1
        if is_cancelled:
            cst["cancelledMembers"] += 1
            if start_month:
                cst["cancelledByStartMonth"][start_month] += 1
        else:
            cst["activeMembers"] += 1
            if start_month:
                cst["activeByStartMonth"][start_month] += 1
        if is_auto_dis:
            cst["autoDisenrolled"] += 1
            if start_month:
                cst["autoDisenrolledByStartMonth"][start_month] += 1
        if has_visit:
            cst["withProviderVisit"] += 1
            if start_month:
                cst["visitByStartMonth"][start_month] += 1
        if has_rx:
            cst["withPrescription"] += 1
            if start_month:
                cst["rxByStartMonth"][start_month] += 1
        if start_month:
            cst["byMonth"][start_month] += 1

    all_employer_groups_summary = []
    for emp_name, st in sorted(employer_stats.items(), key=lambda kv: (-kv[1]["totalEnrolled"], kv[0])):
        is_direct = emp_name.startswith("Direct / Paid Media")
        all_employer_groups_summary.append({
            "employerGroup": emp_name,
            "isDirectNoEmployer": is_direct,
            "partnerSource": st["partnerSource"],
            "isBrokerChannel": st["partnerSource"] in ("EPIC", "LHD", "McGohan Brabender"),
            "refCodes": sorted(list(st["refCodes"])),
            "totalEnrolled": st["totalEnrolled"],
            "activeMembers": st["activeMembers"],
            "cancelledMembers": st["cancelledMembers"],
            "autoDisenrolled": st["autoDisenrolled"],
            "withProviderVisit": st["withProviderVisit"],
            "withPrescription": st["withPrescription"],
            "activeRetentionPct": round((st["activeMembers"] / st["totalEnrolled"]) * 100, 1) if st["totalEnrolled"] else 0.0,
            "disenrollmentPct": round((st["cancelledMembers"] / st["totalEnrolled"]) * 100, 1) if st["totalEnrolled"] else 0.0,
            "byMonth": {m: int(st["byMonth"].get(m, 0)) for m in months},
            "cancelledByMonth": {m: int(st["cancelledByStartMonth"].get(m, 0)) for m in months},
            "activeByMonth": {m: int(st["activeByStartMonth"].get(m, 0)) for m in months},
            "autoDisenrolledByMonth": {m: int(st["autoDisenrolledByStartMonth"].get(m, 0)) for m in months},
            "visitByMonth": {m: int(st["visitByStartMonth"].get(m, 0)) for m in months},
            "rxByMonth": {m: int(st["rxByStartMonth"].get(m, 0)) for m in months},
        })

    channel_order = ["EPIC", "Paid Media", "Employee", "LHD", "McGohan Brabender", "Other"]
    ex_enr_by_source = {r["source"]: r for r in enrollments_by_source}
    ex_canc_by_source = {r["source"]: r for r in cancellations_by_source}
    all_channels_summary = []
    for ch_name in channel_order:
        cst = channel_stats.get(ch_name)
        ex_enr = ex_enr_by_source.get(ch_name, {})
        ex_canc = ex_canc_by_source.get(ch_name, {})
        if not cst and not ex_enr:
            continue
        is_broker = ch_name in ("EPIC", "LHD", "McGohan Brabender")
        cat = "Broker Partner" if is_broker else ("Paid Acquisition" if ch_name == "Paid Media" else "Internal / Direct")
        by_month_map = {m: int(ex_enr.get(m, cst["byMonth"].get(m, 0) if cst else 0)) for m in months}
        canc_by_month_map = {m: int(ex_canc.get(m, cst["cancelledByStartMonth"].get(m, 0) if cst else 0)) for m in months}
        active_by_month_map = {m: max(0, by_month_map[m] - canc_by_month_map[m]) for m in months}
        tot_e = int(ex_enr.get("YTD", sum(by_month_map.values())))
        tot_c = int(ex_canc.get("YTD", sum(canc_by_month_map.values())))
        tot_a = max(0, tot_e - tot_c)
        all_channels_summary.append({
            "channel": ch_name,
            "category": cat,
            "isBroker": is_broker,
            "totalEnrolled": tot_e,
            "activeMembers": tot_a,
            "cancelledMembers": tot_c,
            "autoDisenrolled": cst["autoDisenrolled"] if cst else tot_c,
            "withProviderVisit": cst["withProviderVisit"] if cst else 0,
            "withPrescription": cst["withPrescription"] if cst else 0,
            "activeRetentionPct": round((tot_a / tot_e) * 100, 1) if tot_e else 0.0,
            "disenrollmentPct": round((tot_c / tot_e) * 100, 1) if tot_e else 0.0,
            "byMonth": by_month_map,
            "cancelledByMonth": canc_by_month_map,
            "activeByMonth": active_by_month_map,
            "autoDisenrolledByMonth": {m: int(cst["autoDisenrolledByStartMonth"].get(m, 0)) if cst else 0 for m in months},
            "visitByMonth": {m: int(cst["visitByStartMonth"].get(m, 0)) if cst else 0 for m in months},
            "rxByMonth": {m: int(cst["rxByStartMonth"].get(m, 0)) if cst else 0 for m in months},
        })

    enrollment_reporting = {
        "months": months,
        "activePatientTrackerMonthly": active_tracker,
        "monthlyNetAdditions": net_additions,
        "brokerSharePctMonthly": broker_share_monthly,
        "cancellationPctOfTotalEnrolledMonthly": cancellation_pct_of_enrolled,
        "channels": all_channels_summary,
        "employers": all_employer_groups_summary,
        "notableEmployersExhibits": notable_employers_monthly,
    }

    # A8: Damien Dispense Data (strictly aggregate-only across 2,247 dispense transactions)
    ws_disp = wb["Damien Dispense Data"]
    disp_headers = [str(ws_disp.cell(1, c).value or "").strip() for c in range(1, ws_disp.max_column + 1)]

    status_totals = collections.defaultdict(lambda: {"fills": 0, "revenue": 0.0, "acquisitionCost": 0.0, "margin": 0.0})
    prescriber_stats = collections.defaultdict(lambda: {
        "npi": "",
        "totalTransactions": 0,
        "completedFills": 0,
        "completedGlp1ThroughSep30": 0,
        "cancelledFills": 0,
        "waitingForPickupFills": 0,
        "completedRevenue": 0.0,
        "completedAcquisitionCost": 0.0,
        "completedMargin": 0.0,
    })
    primary_payer_stats = collections.defaultdict(lambda: {
        "completedFills": 0,
        "cancelledFills": 0,
        "waitingForPickupFills": 0,
        "primaryRemit": 0.0,
        "primaryCopay": 0.0,
        "secondaryRemit": 0.0,
        "totalRevenue": 0.0,
        "acquisitionCost": 0.0,
        "margin": 0.0,
    })
    secondary_payer_stats = collections.defaultdict(lambda: {
        "completedFills": 0,
        "secondaryRemit": 0.0,
        "secondaryCopay": 0.0,
        "totalRevenue": 0.0,
        "margin": 0.0,
    })
    drug_stats = collections.defaultdict(lambda: {
        "ndcs": set(),
        "completedFills": 0,
        "completedThroughSep30": 0,
        "cancelledFills": 0,
        "waitingForPickupFills": 0,
        "completedRevenue": 0.0,
        "completedAcquisitionCost": 0.0,
        "completedMargin": 0.0,
    })

    for r_idx in range(2, ws_disp.max_row + 1):
        row = {disp_headers[c - 1]: ws_disp.cell(r_idx, c).value for c in range(1, len(disp_headers) + 1)}
        status = str(row.get("Current Transaction Status") or "Unknown").strip()
        presc = str(row.get("Prescriber Full Name") or "Unknown").strip()
        npi = str(row.get("Prescriber NPI") or "").strip()
        ndc = str(row.get("Dispensed Item NDC") or "").strip()
        drug = str(row.get("Dispensed Item Name") or "Unknown").strip()
        p1 = str(row.get("Primary Third Party") or "Cash / None").strip()
        p2 = str(row.get("Secondary Third Party") or "None").strip()
        dt = row.get("Date Filled")
        dt_str = dt.strftime("%Y-%m-%d") if isinstance(dt, (datetime.datetime, datetime.date)) else str(dt or "")
        is_glp1 = ("wegovy" in drug.lower()) or ("ozempic" in drug.lower())
        is_through_sep = dt_str <= "2026-09-30"

        rev = float(row.get("Total Pharmacy Revenue") or 0.0)
        cost = float(row.get("Acquisition Cost") or 0.0)
        margin = float(row.get("Pharmacy Margin") or 0.0)
        rem1 = float(row.get("Primary Remit Amount") or 0.0)
        cop1 = float(row.get("Primary Copay Amount") or 0.0)
        rem2 = float(row.get("Secondary Remit Amount") or 0.0)
        cop2 = float(row.get("Secondary Copay Amount") or 0.0)

        st_tot = status_totals[status]
        st_tot["fills"] += 1
        st_tot["revenue"] = round(st_tot["revenue"] + rev, 2)
        st_tot["acquisitionCost"] = round(st_tot["acquisitionCost"] + cost, 2)
        st_tot["margin"] = round(st_tot["margin"] + margin, 2)

        pr = prescriber_stats[presc]
        if npi:
            pr["npi"] = npi
        pr["totalTransactions"] += 1
        if status == "Completed":
            pr["completedFills"] += 1
            if is_glp1 and is_through_sep:
                pr["completedGlp1ThroughSep30"] += 1
            pr["completedRevenue"] = round(pr["completedRevenue"] + rev, 2)
            pr["completedAcquisitionCost"] = round(pr["completedAcquisitionCost"] + cost, 2)
            pr["completedMargin"] = round(pr["completedMargin"] + margin, 2)
        elif status == "Cancelled":
            pr["cancelledFills"] += 1
        elif status == "Waiting for Pick up":
            pr["waitingForPickupFills"] += 1

        pp1 = primary_payer_stats[p1]
        if status == "Completed":
            pp1["completedFills"] += 1
            pp1["primaryRemit"] = round(pp1["primaryRemit"] + rem1, 2)
            pp1["primaryCopay"] = round(pp1["primaryCopay"] + cop1, 2)
            pp1["secondaryRemit"] = round(pp1["secondaryRemit"] + rem2, 2)
            pp1["totalRevenue"] = round(pp1["totalRevenue"] + rev, 2)
            pp1["acquisitionCost"] = round(pp1["acquisitionCost"] + cost, 2)
            pp1["margin"] = round(pp1["margin"] + margin, 2)
        elif status == "Cancelled":
            pp1["cancelledFills"] += 1
        elif status == "Waiting for Pick up":
            pp1["waitingForPickupFills"] += 1

        if status == "Completed":
            pp2 = secondary_payer_stats[p2]
            pp2["completedFills"] += 1
            pp2["secondaryRemit"] = round(pp2["secondaryRemit"] + rem2, 2)
            pp2["secondaryCopay"] = round(pp2["secondaryCopay"] + cop2, 2)
            pp2["totalRevenue"] = round(pp2["totalRevenue"] + rev, 2)
            pp2["margin"] = round(pp2["margin"] + margin, 2)

        dr = drug_stats[drug]
        if ndc:
            dr["ndcs"].add(ndc)
        if status == "Completed":
            dr["completedFills"] += 1
            if is_through_sep:
                dr["completedThroughSep30"] += 1
            dr["completedRevenue"] = round(dr["completedRevenue"] + rev, 2)
            dr["completedAcquisitionCost"] = round(dr["completedAcquisitionCost"] + cost, 2)
            dr["completedMargin"] = round(dr["completedMargin"] + margin, 2)
        elif status == "Cancelled":
            dr["cancelledFills"] += 1
        elif status == "Waiting for Pick up":
            dr["waitingForPickupFills"] += 1

    prescribers_list = []
    for name, pr in sorted(prescriber_stats.items(), key=lambda kv: (-kv[1]["completedFills"], kv[0])):
        cf = pr["completedFills"]
        prescribers_list.append({
            "prescriber": name,
            "npi": pr["npi"],
            "totalTransactions": pr["totalTransactions"],
            "completedFills": cf,
            "completedGlp1ThroughSep30": pr["completedGlp1ThroughSep30"],
            "cancelledFills": pr["cancelledFills"],
            "waitingForPickupFills": pr["waitingForPickupFills"],
            "completedRevenue": pr["completedRevenue"],
            "completedAcquisitionCost": pr["completedAcquisitionCost"],
            "completedMargin": pr["completedMargin"],
            "avgRevenuePerCompletedFill": round(pr["completedRevenue"] / cf, 2) if cf else 0.0,
            "avgMarginPerCompletedFill": round(pr["completedMargin"] / cf, 2) if cf else 0.0,
        })

    primary_payers_list = []
    for payer_name, pp in sorted(primary_payer_stats.items(), key=lambda kv: (-kv[1]["completedFills"], kv[0])):
        cf = pp["completedFills"]
        primary_payers_list.append({
            "primaryPayer": payer_name,
            "completedFills": cf,
            "cancelledFills": pp["cancelledFills"],
            "waitingForPickupFills": pp["waitingForPickupFills"],
            "primaryRemit": pp["primaryRemit"],
            "primaryCopay": pp["primaryCopay"],
            "secondaryRemit": pp["secondaryRemit"],
            "totalRevenue": pp["totalRevenue"],
            "acquisitionCost": pp["acquisitionCost"],
            "margin": pp["margin"],
            "avgMarginPerCompletedFill": round(pp["margin"] / cf, 2) if cf else 0.0,
        })

    secondary_payers_list = []
    for payer_name, pp in sorted(secondary_payer_stats.items(), key=lambda kv: (-kv[1]["completedFills"], kv[0])):
        secondary_payers_list.append({
            "secondaryPayer": payer_name,
            "completedFills": pp["completedFills"],
            "secondaryRemit": pp["secondaryRemit"],
            "secondaryCopay": pp["secondaryCopay"],
            "totalRevenue": pp["totalRevenue"],
            "margin": pp["margin"],
        })

    medications_list = []
    for drug_name, dr in sorted(drug_stats.items(), key=lambda kv: (-kv[1]["completedFills"], kv[0])):
        cf = dr["completedFills"]
        medications_list.append({
            "medicationName": drug_name,
            "ndcs": sorted(list(dr["ndcs"])),
            "completedFills": cf,
            "completedThroughSep30": dr["completedThroughSep30"],
            "cancelledFills": dr["cancelledFills"],
            "waitingForPickupFills": dr["waitingForPickupFills"],
            "completedRevenue": dr["completedRevenue"],
            "completedAcquisitionCost": dr["completedAcquisitionCost"],
            "completedMargin": dr["completedMargin"],
            "avgRevenuePerFill": round(dr["completedRevenue"] / cf, 2) if cf else 0.0,
            "avgAcquisitionCostPerFill": round(dr["completedAcquisitionCost"] / cf, 2) if cf else 0.0,
            "avgMarginPerFill": round(dr["completedMargin"] / cf, 2) if cf else 0.0,
        })

    return {
        "privacyPolicy": "AGGREGATE_ONLY_NO_MEMBER_LEVEL_DATA",
        "sourceWorkbook": "September 2026 Analysis.xlsx",
        "clientScope": "damien",
        "exhibits": {
            "enrollmentsBySourceMonthly": enrollments_by_source,
            "brokerSharePctMonthly": broker_share_monthly,
            "cancellationsBySourceMonthly": cancellations_by_source,
            "cancellationPctOfTotalEnrolledMonthly": cancellation_pct_of_enrolled,
            "activePatientTrackerMonthly": active_tracker,
            "monthlyNetAdditions": net_additions,
            "notableEmployerGroupsMonthly": notable_employers_monthly,
            "dispensesByDoseMonthly": dispenses_by_dose_monthly,
            "monthlyPnL": monthly_pnl,
        },
        "alphaAnalytics": {
            "totalDamienMembershipRows": total_damien_alpha_rows,
            "nonTestMembers": non_test_damien_rows,
            "testAccountsExcludedFromDeck": test_damien_rows,
            "totalCancelledMembers": total_cancelled,
            "totalAutoDisenrolledMembers": total_auto_disenrolled,
            "totalMembersWithProviderVisit": total_with_visit,
            "totalMembersWithPrescription": total_with_rx,
            "cancellationsByStartMonth": dict(cancel_by_start_month),
            "couponCodeCounts": dict(coupon_counts.most_common()),
            "refCodeCounts": dict(ref_code_counts.most_common()),
            "prescribedDrugCountsInAlpha": dict(prescribed_drug_counts.most_common()),
            "allEmployerGroups": all_employer_groups_summary,
            "refCodeLookupTable": ref_code_lookups,
            "couponLookupTable": coupon_lookups,
        },
        "dispenseAnalytics": {
            "totalDispenseRows": ws_disp.max_row - 1,
            "byTransactionStatus": dict(status_totals),
            "byPrescriber": prescribers_list,
            "byPrimaryThirdPartyPayer": primary_payers_list,
            "bySecondaryThirdPartyPayer": secondary_payers_list,
            "byMedicationAndNdc": medications_list,
        },
        "enrollmentReporting": enrollment_reporting,
    }


def build_metro_analysis_workbook():
    """
    Builds a tenant-scoped, aggregate-only analysisWorkbook for 'metro' ('Metro Health Center')
    so Ask Bridge AI has full schema parity and zero Damien strings when logged in as 'metro'.
    """
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]
    metro_channels = [
        {
            "channel": "Regional Brokers",
            "category": "Broker Partner",
            "isBroker": True,
            "totalEnrolled": 317,
            "activeMembers": 275,
            "cancelledMembers": 42,
            "autoDisenrolled": 34,
            "withProviderVisit": 295,
            "withPrescription": 268,
            "activeRetentionPct": 86.8,
            "disenrollmentPct": 13.2,
            "byMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 18, "Jun": 52, "Jul": 64, "Aug": 95, "Sep": 88},
            "cancelledByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 2, "Jun": 6, "Jul": 9, "Aug": 12, "Sep": 13},
            "activeByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 16, "Jun": 46, "Jul": 55, "Aug": 83, "Sep": 75},
            "autoDisenrolledByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 2, "Jun": 5, "Jul": 7, "Aug": 10, "Sep": 10},
            "visitByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 17, "Jun": 49, "Jul": 60, "Aug": 89, "Sep": 80},
            "rxByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 16, "Jun": 45, "Jul": 55, "Aug": 80, "Sep": 72},
        },
        {
            "channel": "Paid Media",
            "category": "Paid Acquisition",
            "isBroker": False,
            "totalEnrolled": 290,
            "activeMembers": 220,
            "cancelledMembers": 70,
            "autoDisenrolled": 60,
            "withProviderVisit": 258,
            "withPrescription": 225,
            "activeRetentionPct": 75.9,
            "disenrollmentPct": 24.1,
            "byMonth": {"Jan": 8, "Feb": 12, "Mar": 19, "Apr": 25, "May": 32, "Jun": 44, "Jul": 38, "Aug": 54, "Sep": 58},
            "cancelledByMonth": {"Jan": 1, "Feb": 2, "Mar": 4, "Apr": 5, "May": 6, "Jun": 11, "Jul": 11, "Aug": 15, "Sep": 15},
            "activeByMonth": {"Jan": 7, "Feb": 10, "Mar": 15, "Apr": 20, "May": 26, "Jun": 33, "Jul": 27, "Aug": 39, "Sep": 43},
            "autoDisenrolledByMonth": {"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 9, "Jul": 10, "Aug": 13, "Sep": 13},
            "visitByMonth": {"Jan": 7, "Feb": 11, "Mar": 17, "Apr": 22, "May": 28, "Jun": 39, "Jul": 34, "Aug": 48, "Sep": 52},
            "rxByMonth": {"Jan": 6, "Feb": 9, "Mar": 15, "Apr": 19, "May": 25, "Jun": 34, "Jul": 30, "Aug": 42, "Sep": 45},
        },
        {
            "channel": "Metro Employee",
            "category": "Internal / Direct",
            "isBroker": False,
            "totalEnrolled": 52,
            "activeMembers": 45,
            "cancelledMembers": 7,
            "autoDisenrolled": 5,
            "withProviderVisit": 49,
            "withPrescription": 46,
            "activeRetentionPct": 86.5,
            "disenrollmentPct": 13.5,
            "byMonth": {"Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 6, "Jul": 6, "Aug": 8, "Sep": 7},
            "cancelledByMonth": {"Jan": 1, "Feb": 1, "Mar": 1, "Apr": 1, "May": 1, "Jun": 1, "Jul": 0, "Aug": 0, "Sep": 1},
            "activeByMonth": {"Jan": 6, "Feb": 4, "Mar": 3, "Apr": 3, "May": 4, "Jun": 5, "Jul": 6, "Aug": 8, "Sep": 6},
            "autoDisenrolledByMonth": {"Jan": 1, "Feb": 1, "Mar": 1, "Apr": 0, "May": 1, "Jun": 1, "Jul": 0, "Aug": 0, "Sep": 0},
            "visitByMonth": {"Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 5, "Jul": 6, "Aug": 7, "Sep": 6},
            "rxByMonth": {"Jan": 6, "Feb": 5, "Mar": 4, "Apr": 4, "May": 4, "Jun": 5, "Jul": 6, "Aug": 6, "Sep": 6},
        },
    ]
    metro_employers = [
        {
            "employerGroup": "Metro Transit Authority",
            "isDirectNoEmployer": False,
            "partnerSource": "Regional Brokers",
            "isBrokerChannel": True,
            "refCodes": ["MTA2026"],
            "totalEnrolled": 112,
            "activeMembers": 98,
            "cancelledMembers": 14,
            "autoDisenrolled": 11,
            "withProviderVisit": 106,
            "withPrescription": 96,
            "activeRetentionPct": 87.5,
            "disenrollmentPct": 12.5,
            "byMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 8, "Jun": 18, "Jul": 22, "Aug": 34, "Sep": 30},
            "cancelledByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 1, "Jun": 2, "Jul": 3, "Aug": 4, "Sep": 4},
            "activeByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 7, "Jun": 16, "Jul": 19, "Aug": 30, "Sep": 26},
            "autoDisenrolledByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 1, "Jun": 2, "Jul": 2, "Aug": 3, "Sep": 3},
            "visitByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 8, "Jun": 17, "Jul": 21, "Aug": 32, "Sep": 28},
            "rxByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 7, "Jun": 16, "Jul": 19, "Aug": 29, "Sep": 25},
        },
        {
            "employerGroup": "Lakeside School District",
            "isDirectNoEmployer": False,
            "partnerSource": "Regional Brokers",
            "isBrokerChannel": True,
            "refCodes": ["LSD2026"],
            "totalEnrolled": 85,
            "activeMembers": 74,
            "cancelledMembers": 11,
            "autoDisenrolled": 9,
            "withProviderVisit": 80,
            "withPrescription": 72,
            "activeRetentionPct": 87.1,
            "disenrollmentPct": 12.9,
            "byMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 5, "Jun": 14, "Jul": 19, "Aug": 25, "Sep": 22},
            "cancelledByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 1, "Jun": 2, "Jul": 2, "Aug": 3, "Sep": 3},
            "activeByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 4, "Jun": 12, "Jul": 17, "Aug": 22, "Sep": 19},
            "autoDisenrolledByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 1, "Jun": 1, "Jul": 2, "Aug": 3, "Sep": 2},
            "visitByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 5, "Jun": 13, "Jul": 18, "Aug": 24, "Sep": 20},
            "rxByMonth": {"Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 4, "Jun": 12, "Jul": 16, "Aug": 22, "Sep": 18},
        },
        {
            "employerGroup": "Metro Health Patient",
            "isDirectNoEmployer": False,
            "partnerSource": "Metro Employee",
            "isBrokerChannel": False,
            "refCodes": ["METROEMP"],
            "totalEnrolled": 52,
            "activeMembers": 45,
            "cancelledMembers": 7,
            "autoDisenrolled": 5,
            "withProviderVisit": 49,
            "withPrescription": 46,
            "activeRetentionPct": 86.5,
            "disenrollmentPct": 13.5,
            "byMonth": {"Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 6, "Jul": 6, "Aug": 8, "Sep": 7},
            "cancelledByMonth": {"Jan": 1, "Feb": 1, "Mar": 1, "Apr": 1, "May": 1, "Jun": 1, "Jul": 0, "Aug": 0, "Sep": 1},
            "activeByMonth": {"Jan": 6, "Feb": 4, "Mar": 3, "Apr": 3, "May": 4, "Jun": 5, "Jul": 6, "Aug": 8, "Sep": 6},
            "autoDisenrolledByMonth": {"Jan": 1, "Feb": 1, "Mar": 1, "Apr": 0, "May": 1, "Jun": 1, "Jul": 0, "Aug": 0, "Sep": 0},
            "visitByMonth": {"Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 5, "Jul": 6, "Aug": 7, "Sep": 6},
            "rxByMonth": {"Jan": 6, "Feb": 5, "Mar": 4, "Apr": 4, "May": 4, "Jun": 5, "Jul": 6, "Aug": 6, "Sep": 6},
        },
    ]
    return {
        "privacyPolicy": "AGGREGATE_ONLY_NO_MEMBER_LEVEL_DATA",
        "sourceWorkbook": "Metro_Health_Sep2026_Analysis.xlsx",
        "clientScope": "metro",
        "enrollmentReporting": {
            "months": months,
            "activePatientTrackerMonthly": {"Jan": 15, "Feb": 28, "Mar": 49, "Apr": 78, "May": 115, "Jun": 210, "Jul": 295, "Aug": 420, "Sep": 540},
            "monthlyNetAdditions": {"Jan": 15, "Feb": 13, "Mar": 21, "Apr": 29, "May": 37, "Jun": 95, "Jul": 85, "Aug": 125, "Sep": 120},
            "brokerSharePctMonthly": {"Jan": "0.0%", "Feb": "0.0%", "Mar": "0.0%", "Apr": "0.0%", "May": "32.7%", "Jun": "51.0%", "Jul": "59.3%", "Aug": "60.5%", "Sep": "65.0%", "YTD": "48.1%"},
            "cancellationPctOfTotalEnrolledMonthly": {"Jan": "13.3%", "Feb": "17.6%", "Mar": "21.7%", "Apr": "20.7%", "May": "16.4%", "Jun": "17.6%", "Jul": "19.4%", "Aug": "16.6%", "Sep": "19.0%", "YTD": "18.1%"},
            "channels": metro_channels,
            "employers": metro_employers,
            "notableEmployersExhibits": [
                {"employerGroup": "Metro Transit Authority", "Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 8, "Jun": 18, "Jul": 22, "Aug": 34, "Sep": 30, "YTD": 112},
                {"employerGroup": "Lakeside School District", "Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 5, "Jun": 14, "Jul": 19, "Aug": 25, "Sep": 22, "YTD": 85},
                {"employerGroup": "Metro Health Patient", "Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 6, "Jul": 6, "Aug": 8, "Sep": 7, "YTD": 52},
            ],
        },
        "exhibits": {
            "enrollmentsBySourceMonthly": [
                {"source": "Regional Brokers", "Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 18, "Jun": 52, "Jul": 64, "Aug": 95, "Sep": 88, "YTD": 317},
                {"source": "Paid Media", "Jan": 8, "Feb": 12, "Mar": 19, "Apr": 25, "May": 32, "Jun": 44, "Jul": 38, "Aug": 54, "Sep": 58, "YTD": 290},
                {"source": "Metro Employee", "Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 6, "Jul": 6, "Aug": 8, "Sep": 7, "YTD": 52},
                {"source": "Grand Total", "Jan": 15, "Feb": 17, "Mar": 23, "Apr": 29, "May": 55, "Jun": 102, "Jul": 108, "Aug": 157, "Sep": 153, "YTD": 659},
            ],
            "brokerSharePctMonthly": {"Jan": "0.0%", "Feb": "0.0%", "Mar": "0.0%", "Apr": "0.0%", "May": "32.7%", "Jun": "51.0%", "Jul": "59.3%", "Aug": "60.5%", "Sep": "65.0%", "YTD": "48.1%"},
            "cancellationsBySourceMonthly": [
                {"source": "Total", "Jan": 2, "Feb": 3, "Mar": 5, "Apr": 6, "May": 9, "Jun": 18, "Jul": 21, "Aug": 26, "Sep": 29, "YTD": 119},
            ],
            "cancellationPctOfTotalEnrolledMonthly": {"Jan": "13.3%", "Feb": "17.6%", "Mar": "21.7%", "Apr": "20.7%", "May": "16.4%", "Jun": "17.6%", "Jul": "19.4%", "Aug": "16.6%", "Sep": "19.0%", "YTD": "18.1%"},
            "activePatientTrackerMonthly": {"Jan": 15, "Feb": 28, "Mar": 49, "Apr": 78, "May": 115, "Jun": 210, "Jul": 295, "Aug": 420, "Sep": 540},
            "monthlyNetAdditions": {"Jan": 15, "Feb": 13, "Mar": 21, "Apr": 29, "May": 37, "Jun": 95, "Jul": 85, "Aug": 125, "Sep": 120},
            "notableEmployerGroupsMonthly": [
                {"employerGroup": "Metro Transit Authority", "Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 8, "Jun": 18, "Jul": 22, "Aug": 34, "Sep": 30, "YTD": 112},
                {"employerGroup": "Lakeside School District", "Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 5, "Jun": 14, "Jul": 19, "Aug": 25, "Sep": 22, "YTD": 85},
                {"employerGroup": "Metro Health Patient", "Jan": 7, "Feb": 5, "Mar": 4, "Apr": 4, "May": 5, "Jun": 6, "Jul": 6, "Aug": 8, "Sep": 7, "YTD": 52},
            ],
            "dispensesByDoseMonthly": [
                {"medicationDose": "Wegovy 0.25 Mg/0.5 Ml Pen", "Jan": 6, "Feb": 10, "Mar": 14, "Apr": 22, "May": 30, "Jun": 45, "Jul": 62, "Aug": 75, "Sep": 90, "YTD": 354},
                {"medicationDose": "Wegovy 0.5 Mg/0.5 Ml Pen", "Jan": 0, "Feb": 5, "Mar": 10, "Apr": 16, "May": 24, "Jun": 38, "Jul": 50, "Aug": 68, "Sep": 82, "YTD": 293},
                {"medicationDose": "Wegovy 1 Mg/0.5 Ml Pen", "Jan": 0, "Feb": 0, "Mar": 4, "Apr": 10, "May": 18, "Jun": 30, "Jul": 44, "Aug": 58, "Sep": 98, "YTD": 262},
                {"medicationDose": "Wegovy 1.5 Mg Tablet", "Jan": 0, "Feb": 0, "Mar": 0, "Apr": 0, "May": 0, "Jun": 24, "Jul": 58, "Aug": 110, "Sep": 155, "YTD": 347},
                {"medicationDose": "Ozempic 1 Mg/dose Pen", "Jan": 0, "Feb": 0, "Mar": 1, "Apr": 2, "May": 2, "Jun": 3, "Jul": 4, "Aug": 6, "Sep": 5, "YTD": 23},
                {"medicationDose": "Grand Total", "Jan": 6, "Feb": 15, "Mar": 29, "Apr": 50, "May": 74, "Jun": 140, "Jul": 218, "Aug": 418, "Sep": 430, "YTD": 1380},
            ],
            "monthlyPnL": {
                "Rx Count": {"Jan": 6, "Feb": 15, "Mar": 29, "Apr": 50, "May": 74, "Jun": 140, "Jul": 218, "Aug": 418, "Sep": 430, "YTD": 1380},
                "Revenue": {"Jan": 6840, "Feb": 17100, "Mar": 33060, "Apr": 57000, "May": 84360, "Jun": 160300, "Jul": 249610, "Aug": 479610, "Sep": 492520, "YTD": 1580400},
                "Gross Margin": {"Jan": 5130, "Feb": 12825, "Mar": 24795, "Apr": 42750, "May": 63270, "Jun": 120225, "Jul": 187208, "Aug": 364262, "Sep": 384835, "YTD": 1185300},
                "Sub. Fees": {"Jan": 450, "Feb": 840, "Mar": 1470, "Apr": 2340, "May": 3450, "Jun": 4200, "Jul": 5100, "Aug": 6150, "Sep": 7200, "YTD": 31200},
                "Gross Margin per Rx": {"Jan": 855.0, "Feb": 855.0, "Mar": 855.0, "Apr": 855.0, "May": 855.0, "Jun": 858.75, "Jul": 858.75, "Aug": 871.44, "Sep": 895.0, "YTD": 858.91},
            },
        },
        "alphaAnalytics": {
            "totalDamienMembershipRows": 0,
            "nonTestMembers": 659,
            "totalCancelledMembers": 119,
            "allEmployerGroups": [
                {"employerGroup": "Metro Transit Authority", "partnerSource": "Regional Brokers", "totalEnrolled": 112, "activeMembers": 98, "cancelledMembers": 14},
                {"employerGroup": "Lakeside School District", "partnerSource": "Regional Brokers", "totalEnrolled": 85, "activeMembers": 74, "cancelledMembers": 11},
                {"employerGroup": "Metro Health Patient", "partnerSource": "Metro Employee", "totalEnrolled": 52, "activeMembers": 45, "cancelledMembers": 7},
            ],
        },
        "dispenseAnalytics": {
            "totalDispenseRows": 1450,
            "byTransactionStatus": {
                "Completed": {"fills": 1380, "revenue": 1580400.0, "acquisitionCost": 395100.0, "margin": 1185300.0},
                "Cancelled": {"fills": 60, "revenue": 68400.0, "acquisitionCost": 17100.0, "margin": 51300.0},
                "Waiting for Pick up": {"fills": 10, "revenue": 11400.0, "acquisitionCost": 2850.0, "margin": 8550.0},
            },
            "byPrescriber": [
                {"prescriber": "Vance, Marcus", "npi": "1447609911", "completedFills": 520, "completedRevenue": 595400.0, "completedMargin": 446550.0, "avgMarginPerCompletedFill": 858.75},
                {"prescriber": "Rostova, Elena", "npi": "1881920044", "completedFills": 460, "completedRevenue": 526700.0, "completedMargin": 395025.0, "avgMarginPerCompletedFill": 858.75},
                {"prescriber": "Chen, David", "npi": "1992301122", "completedFills": 400, "completedRevenue": 458300.0, "completedMargin": 343725.0, "avgMarginPerCompletedFill": 859.31},
            ],
            "byPrimaryThirdPartyPayer": [
                {"primaryPayer": "Wegovy Savings Card", "completedFills": 1260, "totalRevenue": 1442700.0, "margin": 1082025.0, "avgMarginPerCompletedFill": 858.75},
                {"primaryPayer": "BlueCross Commercial", "completedFills": 120, "totalRevenue": 137700.0, "margin": 103275.0, "avgMarginPerCompletedFill": 860.63},
            ],
            "bySecondaryThirdPartyPayer": [
                {"secondaryPayer": "Metro Weight Loss Assistance", "completedFills": 1180, "secondaryRemit": 295000.0, "totalRevenue": 1351100.0, "margin": 1013325.0},
            ],
            "byMedicationAndNdc": [
                {"medicationName": "Wegovy 0.25 Mg/0.5 Ml Pen", "ndcs": ["00169452514"], "completedFills": 354, "completedRevenue": 405330.0, "completedMargin": 303998.0, "avgMarginPerFill": 858.75},
                {"medicationName": "Wegovy 1.5 Mg Tablet", "ndcs": ["00169550130"], "completedFills": 347, "completedRevenue": 397315.0, "completedMargin": 297986.0, "avgMarginPerFill": 858.75},
            ],
        },
    }


def build_damien_portal_data(xlsx_path, analysis_xlsx_path=DEFAULT_ANALYSIS_XLSX):
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

    analysis_workbook = parse_damien_analysis_workbook(analysis_xlsx_path)

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
        "analysisWorkbook": analysis_workbook,
        "enrollmentReporting": analysis_workbook.get("enrollmentReporting") if analysis_workbook else None,
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
    metro["analysisWorkbook"] = build_metro_analysis_workbook()
    metro["enrollmentReporting"] = metro["analysisWorkbook"].get("enrollmentReporting")

    return metro


def main():
    parser = argparse.ArgumentParser(description="Ingest client PPTX + XLSX + Analysis XLSX into data/clients/<clientId>/portal_data.json")
    parser.add_argument("--client", default="all", help="Client ID to ingest (damien, metro, or all)")
    parser.add_argument("--xlsx", default=os.path.join(SOURCE_DIR, "Damien_First_Fill_Worklist_Sep2026.xlsx"))
    parser.add_argument("--analysis-xlsx", default=DEFAULT_ANALYSIS_XLSX)
    args = parser.parse_args()

    damien_data = build_damien_portal_data(args.xlsx, args.analysis_xlsx)
    damien_dir = os.path.join(CLIENTS_DIR, "damien")
    os.makedirs(damien_dir, exist_ok=True)
    damien_out = os.path.join(damien_dir, "portal_data.json")
    with open(damien_out, "w", encoding="utf-8") as f:
        json.dump(damien_data, f, indent=2, ensure_ascii=False)
    print(f"Saved Damien baseline (with aggregate analysisWorkbook) -> {damien_out}")

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
    print(f"Saved Metro Health baseline (with aggregate analysisWorkbook) -> {metro_out}")

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
