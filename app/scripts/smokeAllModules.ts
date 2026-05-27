/**
 * Smoke test for ALL modules whose compute can run headlessly.
 *
 * Drives the real import pipeline (zip -> TallyStore -> getLedgerEntries) then,
 * for each module, runs its actual backend:
 *   • Workers (party-matrix, orphan-P&L, related-party, TDS) — imported via a
 *     `self` shim so the module's real message handler runs unmodified.
 *   • Store queries (Trial Balance, Purchase ITC register).
 *   • Voucher reassembly used by VoucherBook / LedgerVoucher / ExceptionDensity.
 *
 * Reports a PASS/EMPTY/ERROR line per module so we can see what populates.
 *
 * Usage: npx tsx scripts/smokeAllModules.ts <zip>
 */
import { readFileSync } from 'node:fs';
import { TallyStore } from '../services/tally';
import { getTrialBalance, getPurchaseITCRegister } from '../services/tally/queries';
import type { LedgerEntry } from '../types';

// ── worker shim: capture the handler each worker registers on import ─────────
type MsgHandler = (e: { data: any }) => void;
let captured: MsgHandler | null = null;
let lastOutput: any = null;
(globalThis as any).self = {
  addEventListener: (_type: string, cb: MsgHandler) => { captured = cb; },
  postMessage: (x: any) => { lastOutput = x; },
};

async function runWorker(modPath: string, input: any): Promise<any> {
  captured = null;
  lastOutput = null;
  await import(modPath);                    // registers handler on the shim
  if (!captured) throw new Error(`worker ${modPath} did not register a handler`);
  (captured as MsgHandler)({ data: input });
  return lastOutput;
}

const isMaster = (e: LedgerEntry) => {
  const t = String(e?.is_master_ledger ?? '').trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'y';
};
const inr = (v: number) =>
  (v < 0 ? '-' : '') + Math.abs(Math.round(v)).toLocaleString('en-IN');

const results: { module: string; status: string; detail: string }[] = [];
const ok = (m: string, d: string) => results.push({ module: m, status: 'PASS', detail: d });
const empty = (m: string, d: string) => results.push({ module: m, status: 'EMPTY', detail: d });
const err = (m: string, d: string) => results.push({ module: m, status: 'ERROR', detail: d });

