// Purchase Register — ITC format.
//
// Ported from purchase_register_itc.py / purchase_register_gui.py.
// Reads directly from the TallyStore so we get the proper group-chain walk
// and ledger-master classification instead of the old name-heuristic.
//
// Outputs the ITC sheet exactly (one row per eligible voucher) plus four
// in-app issue panels: RCM Review, CGST≠SGST, blank/invalid GSTIN, missing
// invoice number. ITC Summary / GL Control / Orphan GST / Ledger Audit are
// deferred to Stage 4 of the refactor.

import React, { useMemo, useState, useEffect } from 'react';
import { Download, AlertCircle, AlertTriangle, FileWarning, ShieldAlert, Search, Settings2, FileText } from 'lucide-react';
import { LedgerEntry } from '../../types';
import {
  getPurchaseITCRegister,
  deriveItcIssues,
  dateRangeOf,
  buildItcSummary,
  buildGLControl,
  buildOrphanGST,
  buildLedgerAudit,
  availablePeriods,
  buildInputLedgerMovement,
  useTallyStore,
  type ItcRow,
  type ItcType,
  type ItcSummaryRow,
  type LedgerAuditCategory,
} from '../../services/tally';

interface PurchaseGSTRegisterProps {
  // Already month-filtered by FileUpload; used only to derive the date
  // range that scopes the ITC query. The relational TallyStore is read
  // from context (TallyStoreProvider in App.tsx) — modules that need it
  // call useTallyStore() rather than receiving it as a prop, so future
  // module migrations don't all force a prop-signature change.
  data: LedgerEntry[];
}

const TYPE_BADGE_CLASS: Record<ItcType, string> = {
  B2B: 'bg-blue-50 text-blue-700 border-blue-200',
  'RCM-UR': 'bg-orange-50 text-orange-700 border-orange-200',
  IMPORTSERVICE: 'bg-purple-50 text-purple-700 border-purple-200',
};

const formatINR = (n: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatDDMMYYYY = (iso: string): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};


