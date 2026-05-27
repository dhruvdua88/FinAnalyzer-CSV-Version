// In-memory relational store backing the entire app. Built from a Tally
// XLSX export ZIP. Modules can read tables directly via the typed Maps/
// arrays exposed below, or call one of the pre-built query views.
//
// The `getLedgerEntries()` method produces the legacy flat-row shape the
// existing audit modules consume — so day-one migration is zero-risk.

import { nameKey } from './helpers';
import type {
  Voucher, AccountingLine, Ledger, Group, VoucherType,
  StockItem, StockGroup, Uom, Godown,
  GstEffectiveRate, InventoryLine, BatchLine, BillRef, InventoryAdditionalCost,
  CostCategory, CostCentre, Employee, PayheadMaster, CostAllocation,
  Attendance, BankAllocation, ClosingStockLedger,
  OpeningBatchAllocation, OpeningBillAllocation, AttendanceType,
  StockCategory, StockitemStandardCost, StockitemStandardPrice,
  ExportMeta,
} from './types';
import {
  parseVoucher, parseAccountingLine, parseLedger, parseGroup, parseVoucherType,
  parseStockItem, parseStockGroup, parseUom, parseGodown,
  parseGstEffectiveRate, parseInventoryLine, parseBatchLine, parseBillRef,
  parseInventoryAdditionalCost, parseCostCategory, parseCostCentre,
  parseEmployee, parsePayhead, parseCostAllocation, parseAttendance,
  parseBankAllocation, parseClosingStockLedger,
  parseOpeningBatchAllocation, parseOpeningBillAllocation,
  parseAttendanceType, parseStockCategory,
  parseStockitemStandardCost, parseStockitemStandardPrice,
  parseExportMeta,
} from './tableParsers';
import { unzipTallyExport, type RawTables, type UnzipResult } from './unzip';
import type { LedgerEntry } from '../../types';

const MASTER_VOUCHER_TYPE = '__MASTER_LEDGER__';

const sortByLine = <T extends { line_no?: number }>(rows: T[]): T[] =>
  rows.slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));

export class TallyStore {
  // ── Masters ─────────────────────────────────────────────────────────────
  readonly meta: ExportMeta;
  readonly ledgers = new Map<string, Ledger>();       // key: nameKey(name)
  readonly groups = new Map<string, Group>();         // key: nameKey(name)
  readonly voucherTypes = new Map<string, VoucherType>();
  readonly stockItems = new Map<string, StockItem>();
  readonly stockGroups = new Map<string, StockGroup>();
  readonly uoms = new Map<string, Uom>();
  readonly godowns = new Map<string, Godown>();
  readonly costCategories = new Map<string, CostCategory>();
  readonly costCentres = new Map<string, CostCentre>();
  readonly employees = new Map<string, Employee>();
  readonly payheads = new Map<string, PayheadMaster>();
  readonly attendanceTypes = new Map<string, AttendanceType>();
  readonly stockCategories = new Map<string, StockCategory>();
  readonly gstEffectiveRates: GstEffectiveRate[] = [];
  readonly stockitemStandardCosts: StockitemStandardCost[] = [];
  readonly stockitemStandardPrices: StockitemStandardPrice[] = [];
  readonly openingBatchAllocations: OpeningBatchAllocation[] = [];
  readonly openingBillAllocations: OpeningBillAllocation[] = [];

  // ── Transactions ────────────────────────────────────────────────────────
  readonly vouchers = new Map<string, Voucher>();     // key: guid
  readonly accountingLines: AccountingLine[] = [];
  readonly inventoryLines: InventoryLine[] = [];
  readonly batchLines: BatchLine[] = [];
  readonly billRefs: BillRef[] = [];
  readonly inventoryAdditionalCosts: InventoryAdditionalCost[] = [];
  readonly costAllocations: CostAllocation[] = [];
  readonly inventoryCostAllocations: CostAllocation[] = [];
  readonly costCategoryCentreAllocations: CostAllocation[] = [];
  readonly attendance: Attendance[] = [];
  readonly bankAllocations: BankAllocation[] = [];
  readonly closingStockLedgers: ClosingStockLedger[] = [];

  // ── Indexes (built lazily on first access) ──────────────────────────────
  private _accByVoucher?: Map<string, AccountingLine[]>;
  private _invByVoucher?: Map<string, InventoryLine[]>;
  private _batchesByVoucher?: Map<string, BatchLine[]>;
  private _billsByVoucher?: Map<string, BillRef[]>;
  private _ratesByItem?: Map<string, GstEffectiveRate[]>;
  private _stockItemsByGuid?: Map<string, StockItem>;
  private _ledgersByGuid?: Map<string, Ledger>;
  private _ledgerEntriesCache?: LedgerEntry[];

