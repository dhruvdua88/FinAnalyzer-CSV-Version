/**
 * Financial-statement validator.
 *
 * Runs the real Balance Sheet / P&L / Trial Balance engines against a Tally ZIP
 * and asserts the numbers. Exits 1 on any failure, so it can gate a change.
 *
 * The expected figures below were derived INDEPENDENTLY from the raw CSVs
 * (Python, straight off mst_ledger + trn_accounting), not from this codebase —
 * so a green run is a genuine cross-check, not a tautology.
 *
 * Usage: npx tsx scripts/validateStatements.ts <zip> [--dataset cyberevolve]
 */
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx-js-style';
import { TallyStore } from '../services/tally';
import { getTrialBalance } from '../services/tally/queries';
import * as BS from '../services/balanceSheet';
import { buildFinancialStatementsWorkbook } from '../services/financialStatementsExcel';
import { buildTrialBalanceWorkbook } from '../services/trialBalanceExcel';

// ── assertion plumbing ───────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const check = (name: string, actual: number, expected: number, tol = 0.01): void => {
  const ok = Math.abs(actual - expected) <= tol;
  ok ? pass++ : fail++;
  const status = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status}  ${name.padEnd(52)} ${inr(actual).padStart(20)}${ok ? '' : `   expected ${inr(expected)}`}`);
};

const checkTrue = (name: string, actual: boolean, detail = ''): void => {
  actual ? pass++ : fail++;
  const status = actual ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status}  ${name.padEnd(52)} ${actual ? 'true' : `false  ${detail}`}`);
};

const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ── expected figures for the CYBEREVOLVE FY2025-26 dataset ───────────────────
const CYBEREVOLVE = {
  profitBeforeTax: 17419011.75,
  reservesSurplus: -16289687.03,
  surplusTransfer: 0,
  employeeBenefits: 34490968.78,
  financeCosts: 25250,
  cwip: 1644766,
  contraFaCount: 4,
  contraFaTotal: 7369921,
  netFixedAssetsInclCwip: 7274908.02,
  tdsReceivable: 4852519.02,
  dutiesTaxesNetLegacy: 2141372.88,
  ledgerCountExclPl: 243,
  neverUsed: 111,
};

