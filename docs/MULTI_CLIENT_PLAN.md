# Multi-Client (Multi-CE) Architecture & Implementation Plan (v8)

> [!IMPORTANT]
> **New in v8 — Phase 7 (`v2.3.0-multi-client`) Addressing All 3 User Requests:**
> 1. **New "Enrollment Reporting" Section Below "Patient Sources" (`view-enrollment`)**: Dedicated interactive reporting section directly below `Patient Sources` in the left sidebar showing **Enrollments**, **Disenrollments (Cancellations & Auto-Disenrollments)**, **Currently Active Counts**, **Net Member Additions**, and **Trends** filterable across **Timeframes** (`All YTD`, `Q1`, `Q2`, `Q3`, or individual months `Jan`–`Sep`), **Channels / Brokers** (`All Channels`, `Broker Partners Combined`, `EPIC`, `LHD`, `McGohan Brabender`, `Paid Media`, `Employee`, `Other`), and **Employers** (all `38` employer groups in `Alpha Data` + the `14` notable employers from `Damien Exhibits`).
> 2. **Clean Login Page (`/login` in `public/login.html`)**:
>    - Fix the logo's weird dark/black background box by removing `background: var(--navy); padding: 8px 14px; border-radius: 10px;` on `.login-logo` so `/assets/logo.png` sits cleanly on the white card.
>    - Change the heading from `"Client Program Analytics"` to **`"Program Analytics"`**.
>    - Remove the verbose subtitle (`"Sign in with your Covered Entity credentials to access your GLP-1 dashboard and pharmacy worklist."`) and footer (`"Protected Covered Entity Environment · Bridge Health Hub"`), leaving a clean, minimal login box.
> 3. **Real, Intelligent Conversational LLM (`/api/ask` in `server.js` & `public/app.js`)**:
>    - Route **100% of user questions to the real Gemini LLM** (`gemini-2.5-flash` with reasoning enabled via `thinkingBudget: 1024`) — removing the brittle regex short-circuits (`isMemberLevelQuery` false positives) that previously returned robotic canned text.
>    - Enforce zero member-level data structurally (zero patient/member IDs or rows exist in the LLM prompt context) while feeding the LLM the complete, unified dataset from **both the `.pptx` executive deck AND both `.xlsx` workbooks** (`Damien_FirstFill_Worklist_Sep2026.xlsx` aggregate summaries + `September 2026 Analysis.xlsx` exhibits, enrollment/disenrollment/active cohorts, employer groups, dose-level dispenses, prescriber economics, payer remits, and monthly P&L).
>    - Upgrade the system prompt and chat markdown renderer (`formatMarkdownText`) so the AI speaks like an executive healthcare strategist—synthesizing across PPTX and XLSX sources, explaining the "why" and "so what", and rendering clean formatted lists, bold callouts, and tables.