  // ── Diagnostics (kept so the UI can surface "read 21 vouchers, 82 lines") ──
  readonly diagnostics: {
    fileList: string[];
    tableCounts: Record<string, number>;
    readmeText: string;
  };

  private constructor(raw: UnzipResult) {
    this.meta = parseExportMeta(raw.tables.get('config') || []);
    this.diagnostics = {
      fileList: raw.fileList,
      tableCounts: {},
      readmeText: raw.readmeText,
    };
    this.ingest(raw.tables);
    for (const [k, v] of raw.tables.entries()) this.diagnostics.tableCounts[k] = v.length;
  }

  static async fromZip(file: File | Blob): Promise<TallyStore> {
    const raw = await unzipTallyExport(file);
    return new TallyStore(raw);
  }

  // ── Ingestion ───────────────────────────────────────────────────────────
  private ingest(tables: RawTables) {
    for (const row of tables.get('mst_group') || []) {
      const g = parseGroup(row);
      if (g.name) this.groups.set(nameKey(g.name), g);
    }
    for (const row of tables.get('mst_ledger') || []) {
      const l = parseLedger(row);
      if (l.name) this.ledgers.set(nameKey(l.name), l);
    }
    for (const row of tables.get('mst_vouchertype') || []) {
      const v = parseVoucherType(row);
      if (v.name) this.voucherTypes.set(nameKey(v.name), v);
    }
    for (const row of tables.get('mst_stock_group') || []) {
      const g = parseStockGroup(row);
      if (g.name) this.stockGroups.set(nameKey(g.name), g);
    }
    for (const row of tables.get('mst_stock_item') || []) {
      const s = parseStockItem(row);
      if (s.name) this.stockItems.set(nameKey(s.name), s);
    }
    for (const row of tables.get('mst_uom') || []) {
      const u = parseUom(row);
      if (u.name) this.uoms.set(nameKey(u.name), u);
    }
    for (const row of tables.get('mst_godown') || []) {
      const g = parseGodown(row);
      if (g.name) this.godowns.set(nameKey(g.name), g);
    }
    for (const row of tables.get('mst_cost_category') || []) {
      const c = parseCostCategory(row);
      if (c.name) this.costCategories.set(nameKey(c.name), c);
    }
    for (const row of tables.get('mst_cost_centre') || []) {
      const c = parseCostCentre(row);
      if (c.name) this.costCentres.set(nameKey(c.name), c);
    }
    for (const row of tables.get('mst_employee') || []) {
      const e = parseEmployee(row);
      if (e.name) this.employees.set(nameKey(e.name), e);
    }
    for (const row of tables.get('mst_payhead') || []) {
      const p = parsePayhead(row);
      if (p.name) this.payheads.set(nameKey(p.name), p);
    }
    for (const row of tables.get('mst_attendance_type') || []) {
      const a = parseAttendanceType(row);
      if (a.name) this.attendanceTypes.set(nameKey(a.name), a);
    }
    for (const row of tables.get('mst_stock_category') || []) {
      const s = parseStockCategory(row);
      if (s.name) this.stockCategories.set(nameKey(s.name), s);
    }
    for (const row of tables.get('mst_gst_effective_rate') || []) {
      this.gstEffectiveRates.push(parseGstEffectiveRate(row));
    }
    for (const row of tables.get('mst_stockitem_standard_cost') || []) {
      this.stockitemStandardCosts.push(parseStockitemStandardCost(row));
    }
    for (const row of tables.get('mst_stockitem_standard_price') || []) {
      this.stockitemStandardPrices.push(parseStockitemStandardPrice(row));
    }
    for (const row of tables.get('mst_opening_batch_allocation') || []) {
      this.openingBatchAllocations.push(parseOpeningBatchAllocation(row));
    }
    for (const row of tables.get('mst_opening_bill_allocation') || []) {
      this.openingBillAllocations.push(parseOpeningBillAllocation(row));
    }

    for (const row of tables.get('trn_voucher') || []) {
      const v = parseVoucher(row);
      if (v.guid) this.vouchers.set(v.guid, v);
    }

    // Accounting lines need a per-voucher line_no. Group rows by guid and
    // assign 0..n in source order so downstream views can render lines in
    // the same order Tally printed them.
    const accCounters = new Map<string, number>();
    for (const row of tables.get('trn_accounting') || []) {
      const guid = String(row.guid || '');
      const lineNo = accCounters.get(guid) || 0;
      accCounters.set(guid, lineNo + 1);
      this.accountingLines.push(parseAccountingLine(row, lineNo));
    }

    const invCounters = new Map<string, number>();
    for (const row of tables.get('trn_inventory') || []) {
      const guid = String(row.guid || '');
      const lineNo = invCounters.get(guid) || 0;
      invCounters.set(guid, lineNo + 1);
      this.inventoryLines.push(parseInventoryLine(row, lineNo));
    }

    for (const row of tables.get('trn_batch') || []) {
      this.batchLines.push(parseBatchLine(row));
    }
    for (const row of tables.get('trn_bill') || []) {
      this.billRefs.push(parseBillRef(row));
    }
    for (const row of tables.get('trn_inventory_additional_cost') || []) {
      this.inventoryAdditionalCosts.push(parseInventoryAdditionalCost(row));
    }
    for (const row of tables.get('trn_cost_centre') || []) {
      this.costAllocations.push(parseCostAllocation(row));
    }
    for (const row of tables.get('trn_cost_inventory_category_centre') || []) {
      this.inventoryCostAllocations.push(parseCostAllocation(row));
    }
    for (const row of tables.get('trn_cost_category_centre') || []) {
      this.costCategoryCentreAllocations.push(parseCostAllocation(row));
    }
    for (const row of tables.get('trn_attendance') || []) {
      this.attendance.push(parseAttendance(row));
    }
    for (const row of tables.get('trn_bank') || []) {
      this.bankAllocations.push(parseBankAllocation(row));
    }
    for (const row of tables.get('trn_closingstock_ledger') || []) {
      this.closingStockLedgers.push(parseClosingStockLedger(row));
    }
  }

