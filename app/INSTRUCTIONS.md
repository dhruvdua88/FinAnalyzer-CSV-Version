# FinAnalyzer Utility Instructions

## 1. Purpose
Developer and operations guide for the web app version of FinAnalyzer.

Current core capabilities:
- One-click import from Tally using bundled loader
- Tally Source File import/export (`.tsf`)
- TSF raw-data export to Excel (`.xlsx`) from first-page sub-feature
- SQL-backed runtime store (with safe fallback path)
- Responsive dashboard shell with section-wise module navigation
- GSTR-2B Reconciliation module (JSON import, multi-period matching, run persistence, Excel/JSON export)
- Voucher Book View (voucher search + full Dr/Cr entry detail + Excel export)
- Ledger Statement (opening/closing rows, running balance, period filter, Excel export)
- Cash Flow Analysis (cash-pool selection, ledger-level fund flow, accounting-style cash flow statement)
- TDS Analysis (ledger-based voucher impact, total TDS, effective TDS%, summary export)
- Purchase GST register, Trial Balance, FIFO ageing, and related analysis modules

## 2. Run App (Windows, Web Mode)
Primary launcher: `run_software.bat`

This launcher now enforces safe startup:
1. Validates `node` and `npm` in PATH.
2. Calls `close_software.bat` before start.
3. Stops existing listeners on ports `5173`, `5174`, `5175`, `5176`.
4. Auto-installs requirements if `node_modules`/runtime binaries are missing.
5. Starts Vite on strict port `5173` and opens `http://127.0.0.1:5173`.
6. Writes startup logs to `vite-dev.log`.

Stop app: `close_software.bat`

End-user guide: `RUN_ME_FIRST.html`

## 2A. Run App (Mac, Web Mode)
Primary launcher: `run_software_mac.command`

Mac launcher behavior:
1. Stops any existing process listening on `127.0.0.1:5173`.
2. Installs dependencies if runtime binaries are missing.
3. Starts Vite on strict port `5173`.

Automator helper script:
- `run_fin_analyzer_automator.sh`
- Intended for "Quick Action" / "Application" style wrapper execution.

## 3. Build & Package
- Install dependencies: `npm install`
- Dev mode: `npm run dev`
- Production build: `npm run build`
- Browser-mode package wrapper: `package_software.bat`

Note: Tauri scripts may exist in the folder, but web mode is the primary maintained runtime path.

## 3A. Node SEA Packaging (Desktop, No Electron/Tauri)
SEA packaging script: `sea/build-sea.cjs`

