/**
 * Self-check for the Cash Flow workbook builder.
 *
 * Builds the workbook from a small hand-made model, writes it through the same
 * write + polishXlsx path the UI uses, and asserts the things that actually
 * break silently: every sheet present, the statement casts (activity subtotals
 * and the closing line), styles survive the write, and freeze panes really
 * land in the XML (xlsx-js-style drops them; polishXlsx splices them back).
 *
 * Usage: npx tsx scripts/validateCashFlowExcel.ts [out.xlsx]
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import XLSX from 'xlsx-js-style';
import { SHEETS, buildCashFlowWorkbook, cashFlowSheetPolish, type CashFlowExcelInput } from '../services/cashFlowExcel';
import { polishXlsx } from '../services/xlsxPolish';

const input: CashFlowExcelInput = {
  companyTitle: 'Demo Trading Private Limited',
  fromDate: '01-04-2025',
  toDate: '31-03-2026',
  cashLedgers: ['Cash-in-Hand', 'HDFC Bank 1234'],
  filters: { search: '', direction: 'all', minAmount: '' },
  statement: {
    buckets: [
      { activity: 'Operating', bucket: 'Sundry Debtors', inflow: 1_00_000, outflow: 0, net: 1_00_000 },
      { activity: 'Operating', bucket: 'Sundry Creditors', inflow: 0, outflow: 60_000, net: -60_000 },
      { activity: 'Investing', bucket: 'Fixed Assets', inflow: 0, outflow: 25_000, net: -25_000 },
      { activity: 'Financing', bucket: 'Secured Loans', inflow: 50_000, outflow: 15_000, net: 35_000 },
    ],
    byActivity: {
      Operating: { inflow: 1_00_000, outflow: 60_000, net: 40_000 },
      Investing: { inflow: 0, outflow: 25_000, net: -25_000 },
      Financing: { inflow: 50_000, outflow: 15_000, net: 35_000 },
    },
    adjustmentNet: 0,
    opening: 20_000,
    movement: 50_000,
    closing: 70_000,
  },
  cashPosition: {
    opening: 20_000, periodMovement: 50_000, closing: 70_000,
    referenceClosing: 70_000, reconciliationDiff: 0,
  },
  cashLedgerDetail: [
    { ledger: 'Cash-in-Hand', opening: 5_000, inflow: 40_000, outflow: 30_000, netMovement: 10_000, closing: 15_000, referenceClosing: 15_000, diff: 0 },
    { ledger: 'HDFC Bank 1234', opening: 15_000, inflow: 1_10_000, outflow: 70_000, netMovement: 40_000, closing: 55_000, referenceClosing: 55_000, diff: 0 },
  ],
  ledgerDetailRows: [
    { label: 'Sundry Debtors', activity: 'Operating', classificationRule: 'PRIMARY_GROUP', primary: 'Sundry Debtors', parent: 'Current Assets', inflow: 1_00_000, outflow: 0, net: 1_00_000, inflowShare: 66.7, outflowShare: 0, vouchers: 12 },
    { label: 'Sundry Creditors', activity: 'Operating', classificationRule: 'PRIMARY_GROUP', primary: 'Sundry Creditors', parent: 'Current Liabilities', inflow: 0, outflow: 60_000, net: -60_000, inflowShare: 0, outflowShare: 60, vouchers: 9 },
    { label: 'Plant & Machinery', activity: 'Investing', classificationRule: 'PRIMARY_GROUP', primary: 'Fixed Assets', parent: 'Fixed Assets', inflow: 0, outflow: 25_000, net: -25_000, inflowShare: 0, outflowShare: 25, vouchers: 2 },
    { label: 'HDFC Term Loan', activity: 'Financing', classificationRule: 'PRIMARY_GROUP', primary: 'Secured Loans', parent: 'Loans (Liability)', inflow: 50_000, outflow: 15_000, net: 35_000, inflowShare: 33.3, outflowShare: 15, vouchers: 4 },
  ],
  primaryRows: [
    { label: 'Sundry Debtors', inflow: 1_00_000, outflow: 0, net: 1_00_000, vouchers: 12 },
    { label: 'Sundry Creditors', inflow: 0, outflow: 60_000, net: -60_000, vouchers: 9 },
    { label: 'Fixed Assets', inflow: 0, outflow: 25_000, net: -25_000, vouchers: 2 },
    { label: 'Secured Loans', inflow: 50_000, outflow: 15_000, net: 35_000, vouchers: 4 },
  ],
  monthlySeries: [
    { monthLabel: 'Apr 2025', inflow: 60_000, outflow: 40_000 },
    { monthLabel: 'May 2025', inflow: 90_000, outflow: 60_000 },
  ],
  totals: { inflow: 1_50_000, outflow: 1_00_000, net: 50_000, voucherCount: 27, visibleRows: 4, blockedCapitalOutflow: 0 },
};

const cellAt = (ws: XLSX.WorkSheet, addr: string) => ws[addr] as any;

const run = async () => {
  const wb = buildCashFlowWorkbook(input);

  // 1. Every sheet the index links to must exist, in order.
  const expected = [SHEETS.cover, SHEETS.statement, SHEETS.cashLedgers, SHEETS.ledgerSummary,
    SHEETS.activity, SHEETS.monthly, SHEETS.basis];
  assert.deepEqual(wb.SheetNames, expected, 'sheet names / order changed');

  // 2. The statement must cast: closing = opening + movement, and the movement
  //    line must be a real formula (not a frozen number).
  const st = wb.Sheets[SHEETS.statement];
  const closingCell = Object.keys(st)
    .filter((k) => /^A\d+$/.test(k))
    .map((k) => ({ k, v: String((st[k] as any).v ?? '') }))
    .find((c) => c.v.startsWith('CLOSING CASH'));
  assert.ok(closingCell, 'closing line missing from the statement');
  const closingRow = Number(closingCell!.k.slice(1));
  const closing = cellAt(st, `D${closingRow}`);
  assert.ok(closing.f, 'closing cash must be a live formula');
  assert.equal(closing.v, input.statement.closing, 'cached closing does not agree with the model');
  assert.equal(closing.v, input.statement.opening + input.statement.movement, 'statement does not cast');

  // 3. Activity subtotals must be SUM formulas over their bucket rows.
  const subtotals = Object.keys(st)
    .filter((k) => /^D\d+$/.test(k))
    .map((k) => cellAt(st, k))
    .filter((c) => typeof c?.f === 'string' && c.f.startsWith('SUM('));
  assert.ok(subtotals.length >= 3, 'expected a SUM subtotal per activity');
  assert.equal(
    subtotals.slice(0, 3).reduce((sum: number, c: any) => sum + c.v, 0),
    input.statement.byActivity.Operating.net + input.statement.byActivity.Investing.net + input.statement.byActivity.Financing.net,
    'activity subtotals do not agree with the model',
  );

  // 4. Styling actually attached (a plain json_to_sheet dump has no .s).
  assert.ok(cellAt(st, 'A1').s?.fill, 'title band lost its fill');
  assert.ok(st['!cols']?.length, 'column widths missing');
  assert.ok(st['!merges']?.length, 'title band merges missing');

  // 5. Number formats present on the figure columns.
  const anyFigure = cellAt(wb.Sheets[SHEETS.cashLedgers], 'B7');
  assert.ok(anyFigure?.z || anyFigure?.s?.numFmt, 'cash ledger figures carry no number format');

  // 6. Freeze panes only exist after polishXlsx — assert on the final bytes.
  const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true }) as ArrayBuffer;
  const polished = await polishXlsx(raw, cashFlowSheetPolish(),
    { showGridLines: false, landscape: true, fitToWidth: true });
  const zip = await JSZip.loadAsync(polished);
  const sheetXmls = await Promise.all(
    Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
      .map((f) => zip.file(f)!.async('string')),
  );
  const frozen = sheetXmls.filter((x) => x.includes('state="frozen"')).length;
  assert.equal(frozen, Object.keys(cashFlowSheetPolish()).length, 'freeze panes did not survive the write');
  assert.ok(sheetXmls.every((x) => x.includes('showGridLines="0"')), 'gridlines not turned off');
  assert.ok(sheetXmls.every((x) => x.includes('orientation="landscape"')), 'page setup missing');

  const out = process.argv[2];
  if (out) {
    writeFileSync(out, Buffer.from(polished));
    console.log(`wrote ${out}`);
  }
  console.log('Cash Flow workbook: all checks passed.');
};

run().catch((e) => { console.error(e); process.exit(1); });