  // ── Lookups ─────────────────────────────────────────────────────────────
  ledger(name: string): Ledger | undefined {
    return this.ledgers.get(nameKey(name));
  }
  group(name: string): Group | undefined {
    return this.groups.get(nameKey(name));
  }
  stockItem(name: string): StockItem | undefined {
    return this.stockItems.get(nameKey(name));
  }
  voucherType(name: string): VoucherType | undefined {
    return this.voucherTypes.get(nameKey(name));
  }
  voucher(guid: string): Voucher | undefined {
    return this.vouchers.get(guid);
  }

  // Resolve the primary-group of a ledger by walking parent chains. We don't
  // store this redundantly; mst_group already carries primary_group directly
  // for each group row, so we just look up the ledger's parent and read it.
  primaryGroupFor(ledgerName: string): string {
    const ledger = this.ledger(ledgerName);
    if (!ledger) return '';
    const group = this.group(ledger.parent);
    return group?.primary_group || ledger.parent;
  }

  accountingLinesFor(voucherGuid: string): AccountingLine[] {
    if (!this._accByVoucher) {
      this._accByVoucher = new Map();
      for (const line of this.accountingLines) {
        const list = this._accByVoucher.get(line.guid);
        if (list) list.push(line); else this._accByVoucher.set(line.guid, [line]);
      }
      for (const list of this._accByVoucher.values()) list.sort((a, b) => a.line_no - b.line_no);
    }
    return this._accByVoucher.get(voucherGuid) || [];
  }

  inventoryLinesFor(voucherGuid: string): InventoryLine[] {
    if (!this._invByVoucher) {
      this._invByVoucher = new Map();
      for (const line of this.inventoryLines) {
        const list = this._invByVoucher.get(line.guid);
        if (list) list.push(line); else this._invByVoucher.set(line.guid, [line]);
      }
      for (const list of this._invByVoucher.values()) list.sort((a, b) => a.line_no - b.line_no);
    }
    return this._invByVoucher.get(voucherGuid) || [];
  }

  batchLinesFor(voucherGuid: string): BatchLine[] {
    if (!this._batchesByVoucher) {
      this._batchesByVoucher = new Map();
      for (const b of this.batchLines) {
        const list = this._batchesByVoucher.get(b.guid);
        if (list) list.push(b); else this._batchesByVoucher.set(b.guid, [b]);
      }
    }
    return this._batchesByVoucher.get(voucherGuid) || [];
  }

  billRefsFor(voucherGuid: string): BillRef[] {
    if (!this._billsByVoucher) {
      this._billsByVoucher = new Map();
      for (const b of this.billRefs) {
        const list = this._billsByVoucher.get(b.guid);
        if (list) list.push(b); else this._billsByVoucher.set(b.guid, [b]);
      }
    }
    return this._billsByVoucher.get(voucherGuid) || [];
  }