const PurchaseGSTRegister: React.FC<PurchaseGSTRegisterProps> = ({ data }) => {
  const store = useTallyStore();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ItcType | 'ALL'>('ALL');
  const [activeIssue, setActiveIssue] = useState<null | 'rcm' | 'cgstSgst' | 'gstin' | 'noInv'>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showLedgerPicker, setShowLedgerPicker] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState('');

  // Period: 'ALL' = whole file, else a 'YYYY-MM' key. Default to the imported
  // month if the upload was a single month, otherwise the whole file.
  const importRange = useMemo(() => dateRangeOf(data), [data]);
  const [period, setPeriod] = useState<string>(() => {
    const { dateFrom: f, dateTo: t } = importRange;
    return f && t && f.slice(0, 7) === t.slice(0, 7) ? f.slice(0, 7) : 'ALL';
  });

  // GST-input ledger selection. null = follow auto-detection; an array = the
  // user's explicit set (can add missed ledgers AND exclude auto-picked ones).
  const [gstSelection, setGstSelection] = useState<string[] | null>(() => {
    try { const v = localStorage.getItem('finanalyzer_itc_gst_sel'); return v ? JSON.parse(v) : null; } catch { return null; }
  });
  useEffect(() => {
    if (gstSelection === null) localStorage.removeItem('finanalyzer_itc_gst_sel');
    else localStorage.setItem('finanalyzer_itc_gst_sel', JSON.stringify(gstSelection));
  }, [gstSelection]);

  const periods = useMemo(() => (store ? availablePeriods(store) : []), [store]);

  const { dateFrom, dateTo } = useMemo<{ dateFrom?: string; dateTo?: string }>(() => {
    if (period === 'ALL') return {};
    const p = periods.find((x) => x.key === period);
    return { dateFrom: p?.from, dateTo: p?.to };
  }, [period, periods]);

  // Universe of GST-relevant ledgers shown in the picker, with auto-status.
  const candidates = useMemo(
    () => (store ? buildLedgerAudit(store, { dateFrom, dateTo }) : []),
    [store, dateFrom, dateTo],
  );
  const autoSelected = useMemo(
    () => candidates.filter((c) => c.category === 'Selected').map((c) => c.ledgerName),
    [candidates],
  );
  // Effective checked set for the picker UI.
  const selectedSet = useMemo(() => new Set(gstSelection ?? autoSelected), [gstSelection, autoSelected]);
  // Authoritative override passed to the queries (undefined while following auto).
  const gstLedgerOverride = gstSelection ?? undefined;

  const allRows = useMemo<ItcRow[]>(() => {
    if (!store) return [];
    return getPurchaseITCRegister(store, { dateFrom, dateTo, gstLedgerOverride });
  }, [store, dateFrom, dateTo, gstLedgerOverride]);

  const issues = useMemo(() => deriveItcIssues(allRows), [allRows]);

  // Which rows the table renders: type filter ∩ search ∩ optional issue
  const visibleRows = useMemo<ItcRow[]>(() => {
    let rows = allRows;
    if (typeFilter !== 'ALL') rows = rows.filter((r) => r.type === typeFilter);
    if (activeIssue === 'rcm') rows = issues.rcmReview.filter((r) => rows.includes(r));
    else if (activeIssue === 'cgstSgst') rows = issues.cgstSgstMismatch.filter((r) => rows.includes(r));
    else if (activeIssue === 'gstin') rows = issues.blankInvalidGstin.filter((r) => rows.includes(r));
    else if (activeIssue === 'noInv') rows = issues.noInvoiceNumber.filter((r) => rows.includes(r));
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        r.partyName.toLowerCase().includes(q) ||
        r.partyGstinUin.toLowerCase().includes(q) ||
        r.vchNo.toLowerCase().includes(q) ||
        r.voucherNumber.toLowerCase().includes(q) ||
        r.expenseLedgers.toLowerCase().includes(q),
      );
    }
    return rows;
  }, [allRows, typeFilter, activeIssue, issues, search]);

  // Footer totals reflect what's on screen, not the whole register — matches
  // user expectations when filtering.
  const totals = useMemo(() => {
    let taxable = 0, igst = 0, cgst = 0, sgst = 0, tax = 0;
    for (const r of visibleRows) {
      taxable += r.taxable; igst += r.igst; cgst += r.cgst; sgst += r.sgst; tax += r.tax;
    }
    return { taxable, igst, cgst, sgst, tax, count: visibleRows.length };
  }, [visibleRows]);

  const handleExportMD = () => {
    if (allRows.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const company = store?.meta.companyName || 'Company';
    const lines: string[] = [];
    lines.push(`# Purchase GST Register — ${company}`);
    lines.push(`**Exported:** ${new Date().toLocaleString('en-IN')}`);
    if (dateFrom || dateTo) lines.push(`**Period:** ${dateFrom || 'start'} to ${dateTo || 'end'}`);
    lines.push(`**Total Vouchers:** ${allRows.length}`);
    lines.push('');
    lines.push('| # | Date | Voucher | Party | GSTIN | Type | Taxable (₹) | IGST (₹) | CGST (₹) | SGST (₹) | Total Tax (₹) |');
    lines.push('|---:|------|---------|-------|-------|------|------------:|---------:|---------:|---------:|--------------:|');
    for (let i = 0; i < allRows.length; i++) {
      const r = allRows[i];
      lines.push(`| ${i + 1} | ${r.date} | ${r.vchNo || r.voucherNumber} | ${r.partyName} | ${r.partyGstinUin || '—'} | ${r.type} | ${r.taxable.toFixed(2)} | ${r.igst.toFixed(2)} | ${r.cgst.toFixed(2)} | ${r.sgst.toFixed(2)} | ${r.tax.toFixed(2)} |`);
    }
    lines.push('');
    lines.push('---');
    lines.push(`**Grand Totals** | Taxable: ${totals.taxable.toFixed(2)} | IGST: ${totals.igst.toFixed(2)} | CGST: ${totals.cgst.toFixed(2)} | SGST: ${totals.sgst.toFixed(2)} | Tax: ${totals.tax.toFixed(2)}`);
    lines.push(`*Negative values indicate credit notes / debit notes / GST credits.*`);
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `Purchase_Register_ITC_${stamp}.md`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    if (!store || allRows.length === 0) return;
    setIsExporting(true);
    try {
      const XLSX = await import('xlsx-js-style');
      const wb = XLSX.utils.book_new();
      const stamp = new Date().toISOString().slice(0, 10);
      const ref = XLSX.utils.encode_cell;
      const range = XLSX.utils.encode_range;

      // ── Company / period banners ──────────────────────────────────────────
      const company = store.meta.companyName || 'Unknown';
      const periodFrom = store.meta.periodFrom || '';
      const periodTo = store.meta.periodTo || '';
      const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const fmtLong = (iso: string): string => {
        const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : iso;
      };
      const dMmmY = (iso: string): string => {
        const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}` : iso;
      };
      const filterDesc = (dateFrom || dateTo)
        ? ` | Filter: ${dateFrom ? fmtLong(dateFrom) : 'start'} to ${dateTo ? fmtLong(dateTo) : 'end'}`
        : '';
      const periodStr = periodFrom ? `${periodFrom} to ${periodTo}` : '';
      const displayPeriod = filterDesc ? filterDesc.replace(' | Filter: ', '') : periodStr;
      const nowStr = new Date().toLocaleString('en-IN');

      // ── Palette (mirrors purchase_register_itc.py) ────────────────────────
      const C = {
        HDR: '1F3864', WHITE: 'FFFFFF', ALT: 'EEF2F8', TOTAL: 'D6E4F0',
        GRAND: '1F3864', ORANGE: 'FFD580', RED: 'FFCDD2',
        SEL: 'E8F5E9', EXCL: 'FFF3E0', MISS: 'FFEBEE', TITLE_FG: '1F3864',
      } as const;
      const thin = { style: 'thin', color: { rgb: 'B0B8C8' } };
      const border = { top: thin, bottom: thin, left: thin, right: thin };
      const NUM_PLAIN = '0.00';
      const NUM_COMMA = '#,##0.00';
      const DATEFMT = 'DD-MMM-YYYY';

      type Cell = { v: string | number; t: 's' | 'n'; s?: Record<string, unknown> };
      const C0 = (v: string | number, s: Record<string, unknown> = {}): Cell => ({
        v: v === null || v === undefined ? '' : v,
        t: typeof v === 'number' ? 'n' : 's',
        s,
      });
      const font = (bold = false, fg = '334155', sz = 10) => ({ name: 'Calibri', sz, bold, color: { rgb: fg } });

      const hdrStyle = {
        font: font(true, C.WHITE),
        fill: { fgColor: { rgb: C.HDR } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border,
      };
      const titleCell = (v: string): Cell => C0(v, { font: font(true, C.TITLE_FG, 13), alignment: { horizontal: 'left', vertical: 'center' } });
      const bannerCell = (v: string): Cell => C0(v, { font: { name: 'Calibri', sz: 10, italic: true, color: { rgb: '555555' } } });

      const dataCell = (
        v: string | number,
        opts: { num?: boolean; comma?: boolean; date?: boolean; alt?: boolean; total?: boolean; grand?: boolean; fill?: string } = {},
      ): Cell => {
        const { num, comma, date, alt, total, grand, fill } = opts;
        const s: Record<string, unknown> = {
          border,
          alignment: { vertical: 'center', horizontal: num || date ? 'right' : 'left' },
        };
        if (grand) { s.font = font(true, C.WHITE); s.fill = { fgColor: { rgb: C.GRAND } }; }
        else if (total) { s.font = font(true); s.fill = { fgColor: { rgb: C.TOTAL } }; }
        else if (fill) { s.font = font(); s.fill = { fgColor: { rgb: fill } }; }
        else if (alt) { s.font = font(); s.fill = { fgColor: { rgb: C.ALT } }; }
        else { s.font = font(); }
        if (num && !grand && typeof v === 'number') s.numFmt = comma ? NUM_COMMA : NUM_PLAIN;
        if (date) s.numFmt = DATEFMT;
        return C0(v, s);
      };

      const setRange = (ws: Record<string, unknown>, rows: number, cols: number) => {
        ws['!ref'] = range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows - 1, 0), c: Math.max(cols - 1, 0) } });
      };

      type Merge = { s: { r: number; c: number }; e: { r: number; c: number } };

      // Generic title + header + data-row table (ITC, Orphan).
      const tableSheet = (
        title: string,
        headers: string[],
        rows: Array<Array<string | number>>,
        cfg: {
          numCols: boolean[];
          commaCols?: boolean[];
          dateCols?: boolean[];
          widths: number[];
          rowFill?: (i: number) => string | undefined;
          footnote?: string;
        },
      ): Record<string, unknown> => {
        const ws: Record<string, unknown> = {};
        const { numCols, commaCols = [], dateCols = [], widths, rowFill, footnote } = cfg;
        let R = 0;
        ws[ref({ r: R, c: 0 })] = titleCell(title);
        R++; // title
        R++; // blank
        const hdrRow = R;
        for (let c = 0; c < headers.length; c++) ws[ref({ r: R, c })] = C0(headers[c], hdrStyle);
        R++;
        for (let i = 0; i < rows.length; i++) {
          const even = (R % 2) === 0;
          const fill = rowFill?.(i);
          for (let c = 0; c < headers.length; c++) {
            const v = c < rows[i].length ? rows[i][c] : '';
            ws[ref({ r: R, c })] = dataCell(v, { num: numCols[c], comma: commaCols[c], date: dateCols[c], alt: even, fill });
          }
          R++;
        }
        const merges: Merge[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
        if (footnote) {
          const fr = R + 1;
          ws[ref({ r: fr, c: 0 })] = C0(footnote, { font: { name: 'Calibri', sz: 9, italic: true, color: { rgb: '7B1010' } } });
          merges.push({ s: { r: fr, c: 0 }, e: { r: fr, c: Math.min(headers.length - 1, 11) } });
          R = fr + 1;
        }
        setRange(ws, R, headers.length);
        ws['!cols'] = widths.map((w) => ({ wch: w }));
        ws['!merges'] = merges;
        ws['!freeze'] = { xSplit: 0, ySplit: hdrRow + 1 };
        ws['!autofilter'] = { ref: range({ s: { r: hdrRow, c: 0 }, e: { r: hdrRow, c: headers.length - 1 } }) };
        return ws;
      };

      // ── Sheet 1: ITC ──────────────────────────────────────────────────────
      const ITC_HEADERS = [
        'Party GSTIN/UIN', 'Party name', 'Vch No.', 'Date',
        'Taxable', 'IGST', 'CGST', 'SGST', 'Tax',
        'Place of Supply', 'Reverse Charge', 'ITC Availability',
        'Type', '3B Month', 'Books Month', 'Invoice Match', 'GSTIN Match', 'FY',
        'Posting Date', 'Expense Ledgers', 'Voucher Type', 'Voucher Number',
        'Primary Group', 'ITC Type', 'Narration', 'Review Flag', 'GUID',
      ];
      const ITC_AMT = new Set(['Taxable', 'IGST', 'CGST', 'SGST', 'Tax']);
      const ITC_NUM = ITC_HEADERS.map((h) => ITC_AMT.has(h));
      const ITC_DATE = ITC_HEADERS.map((h) => h === 'Date' || h === 'Posting Date');
      const ITC_WIDTHS = [20,34,22,14,16,14,12,12,14,18,12,12,14,12,12,18,18,10,14,50,16,20,22,16,40,12,38];
      const itcRows = allRows.map((r) => [
        r.partyGstinUin, r.partyName, r.vchNo, dMmmY(r.date),
        r.taxable, r.igst, r.cgst, r.sgst, r.tax,
        r.placeOfSupply, r.reverseCharge, r.itcAvailability,
        r.type, r.m3b, r.booksMonth, '', '', r.fy,
        dMmmY(r.postingDate), r.expenseLedgers, r.voucherType, r.voucherNumber,
        r.primaryGroup, r.itcType, r.narration, r.reviewFlag, r.guid,
      ] as Array<string | number>);
      const itcFill = (i: number): string | undefined => {
        const r = allRows[i];
        if (Math.abs(r.cgst - r.sgst) > 0.005) return C.RED;
        if (r.tax === 0) return C.ORANGE;
        return undefined;
      };
      const wsItc = tableSheet(
        `ITC Register  |  ${company}${filterDesc}`,
        ITC_HEADERS, itcRows,
        {
          numCols: ITC_NUM, dateCols: ITC_DATE, widths: ITC_WIDTHS, rowFill: itcFill,
          footnote: '★  ORANGE = Tax is ₹0 — check whether RCM applies (unregistered supplier, import of service, GTA, legal fees, etc.). If yes, rebook with RCM ledger and reclassify as RCM-UR.     RED = CGST ≠ SGST — data entry error; both must be equal for intra-state supply.',
        },
      );
      XLSX.utils.book_append_sheet(wb, wsItc, 'ITC');

      // ── Sheet 2: ITC Summary (two stacked blocks + legend) ────────────────
      const sections = buildItcSummary(allRows);
      const SUM_HDRS = ['Month', '# Invoices', 'Taxable', 'IGST', 'CGST', 'SGST', 'Total Tax', '3B Ref'];
      const SUM_NUMSET = new Set(['# Invoices', 'Taxable', 'IGST', 'CGST', 'SGST', 'Total Tax']);
      const TYPE_LABEL: Record<ItcType, string> = {
        'B2B': 'B2B (Regular)   —   4(A)(5) All Other ITC',
        'RCM-UR': 'RCM-UR (Unregistered)   —   4(A)(3) Reverse Charge',
        'IMPORTSERVICE': 'Import of Services   —   4(A)(2) Import of Services',
      };
      const TYPE_REF: Record<ItcType, string> = {
        'B2B': '4(A)(5) All Other ITC',
        'RCM-UR': '4(A)(3) Reverse Charge',
        'IMPORTSERVICE': '4(A)(2) Import of Services',
      };
      const BLOCK_LABEL: Record<string, string> = { 'Books Month': 'A.  By BOOKS MONTH', '3B Month': 'B.  By 3B MONTH' };
      const TYPES_ORDER: ItcType[] = ['B2B', 'RCM-UR', 'IMPORTSERVICE'];

      const wsSum: Record<string, unknown> = {};
      let SR = 0;
      const sumMerges: Merge[] = [];
      const centerNonNum = (cell: Cell, isNum: boolean) => {
        if (!isNum) cell.s = { ...(cell.s || {}), alignment: { vertical: 'center', horizontal: 'center' } };
        return cell;
      };
      wsSum[ref({ r: SR, c: 0 })] = titleCell('ITC Register Summary — for 3B reconciliation');
      sumMerges.push({ s: { r: SR, c: 0 }, e: { r: SR, c: 7 } }); SR++;
      wsSum[ref({ r: SR, c: 0 })] = bannerCell(`Company: ${company}   |   Period: ${displayPeriod}   |   Generated: ${nowStr}   |   Match Books-Month section against your books; 3B-Month section against filed 3B.`);
      sumMerges.push({ s: { r: SR, c: 0 }, e: { r: SR, c: 7 } }); SR++;
      const legendVals = ['Legend:', 'Match', '', 'Mismatch', '', 'Only in Books', '', 'Only in 2B'];
      const legendFills: Array<string | undefined> = [undefined, 'C8E6C9', undefined, 'FFCDD2', undefined, 'FFF9C4', undefined, 'E3F2FD'];
      for (let c = 0; c < 8; c++) {
        const f = legendFills[c];
        wsSum[ref({ r: SR, c })] = C0(legendVals[c], { font: font(!!f), alignment: { horizontal: 'center' }, ...(f ? { fill: { fgColor: { rgb: f } } } : {}) });
      }
      SR += 2; // legend + blank

      const renderBlock = (block: 'Books Month' | '3B Month') => {
        wsSum[ref({ r: SR, c: 0 })] = C0(BLOCK_LABEL[block], { font: font(true, C.TITLE_FG, 12) });
        sumMerges.push({ s: { r: SR, c: 0 }, e: { r: SR, c: 7 } }); SR += 2; // label + blank
        const blockSections = sections.filter((s) => s.block === block);
        let grand: ItcSummaryRow | undefined;
        for (const s of blockSections) { const g = s.rows.find((r) => r.isGrandTotal); if (g) grand = g; }
        for (const type of TYPES_ORDER) {
          const sec = blockSections.find((s) => s.type === type);
          if (!sec) continue;
          const monthRows = sec.rows.filter((r) => !r.isTotal && !r.isGrandTotal);
          if (monthRows.length === 0) continue;
          const totalRow = sec.rows.find((r) => r.isTotal);
          wsSum[ref({ r: SR, c: 0 })] = C0(TYPE_LABEL[type], { font: font(true, C.TITLE_FG) });
          sumMerges.push({ s: { r: SR, c: 0 }, e: { r: SR, c: 7 } }); SR++;
          for (let c = 0; c < 8; c++) wsSum[ref({ r: SR, c })] = C0(SUM_HDRS[c], hdrStyle);
          SR++;
          const emit = (row: ItcSummaryRow, isTot: boolean) => {
            const vals: Array<string | number> = [row.month, row.count, row.taxable, row.igst, row.cgst, row.sgst, row.tax, TYPE_REF[type]];
            const even = (SR % 2) === 0;
            for (let c = 0; c < 8; c++) {
              const isNum = SUM_NUMSET.has(SUM_HDRS[c]);
              wsSum[ref({ r: SR, c })] = centerNonNum(dataCell(vals[c], { num: isNum, comma: isNum, total: isTot, alt: !isTot && even }), isNum);
            }
            SR++;
          };
          for (const m of monthRows) emit(m, false);
          if (totalRow) emit(totalRow, true);
          SR++; // blank after sub-section
        }
        if (grand) {
          const vals: Array<string | number> = [grand.month, grand.count, grand.taxable, grand.igst, grand.cgst, grand.sgst, grand.tax, ''];
          for (let c = 0; c < 8; c++) {
            const isNum = SUM_NUMSET.has(SUM_HDRS[c]);
            wsSum[ref({ r: SR, c })] = centerNonNum(dataCell(vals[c], { num: isNum, comma: isNum, grand: true }), isNum);
          }
          SR++;
        }
        SR += 2; // spacing between blocks
      };
      renderBlock('Books Month');
      renderBlock('3B Month');
      setRange(wsSum, SR, 8);
      wsSum['!cols'] = [18, 12, 18, 16, 14, 14, 16, 30].map((w) => ({ wch: w }));
      wsSum['!merges'] = sumMerges;
      wsSum['!freeze'] = { xSplit: 0, ySplit: 4 };
      XLSX.utils.book_append_sheet(wb, wsSum, 'ITC Summary');

      // ── Sheet 3: GL Control (with notes block) ────────────────────────────
      const glRows = buildGLControl(store, { dateFrom, dateTo, gstLedgerOverride });
      const GL_HDRS = [
        'Primary Group', 'GL: # Vouchers', 'GL: Taxable Value',
        'ITC: # Vouchers', 'ITC: Taxable Value',
        'ITC: IGST', 'ITC: CGST', 'ITC: SGST / UTGST', 'ITC: Total GST',
        'No-GST: # Vouchers', 'No-GST: Taxable Value', '% ITC Coverage',
      ];
      const GL_COMMA = new Set(['GL: Taxable Value', 'ITC: Taxable Value', 'ITC: IGST', 'ITC: CGST', 'ITC: SGST / UTGST', 'ITC: Total GST', 'No-GST: Taxable Value']);
      const GL_WIDTHS = [26, 16, 18, 14, 18, 14, 12, 14, 14, 16, 18, 50];
      const wsGL: Record<string, unknown> = {};
      let GR = 0;
      const glMerges: Merge[] = [];
      wsGL[ref({ r: GR, c: 0 })] = titleCell('GL Control — Tally GL vs ITC Register');
      glMerges.push({ s: { r: GR, c: 0 }, e: { r: GR, c: GL_HDRS.length - 1 } }); GR++;
      wsGL[ref({ r: GR, c: 0 })] = bannerCell(`Period: ${displayPeriod}   |   Each voucher counted ONCE regardless of number of expense lines.`); GR += 2;
      const glNotes = [
        'HOW TO READ THIS SHEET',
        'GL: # Vouchers (Total)  — all accounting vouchers in the Tally export for this period that hit this primary group',
        'GL: Taxable Value        — total debit to this group (sum of all accounting lines, abs value)',
        'ITC: # Vouchers          — subset of above that have at least one GST input line (captured in ITC register)',
        'ITC: Taxable Value       — expense base for those ITC vouchers',
        'ITC: Total GST           — total input credit captured',
        'No-GST: # Vouchers       — vouchers that hit this group but have NO GST input (unregistered / exempt vendors, etc.)',
        '% ITC Coverage           — ITC taxable value ÷ GL taxable value',
      ];
      glNotes.forEach((n, i) => {
        wsGL[ref({ r: GR, c: 0 })] = C0(n, { font: { name: 'Calibri', sz: 10, bold: i === 0, italic: i !== 0, color: { rgb: '444444' } } });
        GR++;
      });
      GR++; // blank
      const glHdrRow = GR;
      for (let c = 0; c < GL_HDRS.length; c++) wsGL[ref({ r: GR, c })] = C0(GL_HDRS[c], hdrStyle);
      GR++;
      for (const r of glRows) {
        const grand = r.isGrandTotal;
        const coverage = grand
          ? '★ One voucher can hit multiple groups — voucher counts are per-group only'
          : (r.glTaxable > 0 ? `${r.itcCoverage.toFixed(1)}%` : '—');
        const vals: Array<string | number> = [
          grand ? 'GRAND TOTAL  ★' : r.primaryGroup,
          grand ? '★ see note' : r.glVouchers,
          r.glTaxable,
          grand ? '★ see note' : r.itcVouchers,
          r.itcTaxable, r.itcIgst, r.itcCgst, r.itcSgst, r.itcTotalGst,
          grand ? '★ see note' : r.noGstVouchers,
          r.noGstTaxable,
          coverage,
        ];
        const even = (GR % 2) === 0;
        for (let c = 0; c < GL_HDRS.length; c++) {
          const isComma = GL_COMMA.has(GL_HDRS[c]);
          wsGL[ref({ r: GR, c })] = dataCell(vals[c], { num: isComma, comma: isComma, grand, alt: !grand && even });
        }
        GR++;
      }
      setRange(wsGL, GR, GL_HDRS.length);
      wsGL['!cols'] = GL_WIDTHS.map((w) => ({ wch: w }));
      wsGL['!merges'] = glMerges;
      wsGL['!freeze'] = { xSplit: 0, ySplit: glHdrRow + 1 };
      wsGL['!autofilter'] = { ref: range({ s: { r: glHdrRow, c: 0 }, e: { r: glHdrRow, c: GL_HDRS.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, wsGL, 'GL Control');

      // ── Sheet 4: Orphan GST ───────────────────────────────────────────────
      const orphanRows = buildOrphanGST(store, { dateFrom, dateTo, gstLedgerOverride });
      if (orphanRows.length === 0) {
        const wsO: Record<string, unknown> = {};
        wsO[ref({ r: 0, c: 0 })] = C0('No orphan GST vouchers found. ✓', { font: font(true, '2E7D32') });
        setRange(wsO, 1, 1);
        wsO['!cols'] = [{ wch: 40 }];
        XLSX.utils.book_append_sheet(wb, wsO, 'Orphan GST');
      } else {
        const ORP_HDRS = ['Voucher Date', 'Voucher Type', 'Voucher Number', 'Ref / Invoice No', 'Supplier / Party', 'Supplier GSTIN', 'Place of Supply', 'IGST', 'CGST', 'SGST / UTGST', 'Total GST', 'All Ledgers in Voucher', 'Narration', 'Issue'];
        const ORP_AMT = new Set(['IGST', 'CGST', 'SGST / UTGST', 'Total GST']);
        const ORP_NUM = ORP_HDRS.map((h) => ORP_AMT.has(h));
        const ORP_DATE = ORP_HDRS.map((h) => h === 'Voucher Date');
        const ORP_WIDTHS = [14, 16, 20, 22, 34, 20, 18, 14, 12, 14, 14, 50, 40, 55];
        const orpRows = orphanRows.map((r) => [
          dMmmY(r.date), r.voucherType, r.voucherNumber, r.invoiceNo,
          r.partyName, r.partyGstin, r.placeOfSupply,
          r.igst, r.cgst, r.sgst, r.totalGst,
          r.allLedgers.split(', ').join(' | '),
          r.narration,
          'GST input present but no Purchase/Exp/FA ledger hit',
        ] as Array<string | number>);
        const wsOrphan = tableSheet(`Orphan GST Vouchers  |  ${company}${filterDesc}`, ORP_HDRS, orpRows, { numCols: ORP_NUM, commaCols: ORP_NUM, dateCols: ORP_DATE, widths: ORP_WIDTHS });
        XLSX.utils.book_append_sheet(wb, wsOrphan, 'Orphan GST');
      }

      // ── Sheet 5: GST Ledger Audit (11 cols + legend + summary) ────────────
      const auditRows = buildLedgerAudit(store, { dateFrom, dateTo });
      const AUD_HDRS = ['Ledger Name', 'Parent Group', 'GST Duty Head', 'Status', 'Exclusion / Note', 'GST Component', 'Is RCM Input', 'Is RCM Payable', 'Fired in Period', 'Ledger GSTIN', 'GST Reg. Type'];
      const AUD_WIDTHS = [44, 22, 18, 18, 60, 14, 12, 14, 14, 22, 18];
      const STATUS_LABEL: Record<LedgerAuditCategory, string> = { 'Selected': 'Selected ✓', 'Excluded': 'Excluded', 'Potential Miss': '⚠ Potential Miss' };
      const STATUS_FILL: Record<LedgerAuditCategory, string> = { 'Selected': C.SEL, 'Excluded': C.EXCL, 'Potential Miss': C.MISS };
      const wsAud: Record<string, unknown> = {};
      let AR = 0;
      const audMerges: Merge[] = [];
      wsAud[ref({ r: AR, c: 0 })] = titleCell('GST Ledger Audit  —  which ledgers are in scope as GST Input');
      audMerges.push({ s: { r: AR, c: 0 }, e: { r: AR, c: 10 } }); AR++;
      wsAud[ref({ r: AR, c: 0 })] = bannerCell(`Company: ${company}${filterDesc}   |   Generated: ${nowStr}   |   Review ⚠ Potential Miss rows — if any should be input GST, fix their group in Tally and re-run.`);
      audMerges.push({ s: { r: AR, c: 0 }, e: { r: AR, c: 10 } }); AR++;
      const audLegVals = ['Selected ✓', '— passed both gates; included as GST input', '', 'Excluded', '— under correct group but name has output keyword', '', '⚠ Potential Miss', '— name looks like GST input but group is wrong → check manually'];
      const audLegFill: Record<number, string> = { 0: C.SEL, 3: C.EXCL, 6: C.MISS };
      for (let c = 0; c < 8; c++) {
        const f = audLegFill[c];
        wsAud[ref({ r: AR, c })] = C0(audLegVals[c], f
          ? { font: font(true, '334155', 9), fill: { fgColor: { rgb: f } }, alignment: { vertical: 'center' } }
          : { font: { name: 'Calibri', sz: 9, italic: [1, 4, 7].includes(c), color: { rgb: '555555' } }, alignment: { vertical: 'center' } });
      }
      AR += 2; // legend + blank
      const audHdrRow = AR;
      for (let c = 0; c < AUD_HDRS.length; c++) wsAud[ref({ r: AR, c })] = C0(AUD_HDRS[c], hdrStyle);
      AR++;
      for (const r of auditRows) {
        const fill = STATUS_FILL[r.category];
        const vals: Array<string | number> = [r.ledgerName, r.parentGroup, r.gstDutyHead, STATUS_LABEL[r.category], r.reason, r.gstComponent, r.isRcmInput, r.isRcmPayable, r.firedInPeriod, r.ledgerGstin, r.gstRegType];
        for (let c = 0; c < AUD_HDRS.length; c++) {
          const cell = dataCell(vals[c], { fill });
          if (c === 8 && r.firedInPeriod === 'Yes') cell.s = { ...(cell.s || {}), font: font(true, '1B5E20') };
          wsAud[ref({ r: AR, c })] = cell;
        }
        AR++;
      }
      const cnt = (cat: LedgerAuditCategory) => auditRows.filter((r) => r.category === cat).length;
      const firedCnt = auditRows.filter((r) => r.firedInPeriod === 'Yes').length;
      AR++; // blank
      wsAud[ref({ r: AR, c: 0 })] = C0(`Summary:   Selected ✓ = ${cnt('Selected')}   |   Excluded = ${cnt('Excluded')}   |   ⚠ Potential Miss = ${cnt('Potential Miss')}   |   Fired in Period = ${firedCnt}`, { font: font(true, C.TITLE_FG, 10) });
      audMerges.push({ s: { r: AR, c: 0 }, e: { r: AR, c: 7 } }); AR++;
      setRange(wsAud, AR, AUD_HDRS.length);
      wsAud['!cols'] = AUD_WIDTHS.map((w) => ({ wch: w }));
      wsAud['!merges'] = audMerges;
      wsAud['!freeze'] = { xSplit: 0, ySplit: audHdrRow + 1 };
      wsAud['!autofilter'] = { ref: range({ s: { r: audHdrRow, c: 0 }, e: { r: audHdrRow, c: AUD_HDRS.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, wsAud, 'GST Ledger Audit');

      // ── Sheet 6: Info (selection-rule documentation) ──────────────────────
      const wsInfo: Record<string, unknown> = {};
      const infoRows: Array<[string, string]> = [
        ['Field', 'Value'],
        ['Company', company],
        ['File Period', periodStr],
        ['Filter From', dateFrom || 'none'],
        ['Filter To', dateTo || 'none'],
        ['Generated At', new Date().toISOString().slice(0, 19).replace('T', ' ')],
        ['ITC Rows', String(allRows.length)],
        ['Orphan GST', String(orphanRows.length)],
        ['Ledger Audit', `${auditRows.length} candidate ledgers reviewed`],
        ['', ''],
        ['Target Groups', 'Purchase Accounts | Direct Expenses | Indirect Expenses | Fixed Assets'],
        ['GST Selection', "parent='GST' OR (parent='Duties & Taxes' AND gst_duty_head not null)"],
        ['GST Excluded', 'output/sales GST, accrued, gst payable/balance ledgers'],
        ['RCM Selection', "GST ledger name contains 'RCM'"],
        ['RCM Payable', "'RCM' + 'PAYABLE' in name — invoice value only, not ITC"],
        ['Type: RCM-UR', 'voucher has any RCM ledger'],
        ['Type: IMPORT', 'no GSTIN + IGST > 0 + CGST = 0'],
        ['Type: B2B', 'all other eligible vouchers'],
        ['Orange rows', 'Tax = 0 on ITC sheet — review whether RCM applies'],
        ['Red rows', 'CGST ≠ SGST — data entry error; both must be equal for intra-state'],
        ['Script', 'purchase_register_itc.py (web port)'],
      ];
      infoRows.forEach(([k, v], i) => {
        if (i === 0) {
          wsInfo[ref({ r: i, c: 0 })] = C0(k, hdrStyle);
          wsInfo[ref({ r: i, c: 1 })] = C0(v, hdrStyle);
        } else {
          wsInfo[ref({ r: i, c: 0 })] = C0(k, { font: font(true), border, alignment: { vertical: 'center', horizontal: 'left' } });
          wsInfo[ref({ r: i, c: 1 })] = C0(v, { font: font(), border, alignment: { vertical: 'center', horizontal: 'left' } });
        }
      });
      setRange(wsInfo, infoRows.length, 2);
      wsInfo['!cols'] = [{ wch: 28 }, { wch: 80 }];
      XLSX.utils.book_append_sheet(wb, wsInfo, 'Info');

      // ── Sheet 7: GST Input Ledger Movement ────────────────────────────────
      const mov = buildInputLedgerMovement(store, { dateFrom, dateTo, gstLedgerOverride });
      const wsMov: Record<string, unknown> = {};
      let MR = 0;
      const movMerges: Merge[] = [];
      wsMov[ref({ r: MR, c: 0 })] = titleCell(`GST Input Ledger Movement  |  ${company}${filterDesc}`);
      movMerges.push({ s: { r: MR, c: 0 }, e: { r: MR, c: 12 } }); MR++;
      wsMov[ref({ r: MR, c: 0 })] = bannerCell(`Period: ${displayPeriod}   |   Balances are Debit-positive (input GST = asset). "ITC" = movement captured in the ITC register (expense vouchers); "Other" = payments / journals / set-offs / ITC reversals.`);
      movMerges.push({ s: { r: MR, c: 0 }, e: { r: MR, c: 12 } }); MR += 2;

      // Section A — per-ledger reconciliation
      const SUMH = ['Ledger', 'Component', 'RCM?', 'Opening (Dr)', 'ITC Dr', 'ITC Cr', 'Other Dr', 'Other Cr', 'Total Dr', 'Total Cr', 'Closing (Dr)', 'Books Closing', 'Δ vs Books'];
      const SUM_AMT = new Set(['Opening (Dr)', 'ITC Dr', 'ITC Cr', 'Other Dr', 'Other Cr', 'Total Dr', 'Total Cr', 'Closing (Dr)', 'Books Closing', 'Δ vs Books']);
      const movSumHdrRow = MR;
      for (let c = 0; c < SUMH.length; c++) wsMov[ref({ r: MR, c })] = C0(SUMH[c], hdrStyle);
      MR++;
      for (const s of mov.summary) {
        const grand = s.isTotal;
        const even = (MR % 2) === 0;
        const vals: Array<string | number> = [
          s.ledgerName, s.component, s.isRcm ? 'Y' : '',
          s.opening, s.itcDr, s.itcCr, s.otherDr, s.otherCr, s.totalDr, s.totalCr, s.closing,
          mov.fullPeriod ? s.closingBooks : '—',
          mov.fullPeriod ? s.recoDelta : '—',
        ];
        for (let c = 0; c < SUMH.length; c++) {
          const isComma = SUM_AMT.has(SUMH[c]) && typeof vals[c] === 'number';
          wsMov[ref({ r: MR, c })] = dataCell(vals[c], { num: isComma, comma: isComma, grand, alt: !grand && even });
        }
        MR++;
      }
      if (mov.fullPeriod) {
        const note = "Δ vs Books can be non-zero for GST duty ledgers — Tally squares off GST internally and the export's line-level detail for duty ledgers is partial. The ITC Dr column ties to the ITC register total tax.";
        wsMov[ref({ r: MR + 1, c: 0 })] = C0(note, { font: { name: 'Calibri', sz: 9, italic: true, color: { rgb: '7B1010' } } });
        movMerges.push({ s: { r: MR + 1, c: 0 }, e: { r: MR + 1, c: 12 } });
        MR += 3;
      } else {
        MR += 1;
      }

      // Section B — voucher-level detail (ITC + non-ITC, tagged)
      wsMov[ref({ r: MR, c: 0 })] = C0('Voucher-level detail — every voucher touching an input ledger (ITC = captured in register, Other = payment / journal / adjustment)', { font: font(true, C.TITLE_FG, 12) });
      movMerges.push({ s: { r: MR, c: 0 }, e: { r: MR, c: 9 } }); MR += 2;
      const DETH = ['Date', 'Voucher Type', 'Voucher No', 'Ledger', 'Component', 'Party', 'Debit', 'Credit', 'Bucket', 'Narration'];
      const DET_AMT = DETH.map((h) => h === 'Debit' || h === 'Credit');
      const DET_DATE = DETH.map((h) => h === 'Date');
      const movDetHdrRow = MR;
      for (let c = 0; c < DETH.length; c++) wsMov[ref({ r: MR, c })] = C0(DETH[c], hdrStyle);
      MR++;
      for (const l of mov.lines) {
        const even = (MR % 2) === 0;
        const fill = l.bucket === 'Other' ? C.ORANGE : undefined;
        const vals: Array<string | number> = [
          dMmmY(l.date), l.voucherType, l.voucherNumber, l.ledgerName, l.component, l.party,
          l.debit, l.credit, l.bucket, l.narration,
        ];
        for (let c = 0; c < DETH.length; c++) {
          wsMov[ref({ r: MR, c })] = dataCell(vals[c], { num: DET_AMT[c], comma: DET_AMT[c], date: DET_DATE[c], alt: even, fill });
        }
        MR++;
      }
      setRange(wsMov, MR, SUMH.length);
      wsMov['!cols'] = [34, 12, 7, 16, 12, 12, 14, 14, 14, 14, 16, 16, 14].map((w) => ({ wch: w }));
      wsMov['!merges'] = movMerges;
      wsMov['!freeze'] = { xSplit: 0, ySplit: movSumHdrRow + 1 };
      wsMov['!autofilter'] = { ref: range({ s: { r: movDetHdrRow, c: 0 }, e: { r: movDetHdrRow, c: DETH.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, wsMov, 'Input Ledger Movement');

      XLSX.writeFile(wb, `Purchase_Register_ITC_${stamp}.xlsx`, { compression: true });
    } finally {
      setIsExporting(false);
    }
  };

  // ── Empty / fallback states ────────────────────────────────────────────────
  if (!store) {
    return (
      <div className="bg-white border border-amber-200 rounded-2xl p-8 shadow-sm">
        <div className="flex gap-4 items-start">
          <div className="shrink-0 w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
            <AlertCircle size={24} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Tally Excel Export (ZIP) required</h2>
            <p className="text-sm text-slate-600 mt-1 leading-relaxed">
              The Purchase Register builds the ITC schedule by walking <code>mst_group</code> parent chains
              and reading <code>mst_ledger.gst_duty_head</code> — fields only the Tally Excel Export ZIP
              carries. The legacy live-loader import doesn't expose them.
            </p>
            <p className="text-sm text-slate-600 mt-2">
              Return to the file picker and choose <strong>Import Tally Excel Export (ZIP)</strong>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-500">
        No eligible purchase / expense / fixed-asset vouchers found in the selected period.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Issue panels ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <IssueCard
          icon={<AlertTriangle size={18} />} accent="orange"
          title="RCM Review" subtitle="Tax = ₹ 0"
          count={issues.rcmReview.length}
          active={activeIssue === 'rcm'}
          onClick={() => setActiveIssue((p) => (p === 'rcm' ? null : 'rcm'))}
        />
        <IssueCard
          icon={<ShieldAlert size={18} />} accent="red"
          title="CGST ≠ SGST" subtitle="Data entry error"
          count={issues.cgstSgstMismatch.length}
          active={activeIssue === 'cgstSgst'}
          onClick={() => setActiveIssue((p) => (p === 'cgstSgst' ? null : 'cgstSgst'))}
        />
        <IssueCard
          icon={<FileWarning size={18} />} accent="yellow"
          title="Blank / Invalid GSTIN" subtitle="Tax > 0"
          count={issues.blankInvalidGstin.length}
          active={activeIssue === 'gstin'}
          onClick={() => setActiveIssue((p) => (p === 'gstin' ? null : 'gstin'))}
        />
        <IssueCard
          icon={<FileWarning size={18} />} accent="yellow"
          title="Missing Invoice No." subtitle="Tax > 0"
          count={issues.noInvoiceNumber.length}
          active={activeIssue === 'noInv'}
          onClick={() => setActiveIssue((p) => (p === 'noInv' ? null : 'noInv'))}
        />
      </div>

      {/* ── Filter / search / export bar ──────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-3 shadow-sm">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search party, GSTIN, invoice, voucher#, ledger…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          title="Period"
          className="px-3 py-2 text-sm font-semibold border border-slate-200 rounded-lg bg-white text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none"
        >
          <option value="ALL">All Periods</option>
          {periods.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-semibold">
          {(['ALL', 'B2B', 'RCM-UR', 'IMPORTSERVICE'] as const).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                typeFilter === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}>
              {t === 'IMPORTSERVICE' ? 'IMPORT-SVC' : t}
            </button>
          ))}
        </div>
        {activeIssue && (
          <button onClick={() => setActiveIssue(null)}
            className="px-3 py-1.5 text-xs font-bold rounded-lg bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100">
            Clear issue filter
          </button>
        )}
        <button onClick={() => setShowLedgerPicker((p) => !p)}
          className={`px-3 py-1.5 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg border transition-colors ${
            showLedgerPicker || gstSelection !== null
              ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
              : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
          }`}>
          <Settings2 size={13} />
          GST Ledgers ({selectedSet.size}{gstSelection !== null ? ' · custom' : ''})
        </button>
        <button onClick={handleExportMD}
          className="px-4 py-2 inline-flex items-center gap-2 text-sm font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors shadow-sm">
          <FileText size={16} />
          Export MD
        </button>
        <button onClick={handleExport} disabled={isExporting}
          className="px-4 py-2 inline-flex items-center gap-2 text-sm font-bold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300 transition-colors shadow-sm">
          <Download size={16} />
          {isExporting ? 'Exporting…' : 'Export Excel'}
        </button>
      </div>

      {/* ── GST Input Ledger Picker (searchable multi-select) ─────────────── */}
      {showLedgerPicker && (() => {
        const ql = ledgerSearch.trim().toLowerCase();
        const filtered = candidates.filter((c) =>
          !ql ||
          c.ledgerName.toLowerCase().includes(ql) ||
          (c.parentGroup || '').toLowerCase().includes(ql) ||
          (c.gstDutyHead || '').toLowerCase().includes(ql),
        );
        const toggle = (name: string, on: boolean) => {
          setGstSelection((prev) => {
            const base = new Set(prev ?? autoSelected);
            if (on) base.add(name); else base.delete(name);
            return [...base];
          });
        };
        const bulk = (on: boolean) => {
          setGstSelection((prev) => {
            const base = new Set(prev ?? autoSelected);
            for (const c of filtered) { if (on) base.add(c.ledgerName); else base.delete(c.ledgerName); }
            return [...base];
          });
        };
        const catTag: Record<LedgerAuditCategory, { txt: string; cls: string }> = {
          'Selected':       { txt: 'auto',     cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
          'Excluded':       { txt: 'excluded', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
          'Potential Miss': { txt: 'review',   cls: 'bg-rose-50 text-rose-700 border-rose-200' },
        };
        return (
          <div className="bg-white border border-indigo-200 rounded-xl shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  GST Input Ledgers — {selectedSet.size} selected {gstSelection === null ? '(auto)' : '(custom)'}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Tick the ledgers whose IGST/CGST/SGST feed the ITC totals. Auto-detected ledgers are pre-ticked — untick to exclude, tick greyed ones to add.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <button onClick={() => bulk(true)} className="px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Select shown</button>
                <button onClick={() => bulk(false)} className="px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Clear shown</button>
                <button onClick={() => setGstSelection(null)} disabled={gstSelection === null}
                  className="px-2.5 py-1 rounded-md border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-default">Reset to auto</button>
              </div>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" value={ledgerSearch} onChange={(e) => setLedgerSearch(e.target.value)}
                placeholder="Search ledger, group, duty head…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-500 px-3 py-2">No ledgers match “{ledgerSearch}”.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto pr-1">
                {filtered.map((c) => {
                  const checked = selectedSet.has(c.ledgerName);
                  const tag = catTag[c.category];
                  return (
                    <label key={c.ledgerName}
                      className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        checked ? 'bg-indigo-50 border-indigo-200' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                      }`}>
                      <input type="checkbox" checked={checked}
                        onChange={(e) => toggle(c.ledgerName, e.target.checked)}
                        className="mt-0.5 accent-indigo-600 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs font-semibold text-slate-900 truncate">{c.ledgerName}</p>
                          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold border ${tag.cls}`}>{tag.txt}</span>
                          {c.gstComponent && <span className="shrink-0 text-[9px] font-bold text-slate-400">{c.gstComponent}</span>}
                          {c.isRcmInput === 'Yes' && <span className="shrink-0 text-[9px] font-bold text-orange-600">RCM</span>}
                        </div>
                        <p className="text-[10px] text-slate-500 truncate">
                          {c.parentGroup}{c.gstDutyHead ? ` · ${c.gstDutyHead}` : ''}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto max-h-[640px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-700 font-semibold">
              <tr>
                <Th>Date</Th>
                <Th>Party</Th>
                <Th>GSTIN</Th>
                <Th>Vch No.</Th>
                <Th numeric>Taxable</Th>
                <Th numeric>IGST</Th>
                <Th numeric>CGST</Th>
                <Th numeric>SGST</Th>
                <Th numeric>Tax</Th>
                <Th>Type</Th>
                <Th>RC</Th>
                <Th>Books</Th>
                <Th>Primary Group</Th>
                <Th>ITC Type</Th>
                <Th>Expense Ledgers</Th>
                <Th>Voucher#</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleRows.map((r) => (
                <tr key={r.guid} className={`hover:bg-slate-50 ${r.tax === 0 ? 'bg-orange-50/30' : ''}`}>
                  <Td>{formatDDMMYYYY(r.date)}</Td>
                  <Td className="font-medium text-slate-800">{r.partyName}</Td>
                  <Td className="font-mono text-[11px]">{r.partyGstinUin}</Td>
                  <Td>{r.vchNo}</Td>
                  <Td numeric>{formatINR(r.taxable)}</Td>
                  <Td numeric>{r.igst ? formatINR(r.igst) : '—'}</Td>
                  <Td numeric>{r.cgst ? formatINR(r.cgst) : '—'}</Td>
                  <Td numeric>{r.sgst ? formatINR(r.sgst) : '—'}</Td>
                  <Td numeric className="font-bold">{formatINR(r.tax)}</Td>
                  <Td>
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${TYPE_BADGE_CLASS[r.type]}`}>
                      {r.type === 'IMPORTSERVICE' ? 'IMPORT-SVC' : r.type}
                    </span>
                  </Td>
                  <Td className={`text-center ${r.reverseCharge === 'Y' ? 'text-orange-700 font-bold' : 'text-slate-400'}`}>
                    {r.reverseCharge}
                  </Td>
                  <Td>{r.booksMonth}</Td>
                  <Td>{r.primaryGroup}</Td>
                  <Td>{r.itcType}</Td>
                  <Td className="max-w-[220px] truncate" title={r.expenseLedgers}>{r.expenseLedgers}</Td>
                  <Td>{r.voucherNumber}</Td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={16} className="py-8 text-center text-slate-400 text-sm">
                    No rows match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
            {visibleRows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-900 text-white font-bold text-[11px]">
                <tr>
                  <td colSpan={4} className="px-3 py-2">
                    {totals.count} {totals.count === 1 ? 'voucher' : 'vouchers'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.taxable)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.igst)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.cgst)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.sgst)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatINR(totals.tax)}</td>
                  <td colSpan={7}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ── Footnote: classification rules ───────────────────────────────── */}
      <details className="bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 group">
        <summary className="px-4 py-2.5 cursor-pointer font-semibold text-slate-700 hover:bg-slate-100 rounded-xl select-none">
          How vouchers are classified
        </summary>
        <div className="px-4 pb-4 pt-2 space-y-1 leading-relaxed">
          <p><strong>Eligible voucher:</strong> <code>is_accounting_voucher = 1</code> AND has at least one accounting line under Purchase Accounts / Direct Expenses / Indirect Expenses / Fixed Assets (parent-chain walk).</p>
          <p><strong>GST input ledger:</strong> parent group = <code>GST</code> OR (parent = <code>Duties &amp; Taxes</code> AND <code>gst_duty_head</code> populated), AND name does <em>not</em> contain output-tax keywords (<code>output</code>, <code>sales cgst/igst/sgst</code>, <code>payable/c</code>, <code>gst payable</code>, <code>gst cash</code>, <code>accrued</code>). Use the <strong>GST Ledgers</strong> button to manually add ledgers not picked up by auto-detection.</p>
          <p><strong>RCM input:</strong> GST input ledger with <code>RCM</code> in name; excludes <code>RCM Payable</code>.</p>
          <p><strong>Type:</strong> <code>RCM-UR</code> if any RCM line; else <code>IMPORTSERVICE</code> if no supplier GSTIN AND IGST&gt;0 AND CGST=0; else <code>B2B</code>.</p>
          <p><strong>Invoice number:</strong> <code>reference_number</code> (supplier inv#) if present, else <code>voucher_number</code>. <strong>Invoice date:</strong> <code>reference_date</code> if present, else voucher date.</p>
        </div>
      </details>
    </div>
  );
};

