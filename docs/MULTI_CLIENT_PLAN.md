# Multi-Client (Multi-CE) Architecture & Implementation Plan (v5)

> [!IMPORTANT]
> **Confirmed Architectural Decisions (v5):**
> 1. **Zero-Impact Side-by-Side Isolation**: The existing HTTP Basic Auth MVP site (`damien-program-portal`, tag `MVP`, `https://damien-program-portal-525536279111.us-central1.run.app`) remains **100% frozen on HTTP Basic Auth**. The new Multi-Client platform (`bridge-program-portal`) is deployed to a **separate GCP Cloud Run service (`https://bridge-program-portal-525536279111.us-central1.run.app`)** with its own new web login security system.
> 2. **New Web Login & Signed Session Cookie Security System (No Browser Basic Auth Popup)**: Users authenticate via a dedicated **Bridge Health Hub Web Login screen (`/login`)** that sets an HMAC-SHA256 signed `HttpOnly` session cookie (`bridge_session`), strictly locking that session 1-to-1 to the authenticated Covered Entity (`clientId`). A **Sign Out** button in the top header clears the session and returns to `/login` so users can sign out and sign in as another client in the same browser window.
> 3. **Durable Cloud Persistence for Worklist Edits**: Pharmacist updates (`Status`, `Date contacted`, `Notes`, `Corrected patient ID`) are persisted per client in **Google Cloud Storage (GCS)** (`gs://dev-dispatch-331019-portal-state/clients/<clientId>/worklist_edits.json`).