  // GST effective rate for an item as of a particular date. Returns the most
  // recent row whose applicable_from ≤ date, or undefined if no rate is on
  // file. Duty-head-agnostic — caller filters if needed.
  gstRateAt(itemName: string, isoDate: string): GstEffectiveRate | undefined {
    if (!this._ratesByItem) {
      this._ratesByItem = new Map();
      for (const r of this.gstEffectiveRates) {
        const k = nameKey(r.item);
        const list = this._ratesByItem.get(k);
        if (list) list.push(r); else this._ratesByItem.set(k, [r]);
      }
      for (const list of this._ratesByItem.values()) {
        list.sort((a, b) => a.applicable_from.localeCompare(b.applicable_from));
      }
    }
    const rows = this._ratesByItem.get(nameKey(itemName));
    if (!rows) return undefined;
    let best: GstEffectiveRate | undefined;
    for (const r of rows) {
      if (r.applicable_from && r.applicable_from > isoDate) break;
      best = r;
    }
    return best;
  }

  // Headline GST percentage for an item as of a date, derived from
  // mst_gst_effective_rate. Unlike gstRateAt() (which is duty-head-agnostic),
  // this resolves the *effective* slab: the IGST row's rate, or CGST + SGST
  // when IGST isn't on file. Returns undefined when the item has no rate rows.
  // Used to back-fill the per-line gst_rate when mst_stock_item leaves it blank.
  gstHeadlineRateAt(itemName: string, isoDate: string): number | undefined {
    if (!this._ratesByItem) this.gstRateAt(itemName, isoDate); // build index
    const rows = this._ratesByItem!.get(nameKey(itemName));
    if (!rows || rows.length === 0) return undefined;

    // Latest applicable_from that is on/before the voucher date (fall back to
    // the earliest slab if every row post-dates it — better than nothing).
    let asOf = '';
    for (const r of rows) {
      if (r.applicable_from && r.applicable_from > isoDate) break;
      asOf = r.applicable_from;
    }
    const slab = rows.filter((r) => r.applicable_from === asOf);
    const effective = slab.length ? slab : rows;

    const rateOf = (head: RegExp) => {
      const row = effective.find((r) => head.test((r.duty_head || '').toUpperCase()));
      return row ? row.rate : 0;
    };
    const igst = rateOf(/IGST/);
    if (igst > 0) return igst;
    const cgst = rateOf(/CGST/);
    const sgst = rateOf(/SGST|UTGST/);
    const sum = cgst + sgst;
    return sum > 0 ? sum : undefined;
  }

