# FinAnalyzer

> **A desktop audit utility for Chartered Accountants working with Tally Prime.**
> One-click import from Tally → run 20+ audit modules → export beautifully formatted Excel working papers.

FinAnalyzer was built by a practicing CA for practicing CAs. If you've ever spent an evening pivoting a Day Book in Excel just to check TDS coverage or reconcile GSTR-2B, this tool is for you. No Tally add-on is installed. Nothing is uploaded to any server. Everything runs locally on your machine.

---

## ⬇️ Download the ready-to-run app (no Node install needed)

Grab a standalone build — unzip and double-click. **All downloads:** [github.com/dhruvdua88/finanalyzer/releases](https://github.com/dhruvdua88/finanalyzer/releases)

| Platform | Download |
|---|---|
| **Windows 10/11** (x64) | [FinAnalyzer-windows-x64.zip](https://github.com/dhruvdua88/finanalyzer/releases/download/v1.0.0-desktop/FinAnalyzer-windows-x64.zip) |
| **macOS** (Apple Silicon / M1–M4) | [FinAnalyzer-macos-arm64.zip](https://github.com/dhruvdua88/finanalyzer/releases/download/v1.0.0-desktop/FinAnalyzer-macos-arm64.zip) |
| **macOS** (Intel) | [FinAnalyzer-macos-x64.zip](https://github.com/dhruvdua88/finanalyzer/releases/download/v1.0.0-desktop/FinAnalyzer-macos-x64.zip) |

1. Unzip the folder anywhere.
2. **Windows:** double-click `FinAnalyzer.exe`. **macOS:** double-click `Run FinAnalyzer.command` (first time: right-click → **Open** to get past Gatekeeper, since the build isn't notarized).
3. Keep the `app/` folder next to the executable — it's required. The app opens at `http://127.0.0.1:5173`.

> Prefer to run from source instead? See the [Quick Start](#quick-start-for-chartered-accountants-no-coding) below.

---

## What it does (at a glance)

| Area | Modules |
|---|---|
| **Setup** | Dashboard Overview, Audit Configuration Manager |
| **TSF Compare** | Compare two Tally Source Files by strict GUID to spot back-dated entries |
| **Core Audit** | Accounting Ledger Analytics, Voucher Book View, Ledger Statement, **Party Ledger Transaction Matrix**, Related Party (RPT) Analysis, Trial Balance Analysis |
| **Ageing** | Debtor Ageing (FIFO), Creditor Ageing (FIFO) |
| **GST & Tax** | GST Expense Analysis, GST Ledger Summary, **GSTR-2B Reconciliation**, GST Rate Analysis, ITC 3B Reconciliation, Purchase GST Register, Sales Register, RCM Analysis, **TDS Analysis** |
| **Analytics** | Balance Sheet Cleanliness, Cash Flow, Exception Density Heatmap, Profit & Loss, Variance Analysis |

Each module produces an audit-ready Excel workbook with headers, colour coding, totals and observations — the kind of file you can paste straight into a file note.

---

## Who this is for

- **Chartered Accountants** doing statutory audit, tax audit, internal audit or concurrent audit on Tally-based books.
- **Audit teams** who want reproducible working papers instead of ad-hoc pivots.
- **Finance/controllership teams** looking for a monthly close review tool.

You do **not** need to be a developer. Follow the Quick Start below.

---

## Requirements

### Minimum system
- **Windows 10/11** (primary supported), or **macOS 12+** (Intel or Apple Silicon)
- **8 GB RAM** (16 GB recommended for companies with 100k+ vouchers/year)
- **2 GB free disk space**

### Software (one-time install)
- **Node.js LTS** — download from [https://nodejs.org](https://nodejs.org) and install with defaults
- **Tally Prime** (any recent release) — only if you want the one-click Tally import
- **Git** (only if you want to update automatically) — [https://git-scm.com](https://git-scm.com)

That's it. No database server. No Python. No cloud account.

---

## Quick Start for Chartered Accountants (no coding)

### Step 1 — Download the app
1. Click the green **Code** button above this README on GitHub → **Download ZIP**.
2. Extract the ZIP to any folder, e.g. `C:\FinAnalyzer` or `~/FinAnalyzer`.

### Step 2 — First-time setup (only once)
1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org) (keep clicking Next with defaults).
2. Open the extracted folder. You should see files like `run_software.bat`, `package.json`, `README.md`.
3. **Windows:** double-click `run_software.bat`. A black terminal window will open and say *"Installing dependencies… please wait"*. The first run takes 3–5 minutes. After that it opens `http://127.0.0.1:5173` in your browser.
4. **macOS:** double-click `run_software_mac.command`. If macOS blocks it, right-click → **Open** → **Open anyway**.

> Leave the terminal window open while you use the app. Closing it stops the app.

### Step 3 — Install the Tally loader (one-time, only if you want Option A)
The **Import from Tally** button relies on a helper utility called `tally-database-loader`. It isn't bundled with this repo — download the **pre-built** version once. No `npm install` needed.

**A. Download (≈15 MB, pre-built)**

Click → [https://excelkida.com/resource/tally-database-loader-utility-1.0.42.7z](https://excelkida.com/resource/tally-database-loader-utility-1.0.42.7z)

The file is a `.7z` archive (like `.zip` but compressed better).

**B. Extract it**

- **Windows:** install [7-Zip](https://www.7-zip.org/) (free, one-time). Right-click the `.7z` file → **7-Zip → Extract Here**.
- **macOS:** install [The Unarchiver](https://theunarchiver.com/) from the App Store (free, one-time). Double-click the `.7z` file.
- **Linux:** `sudo apt install p7zip-full` then `7z x tally-database-loader-utility-1.0.42.7z`.

**C. Rename the extracted folder**

You'll get a folder whose name starts with `tally-database-loader-utility…`. **Rename it to exactly:**

```
tally-database-loader-main
```

(The app looks for this exact name — no spaces, no version number.)

**D. Place it inside the FinAnalyzer folder**

Drag the renamed folder into your FinAnalyzer folder. The final layout must look like this:

```
FinAnalyzer/
├── tally-database-loader-main/   ← the folder you just renamed
│   ├── dist/
│   │   └── index.mjs             ← must exist
│   ├── config.json               ← must exist
│   └── …
├── App.tsx
├── package.json
└── run_software.bat (or run_software_mac.command)
```

**E. Restart FinAnalyzer**

Close the terminal running FinAnalyzer, then double-click `run_software.bat` (Windows) or `run_software_mac.command` (Mac) again. The warning *"Loader utility not found"* will disappear and **Import from Tally** will work.

> **Troubleshooting:** if FinAnalyzer still shows the warning, open the `tally-database-loader-main` folder and confirm both `dist/index.mjs` and `config.json` exist. If `dist/` is missing, your archive was a source-only version — in that case open Terminal in that folder and run `npm install && npm run build`.

Skip this entire step if you only plan to import `.TSF` files (Option B).

### Step 4 — Load your Tally data
You have **three ways** to get data into FinAnalyzer:

**Option A — One-click Tally import (fastest)**
1. Open **Tally Prime** and load your company.
2. In Tally, enable ODBC/XML connectivity: `F1 → Settings → Connectivity → Client/Server configuration → TallyPrime is acting as: Both → Port 9000`.
3. In FinAnalyzer, click **Import from Tally**, pick the financial year, click **Fetch**.

**Option B — Import a TSF file (Tally Source File)**
If a colleague has already exported the company's data as a `.TSF` file:
1. Click **Import Tally Source File**.
2. Select the `.TSF`. Done — all modules populate.

**Option C — TSF Raw to Excel utility (no analysis needed)**
On the first page, there is a standalone **TSF Raw to Excel** converter if you just want flat CSV-style sheets.

### Step 5 — Run modules
Click any module on the left sidebar. Each module has:
- Filters at the top (date range, ledger selection, primary group)
- A preview table
- An **Export Beautiful Excel** button top-right — this is the deliverable for your file

### Step 6 — Close the app
- **Windows:** double-click `close_software.bat` (or simply close the black terminal window).
- **macOS:** press `Ctrl+C` in the terminal, then close it.

---

## Tally connectivity checklist

If **Import from Tally** fails, confirm each of these in Tally Prime:

- [ ] Company is loaded (not just selected)
- [ ] `F1 → Settings → Connectivity → Client/Server configuration`
  - TallyPrime is acting as: **Both**
  - Enable ODBC: **Yes**
  - Port: **9000** (default)
- [ ] Windows Firewall is not blocking Tally on port 9000
- [ ] Tally and FinAnalyzer are running on the **same machine** (or same LAN if you know what you're doing)

Test quickly: open a browser and go to [http://localhost:9000](http://localhost:9000). You should see some Tally XML response. If yes, FinAnalyzer will connect.

---

## Module deep-dives

### Party Ledger Transaction Matrix
The flagship audit module. For each party in Sundry Debtors/Creditors it shows:
- Total Sales, Purchase, Expenses routed through that party
- TDS deducted and **TDS / Expense %** (spot under-deduction instantly)
- GST component and **GST / (Sales + Expense) %**
- RCM, Bank, Others/Adjustments
- Net Balance vs movement gap

Because TDS/GST ledgers aren't tagged inside Tally, the module lets you **tick which ledgers count as TDS, GST, RCM** (with auto-suggest). That selection is saved as a **Profile JSON** — re-usable across periods.

### GSTR-2B Reconciliation
Upload the GSTR-2B JSON downloaded from the GST portal → matches against Purchase Register → outputs matched / in-books-not-2B / in-2B-not-books / rate-mismatch buckets.

### TDS Analysis
Section-wise (194C / 194J / 194Q etc.) compliance check with threshold flagging.

### Trial Balance Analysis
Group-wise and ledger-wise TB with opening/movement/closing, plus cleanliness checks.

### Debtor & Creditor Ageing (FIFO)
True FIFO bucket ageing (not by invoice date — by actual knockoff using receipt/payment vouchers).

---

## Developer Commands (skip if you're not a developer)

```bash
npm install         # install dependencies
npm run dev         # browser dev mode at http://127.0.0.1:5173
npm run build       # production build into /dist
npm run tauri:dev   # run as native desktop app (requires Rust)
npm run tauri:build # build Windows installer
```

See [INSTRUCTIONS.md](INSTRUCTIONS.md) for architecture notes.

---

## Data & privacy

- **Nothing leaves your machine.** There is no telemetry, no cloud call, no licence server.
- Your Tally data is processed in-memory and written only to the Excel files *you* export.
- Do **not** commit real client data (TSF, GSTR-2B JSON, Trial Balance PDFs, etc.) back to this repo. The `.gitignore` excludes common filenames to protect you.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm` is not recognised | Node.js not installed. Re-run installer from [nodejs.org](https://nodejs.org) and reboot. |
| Browser shows *"site can't be reached"* at `127.0.0.1:5173` | The terminal window was closed. Re-run `run_software.bat` / `run_software_mac.command`. |
| Import from Tally returns 0 records | Tally port 9000 not open, or a company isn't loaded. Run the connectivity checklist above. |
| Excel export button does nothing on a huge company | Files with 500k+ vouchers can take 30–60 seconds. Wait; watch the terminal for progress. |
| First run is stuck on "installing" | Check your internet. `npm install` downloads ~200 MB. Corporate proxies can block this — try on a personal network. |
| App is slow with 1 million+ vouchers | Use `Mode: SQL (low-memory)` toggle shown on the top-right of each module. |

If the fix isn't here, open an **Issue** on this repo with (a) the module, (b) what you clicked, (c) a screenshot of the browser + terminal.

---

## Contributing

Pull requests welcome, especially from other CAs.

1. Fork the repo.
2. `npm install` and `npm run dev`.
3. New modules go under `components/modules/`. Each module is a self-contained `.tsx` that receives `data: LedgerEntry[]`.
4. Keep Excel exports consistent: `xlsx-js-style`, freeze panes at the header row, totals row in slate-900, observations block at the bottom.
5. Open a PR with a screenshot of the module and the exported Excel.

---

## Disclaimer

FinAnalyzer is an **aid** to the audit process, not a substitute for professional judgement. Always verify flagged exceptions against source documents before concluding. The authors accept no liability for reliance on the tool's output.

---

## Licence

This project is released under the MIT Licence — see [LICENSE](LICENSE). You may use it freely in your practice, modify it, and share modifications, provided the copyright notice is retained.

---

**Built by a CA, for CAs. If it saves you an evening, pay it forward — file an issue with a feature idea or open a PR.**