Key rule:
- SEA output is OS-specific (it embeds the current machine's Node runtime).
- Build on Windows to get `FinAnalyzer.exe`.
- Build on macOS to get `FinAnalyzer` (Mach-O), not usable as a Windows executable.

Windows `.exe` build steps:
1. Copy project source to Windows (do not reuse macOS `sea/out` binaries).
2. Run `npm install`.
3. Run `node sea/build-sea.cjs`.
4. Collect build output from `sea\out\FinAnalyzer\`.

What to share with end users (Windows):
- `sea\out\FinAnalyzer\FinAnalyzer.exe`
- `sea\out\FinAnalyzer\app\` (required)
- launcher scripts in the same folder (optional)

## 4. Date Convention
All user-facing date output/input should remain in `dd/mm/yyyy`.

## 5. Architecture Overview
### Frontend
- `App.tsx`: module shell, shared settings, data load orchestration.
- `components/FileUpload.tsx`: one-click Tally import, TSF import/export, TSF raw-to-Excel sub-feature.
- `components/modules/*`: module-specific analysis and exports.
- Key modules:
  - `components/modules/VoucherBookView.tsx`
  - `components/modules/LedgerVoucherView.tsx` (UI label: `Ledger Statement`)
  - `components/modules/TDSAnalysis.tsx`
  - `components/modules/CashFlowAnalysis.tsx`
  - `components/modules/DebtorAgeingFIFO.tsx`
  - `components/modules/CreditorAgeingFIFO.tsx`
- `services/sqlDataService.ts`: API wrapper for SQL/source operations.

### Backend Hosts (same API contract)
- Dev host middleware: `vite.config.ts` (`tally-loader-bridge`)
- Desktop-compatible host: `desktop-backend/backend.cjs`

## 6. Stable API Contract
- `GET /api/data/health`
- `POST /api/data/load`
- `GET /api/data/rows`
- `GET /api/data/summary`
- `POST /api/data/clear`
- `POST /api/data/import-source`
- `GET /api/data/export-source`
- `POST /api/data/source-to-excel`
- `GET /api/loader/status`
- `POST /api/loader/run-and-export`
- `POST /api/loader/abort`
- `POST /api/gstr2b/import`
- `GET /api/gstr2b/imports`
- `POST /api/gstr2b/imports/clear`
- `GET /api/gstr2b/imports/:id`
- `POST /api/gstr2b/reconcile`
- `GET /api/gstr2b/runs`
- `GET /api/gstr2b/runs/:id`
- `GET /api/gstr2b/runs/:id/export-xlsx`
- `GET /api/gstr2b/runs/:id/export-json`

Progress UI depends on `/api/loader/status` fields:
- `running`
- `logs`
- `lastRunAt`
- `lastError`
- `loaderRoot`

## 7. Loader Placement Requirement
Bundled loader path must remain present:

`tally-database-loader-main (1)\tally-database-loader-main`

## 8. Data Contract and Rules
All analysis modules consume normalized `LedgerEntry` rows from `types.ts`.

Critical fields:
- `date`
- `voucher_number`, `invoice_number`
- `Ledger`, `amount`
- `opening_balance`, `closing_balance`
- `TallyPrimary`, `TallyParent`, `Group`
- `is_accounting_voucher`, `is_master_ledger`

Global rule:
- Analyze only rows where `is_accounting_voucher = 1`.

Amount sign convention used by analytics modules:
- `amount > 0` => Credit effect
- `amount < 0` => Debit effect

## 9. TSF Export Requirements
Exported TSF must retain and/or generate these reference tables:
- `ledger_entries`
- `trn_accounting`
- `mst_ledger`
- `trial_balance_from_mst_ledger`

`trial_balance_from_mst_ledger` is derived from `mst_ledger` balances.

## 10. Purchase GST Register Rules (Current)
- Include vouchers where at least one line hits:
  - Purchase / Expense / Fixed Asset (by `TallyPrimary`), or
  - selected GST ledger(s).
- Restrict to `is_accounting_voucher = 1`.
- Taxable value comes from Purchase/Expense/Fixed Asset primary impact lines.
- Reverse charge uses selected RCM ledgers and is shown as `Yes/No`.
- `Type` mapping:
  - `RCM` if reverse charge is `Yes`
  - `IMPORTGOODS OR SERVICE` if expense ledger text indicates import
  - `B2B` if party GSTIN/UIN is present
  - blank otherwise
- Reco sheet keeps separate columns for Purchase, Expense, and Fixed Asset.

## 10A. GSTR-2B Reconciliation Rules (Current)
- Import source for 2B is JSON only (GST portal JSON payload).
- Supported JSON paths:
  - `data.docdata.b2b[].inv[]`
  - `data.docdata.cdnr[].nt[]`
  - `data.docdata.b2ba[].inv[]` (optional)
- Books-side data comes from loaded Purchase Register / ledger rows already in system.
- Reconciliation uses only tax-bearing books documents (`totalTax != 0`, threshold-safe).
- Books normalization must capture GSTIN from party/non-tax lines as well (not only tax rows).
- Scope supports:
  - multi-select 2B imports (`importIds`)
  - multi-select books periods (`scope.months`)
  - optional entity GSTIN and branch/location
- Matching passes:
  - A: `GSTIN + invoice no + date`
  - B: `GSTIN + invoice no` with date tolerance
  - C: `GSTIN + normalized invoice no`
  - D: `GSTIN + amount tolerance` fallback
- Statuses:
  - `MATCH`, `ONLY_IN_BOOKS`, `ONLY_IN_2B`, `AMOUNT_MISMATCH`, `DATE_MISMATCH`, `RCM_MISMATCH`, `DUPLICATE`
- Summary outputs required:
  - GSTIN-wise mismatch buckets
  - overall party + GSTIN summary
  - invoice status-level summary
- Clear behavior:
  - `Clear 2B` removes selected (or all) imported 2B files and related reconciliation runs.
- Export outputs:
  - JSON download of run result
  - Styled Excel workbook with sheets:
    - `Data Dictionary`
    - `Summary`
    - `Overall Party GSTIN`
    - `Status Summary`
    - `Invoice Summary`
    - `GSTIN Summary`
    - `Matches`
    - `Mismatches`
    - `All Details`
    - `Action List`

## 11. Ledger Statement Rules (Current)
- Module label shown in UI: `Ledger Statement`.
- Scope: single selected ledger within selected date range.
- Must show `Opening Balance b/f` row at top and `Closing Balance c/f` row at bottom.
- Running balance is computed in-period using voucher rows and opening at period start.
- Search filters voucher-level rows without removing opening/closing rows.
- Excel export must include statement rows and reconciliation summary.

## 12. TDS Analysis Rules (Current)
- TDS is computed using selected TDS tax ledgers.
- Voucher grouping key is `voucher_number + date + voucher_type` to reduce collisions.
- Report is ledger-centric: for each selected analysis ledger, show net voucher hit, total TDS, and effective TDS%.
- Keep zero-TDS rows visible where applicable for audit traceability.
- Export supports summary-level output.

## 13. Cash Flow Analysis Rules (Current)
- Auto-select cash pool ledgers if primary/parent/group text contains `bank` or `cash` (case-insensitive).
- Allow manual add/remove of ledgers in cash pool for business overrides (for example OD/loan equivalents).
- Direction logic based on opposite ledger sign:
  - Opposite debit => outflow from cash pool
  - Opposite credit => inflow to cash pool
- Primary output is ledger-level flow analysis (not voucher-detail first).
- Provide accounting-style cash flow statement with opening, movement, and closing.

## 14. Extension Checklist
When adding/changing modules:
1. Keep compatibility with `LedgerEntry` contract in `types.ts`.
2. Register UI/module routing updates in `App.tsx`.
3. Preserve API contract listed above.
4. Run `npm run build` before shipping.
5. Update `README.md` and this file for behavior changes.

## 15. Changed Files Handover (Current Session)
Current session replacement package:
- Folder: `session_changed_files_2026-02-17/`
- Archive: `session_changed_files_2026-02-17.zip`

Files in handover package:
- `App.tsx`
- `types.ts`
- `vite.config.ts`
- `desktop-backend/backend.cjs`
- `desktop-backend/services/gstr2bReconciliation.cjs`
- `desktop-backend/tests/gstr2bReconciliation.test.cjs`
- `services/gstr2bReconciliationService.ts`
- `components/modules/GSTR2BReconciliation.tsx`
- `run_software_mac.command`
- `run_fin_analyzer_automator.sh`

## 16. Known Constraints
- One-click import requires Tally Prime with XML connectivity (typically port `9000`).
- First run may install missing npm dependencies.
- Large datasets are expected; prefer indexed/filter-first operations and memoized transforms.

## 17. Publish to New GitHub Repo
If this folder is already committed locally, publish with:
1. Create empty repository on GitHub (no README/license/gitignore).
2. Add remote:
   `git remote add origin <YOUR_GITHUB_REPO_URL>`
3. Push:
   `git push -u origin main`