// ── Sub-components ─────────────────────────────────────────────────────────

const IssueCard: React.FC<{
  icon: React.ReactNode;
  accent: 'orange' | 'red' | 'yellow';
  title: string;
  subtitle: string;
  count: number;
  active: boolean;
  onClick: () => void;
}> = ({ icon, accent, title, subtitle, count, active, onClick }) => {
  const accentMap = {
    orange: { ring: 'ring-orange-400', border: 'border-orange-200', text: 'text-orange-700', bg: 'bg-orange-50' },
    red:    { ring: 'ring-red-400',    border: 'border-red-200',    text: 'text-red-700',    bg: 'bg-red-50' },
    yellow: { ring: 'ring-yellow-400', border: 'border-yellow-200', text: 'text-yellow-700', bg: 'bg-yellow-50' },
  } as const;
  const c = accentMap[accent];
  const okState = count === 0;

  return (
    <button onClick={onClick} disabled={okState && !active}
      className={`text-left p-3 rounded-xl border bg-white shadow-sm transition-all ${
        active ? `ring-2 ${c.ring} ${c.border}` : 'border-slate-200 hover:border-slate-300'
      } ${okState ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}>
      <div className="flex items-start gap-2">
        <div className={`shrink-0 w-8 h-8 rounded-lg ${c.bg} ${c.text} flex items-center justify-center`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-slate-900 truncate">{title}</p>
          <p className="text-[10px] text-slate-500 truncate">{subtitle}</p>
        </div>
        <div className={`text-xl font-black ${okState ? 'text-emerald-600' : c.text}`}>
          {okState ? '✓' : count}
        </div>
      </div>
    </button>
  );
};

const Th: React.FC<{ children: React.ReactNode; numeric?: boolean }> = ({ children, numeric }) => (
  <th className={`px-3 py-2 ${numeric ? 'text-right' : 'text-left'} whitespace-nowrap`}>{children}</th>
);

const Td: React.FC<{ children: React.ReactNode; numeric?: boolean; className?: string; title?: string }> =
  ({ children, numeric, className = '', title }) => (
    <td title={title} className={`px-3 py-1.5 ${numeric ? 'text-right font-mono tabular-nums' : ''} ${className}`}>
      {children}
    </td>
  );

export default PurchaseGSTRegister;