  // ── Legacy shim ─────────────────────────────────────────────────────────
  // Produces the flat-row LedgerEntry[] that every existing module reads.
  // Two row classes are emitted:
  //
  //   1. Transaction rows — one per accounting line on an `is_accounting_voucher`
  //      voucher. Joins voucher header + ledger + group.
  //   2. Master-ledger rows — one per ledger that has no transaction in the
  //      period, so opening/closing balances still surface in Trial Balance.
  //
  // Optional enrichment fields (HSN, GST rate, PAN, place_of_supply, etc.)
  // are populated when present so modules that opt-in can read them, but
  // they don't break modules that ignore them.
  getLedgerEntries(): LedgerEntry[] {
    if (this._ledgerEntriesCache) return this._ledgerEntriesCache;

    const rows: LedgerEntry[] = [];
    const seenLedgers = new Set<string>();
    const now = Date.now();

    let txIndex = 0;
    for (const voucher of this.vouchers.values()) {
      if (!voucher.is_accounting_voucher) continue;
      const lines = this.accountingLinesFor(voucher.guid);
      if (lines.length === 0) continue;

      for (const line of lines) {
        const ledger = this.ledger(line.ledger);
        const group = ledger ? this.group(ledger.parent) : undefined;
        const groupName = ledger?.parent || '';
        const primary = group?.primary_group || groupName;

        // For sales/purchase invoices, the inventory line gives us the
        // matching stock item — useful for HSN / GST rate enrichment.
        const inventory = this.inventoryLinesFor(voucher.guid);
        const firstInvItem = inventory[0]?.item || '';
        const stock = firstInvItem ? this.stockItem(firstInvItem) : undefined;

        // mst_stock_item.gst_rate is frequently blank/0 in Tally exports; the
        // mst_gst_effective_rate master carries the real HSN-level slab. Use it
        // to back-fill rate and HSN so downstream GST modules see the rate the
        // item is actually taxed at, not a placeholder 0.
        let gstRate = stock?.gst_rate ?? 0;
        let gstHsn = stock?.gst_hsn_code || '';
        if (firstInvItem && (!gstRate || !gstHsn)) {
          if (!gstRate) {
            const eff = this.gstHeadlineRateAt(firstInvItem, voucher.date);
            if (eff) gstRate = eff;
          }
          if (!gstHsn) {
            const effRow = this.gstRateAt(firstInvItem, voucher.date);
            if (effRow?.hsn_code) gstHsn = effRow.hsn_code;
          }
        }

        const billRefs = this.billRefsFor(voucher.guid).filter(
          (b) => nameKey(b.ledger) === nameKey(line.ledger),
        );

        seenLedgers.add(nameKey(line.ledger));

        rows.push({
          guid: `${voucher.guid}-${line.line_no}-${txIndex++}`,
          date: voucher.date,
          voucher_type: voucher.voucher_type,
          voucher_number: voucher.voucher_number || `UNKNOWN-${txIndex}`,
          invoice_number: voucher.reference_number,
          reference_number: voucher.reference_number,
          narration: voucher.narration,
          party_name: voucher.party_name,
          gstin: ledger?.gstn || '',
          Ledger: line.ledger,
          amount: line.amount,
          Group: groupName,
          opening_balance: ledger?.opening_balance ?? 0,
          closing_balance: ledger?.closing_balance ?? 0,
          TallyParent: groupName,
          TallyPrimary: primary,
          is_revenue: ledger?.is_revenue ? 1 : 0,
          is_accounting_voucher: 1,
          is_master_ledger: 0,

          // Enrichment — optional fields. Existing modules ignore these;
          // new/migrated modules can read them.
          gst_hsn_code: gstHsn,
          gst_rate: gstRate,
          gst_taxability: stock?.gst_taxability || '',
          pan: ledger?.it_pan || '',
          gst_registration_type: ledger?.gst_registration_type || '',
          mailing_state: ledger?.mailing_state || '',
          place_of_supply: voucher.place_of_supply || '',
          reference_date: voucher.reference_date || '',
          bill_reference: billRefs.map((b) => b.name).filter(Boolean).join(' | '),
          bill_credit_period: ledger?.bill_credit_period ?? 0,
          is_invoice: voucher.is_invoice ? 1 : 0,
        } as LedgerEntry);
      }
    }

    // Emit a master row for every ledger that didn't appear in a transaction
    // so Trial Balance / Ageing keep their opening/closing balances visible.
    let masterIndex = 0;
    for (const ledger of this.ledgers.values()) {
      const key = nameKey(ledger.name);
      if (seenLedgers.has(key)) continue;
      const group = this.group(ledger.parent);
      rows.push({
        guid: `ledger-master-${now}-${masterIndex}`,
        date: '',
        voucher_type: MASTER_VOUCHER_TYPE,
        voucher_number: `${MASTER_VOUCHER_TYPE}${masterIndex + 1}`,
        invoice_number: '',
        reference_number: '',
        narration: 'Ledger master balance row',
        party_name: '',
        gstin: ledger.gstn,
        Ledger: ledger.name,
        amount: 0,
        Group: ledger.parent,
        opening_balance: ledger.opening_balance,
        closing_balance: ledger.closing_balance,
        TallyParent: ledger.parent,
        TallyPrimary: group?.primary_group || ledger.parent,
        is_revenue: ledger.is_revenue ? 1 : 0,
        is_accounting_voucher: 1,
        is_master_ledger: 1,
        pan: ledger.it_pan || '',
        gst_registration_type: ledger.gst_registration_type || '',
        mailing_state: ledger.mailing_state || '',
        bill_credit_period: ledger.bill_credit_period || 0,
      } as LedgerEntry);
      masterIndex++;
    }

    this._ledgerEntriesCache = rows;
    return rows;
  }

  // Coarse-grained summary for the dashboard banner.
  summary() {
    let minDate = '';
    let maxDate = '';
    const voucherSet = new Set<string>();
    for (const v of this.vouchers.values()) {
      if (!v.is_accounting_voucher) continue;
      voucherSet.add(v.voucher_number || v.guid);
      if (v.date) {
        if (!minDate || v.date < minDate) minDate = v.date;
        if (!maxDate || v.date > maxDate) maxDate = v.date;
      }
    }
    return {
      vouchers: voucherSet.size,
      accountingLines: this.accountingLines.length,
      ledgers: this.ledgers.size,
      stockItems: this.stockItems.size,
      minDate,
      maxDate,
      companyName: this.meta.companyName,
      periodFrom: this.meta.periodFrom,
      periodTo: this.meta.periodTo,
    };
  }
}