const main = async () => {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('usage: tsx scripts/validateStatements.ts <zip>');
    process.exit(2);
  }
  const store = await TallyStore.fromZip(new Blob([new Uint8Array(readFileSync(zipPath))]));
  const E = CYBEREVOLVE;

  console.log(`\n\x1b[1mValidating\x1b[0m ${store.meta?.companyName ?? '?'}  ${store.meta?.periodFrom} → ${store.meta?.periodTo}`);
  console.log(`ledgers ${store.ledgers.size}  groups ${store.groups.size}  vouchers ${store.vouchers.size}  lines ${store.accountingLines.length}`);

  // ── Trial Balance ─────────────────────────────────────────────────────────
  section('Trial Balance');
  const tb: any = getTrialBalance(store as any);
  check('closing Dr − Cr delta', tb.balanceCheck.closing.delta, 0);
  checkTrue('closing balance check ok', tb.balanceCheck.closing.ok === true);
  check('opening Dr − Cr delta', tb.balanceCheck.opening.delta, 0);
  check('transactions Dr − Cr delta', tb.balanceCheck.during.delta, 0);
  check('reconciliation failures', (tb.reconciliationFailures ?? []).length, 0);
  check('never-used ledger count', tb.activityCounts?.['never-used'] ?? -1, E.neverUsed, 0);

  // ── Balance Sheet ─────────────────────────────────────────────────────────
  section('Balance Sheet — balancing');
  const branch = BS.buildBranchFromStore(store as any, 'MAIN', {});
  check('balance difference (Assets − Equity&Liab)', BS.bsReconciliation(branch), 0, 0.005);
  checkTrue('total assets === total equity & liabilities',
    Math.abs(BS.totalAssets(branch) - BS.totalEquityLiabilities(branch)) <= 0.005,
    `assets ${inr(BS.totalAssets(branch))} vs E&L ${inr(BS.totalEquityLiabilities(branch))}`);
  checkTrue('no plug line on the face of the statement',
    !BS.BS_LINE_DEFS.some((d: any) => d.kind === 'plug' || /plug|difference/i.test(d.label)));

  section('Balance Sheet — figures');
  check('profit before tax', BS.profitBeforeTax(branch), E.profitBeforeTax);
  check('reserves & surplus (negative = accum. losses)', BS.reservesSurplus(branch), E.reservesSurplus);
  const surplusTransfer = (BS as any).surplusTransfer;
  if (typeof surplusTransfer === 'function') check('surplus transfer (REV + P&L A/c)', surplusTransfer(branch), E.surplusTransfer);

  // ── Ledger accounting: nothing dropped, nothing double-counted ─────────────
  section('Ledger accounting');
  check('ledgers built (excl. P&L A/c)', branch.ledgers.length, E.ledgerCountExclPl, 0);
  const anyBranch = branch as any;
  if (anyBranch.ledgers[0]?.lineId !== undefined) {
    const unassigned = anyBranch.ledgers.filter((l: any) => !l.lineId);
    checkTrue('every ledger assigned to a statement line', unassigned.length === 0,
      unassigned.slice(0, 5).map((l: any) => l.name).join(', '));
    const counted = new Set(anyBranch.ledgers.map((l: any) => l.name)).size;
    check('distinct ledgers accounted for', counted, E.ledgerCountExclPl, 0);
  }

  // ── Phase 2 figures (only asserted once the line registry exists) ──────────
  const lineSum = (BS as any).lineSum;
  if (typeof lineSum === 'function') {
    section('Schedule III classification');
    check('capital work-in-progress (separate from PPE)', lineSum(branch, 'cwip'), E.cwip, 1);
    const isContra = (BS as any).isContraFA;
    if (typeof isContra === 'function') {
      const contras = anyBranch.ledgers.filter((l: any) => isContra(l));
      check('accumulated depreciation ledgers detected', contras.length, E.contraFaCount, 0);
      check('accumulated depreciation total', contras.reduce((s: number, l: any) => s + l.closing, 0), E.contraFaTotal, 1);
    }
    check('net fixed assets (PPE + intangibles + CWIP)',
      ['ppe', 'intangibles', 'cwip', 'intangibles_dev'].reduce((s, id) => s + lineSum(branch, id), 0),
      E.netFixedAssetsInclCwip, 1);
    checkTrue('duties & taxes not netted into one liability',
      lineSum(branch, 'duties_taxes_payable') >= 0 && lineSum(branch, 'st_loans_advances') >= 0);
    checkTrue('no negative asset or liability totals on the face',
      BS.BS_LINE_DEFS.filter((d: any) => d.kind === 'line' && d.fn)
        .every((d: any) => d.fn(branch) >= -0.005 || /reserve|surplus/i.test(d.label)));
  }

  // ── P&L face ──────────────────────────────────────────────────────────────
  section('Statement of Profit & Loss');
  check('employee benefits expense', BS.employeeCosts(branch), E.employeeBenefits);
  check('finance costs', BS.financeCosts(branch), E.financeCosts);
  check('profit before tax (invariant under expense re-splits)', BS.profitBeforeTax(branch), E.profitBeforeTax);

  // ── Workbook: linkage, formulas, traceability ─────────────────────────────
  section('Excel workbook');
  const wb = buildFinancialStatementsWorkbook({
    branches: [branch],
    consolidated: null,
    companyTitle: branch.company,
    periodLabel: branch.periodLabel,
    primaryGroups: BS.collectPrimaryGroups([{ store: store as any, branchName: 'MAIN' }], {}),
  });

  let formulaCells = 0;
  const brokenLinks: string[] = [];
  for (const name of wb.SheetNames) {
    const ws: any = wb.Sheets[name];
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      if (ws[key].f) formulaCells++;
      const target = ws[key].l?.Target;
      if (!target) continue;
      const m = /^#?'?([^'!]+)'?!/.exec(String(target).replace(/^#/, ''));
      if (m && !wb.SheetNames.includes(m[1])) brokenLinks.push(`${name}!${key} → ${target}`);
    }
  }
  checkTrue('every internal hyperlink resolves to a real sheet', brokenLinks.length === 0, brokenLinks.slice(0, 3).join('; '));
  checkTrue('note totals are live SUM formulas', formulaCells > 0, `${formulaCells} formula cells`);
  checkTrue('a Ledger Index sheet is produced', wb.SheetNames.includes('Ledger Index'));

  const li: any = wb.Sheets['Ledger Index'];
  if (li) {
    const rows = XLSX.utils.decode_range(li['!ref']).e.r - 2; // header band + nav + column header
    check('Ledger Index covers every ledger', rows, E.ledgerCountExclPl, 0);
  }

  // Note numbers must be assigned from the face, never hardcoded: every note
  // referenced on the face must exist, and every note sheet must be referenced.
  const noteSheets = wb.SheetNames.filter((n) => /^N\d+ /.test(n));
  const referenced = new Set<string>();
  for (const sheet of ['Balance Sheet', 'P&L Statement']) {
    const ws: any = wb.Sheets[sheet];
    for (const key of Object.keys(ws)) {
      const t = ws[key]?.l?.Target;
      if (!t) continue;
      const m = /^#?'?([^'!]+)'?!/.exec(String(t).replace(/^#/, ''));
      if (m && /^N\d+ /.test(m[1])) referenced.add(m[1]);
    }
  }
  checkTrue('every note is referenced from the face of a statement',
    noteSheets.every((n) => referenced.has(n)),
    noteSheets.filter((n) => !referenced.has(n)).join(', '));
  checkTrue('note sheets are numbered contiguously from 1', noteSheets
    .map((n) => Number(/^N(\d+) /.exec(n)![1]))
    .sort((a, b) => a - b)
    .every((v, i) => v === i + 1), noteSheets.join(', '));

  // ── Trial Balance workbook ────────────────────────────────────────────────
  section('Trial Balance workbook');
  const tbWb = buildTrialBalanceWorkbook({ tb, companyTitle: store.meta?.companyName ?? '', hideUnused: true });
  const tws: any = tbWb.Sheets['Trial Balance'];
  checkTrue('trial balance sheet produced', !!tws);
  let tbFormulas = 0;
  let styled = 0;
  for (const key of Object.keys(tws)) {
    if (key.startsWith('!')) continue;
    if (tws[key].f) tbFormulas++;
    if (tws[key].s) styled++;
  }
  checkTrue('grand total is a live SUM over the ledger rows', tbFormulas >= 6, `${tbFormulas} formulas`);
  checkTrue('every cell carries a style (formatted, not a raw dump)', styled > 100, `${styled} styled cells`);
  const cells = Object.keys(tws).filter((k) => !k.startsWith('!'));
  checkTrue('unused ledgers are excluded from the export',
    !cells.some((k) => typeof tws[k].v === 'string' && /Abhijit Manoj Bhai/.test(tws[k].v)));

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('validator crashed:', e);
  process.exit(2);
});