async function main() {
  const zip = process.argv[2];
  if (!zip) { console.error('Usage: npx tsx scripts/smokeAllModules.ts <zip>'); process.exit(1); }

  const store = await TallyStore.fromZip(new Blob([readFileSync(zip)]));
  const rows = store.getLedgerEntries();
  const txRows = rows.filter((r) => !isMaster(r));
  const mstRows = rows.filter((r) => isMaster(r));
  const allLedgers = Array.from(new Set(rows.map((r) => String(r.Ledger || '').trim()).filter(Boolean)));
  const ledgerPrimary = new Map<string, string>();
  for (const r of rows) {
    const l = String(r.Ledger || '').trim();
    if (l && !ledgerPrimary.has(l)) ledgerPrimary.set(l, String(r.TallyPrimary || '').trim());
  }
  const underDuties = (l: string) => /duties/i.test(ledgerPrimary.get(l) || '');
  const tdsLedgers = allLedgers.filter((l) => (/\btds\b|194/i.test(l)) && underDuties(l));
  const gstLedgers = allLedgers.filter((l) => /(igst|cgst|sgst|utgst|gst|cess)/i.test(l) && underDuties(l));
  const rcmLedgers = allLedgers.filter((l) => /(rcm|reverse charge)/i.test(l));

  console.log(`\nStore: ${rows.length} rows  (tx ${txRows.length} / master ${mstRows.length})`);
  console.log(`Tax ledgers — TDS ${tdsLedgers.length} · GST ${gstLedgers.length} · RCM ${rcmLedgers.length}\n`);

  // ── 1. Voucher reassembly (PartyMatrix / VoucherBook / LedgerVoucher / ExceptionDensity) ──
  try {
    const key = (g: string) => (g && !g.startsWith('ledger-master-') ? g.replace(/-\d+$/, '') : g);
    const groups = new Map<string, number>();
    txRows.forEach((r) => { const k = key(String(r.guid || '')); groups.set(k, (groups.get(k) || 0) + 1); });
    const sizes = [...groups.values()];
    const multi = sizes.filter((s) => s > 1).length;
    const detail = `${groups.size} vouchers, ${multi} multi-line (${((multi / groups.size) * 100).toFixed(0)}%)`;
    if (multi > 0) ok('Voucher reassembly (4 modules)', detail);
    else empty('Voucher reassembly (4 modules)', detail + ' — legs not grouping!');
  } catch (e: any) { err('Voucher reassembly', e.message); }

  // ── 2. Party Ledger Matrix worker ──
  try {
    const out = await runWorker('../workers/partyMatrixWorker.ts',
      { txRows, mstRows, primary: 'Sundry Debtors', tdsLedgers, gstLedgers, rcmLedgers });
    const sales = out.rows.reduce((s: number, r: any) => s + r.totalSales, 0);
    const active = out.rows.filter((r: any) => Math.abs(r.totalSales) > 1 || Math.abs(r.others) > 1).length;
    if (out.error) err('Party Ledger Matrix', out.error);
    else if (active > 0) ok('Party Ledger Matrix', `Sundry Debtors: ${active} active, sales ${inr(sales)}`);
    else empty('Party Ledger Matrix', 'no active parties');
  } catch (e: any) { err('Party Ledger Matrix', e.message); }

  // ── 3. Orphan P&L Vouchers worker ──
  try {
    const filters = { fromDate: null, toDate: null, voucherTypeFilter: 'all', plBucketFilter: 'all',
      routedBucketFilter: 'all', minAmount: 0, hideCashBankOnly: false, search: '' };
    const out = await runWorker('../workers/orphanPLWorker.ts', { rows: txRows, filters });
    const d = `scanned ${out.stats.totalVouchersScanned}, flagged ${out.stats.totalFlagged}, ₹${inr(out.stats.totalOrphanAmount)}`;
    if (out.stats.totalVouchersScanned > 0) ok('Orphan P&L Vouchers', d);
    else empty('Orphan P&L Vouchers', d);
  } catch (e: any) { err('Orphan P&L Vouchers', e.message); }

  // ── 4. Related Party worker (no tags -> RPT requires user tagging; verify it runs) ──
  try {
    const thresholds = { materialityRupees: 0, yearEndDays: 7, roundAmountUnit: 100000, section188TurnoverPct: 10, annualTurnover: 0 };
    const out = await runWorker('../workers/relatedPartyWorker.ts',
      { txRows, mstRows, parties: {}, ledgerTxType: {}, thresholds });
    if (out.error) err('Related Party Analysis', out.error);
    else ok('Related Party Analysis', `universe ${out.partyUniverseCount}, unbalanced vch ${out.unbalancedVoucherCount} (RPT needs party tagging)`);
  } catch (e: any) { err('Related Party Analysis', e.message); }

  // ── 5. TDS worker (build raw rows like the component) ──
  try {
    const taxSet = new Set(tdsLedgers);
    const isExpense = (e: LedgerEntry) => /expense|purchase/i.test(String(e.TallyPrimary || ''));
    const vmap = new Map<string, LedgerEntry[]>();
    txRows.forEach((e) => {
      const k = `${String(e.voucher_number || e.invoice_number || 'UNKNOWN').trim()}__${String(e.date || '')}__${String(e.voucher_type || '')}`;
      (vmap.get(k) || vmap.set(k, []).get(k)!).push(e);
    });
    const raw: any[] = [];
    vmap.forEach((entries) => {
      const tds = entries.filter((e) => taxSet.has(String(e.Ledger || '')));
      const totalTds = Math.abs(tds.reduce((s, e) => s + Number(e.amount || 0), 0));
      const tdsNames = Array.from(new Set(tds.map((e) => String(e.Ledger || '').trim()))).join('||');
      const party = entries.find((e) => e.party_name)?.party_name || '';
      const expMap = new Map<string, number>();
      entries.forEach((e) => { if (isExpense(e)) expMap.set(String(e.Ledger || ''), (expMap.get(String(e.Ledger || '')) || 0) + Number(e.amount || 0)); });
      expMap.forEach((amt, led) => raw.push({ voucher_number: '', date: '', voucher_type: '', expense_ledger: led, net_amount: amt, party_name: party, narration: '', total_tds: totalTds, tds_ledger_names: tdsNames }));
    });
    const filters = { viewMode: 'ledger', minVoucherAmount: 0, minLedgerAmount: 0, statusFilter: 'all', rateFilter: 'all' };
    const out = await runWorker('../workers/tdsWorker.ts', { rows: raw, thresholdConfig: { enabled: false, sectionMappings: [] }, filters });
    const groups = out.groups?.length || 0;
    const tdsTotal = (out.groups || []).reduce((s: number, g: any) => s + g.totalTDS, 0);
    if (groups > 0) ok('TDS Analysis', `${groups} expense ledgers, TDS ₹${inr(tdsTotal)} (raw rows ${raw.length})`);
    else empty('TDS Analysis', `no expense ledgers (raw rows ${raw.length})`);
  } catch (e: any) { err('TDS Analysis', e.message); }

  // ── 6. Trial Balance query ──
  try {
    const tb = getTrialBalance(store);
    const n = (tb as any).rows?.length ?? (tb as any).nodes?.length ?? 0;
    ok('Trial Balance', `result keys: ${Object.keys(tb as any).join(', ')}`);
  } catch (e: any) { err('Trial Balance', e.message); }

  // ── 7. Purchase ITC register query (Purchase GST Register / ITC-3B) ──
  try {
    const itc = getPurchaseITCRegister(store);
    if (itc.length > 0) ok('Purchase ITC Register', `${itc.length} rows`);
    else empty('Purchase ITC Register', '0 rows');
  } catch (e: any) { err('Purchase ITC Register', e.message); }

  // ── 8. Data-presence sanity for component-only modules ──
  const vt = new Map<string, number>();
  txRows.forEach((r) => vt.set(String(r.voucher_type || ''), (vt.get(String(r.voucher_type || '')) || 0) + 1));
  const has = (re: RegExp) => [...vt.entries()].filter(([k]) => re.test(k)).reduce((s, [, n]) => s + n, 0);
  console.log('Voucher types present:');
  [...vt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`   ${String(n).padStart(5)}  ${k}`));
  console.log('');

  // ── report ──
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(pad('MODULE', 34) + pad('STATUS', 8) + 'DETAIL');
  console.log('-'.repeat(100));
  for (const r of results) console.log(pad(r.module, 34) + pad(r.status, 8) + r.detail);
  console.log('');
  const counts = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {} as Record<string, number>);
  console.log(`Summary: ${JSON.stringify(counts)}`);
}

main().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });
