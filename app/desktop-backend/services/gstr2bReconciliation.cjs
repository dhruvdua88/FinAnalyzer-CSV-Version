const XLSX = require('xlsx-js-style');
const crypto = require('node:crypto');

const STATUS = {
  MATCH: 'MATCH',
  ONLY_IN_BOOKS: 'ONLY_IN_BOOKS',
  ONLY_IN_2B: 'ONLY_IN_2B',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DATE_MISMATCH: 'DATE_MISMATCH',
  RCM_MISMATCH: 'RCM_MISMATCH',
  DUPLICATE: 'DUPLICATE',
};

const MATCH_PASS = {
  STRICT: 'A_STRICT',
  GSTIN_INVOICE: 'B_GSTIN_INVOICE',
  GSTIN_NORMALIZED_INVOICE: 'C_GSTIN_NORMALIZED_INVOICE',
  GSTIN_AMOUNT_FALLBACK: 'D_GSTIN_AMOUNT_FALLBACK',
  UNMATCHED_BOOKS: 'UNMATCHED_BOOKS',
  UNMATCHED_2B: 'UNMATCHED_2B',
};

const MATCH_PASS_LABEL = {
  [MATCH_PASS.STRICT]: 'Strict GSTIN + Invoice + Date',
  [MATCH_PASS.GSTIN_INVOICE]: 'GSTIN + Invoice (Date Variance Aware)',
  [MATCH_PASS.GSTIN_NORMALIZED_INVOICE]: 'GSTIN + Normalized Invoice',
  [MATCH_PASS.GSTIN_AMOUNT_FALLBACK]: 'GSTIN + Amount Fallback',
  [MATCH_PASS.UNMATCHED_BOOKS]: 'No 2B Candidate',
  [MATCH_PASS.UNMATCHED_2B]: 'No Books Candidate',
};

const MATCH_PASS_CONFIDENCE = {
  [MATCH_PASS.STRICT]: 'HIGH',
  [MATCH_PASS.GSTIN_INVOICE]: 'HIGH',
  [MATCH_PASS.GSTIN_NORMALIZED_INVOICE]: 'MEDIUM',
  [MATCH_PASS.GSTIN_AMOUNT_FALLBACK]: 'LOW',
  [MATCH_PASS.UNMATCHED_BOOKS]: 'NA',
  [MATCH_PASS.UNMATCHED_2B]: 'NA',
};

const THIN_BORDER = {
  top: { style: 'thin', color: { rgb: 'FFD9DEE6' } },
  bottom: { style: 'thin', color: { rgb: 'FFD9DEE6' } },
  left: { style: 'thin', color: { rgb: 'FFD9DEE6' } },
  right: { style: 'thin', color: { rgb: 'FFD9DEE6' } },
};

const HEADER_STYLE = {
  font: { bold: true, color: { rgb: 'FFFFFFFF' }, name: 'Calibri', sz: 11 },
  fill: { fgColor: { rgb: 'FF1F4E78' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: THIN_BORDER,
};

const SECTION_STYLE = {
  font: { bold: true, color: { rgb: 'FF1F4E78' }, name: 'Calibri', sz: 11 },
  fill: { fgColor: { rgb: 'FFEAF1FB' } },
  alignment: { horizontal: 'left', vertical: 'center' },
  border: THIN_BORDER,
};

const mergeCellStyle = (base = {}, patch = {}) => ({
  ...base,
  ...patch,
  font: { ...(base.font || {}), ...(patch.font || {}) },
  fill: { ...(base.fill || {}), ...(patch.fill || {}) },
  alignment: { ...(base.alignment || {}), ...(patch.alignment || {}) },
  border: { ...(base.border || {}), ...(patch.border || {}) },
});

const applyStylePatch = (cell, stylePatch) => {
  if (!cell) return;
  cell.s = mergeCellStyle(cell.s || {}, stylePatch);
};

const getSheetRange = (sheet) => {
  if (!sheet || !sheet['!ref']) return null;
  return XLSX.utils.decode_range(sheet['!ref']);
};

const applyHeaderStyle = (sheet) => {
  const range = getSheetRange(sheet);
  if (!range) return;
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    applyStylePatch(cell, HEADER_STYLE);
  }
};

const applyAutoFilter = (sheet) => {
  if (!sheet || !sheet['!ref']) return;
  sheet['!autofilter'] = { ref: sheet['!ref'] };
};

const getHeaderIndexMap = (sheet) => {
  const range = getSheetRange(sheet);
  const map = new Map();
  if (!range) return map;
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    const key = normalizeUpper(cell?.v || '');
    if (key) map.set(key, col);
  }
  return map;
};

const applyNumberFormats = (sheet, numberHeaders = []) => {
  const range = getSheetRange(sheet);
  if (!range) return;
  const headerMap = getHeaderIndexMap(sheet);
  const cols = numberHeaders
    .map((header) => headerMap.get(normalizeUpper(header)))
    .filter((col) => Number.isInteger(col));
  if (!cols.length) return;

  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    cols.forEach((col) => {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = sheet[address];
      if (!cell || (cell.t !== 'n' && typeof cell.v !== 'number')) return;
      cell.z = '#,##0.00';
      applyStylePatch(cell, {
        alignment: { horizontal: 'right', vertical: 'center' },
        border: THIN_BORDER,
      });
    });
  }
};

const applyStatusHighlights = (sheet, statusHeader = 'Status') => {
  const range = getSheetRange(sheet);
  if (!range) return;
  const headerMap = getHeaderIndexMap(sheet);
  const statusCol = headerMap.get(normalizeUpper(statusHeader));
  if (!Number.isInteger(statusCol)) return;

  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: statusCol })];
    const status = normalizeUpper(cell?.v || '');
    if (!status) continue;
    if (status === STATUS.MATCH) {
      applyStylePatch(cell, {
        font: { bold: true, color: { rgb: 'FF1F7A1F' } },
      });
    } else {
      applyStylePatch(cell, {
        font: { bold: true, color: { rgb: 'FF9F1D1D' } },
      });
    }
  }
};

const styleTabularSheet = (sheet, options = {}) => {
  if (!sheet || !sheet['!ref']) return;
  applyHeaderStyle(sheet);
  applyAutoFilter(sheet);
  applyNumberFormats(sheet, Array.isArray(options.numberHeaders) ? options.numberHeaders : []);
  if (options.statusHeader) applyStatusHighlights(sheet, options.statusHeader);
  if (Array.isArray(options.cols)) sheet['!cols'] = options.cols;
};

const toTableRows = (rows, fallbackColumn = 'Info', fallbackValue = 'No records found for selected scope.') => {
  if (Array.isArray(rows) && rows.length > 0) return rows;
  return [{ [fallbackColumn]: fallbackValue }];
};

const normalizeText = (value) => String(value ?? '').trim();

const normalizeUpper = (value) => normalizeText(value).toUpperCase();

const normalizeGstin = (value) => {
  const gstin = normalizeUpper(value);
  return /^[0-9A-Z]{15}$/.test(gstin) ? gstin : '';
};

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = normalizeText(value).replace(/,/g, '');
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value) => Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;

const normalizeInvoiceNo = (value) => normalizeUpper(value);

const normalizeInvoiceNoLoose = (value) => normalizeUpper(value).replace(/[^0-9A-Z]/g, '');

const isAccountingVoucher = (value) => {
  const text = normalizeText(value).toLowerCase();
  if (!text) return true;
  if (['1', 'true', 'yes', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'n'].includes(text)) return false;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed > 0 : false;
};

const isMasterLedger = (value) => {
  const text = normalizeText(value).toLowerCase();
  if (!text) return false;
  if (['1', 'true', 'yes', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'n'].includes(text)) return false;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed > 0 : false;
};

const parseDateToIso = (value) => {
  const raw = normalizeText(value);
  if (!raw) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  if (/^\d{8}$/.test(raw)) {
    const yyyy = raw.slice(0, 4);
    const mm = raw.slice(4, 6);
    const dd = raw.slice(6, 8);
    const dt = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (dt.getFullYear() === Number(yyyy) && dt.getMonth() === Number(mm) - 1 && dt.getDate() === Number(dd)) {
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  const dmyMatch = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (dmyMatch) {
    const dd = Number(dmyMatch[1]);
    const mm = Number(dmyMatch[2]);
    const yyyy = Number(dmyMatch[3]);
    const dt = new Date(yyyy, mm - 1, dd);
    if (dt.getFullYear() === yyyy && dt.getMonth() === mm - 1 && dt.getDate() === dd) {
      return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
};

const isoToDdMmYyyy = (isoDate) => {
  const d = parseDateToIso(isoDate);
  if (!d) return '';
  const [yyyy, mm, dd] = d.split('-');
  return `${dd}/${mm}/${yyyy}`;
};

const getMonthKeyFromIso = (isoDate) => {
  const d = parseDateToIso(isoDate);
  if (!d) return '';
  return `${d.slice(5, 7)}/${d.slice(0, 4)}`;
};

const normalizeScopeMonth = (value) => {
  const raw = normalizeText(value);
  if (!raw || raw.toLowerCase() === 'all') return 'All';
  if (/^\d{2}\/\d{4}$/.test(raw)) return raw;
  if (/^\d{6}$/.test(raw)) return `${raw.slice(0, 2)}/${raw.slice(2, 6)}`;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
  return raw;
};

const normalizeScopeMonths = (value) => {
  const list = Array.isArray(value) ? value : [value];
  const normalized = list.map(normalizeScopeMonth).filter(Boolean);
  if (normalized.length === 0) return new Set(['All']);
  if (normalized.includes('All')) return new Set(['All']);
  return new Set(normalized);
};

const abs = (value) => Math.abs(toNumber(value));

const normalizeRcFlag = (value) => {
  const text = normalizeText(value).toUpperCase();
  if (!text) return false;
  return text === 'Y' || text === 'YES' || text === 'TRUE' || text === '1';
};

const taxHeadFromLedger = (ledgerName) => {
  const text = normalizeText(ledgerName).toLowerCase();
  if (text.includes('igst')) return 'IGST';
  if (text.includes('cgst')) return 'CGST';
  if (text.includes('sgst') || text.includes('utgst')) return 'SGST';
  if (text.includes('cess')) return 'CESS';
  return '';
};

const amountTotal = (doc) => round2(toNumber(doc.taxable) + toNumber(doc.igst) + toNumber(doc.cgst) + toNumber(doc.sgst) + toNumber(doc.cess));

const taxTotal = (doc) => round2(toNumber(doc.igst) + toNumber(doc.cgst) + toNumber(doc.sgst) + toNumber(doc.cess));

const isPrimaryImpactRow = (row) => {
  const primary = normalizeText(row?.TallyPrimary || row?.tally_primary).toLowerCase();
  return primary.includes('purchase') || primary.includes('expense') || primary.includes('fixed asset');
};

const getBranchValue = (row) =>
  normalizeText(
    row?.branch ||
      row?.Branch ||
      row?.location ||
      row?.Location ||
      row?.godown ||
      row?.Godown ||
      row?.cost_center ||
      row?.costCenter ||
      ''
  );

const getBooksPartyName = (row) =>
  normalizeText(
    row?.party_name ||
      row?.partyName ||
      row?.['Party Name'] ||
      row?.Party ||
      row?.party ||
      row?.Ledger ||
      row?.ledger ||
      ''
  );

const getBooksSupplierGstin = (row) =>
  normalizeGstin(
    row?.gstin ||
      row?.GSTIN ||
      row?.gstn ||
      row?.GSTN ||
      row?.['Party GSTIN'] ||
      row?.party_gstin ||
      row?.['Party GSTIN/UIN'] ||
      row?.party_gstin_uin ||
      row?.['Supplier GSTIN'] ||
      row?.supplier_gstin ||
      row?.supplierGstin ||
      row?.ctin ||
      row?.CTIN ||
      ''
  );

const getBooksInvoiceNo = (row) =>
  normalizeInvoiceNo(
    row?.invoice_number ||
      row?.invoiceNo ||
      row?.['Invoice No'] ||
      row?.['Invoice Number'] ||
      row?.['Inv No'] ||
      row?.voucher_number ||
      row?.voucherNo ||
      row?.['Voucher No'] ||
      row?.reference_number ||
      row?.referenceNo ||
      row?.['Reference No'] ||
      ''
  );

const getBooksDateIso = (row) =>
  parseDateToIso(
    row?.date ||
      row?.Date ||
      row?.voucher_date ||
      row?.['Voucher Date'] ||
      row?.invoice_date ||
      row?.['Invoice Date'] ||
      ''
  );

const getEntityGstinValue = (row) =>
  normalizeGstin(row?.entity_gstin || row?.entityGstin || row?.company_gstin || row?.companyGstin || row?.gstin_entity || row?.entity || '');

const recommendAction = (status) => {
  if (status === STATUS.ONLY_IN_BOOKS) return 'Follow up with vendor to upload invoice in GSTR-1 / 2B.';
  if (status === STATUS.ONLY_IN_2B) return 'Record missing invoice in books or fix GSTIN/invoice mapping.';
  if (status === STATUS.AMOUNT_MISMATCH) return 'Review tax/taxable values and pass correction entry.';
  if (status === STATUS.DATE_MISMATCH) return 'Verify invoice date and posting date; amend period if required.';
  if (status === STATUS.RCM_MISMATCH) return 'Review reverse-charge classification in books and return.';
  if (status === STATUS.DUPLICATE) return 'Identify and remove duplicate invoice/note records.';
  return 'No action required.';
};

const parse2BJson = (input, meta = {}) => {
  let parsed = input;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error('Invalid JSON. Please provide a valid GSTR-2B JSON payload.');
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON payload. Expected an object.');
  }

  const data = parsed.data;
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid GSTR-2B JSON shape. Missing root key: data.');
  }

  const docdata = data.docdata || {};
  const b2b = Array.isArray(docdata.b2b) ? docdata.b2b : [];
  const cdnr = Array.isArray(docdata.cdnr) ? docdata.cdnr : [];
  const b2ba = Array.isArray(docdata.b2ba) ? docdata.b2ba : [];

  const rows = [];

  const pushRow = ({
    section,
    supplier,
    row,
    sign = 1,
    entityGstin,
    parentType = '',
    amended = false,
  }) => {
    const invoiceNo = normalizeInvoiceNo(row?.inum || row?.nt_num || row?.ntnum || row?.docnum || row?.doc_no || '');
    const invoiceNoNorm = normalizeInvoiceNoLoose(invoiceNo);
    if (!invoiceNoNorm) return;

    const invoiceDate = parseDateToIso(row?.dt || row?.nt_dt || row?.ntdt || row?.idt || row?.docdt || '');
    const taxable = round2(sign * toNumber(row?.txval));
    const igst = round2(sign * toNumber(row?.igst));
    const cgst = round2(sign * toNumber(row?.cgst));
    const sgst = round2(sign * toNumber(row?.sgst));
    const cess = round2(sign * toNumber(row?.cess));
    const value = round2(sign * toNumber(row?.val || amountTotal({ taxable, igst, cgst, sgst, cess })));

    rows.push({
      importRowId: `${section}-${rows.length + 1}`,
      section,
      supplierGstin: normalizeGstin(supplier?.ctin || supplier?.gstin || ''),
      supplierName: normalizeText(supplier?.trdnm || supplier?.legal_name || ''),
      invoiceNo,
      invoiceNoNorm,
      invoiceDate,
      invoiceDateDisplay: isoToDdMmYyyy(invoiceDate),
      taxable,
      igst,
      cgst,
      sgst,
      cess,
      totalTax: taxTotal({ igst, cgst, sgst, cess }),
      totalValue: value,
      reverseCharge: normalizeRcFlag(row?.rev),
      type: normalizeUpper(parentType || section),
      itcAvailability: normalizeUpper(row?.itcavl || ''),
      pos: normalizeText(row?.pos || ''),
      entityGstin: normalizeGstin(entityGstin),
      branch: '',
      isAmended: amended,
      isISD: normalizeUpper(parentType || section).includes('ISD'),
      raw: row,
    });
  };

  b2b.forEach((supplier) => {
    const inv = Array.isArray(supplier?.inv) ? supplier.inv : [];
    inv.forEach((row) => {
      pushRow({ section: 'B2B', supplier, row, sign: 1, entityGstin: data.gstin, parentType: 'B2B' });
    });
  });

  cdnr.forEach((supplier) => {
    const notes = Array.isArray(supplier?.nt) ? supplier.nt : [];
    notes.forEach((row) => {
      const ntty = normalizeUpper(row?.ntty || row?.nt_type || '');
      const sign = ntty.startsWith('C') ? -1 : 1;
      pushRow({ section: 'CDNR', supplier, row, sign, entityGstin: data.gstin, parentType: `CDNR_${ntty || 'N'}` });
    });
  });

  b2ba.forEach((supplier) => {
    const inv = Array.isArray(supplier?.inv) ? supplier.inv : [];
    inv.forEach((row) => {
      pushRow({ section: 'B2BA', supplier, row, sign: 1, entityGstin: data.gstin, parentType: 'B2BA', amended: true });
    });
  });

  if (rows.length === 0) {
    throw new Error('No invoices found in JSON. Expected data.docdata.b2b[].inv[] and/or data.docdata.cdnr[].nt[].');
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.taxable += row.taxable;
      acc.igst += row.igst;
      acc.cgst += row.cgst;
      acc.sgst += row.sgst;
      acc.cess += row.cess;
      acc.totalTax += row.totalTax;
      acc.totalValue += row.totalValue;
      return acc;
    },
    { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, totalTax: 0, totalValue: 0 }
  );

  const counts = {
    totalDocuments: rows.length,
    b2bDocuments: rows.filter((x) => x.section === 'B2B').length,
    cdnrDocuments: rows.filter((x) => x.section === 'CDNR').length,
    b2baDocuments: rows.filter((x) => x.section === 'B2BA').length,
  };

  const entityGstin = normalizeGstin(data.gstin || meta?.entityGstin || '');

  return {
    metadata: {
      rtnprd: normalizeText(data.rtnprd || ''),
      entityGstin,
      version: normalizeText(data.version || ''),
      generatedAt: normalizeText(data.gendt || ''),
      uploadedAt: new Date().toISOString(),
      sourceName: normalizeText(meta?.sourceName || ''),
    },
    counts,
    totals: {
      taxable: round2(totals.taxable),
      igst: round2(totals.igst),
      cgst: round2(totals.cgst),
      sgst: round2(totals.sgst),
      cess: round2(totals.cess),
      totalTax: round2(totals.totalTax),
      totalValue: round2(totals.totalValue),
    },
    rows,
  };
};

const normalizeBooks = (booksRows, options = {}) => {
  const rows = Array.isArray(booksRows) ? booksRows : [];
  const selectedGstLedgers = new Set((options?.selectedGstLedgers || []).map((x) => normalizeUpper(x)).filter(Boolean));
  const selectedRcmLedgers = new Set((options?.selectedRcmLedgers || []).map((x) => normalizeUpper(x)).filter(Boolean));
  const requireNonZeroTax = options?.requireNonZeroTax !== false;
  const nonZeroTaxMin = Number.isFinite(Number(options?.nonZeroTaxMin)) ? Number(options.nonZeroTaxMin) : 0.005;

  const monthScopes = normalizeScopeMonths(options?.months ?? options?.month);
  const entityScope = normalizeGstin(options?.entityGstin || '');
  const branchScope = normalizeUpper(options?.branch || '');

  const groups = new Map();
  const docMetaByKey = new Map();

  const getDocBasics = (row) => {
    const dateIso = getBooksDateIso(row);
    if (!dateIso) return null;

    const monthKey = getMonthKeyFromIso(dateIso);
    if (!monthScopes.has('All') && !monthScopes.has(monthKey)) return null;

    const entityGstin = getEntityGstinValue(row);
    if (entityScope && entityGstin && entityGstin !== entityScope) return null;

    const branch = getBranchValue(row);
    if (branchScope && !normalizeUpper(branch).includes(branchScope)) return null;

    const invoiceNo = getBooksInvoiceNo(row);
    if (!invoiceNo) return null;
    const invoiceNoNorm = normalizeInvoiceNoLoose(invoiceNo);
    if (!invoiceNoNorm) return null;

    return { dateIso, invoiceNo, invoiceNoNorm, entityGstin, branch };
  };

  // Pass 1: collect GSTIN / party from all accounting lines, including non-tax party ledger lines.
  rows.forEach((row) => {
    if (!isAccountingVoucher(row?.is_accounting_voucher)) return;
    if (isMasterLedger(row?.is_master_ledger)) return;
    const basics = getDocBasics(row);
    if (!basics) return;

    const docKey = `${basics.invoiceNo}|${basics.dateIso}`;
    if (!docMetaByKey.has(docKey)) {
      docMetaByKey.set(docKey, {
        supplierGstin: '',
        supplierName: '',
        entityGstin: basics.entityGstin,
        branch: basics.branch,
        hasPrimaryLine: false,
      });
    }

    const meta = docMetaByKey.get(docKey);
    const supplierGstin = getBooksSupplierGstin(row);
    const supplierName = getBooksPartyName(row);
    const isPrimary = isPrimaryImpactRow(row);

    if (supplierGstin && !meta.supplierGstin) meta.supplierGstin = supplierGstin;
    if (supplierName && !meta.supplierName) meta.supplierName = supplierName;
    if (basics.entityGstin && !meta.entityGstin) meta.entityGstin = basics.entityGstin;
    if (basics.branch && !meta.branch) meta.branch = basics.branch;
    if (isPrimary) meta.hasPrimaryLine = true;
  });

  // Pass 2: aggregate tax-bearing purchase-register lines to invoice level.
  rows.forEach((row) => {
    if (!isAccountingVoucher(row?.is_accounting_voucher)) return;
    if (isMasterLedger(row?.is_master_ledger)) return;
    const basics = getDocBasics(row);
    if (!basics) return;

    const docKey = `${basics.invoiceNo}|${basics.dateIso}`;
    const meta = docMetaByKey.get(docKey) || {};
    const supplierGstin = getBooksSupplierGstin(row) || normalizeGstin(meta.supplierGstin || '');

    const ledgerName = normalizeUpper(row?.Ledger || row?.ledger || '');
    const taxHead = taxHeadFromLedger(ledgerName);
    const hasSelectedTaxLedger = selectedGstLedgers.size > 0 && selectedGstLedgers.has(ledgerName);
    const isDefaultTaxLedger =
      selectedGstLedgers.size === 0 && ['IGST', 'CGST', 'SGST', 'CESS'].includes(taxHead);
    const isTaxLedger = hasSelectedTaxLedger || isDefaultTaxLedger;
    const isPrimary = isPrimaryImpactRow(row);

    if (!isTaxLedger && !isPrimary) return;
    if (isTaxLedger && !isPrimary && !meta.hasPrimaryLine) return;

    const strictKey = docKey;
    let agg = groups.get(strictKey);
    if (!agg) {
      agg = {
        source: 'BOOKS',
        supplierGstin,
        supplierName: normalizeText(meta.supplierName || getBooksPartyName(row)),
        invoiceNo: basics.invoiceNo,
        invoiceNoNorm: basics.invoiceNoNorm,
        invoiceDate: basics.dateIso,
        invoiceDateDisplay: isoToDdMmYyyy(basics.dateIso),
        taxable: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
        totalTax: 0,
        totalValue: 0,
        reverseCharge: false,
        type: normalizeUpper(row?.Type || row?.type || ''),
        entityGstin: basics.entityGstin || normalizeGstin(meta.entityGstin || ''),
        branch: basics.branch || normalizeText(meta.branch || ''),
        isAmended: false,
        isISD: false,
        lineCount: 0,
      };
      groups.set(strictKey, agg);
    }

    const amount = abs(row?.amount);
    const partyName = getBooksPartyName(row);
    agg.lineCount += 1;
    if (supplierGstin && !agg.supplierGstin) agg.supplierGstin = supplierGstin;
    if (partyName && !agg.supplierName) agg.supplierName = partyName;

    if (isPrimary) agg.taxable = round2(agg.taxable + amount);
    if (isTaxLedger) {
      if (taxHead === 'IGST') agg.igst = round2(agg.igst + amount);
      if (taxHead === 'CGST') agg.cgst = round2(agg.cgst + amount);
      if (taxHead === 'SGST') agg.sgst = round2(agg.sgst + amount);
      if (taxHead === 'CESS') agg.cess = round2(agg.cess + amount);
    }

    if (selectedRcmLedgers.has(ledgerName)) agg.reverseCharge = true;
    const sourceType = normalizeUpper(row?.Type || row?.type || row?.voucher_type || '');
    if (sourceType && !agg.type) agg.type = sourceType;

    const isdTag =
      ledgerName.includes('ISD') ||
      normalizeUpper(row?.Type || row?.type || '').includes('ISD') ||
      normalizeUpper(row?.TallyPrimary || row?.tally_primary || '').includes('ISD');
    if (isdTag) agg.isISD = true;
  });

  const normalized = Array.from(groups.values())
    .map((row) => {
      const next = {
        ...row,
        totalTax: taxTotal(row),
        totalValue: amountTotal(row),
      };
      return next;
    })
    // Reconciliation should use Purchase Register-style tax-bearing documents only.
    .filter((row) => (requireNonZeroTax ? abs(row.totalTax) > nonZeroTaxMin : true));

  const duplicateLooseCount = new Map();
  normalized.forEach((row) => {
    const key = `${row.supplierGstin}|${row.invoiceNoNorm}`;
    duplicateLooseCount.set(key, (duplicateLooseCount.get(key) || 0) + 1);
  });

  normalized.forEach((row) => {
    const key = `${row.supplierGstin}|${row.invoiceNoNorm}`;
    row.isDuplicate = (duplicateLooseCount.get(key) || 0) > 1;
  });

  return normalized;
};

const buildLookupMaps = (docs, keyFn) => {
  const map = new Map();
  docs.forEach((doc, idx) => {
    const key = keyFn(doc);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(idx);
  });
  return map;
};

const dayDiff = (d1, d2) => {
  if (!d1 || !d2) return Number.POSITIVE_INFINITY;
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(t1 - t2) / (24 * 60 * 60 * 1000));
};

const getStatusFromPair = (book, portal, options) => {
  const invTolerance = toNumber(options?.invTolerance ?? 10);
  const enableDateTolerance = options?.enableDateTolerance !== false;
  const dateToleranceDays = Number.isFinite(Number(options?.dateToleranceDays))
    ? Number(options.dateToleranceDays)
    : 2;

  if (book?.isDuplicate || portal?.isDuplicate) return STATUS.DUPLICATE;
  if (!!book?.reverseCharge !== !!portal?.reverseCharge) return STATUS.RCM_MISMATCH;

  const totalValueDiff = round2(toNumber(book?.totalValue) - toNumber(portal?.totalValue));
  const totalTaxDiff = round2(toNumber(book?.totalTax) - toNumber(portal?.totalTax));
  if (abs(totalValueDiff) > invTolerance || abs(totalTaxDiff) > invTolerance) return STATUS.AMOUNT_MISMATCH;

  const dDiff = dayDiff(book?.invoiceDate, portal?.invoiceDate);
  if (Number.isFinite(dDiff) && dDiff > 0) {
    if (!enableDateTolerance || dDiff > dateToleranceDays) return STATUS.DATE_MISMATCH;
  }

  return STATUS.MATCH;
};

const applyScopeToDocs = (docs, scope = {}, sourceType = 'BOOKS') => {
  const monthScopes = normalizeScopeMonths(scope?.months ?? scope?.month);
  const entityScope = normalizeGstin(scope?.entityGstin || '');
  const branchScope = normalizeUpper(scope?.branch || '');

  return docs.filter((doc) => {
    const monthKey = getMonthKeyFromIso(doc?.invoiceDate || '');
    if (!monthScopes.has('All') && !monthScopes.has(monthKey)) return false;

    if (entityScope) {
      const docEntity = normalizeGstin(doc?.entityGstin || '');
      if (docEntity && docEntity !== entityScope) return false;
      if (sourceType === 'PORTAL' && !docEntity) return false;
    }

    if (branchScope && sourceType === 'BOOKS') {
      const branch = normalizeUpper(doc?.branch || '');
      if (!branch.includes(branchScope)) return false;
    }

    return true;
  });
};

const buildInvoiceResult = ({ book, portal, status, matchPass }) => {
  const booksGstin = normalizeGstin(book?.supplierGstin || '');
  const twoBGstin = normalizeGstin(portal?.supplierGstin || '');
  const gstin = normalizeGstin(booksGstin || twoBGstin || '');
  const invoiceNo = normalizeInvoiceNo(book?.invoiceNo || portal?.invoiceNo || '');
  const invoiceNoNorm = normalizeInvoiceNoLoose(invoiceNo);

  const books = book || {
    supplierName: '',
    taxable: 0,
    igst: 0,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 0,
    totalValue: 0,
    reverseCharge: false,
    invoiceDate: '',
    type: '',
    isISD: false,
  };

  const portalData = portal || {
    supplierName: '',
    taxable: 0,
    igst: 0,
    cgst: 0,
    sgst: 0,
    cess: 0,
    totalTax: 0,
    totalValue: 0,
    reverseCharge: false,
    invoiceDate: '',
    type: '',
    isISD: false,
  };

  const taxableDiff = round2(toNumber(books.taxable) - toNumber(portalData.taxable));
  const igstDiff = round2(toNumber(books.igst) - toNumber(portalData.igst));
  const cgstDiff = round2(toNumber(books.cgst) - toNumber(portalData.cgst));
  const sgstDiff = round2(toNumber(books.sgst) - toNumber(portalData.sgst));
  const cessDiff = round2(toNumber(books.cess) - toNumber(portalData.cess));
  const totalTaxDiff = round2(toNumber(books.totalTax) - toNumber(portalData.totalTax));
  const totalValueDiff = round2(toNumber(books.totalValue) - toNumber(portalData.totalValue));

  const invoiceDateBooks = parseDateToIso(books.invoiceDate);
  const invoiceDatePortal = parseDateToIso(portalData.invoiceDate);
  const matchMethod = MATCH_PASS_LABEL[matchPass] || matchPass || '';
  const matchConfidence = MATCH_PASS_CONFIDENCE[matchPass] || 'NA';
  const computedDateDiff = dayDiff(invoiceDateBooks, invoiceDatePortal);
  const dateDiffDays = Number.isFinite(computedDateDiff) ? computedDateDiff : '';

  const statusExplanation = (() => {
    if (status === STATUS.MATCH) return 'Matched within configured invoice/date tolerance.';
    if (status === STATUS.DATE_MISMATCH) {
      const days = Number.isFinite(computedDateDiff) ? computedDateDiff : '';
      return days === '' ? 'Invoice date mismatch between books and 2B.' : `Invoice dates differ by ${days} day(s).`;
    }
    if (status === STATUS.AMOUNT_MISMATCH) {
      return `Value diff ${round2(totalValueDiff).toFixed(2)}, tax diff ${round2(totalTaxDiff).toFixed(2)} beyond tolerance.`;
    }
    if (status === STATUS.RCM_MISMATCH) return 'Reverse-charge flag differs between books and 2B.';
    if (status === STATUS.ONLY_IN_BOOKS) return 'Present in purchase register but not found in selected 2B data.';
    if (status === STATUS.ONLY_IN_2B) return 'Present in selected 2B data but not found in purchase register.';
    if (status === STATUS.DUPLICATE) return 'Duplicate invoice detected in books and/or 2B data.';
    return 'Review invoice mapping and source data.';
  })();

  return {
    gstin,
    booksGstin,
    twoBGstin,
    booksPartyName: normalizeText(books.supplierName),
    twoBPartyName: normalizeText(portalData.supplierName),
    partyName: normalizeText(books.supplierName || portalData.supplierName),
    invoiceNo,
    invoiceNoNorm,
    invoiceDateBooks,
    invoiceDateBooksDisplay: isoToDdMmYyyy(invoiceDateBooks),
    invoiceDate2B: invoiceDatePortal,
    invoiceDate2BDisplay: isoToDdMmYyyy(invoiceDatePortal),
    dateDiffDays,
    booksTaxable: round2(books.taxable),
    booksIgst: round2(books.igst),
    booksCgst: round2(books.cgst),
    booksSgst: round2(books.sgst),
    booksCess: round2(books.cess),
    booksTotalTax: round2(books.totalTax),
    booksTotalValue: round2(books.totalValue),
    twoBTaxable: round2(portalData.taxable),
    twoBIgst: round2(portalData.igst),
    twoBCgst: round2(portalData.cgst),
    twoBSgst: round2(portalData.sgst),
    twoBCess: round2(portalData.cess),
    twoBTotalTax: round2(portalData.totalTax),
    twoBTotalValue: round2(portalData.totalValue),
    taxableDiff,
    igstDiff,
    cgstDiff,
    sgstDiff,
    cessDiff,
    totalTaxDiff,
    totalValueDiff,
    booksReverseCharge: !!books.reverseCharge,
    twoBReverseCharge: !!portalData.reverseCharge,
    booksType: normalizeUpper(books.type),
    twoBType: normalizeUpper(portalData.type),
    status,
    statusExplanation,
    reasonCode: status,
    recommendedAction: recommendAction(status),
    matchPass,
    matchMethod,
    matchConfidence,
    isISD: !!books.isISD,
  };
};

const generateSummary = (invoiceResults, options = {}, isdExcludedRows = []) => {
  const gstTolerance = toNumber(options?.gstTolerance ?? 50);

  const byStatus = {
    [STATUS.MATCH]: 0,
    [STATUS.ONLY_IN_BOOKS]: 0,
    [STATUS.ONLY_IN_2B]: 0,
    [STATUS.AMOUNT_MISMATCH]: 0,
    [STATUS.DATE_MISMATCH]: 0,
    [STATUS.RCM_MISMATCH]: 0,
    [STATUS.DUPLICATE]: 0,
  };

  const gstinAgg = new Map();
  const partyGstinAgg = new Map();
  const statusAgg = new Map();

  const getAgg = (gstin) => {
    const key = gstin || 'UNREGISTERED';
    if (!gstinAgg.has(key)) {
      gstinAgg.set(key, {
        gstin: key,
        onlyInBooksCount: 0,
        onlyInBooksTaxDiff: 0,
        onlyIn2BCount: 0,
        onlyIn2BTaxDiff: 0,
        bothCount: 0,
        booksTax: 0,
        twoBTax: 0,
        taxDiff: 0,
        duplicateCount: 0,
      });
    }
    return gstinAgg.get(key);
  };

  invoiceResults.forEach((row) => {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;

    const selectedGstin = normalizeGstin(row.booksGstin || row.twoBGstin || row.gstin || '');
    const agg = getAgg(selectedGstin);
    const selectedPartyName = normalizeText(row.partyName || row.booksPartyName || row.twoBPartyName || '') || 'UNKNOWN PARTY';
    const partyKey = `${selectedGstin || 'UNREGISTERED'}|${selectedPartyName}`;

    if (!partyGstinAgg.has(partyKey)) {
      partyGstinAgg.set(partyKey, {
        gstin: selectedGstin || 'UNREGISTERED',
        partyName: selectedPartyName,
        invoiceCount: 0,
        matchCount: 0,
        mismatchCount: 0,
        onlyInBooksCount: 0,
        onlyIn2BCount: 0,
        duplicateCount: 0,
        booksTotalTax: 0,
        twoBTotalTax: 0,
        taxDiff: 0,
        booksTotalValue: 0,
        twoBTotalValue: 0,
        valueDiff: 0,
      });
    }

    const partyBucket = partyGstinAgg.get(partyKey);
    partyBucket.invoiceCount += 1;
    if (row.status === STATUS.MATCH) partyBucket.matchCount += 1;
    if (row.status !== STATUS.MATCH) partyBucket.mismatchCount += 1;
    if (row.status === STATUS.ONLY_IN_BOOKS) partyBucket.onlyInBooksCount += 1;
    if (row.status === STATUS.ONLY_IN_2B) partyBucket.onlyIn2BCount += 1;
    if (row.status === STATUS.DUPLICATE) partyBucket.duplicateCount += 1;
    partyBucket.booksTotalTax = round2(partyBucket.booksTotalTax + toNumber(row.booksTotalTax));
    partyBucket.twoBTotalTax = round2(partyBucket.twoBTotalTax + toNumber(row.twoBTotalTax));
    partyBucket.taxDiff = round2(partyBucket.booksTotalTax - partyBucket.twoBTotalTax);
    partyBucket.booksTotalValue = round2(partyBucket.booksTotalValue + toNumber(row.booksTotalValue));
    partyBucket.twoBTotalValue = round2(partyBucket.twoBTotalValue + toNumber(row.twoBTotalValue));
    partyBucket.valueDiff = round2(partyBucket.booksTotalValue - partyBucket.twoBTotalValue);

    if (!statusAgg.has(row.status)) {
      statusAgg.set(row.status, {
        status: row.status,
        invoiceCount: 0,
        booksTotalTax: 0,
        twoBTotalTax: 0,
        taxDiff: 0,
        booksTotalValue: 0,
        twoBTotalValue: 0,
        valueDiff: 0,
      });
    }
    const statusBucket = statusAgg.get(row.status);
    statusBucket.invoiceCount += 1;
    statusBucket.booksTotalTax = round2(statusBucket.booksTotalTax + toNumber(row.booksTotalTax));
    statusBucket.twoBTotalTax = round2(statusBucket.twoBTotalTax + toNumber(row.twoBTotalTax));
    statusBucket.taxDiff = round2(statusBucket.booksTotalTax - statusBucket.twoBTotalTax);
    statusBucket.booksTotalValue = round2(statusBucket.booksTotalValue + toNumber(row.booksTotalValue));
    statusBucket.twoBTotalValue = round2(statusBucket.twoBTotalValue + toNumber(row.twoBTotalValue));
    statusBucket.valueDiff = round2(statusBucket.booksTotalValue - statusBucket.twoBTotalValue);

    if (row.status === STATUS.ONLY_IN_BOOKS) {
      agg.onlyInBooksCount += 1;
      agg.onlyInBooksTaxDiff = round2(agg.onlyInBooksTaxDiff + row.booksTotalTax);
    } else if (row.status === STATUS.ONLY_IN_2B) {
      agg.onlyIn2BCount += 1;
      agg.onlyIn2BTaxDiff = round2(agg.onlyIn2BTaxDiff + row.twoBTotalTax);
    } else {
      agg.bothCount += 1;
      agg.booksTax = round2(agg.booksTax + row.booksTotalTax);
      agg.twoBTax = round2(agg.twoBTax + row.twoBTotalTax);
      agg.taxDiff = round2(agg.booksTax - agg.twoBTax);
      if (row.status === STATUS.DUPLICATE) agg.duplicateCount += 1;
    }
  });

  const onlyInBooks = [];
  const both = [];
  const onlyIn2B = [];

  Array.from(gstinAgg.values()).forEach((bucket) => {
    if (bucket.onlyInBooksCount > 0) {
      onlyInBooks.push({
        ...bucket,
        clientAction: 'Follow up with vendor for missing 2B visibility / filing.',
      });
    }

    if (bucket.bothCount > 0 && abs(bucket.taxDiff) >= gstTolerance) {
      both.push({
        ...bucket,
        clientAction:
          bucket.duplicateCount > 0
            ? 'Duplicate documents detected. Clean duplicates and re-run.'
            : 'Investigate GST/taxable difference and pass correction entry if required.',
      });
    }

    if (bucket.onlyIn2BCount > 0) {
      onlyIn2B.push({
        ...bucket,
        clientAction: 'Book missing invoices/notes or fix mapping in Purchase Register.',
      });
    }
  });

  both.sort((a, b) => abs(b.taxDiff) - abs(a.taxDiff));

  const isdByGstin = new Map();
  isdExcludedRows.forEach((row) => {
    const gstin = row.supplierGstin || 'UNREGISTERED';
    if (!isdByGstin.has(gstin)) {
      isdByGstin.set(gstin, {
        gstin,
        count: 0,
        totalTax: 0,
      });
    }
    const bucket = isdByGstin.get(gstin);
    bucket.count += 1;
    bucket.totalTax = round2(bucket.totalTax + toNumber(row.totalTax));
  });

  const totals = invoiceResults.reduce(
    (acc, row) => {
      acc.booksTotalTax += row.booksTotalTax;
      acc.twoBTotalTax += row.twoBTotalTax;
      acc.taxDiff += row.totalTaxDiff;
      return acc;
    },
    { booksTotalTax: 0, twoBTotalTax: 0, taxDiff: 0 }
  );

  const overallByPartyGstin = Array.from(partyGstinAgg.values())
    .sort((a, b) => {
      const diff = abs(b.taxDiff) - abs(a.taxDiff);
      if (diff !== 0) return diff;
      return b.invoiceCount - a.invoiceCount;
    });

  const invoiceStatusSummary = Array.from(statusAgg.values()).sort((a, b) =>
    (b.invoiceCount || 0) - (a.invoiceCount || 0)
  );

  return {
    byStatus,
    totals: {
      booksTotalTax: round2(totals.booksTotalTax),
      twoBTotalTax: round2(totals.twoBTotalTax),
      taxDiff: round2(totals.taxDiff),
      invoiceCount: invoiceResults.length,
      isdExcludedCount: isdExcludedRows.length,
    },
    gstinSummary: {
      onlyInBooks,
      both,
      onlyIn2B,
      isdExcluded: Array.from(isdByGstin.values()),
    },
    overallByPartyGstin,
    invoiceStatusSummary,
  };
};

const buildActionList = (invoiceResults) => ({
  vendorChaseList: invoiceResults.filter((x) => x.status === STATUS.ONLY_IN_BOOKS),
  correctionList: invoiceResults.filter((x) => [STATUS.AMOUNT_MISMATCH, STATUS.DATE_MISMATCH, STATUS.RCM_MISMATCH, STATUS.ONLY_IN_2B].includes(x.status)),
  duplicateCleanupList: invoiceResults.filter((x) => x.status === STATUS.DUPLICATE),
});

const compareMatchCandidates = (a, b) => {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.valueDiff !== b.valueDiff) return a.valueDiff - b.valueDiff;
  if (a.taxDiff !== b.taxDiff) return a.taxDiff - b.taxDiff;
  if (a.dateDiff !== b.dateDiff) return a.dateDiff - b.dateDiff;
  if (a.bookIdx !== b.bookIdx) return a.bookIdx - b.bookIdx;
  return a.portalIdx - b.portalIdx;
};

const finiteDayDiff = (d1, d2) => {
  const diff = dayDiff(d1, d2);
  return Number.isFinite(diff) ? diff : 999999;
};

const _reconcileImpl = (booksDocsRaw, portalDocsRaw, options = {}) => {
  const config = {
    enableDateTolerance: options?.enableDateTolerance !== false,
    dateToleranceDays: Number.isFinite(Number(options?.dateToleranceDays)) ? Number(options?.dateToleranceDays) : 2,
    invTolerance: Number.isFinite(Number(options?.invTolerance)) ? Number(options?.invTolerance) : 10,
    gstTolerance: Number.isFinite(Number(options?.gstTolerance)) ? Number(options?.gstTolerance) : 50,
    allowAmountFallback: options?.allowAmountFallback === true,
  };

  const scopedBooksDocs = applyScopeToDocs(booksDocsRaw, options?.scope || {}, 'BOOKS');
  const scopedPortalDocs = applyScopeToDocs(portalDocsRaw, options?.scope || {}, 'PORTAL');

  const isdExcludedRows = scopedBooksDocs.filter((x) => !!x.isISD);
  const booksDocs = scopedBooksDocs.filter((x) => !x.isISD);
  const portalDocs = scopedPortalDocs;

  const booksUsed = new Set();
  const portalUsed = new Set();
  const pairs = [];

  const strictKeyRaw = (doc) => `${doc.supplierGstin}|${doc.invoiceNo}|${doc.invoiceDate}`;
  const invoiceKeyRaw = (doc) => `${doc.supplierGstin}|${doc.invoiceNo}`;
  const invoiceKeyLoose = (doc) => `${doc.supplierGstin}|${doc.invoiceNoNorm}`;
  const gstinKey = (doc) => `${doc.supplierGstin}`;

  const portalStrictMap = buildLookupMaps(portalDocs, strictKeyRaw);
  const portalInvoiceRawMap = buildLookupMaps(portalDocs, invoiceKeyRaw);
  const portalInvoiceLooseMap = buildLookupMaps(portalDocs, invoiceKeyLoose);
  const portalGstinMap = buildLookupMaps(portalDocs, gstinKey);
  const allocatePairsFromCandidates = ({ pass, priority, getCandidates, filterCandidate }) => {
    const candidates = [];
    booksDocs.forEach((book, bookIdx) => {
      if (booksUsed.has(bookIdx)) return;
      const candidateIndexes = getCandidates(book, bookIdx) || [];
      candidateIndexes.forEach((portalIdx) => {
        if (portalUsed.has(portalIdx)) return;
        const portal = portalDocs[portalIdx];
        if (!portal) return;
        const candidate = {
          pass,
          priority,
          bookIdx,
          portalIdx,
          dateDiff: finiteDayDiff(book.invoiceDate, portal.invoiceDate),
          valueDiff: abs(toNumber(book.totalValue) - toNumber(portal.totalValue)),
          taxDiff: abs(toNumber(book.totalTax) - toNumber(portal.totalTax)),
        };
        if (filterCandidate && !filterCandidate(candidate, book, portal)) return;
        candidates.push(candidate);
      });
    });

    candidates.sort(compareMatchCandidates);
    candidates.forEach((candidate) => {
      if (booksUsed.has(candidate.bookIdx)) return;
      if (portalUsed.has(candidate.portalIdx)) return;
      booksUsed.add(candidate.bookIdx);
      portalUsed.add(candidate.portalIdx);
      pairs.push({
        bookIdx: candidate.bookIdx,
        portalIdx: candidate.portalIdx,
        pass: candidate.pass,
      });
    });
  };

  allocatePairsFromCandidates({
    pass: MATCH_PASS.STRICT,
    priority: 400,
    getCandidates: (book) => portalStrictMap.get(strictKeyRaw(book)) || [],
  });

  allocatePairsFromCandidates({
    pass: MATCH_PASS.GSTIN_INVOICE,
    priority: 300,
    getCandidates: (book) => portalInvoiceRawMap.get(invoiceKeyRaw(book)) || [],
  });

  allocatePairsFromCandidates({
    pass: MATCH_PASS.GSTIN_NORMALIZED_INVOICE,
    priority: 200,
    getCandidates: (book) => portalInvoiceLooseMap.get(invoiceKeyLoose(book)) || [],
  });

  if (config.allowAmountFallback) {
    allocatePairsFromCandidates({
      pass: MATCH_PASS.GSTIN_AMOUNT_FALLBACK,
      priority: 100,
      getCandidates: (book) => portalGstinMap.get(gstinKey(book)) || [],
      filterCandidate: (candidate) =>
        candidate.valueDiff <= config.invTolerance &&
        candidate.taxDiff <= config.invTolerance &&
        candidate.dateDiff <= Math.max(31, config.dateToleranceDays * 5),
    });
  }

  const invoiceResults = [];

  pairs.forEach((pair) => {
    const book = booksDocs[pair.bookIdx];
    const portal = portalDocs[pair.portalIdx];
    const status = getStatusFromPair(book, portal, config);
    invoiceResults.push(
      buildInvoiceResult({
        book,
        portal,
        status,
        matchPass: pair.pass,
      })
    );
  });

  booksDocs.forEach((book, idx) => {
    if (booksUsed.has(idx)) return;
    const status = book.isDuplicate ? STATUS.DUPLICATE : STATUS.ONLY_IN_BOOKS;
    invoiceResults.push(
      buildInvoiceResult({
        book,
        portal: null,
        status,
        matchPass: MATCH_PASS.UNMATCHED_BOOKS,
      })
    );
  });

  portalDocs.forEach((portal, idx) => {
    if (portalUsed.has(idx)) return;
    const status = portal.isDuplicate ? STATUS.DUPLICATE : STATUS.ONLY_IN_2B;
    invoiceResults.push(
      buildInvoiceResult({
        book: null,
        portal,
        status,
        matchPass: MATCH_PASS.UNMATCHED_2B,
      })
    );
  });

  const summary = generateSummary(invoiceResults, config, isdExcludedRows);
  const actionList = buildActionList(invoiceResults);

  const invoiceMismatches = invoiceResults
    .filter((x) => x.status !== STATUS.MATCH)
    .sort((a, b) => {
      if (a.gstin !== b.gstin) return a.gstin.localeCompare(b.gstin);
      if (a.invoiceDateBooks !== b.invoiceDateBooks) return (a.invoiceDateBooks || '').localeCompare(b.invoiceDateBooks || '');
      return (a.invoiceNo || '').localeCompare(b.invoiceNo || '');
    });

  return {
    config,
    scope: (() => {
      const months = Array.from(normalizeScopeMonths(options?.scope?.months ?? options?.scope?.month));
      return {
        month: months.includes('All') ? 'All' : (months[0] || 'All'),
        months,
        entityGstin: normalizeGstin(options?.scope?.entityGstin || ''),
        branch: normalizeText(options?.scope?.branch || ''),
      };
    })(),
    counts: {
      booksConsidered: booksDocs.length,
      portalConsidered: portalDocs.length,
      matched: invoiceResults.filter((x) => x.status === STATUS.MATCH).length,
      mismatches: invoiceMismatches.length,
      isdExcluded: isdExcludedRows.length,
    },
    summary,
    invoiceResults,
    invoiceMismatches,
    actionList,
  };
};

/**
 * Memoised wrapper around _reconcileImpl.
 *
 * Reconciliation is a pure function of (books, portal, options) — same
 * inputs always produce the same output. The work itself (~hundreds of ms
 * on large datasets, dominated by hash-map construction over thousands of
 * docs) is wasted when the user re-invokes with identical inputs (e.g.
 * after toggling an unrelated UI panel that triggers a re-render).
 *
 * Cache strategy:
 *   - Key: SHA-256 of a stable JSON encoding of all three arguments.
 *     Includes scope, tolerances, all flags. Different scope → different key.
 *   - LRU with max RECONCILE_CACHE_LIMIT entries. On overflow, evict oldest.
 *   - Result is returned by reference. Callers MUST treat as read-only;
 *     deep-cloning every cached result would defeat the purpose.
 *
 * Callers can opt out per-call by setting `options.bypassCache = true`.
 */
const RECONCILE_CACHE_LIMIT = 5;
const _reconcileCache = new Map();

const _reconcileCacheKey = (booksDocsRaw, portalDocsRaw, options) => {
  // JSON.stringify is sufficient for hashing here: the inputs are plain
  // objects produced by the parsers, no Date instances or circular refs.
  // We hash the JSON rather than using it directly so the cache key
  // doesn't grow with input size.
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(booksDocsRaw || []));
  hash.update('|');
  hash.update(JSON.stringify(portalDocsRaw || []));
  hash.update('|');
  // Strip bypassCache from the keyed options so toggling it doesn't
  // pointlessly fragment the cache.
  const { bypassCache: _ignore, ...keyedOptions } = options || {};
  hash.update(JSON.stringify(keyedOptions));
  return hash.digest('hex');
};

const reconcile = (booksDocsRaw, portalDocsRaw, options = {}) => {
  if (options?.bypassCache === true) {
    return _reconcileImpl(booksDocsRaw, portalDocsRaw, options);
  }

  const key = _reconcileCacheKey(booksDocsRaw, portalDocsRaw, options);
  const cached = _reconcileCache.get(key);
  if (cached) {
    // Touch to refresh LRU position (Map preserves insertion order).
    _reconcileCache.delete(key);
    _reconcileCache.set(key, cached);
    return cached;
  }

  const result = _reconcileImpl(booksDocsRaw, portalDocsRaw, options);
  _reconcileCache.set(key, result);
  // Evict oldest entries on overflow.
  while (_reconcileCache.size > RECONCILE_CACHE_LIMIT) {
    const oldestKey = _reconcileCache.keys().next().value;
    _reconcileCache.delete(oldestKey);
  }
  return result;
};

/** Test-only: reset the LRU cache. Used by reconciliation.test.cjs. */
const _resetReconcileCache = () => {
  _reconcileCache.clear();
};

const exportXlsx = (resultPayload) => {
  const result = resultPayload || {};
  const summary = result.summary || {};
  const gstinSummary = summary.gstinSummary || {};
  const allInvoiceRows = Array.isArray(result.invoiceResults) ? result.invoiceResults : [];
  const invoiceRows = Array.isArray(result.invoiceMismatches) ? result.invoiceMismatches : allInvoiceRows.filter((x) => x.status !== STATUS.MATCH);
  const matchedRows = allInvoiceRows.filter((x) => x.status === STATUS.MATCH);
  const actionList = result.actionList || {};
  const overallByPartyGstin = Array.isArray(summary.overallByPartyGstin) ? summary.overallByPartyGstin : [];
  const invoiceStatusSummary = Array.isArray(summary.invoiceStatusSummary) ? summary.invoiceStatusSummary : [];

  const mapInvoiceRowForExport = (row) => ({
    GSTIN: row.gstin,
    BooksGSTIN: row.booksGstin || '',
    TwoBGSTIN: row.twoBGstin || '',
    PartyName: row.partyName || '',
    BooksPartyName: row.booksPartyName || '',
    TwoBPartyName: row.twoBPartyName || '',
    InvoiceNo: row.invoiceNo,
    InvoiceNoNormalized: row.invoiceNoNorm,
    BooksDate: row.invoiceDateBooksDisplay,
    TwoBDate: row.invoiceDate2BDisplay,
    DateDiffDays: row.dateDiffDays,
    Status: row.status,
    StatusExplanation: row.statusExplanation || '',
    ReasonCode: row.reasonCode,
    MatchPass: row.matchPass,
    MatchMethod: row.matchMethod || '',
    MatchConfidence: row.matchConfidence || '',
    BooksType: row.booksType,
    TwoBType: row.twoBType,
    BooksRCM: row.booksReverseCharge ? 'Yes' : 'No',
    TwoBRCM: row.twoBReverseCharge ? 'Yes' : 'No',
    BooksTaxable: row.booksTaxable,
    BooksIGST: row.booksIgst,
    BooksCGST: row.booksCgst,
    BooksSGST: row.booksSgst,
    BooksCESS: row.booksCess,
    BooksTotalTax: row.booksTotalTax,
    BooksTotalValue: row.booksTotalValue,
    TwoBTaxable: row.twoBTaxable,
    TwoBIGST: row.twoBIgst,
    TwoBCGST: row.twoBCgst,
    TwoBSGST: row.twoBSgst,
    TwoBCESS: row.twoBCess,
    TwoBTotalTax: row.twoBTotalTax,
    TwoBTotalValue: row.twoBTotalValue,
    DiffTaxable: row.taxableDiff,
    DiffIGST: row.igstDiff,
    DiffCGST: row.cgstDiff,
    DiffSGST: row.sgstDiff,
    DiffCESS: row.cessDiff,
    DiffTotalTax: row.totalTaxDiff,
    DiffTotalValue: row.totalValueDiff,
    RecommendedAction: row.recommendedAction,
  });

  const summaryRows = [];
  const scopeMonths = Array.isArray(result?.scope?.months) && result.scope.months.length > 0
    ? result.scope.months.join(', ')
    : normalizeText(result?.scope?.month || 'All');

  summaryRows.push({ Section: 'Run Scope', Metric: 'Periods', Value: scopeMonths });
  summaryRows.push({ Section: 'Run Scope', Metric: 'Entity GSTIN', Value: normalizeText(result?.scope?.entityGstin || 'Any') });
  summaryRows.push({ Section: 'Run Scope', Metric: 'Branch', Value: normalizeText(result?.scope?.branch || 'Any') });
  summaryRows.push({ Section: 'Run Scope', Metric: 'Generated At', Value: normalizeText(result?.generatedAt || new Date().toISOString()) });
  summaryRows.push({ Section: 'Run Summary', Metric: 'Invoices in Scope (Books)', Value: result?.counts?.booksConsidered || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: 'Invoices in Scope (2B)', Value: result?.counts?.portalConsidered || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: 'Matched', Value: result?.counts?.matched || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: 'Mismatches', Value: result?.counts?.mismatches || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: 'ISD Excluded', Value: result?.counts?.isdExcluded || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: 'Books Total Tax', Value: summary?.totals?.booksTotalTax || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: '2B Total Tax', Value: summary?.totals?.twoBTotalTax || 0 });
  summaryRows.push({ Section: 'Run Summary', Metric: 'Tax Difference', Value: summary?.totals?.taxDiff || 0 });

  Object.entries(summary?.byStatus || {}).forEach(([status, count]) => {
    summaryRows.push({ Section: 'Status Counts', Metric: status, Value: count });
  });

  (gstinSummary.onlyInBooks || []).forEach((row) => {
    summaryRows.push({
      Section: 'Only in Books',
      Metric: row.gstin,
      Value: row.onlyInBooksTaxDiff,
      Count: row.onlyInBooksCount,
      ClientAction: row.clientAction,
    });
  });

  (gstinSummary.both || []).forEach((row) => {
    summaryRows.push({
      Section: 'Both (Diff >= GST_TOL)',
      Metric: row.gstin,
      Value: row.taxDiff,
      Count: row.bothCount,
      ClientAction: row.clientAction,
    });
  });

  (gstinSummary.onlyIn2B || []).forEach((row) => {
    summaryRows.push({
      Section: 'Only in 2B',
      Metric: row.gstin,
      Value: row.onlyIn2BTaxDiff,
      Count: row.onlyIn2BCount,
      ClientAction: row.clientAction,
    });
  });

  (gstinSummary.isdExcluded || []).forEach((row) => {
    summaryRows.push({
      Section: 'ISD Excluded',
      Metric: row.gstin,
      Value: row.totalTax,
      Count: row.count,
      ClientAction: 'Review ISD entries separately.',
    });
  });

  const actionRows = [];
  const mismatchReasonRows = [];
  const invoiceSummaryRows = allInvoiceRows.map((row) => ({
    GSTIN: row.gstin,
    PartyName: row.partyName || '',
    InvoiceNo: row.invoiceNo,
    BooksDate: row.invoiceDateBooksDisplay,
    TwoBDate: row.invoiceDate2BDisplay,
    Status: row.status,
    StatusExplanation: row.statusExplanation || '',
    MatchPass: row.matchPass,
    MatchMethod: row.matchMethod || '',
    MatchConfidence: row.matchConfidence || '',
    BooksTotalTax: row.booksTotalTax,
    TwoBTotalTax: row.twoBTotalTax,
    DiffTotalTax: row.totalTaxDiff,
    BooksTotalValue: row.booksTotalValue,
    TwoBTotalValue: row.twoBTotalValue,
    DiffTotalValue: row.totalValueDiff,
  }));

  const overallRows = overallByPartyGstin.map((row) => ({
    GSTIN: row.gstin,
    PartyName: row.partyName,
    InvoiceCount: row.invoiceCount,
    MatchCount: row.matchCount,
    MismatchCount: row.mismatchCount,
    OnlyInBooksCount: row.onlyInBooksCount,
    OnlyIn2BCount: row.onlyIn2BCount,
    DuplicateCount: row.duplicateCount,
    BooksTotalTax: row.booksTotalTax,
    TwoBTotalTax: row.twoBTotalTax,
    TaxDiff: row.taxDiff,
    BooksTotalValue: row.booksTotalValue,
    TwoBTotalValue: row.twoBTotalValue,
    ValueDiff: row.valueDiff,
  }));

  const statusSummaryRows = invoiceStatusSummary.map((row) => ({
    Status: row.status,
    InvoiceCount: row.invoiceCount,
    BooksTotalTax: row.booksTotalTax,
    TwoBTotalTax: row.twoBTotalTax,
    TaxDiff: row.taxDiff,
    BooksTotalValue: row.booksTotalValue,
    TwoBTotalValue: row.twoBTotalValue,
    ValueDiff: row.valueDiff,
  }));

  const mismatchReasonAgg = new Map();
  invoiceRows.forEach((row) => {
    const key = `${row.status || ''}|${row.matchMethod || ''}|${row.matchConfidence || ''}`;
    if (!mismatchReasonAgg.has(key)) {
      mismatchReasonAgg.set(key, {
        Status: row.status || '',
        MatchMethod: row.matchMethod || '',
        MatchConfidence: row.matchConfidence || '',
        InvoiceCount: 0,
        TotalTaxDiff: 0,
        TotalValueDiff: 0,
      });
    }
    const bucket = mismatchReasonAgg.get(key);
    bucket.InvoiceCount += 1;
    bucket.TotalTaxDiff = round2(bucket.TotalTaxDiff + toNumber(row.totalTaxDiff));
    bucket.TotalValueDiff = round2(bucket.TotalValueDiff + toNumber(row.totalValueDiff));
  });
  mismatchReasonRows.push(...Array.from(mismatchReasonAgg.values()).sort((a, b) => b.InvoiceCount - a.InvoiceCount));

  const dataDictionaryRows = [
    { Sheet: 'Summary', Purpose: 'Run scope, KPIs, status counts and GSTIN action buckets.' },
    { Sheet: 'Overall Party GSTIN', Purpose: 'Overall reconciliation summary grouped by Party Name + GSTIN.' },
    { Sheet: 'Status Summary', Purpose: 'Invoice-wise status summary with tax and value totals.' },
    { Sheet: 'Mismatch Reason Summary', Purpose: 'Non-matches grouped by status + match method + confidence.' },
    { Sheet: 'Invoice Summary', Purpose: 'Invoice-wise roll-up (all invoices) with status and tax/value diffs.' },
    { Sheet: 'GSTIN Summary', Purpose: 'Only in Books / Both / Only in 2B / ISD excluded buckets by GSTIN.' },
    { Sheet: 'Matches', Purpose: 'Matched invoices only (full detail).' },
    { Sheet: 'Mismatches', Purpose: 'All non-match invoices (full detail).' },
    { Sheet: 'All Details', Purpose: 'Full invoice-level output for all statuses.' },
    { Sheet: 'Action List', Purpose: 'Vendor chase, correction and duplicate clean-up worklists.' },
  ];

  const gstinSummaryRows = [];
  (gstinSummary.onlyInBooks || []).forEach((row) => {
    gstinSummaryRows.push({
      Section: 'Only in Books',
      GSTIN: row.gstin,
      Count: row.onlyInBooksCount,
      BooksTax: row.onlyInBooksTaxDiff,
      TwoBTax: 0,
      TaxDiff: row.onlyInBooksTaxDiff,
      ClientAction: row.clientAction,
    });
  });
  (gstinSummary.both || []).forEach((row) => {
    gstinSummaryRows.push({
      Section: 'Both (Diff >= GST_TOL)',
      GSTIN: row.gstin,
      Count: row.bothCount,
      BooksTax: row.booksTax,
      TwoBTax: row.twoBTax,
      TaxDiff: row.taxDiff,
      ClientAction: row.clientAction,
    });
  });
  (gstinSummary.onlyIn2B || []).forEach((row) => {
    gstinSummaryRows.push({
      Section: 'Only in 2B',
      GSTIN: row.gstin,
      Count: row.onlyIn2BCount,
      BooksTax: 0,
      TwoBTax: row.onlyIn2BTaxDiff,
      TaxDiff: round2(0 - toNumber(row.onlyIn2BTaxDiff)),
      ClientAction: row.clientAction,
    });
  });
  (gstinSummary.isdExcluded || []).forEach((row) => {
    gstinSummaryRows.push({
      Section: 'ISD Excluded',
      GSTIN: row.gstin,
      Count: row.count,
      BooksTax: row.totalTax,
      TwoBTax: 0,
      TaxDiff: row.totalTax,
      ClientAction: 'Review ISD entries separately.',
    });
  });

  (actionList.vendorChaseList || []).forEach((row) => {
    actionRows.push({
      ActionBucket: 'Vendor Chase List',
      GSTIN: row.gstin,
      BooksGSTIN: row.booksGstin || '',
      TwoBGSTIN: row.twoBGstin || '',
      PartyName: row.partyName || '',
      InvoiceNo: row.invoiceNo,
      BooksDate: row.invoiceDateBooksDisplay,
      TwoBDate: row.invoiceDate2BDisplay,
      Status: row.status,
      RecommendedAction: row.recommendedAction,
      TotalTaxDiff: row.totalTaxDiff,
      TotalValueDiff: row.totalValueDiff,
    });
  });

  (actionList.correctionList || []).forEach((row) => {
    actionRows.push({
      ActionBucket: 'Correction List',
      GSTIN: row.gstin,
      BooksGSTIN: row.booksGstin || '',
      TwoBGSTIN: row.twoBGstin || '',
      PartyName: row.partyName || '',
      InvoiceNo: row.invoiceNo,
      BooksDate: row.invoiceDateBooksDisplay,
      TwoBDate: row.invoiceDate2BDisplay,
      Status: row.status,
      RecommendedAction: row.recommendedAction,
      TotalTaxDiff: row.totalTaxDiff,
      TotalValueDiff: row.totalValueDiff,
    });
  });

  (actionList.duplicateCleanupList || []).forEach((row) => {
    actionRows.push({
      ActionBucket: 'Duplicate Cleanup List',
      GSTIN: row.gstin,
      BooksGSTIN: row.booksGstin || '',
      TwoBGSTIN: row.twoBGstin || '',
      PartyName: row.partyName || '',
      InvoiceNo: row.invoiceNo,
      BooksDate: row.invoiceDateBooksDisplay,
      TwoBDate: row.invoiceDate2BDisplay,
      Status: row.status,
      RecommendedAction: row.recommendedAction,
      TotalTaxDiff: row.totalTaxDiff,
      TotalValueDiff: row.totalValueDiff,
    });
  });

  const workbook = XLSX.utils.book_new();
  const dataDictionarySheet = XLSX.utils.json_to_sheet(toTableRows(dataDictionaryRows));
  const summarySheet = XLSX.utils.json_to_sheet(toTableRows(summaryRows));
  const overallSheet = XLSX.utils.json_to_sheet(toTableRows(overallRows, 'Info', 'No overall party-level records.'));
  const statusSummarySheet = XLSX.utils.json_to_sheet(toTableRows(statusSummaryRows, 'Info', 'No status summary records.'));
  const mismatchReasonSheet = XLSX.utils.json_to_sheet(toTableRows(mismatchReasonRows, 'Info', 'No mismatch reason records.'));
  const invoiceSummarySheet = XLSX.utils.json_to_sheet(toTableRows(invoiceSummaryRows, 'Info', 'No invoice-level records.'));
  const gstinSummarySheet = XLSX.utils.json_to_sheet(toTableRows(gstinSummaryRows, 'Info', 'No GSTIN summary records.'));
  const mismatchSheet = XLSX.utils.json_to_sheet(toTableRows(invoiceRows.map(mapInvoiceRowForExport), 'Info', 'No mismatches found.'));
  const matchSheet = XLSX.utils.json_to_sheet(toTableRows(matchedRows.map(mapInvoiceRowForExport), 'Info', 'No matches found.'));
  const allDetailsSheet = XLSX.utils.json_to_sheet(toTableRows(allInvoiceRows.map(mapInvoiceRowForExport), 'Info', 'No invoice details found.'));
  const actionSheet = XLSX.utils.json_to_sheet(toTableRows(actionRows, 'Info', 'No action items generated.'));

  styleTabularSheet(dataDictionarySheet, {
    cols: [{ wch: 24 }, { wch: 96 }],
  });
  styleTabularSheet(summarySheet, {
    cols: [{ wch: 24 }, { wch: 36 }, { wch: 18 }, { wch: 12 }, { wch: 56 }],
    numberHeaders: ['Value', 'Count'],
  });
  styleTabularSheet(overallSheet, {
    cols: [
      { wch: 18 }, { wch: 34 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
      { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 },
    ],
    numberHeaders: ['BooksTotalTax', 'TwoBTotalTax', 'TaxDiff', 'BooksTotalValue', 'TwoBTotalValue', 'ValueDiff'],
  });
  styleTabularSheet(statusSummarySheet, {
    cols: [{ wch: 20 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }],
    numberHeaders: ['BooksTotalTax', 'TwoBTotalTax', 'TaxDiff', 'BooksTotalValue', 'TwoBTotalValue', 'ValueDiff'],
    statusHeader: 'Status',
  });
  styleTabularSheet(mismatchReasonSheet, {
    cols: [{ wch: 20 }, { wch: 32 }, { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 16 }],
    numberHeaders: ['TotalTaxDiff', 'TotalValueDiff'],
    statusHeader: 'Status',
  });
  styleTabularSheet(invoiceSummarySheet, {
    cols: [{ wch: 18 }, { wch: 34 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 40 }, { wch: 24 }, { wch: 32 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }],
    numberHeaders: ['BooksTotalTax', 'TwoBTotalTax', 'DiffTotalTax', 'BooksTotalValue', 'TwoBTotalValue', 'DiffTotalValue'],
    statusHeader: 'Status',
  });
  styleTabularSheet(gstinSummarySheet, {
    cols: [{ wch: 22 }, { wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 52 }],
    numberHeaders: ['BooksTax', 'TwoBTax', 'TaxDiff'],
  });
  const invoiceCols = [
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 30 }, { wch: 30 }, { wch: 30 }, { wch: 20 }, { wch: 20 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 40 }, { wch: 18 }, { wch: 32 }, { wch: 16 }, { wch: 26 },
    { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 10 },
    { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
    { wch: 42 },
  ];
  const invoiceNumberHeaders = [
    'BooksTaxable', 'BooksIGST', 'BooksCGST', 'BooksSGST', 'BooksCESS', 'BooksTotalTax', 'BooksTotalValue',
    'TwoBTaxable', 'TwoBIGST', 'TwoBCGST', 'TwoBSGST', 'TwoBCESS', 'TwoBTotalTax', 'TwoBTotalValue',
    'DiffTaxable', 'DiffIGST', 'DiffCGST', 'DiffSGST', 'DiffCESS', 'DiffTotalTax', 'DiffTotalValue',
  ];
  styleTabularSheet(mismatchSheet, { cols: invoiceCols, numberHeaders: invoiceNumberHeaders, statusHeader: 'Status' });
  styleTabularSheet(matchSheet, { cols: invoiceCols, numberHeaders: invoiceNumberHeaders, statusHeader: 'Status' });
  styleTabularSheet(allDetailsSheet, { cols: invoiceCols, numberHeaders: invoiceNumberHeaders, statusHeader: 'Status' });
  styleTabularSheet(actionSheet, {
    cols: [{ wch: 24 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 48 }, { wch: 14 }, { wch: 14 }],
    numberHeaders: ['TotalTaxDiff', 'TotalValueDiff'],
    statusHeader: 'Status',
  });

  const summaryRange = getSheetRange(summarySheet);
  if (summaryRange) {
    for (let row = summaryRange.s.r + 1; row <= summaryRange.e.r; row += 1) {
      const sectionCell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
      const sectionText = normalizeUpper(sectionCell?.v || '');
      if (sectionText === 'RUN SCOPE' || sectionText === 'RUN SUMMARY') {
        for (let col = summaryRange.s.c; col <= summaryRange.e.c; col += 1) {
          const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: col })];
          applyStylePatch(cell, SECTION_STYLE);
        }
      }
    }
  }

  XLSX.utils.book_append_sheet(workbook, dataDictionarySheet, 'Data Dictionary');
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(workbook, overallSheet, 'Overall Party GSTIN');
  XLSX.utils.book_append_sheet(workbook, statusSummarySheet, 'Status Summary');
  XLSX.utils.book_append_sheet(workbook, mismatchReasonSheet, 'Mismatch Reason Summary');
  XLSX.utils.book_append_sheet(workbook, invoiceSummarySheet, 'Invoice Summary');
  XLSX.utils.book_append_sheet(workbook, gstinSummarySheet, 'GSTIN Summary');
  XLSX.utils.book_append_sheet(workbook, matchSheet, 'Matches');
  XLSX.utils.book_append_sheet(workbook, mismatchSheet, 'Mismatches');
  XLSX.utils.book_append_sheet(workbook, allDetailsSheet, 'All Details');
  XLSX.utils.book_append_sheet(workbook, actionSheet, 'Action List');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true, cellStyles: true });
};

module.exports = {
  STATUS,
  parse2BJson,
  normalizeBooks,
  reconcile,
  generateSummary,
  exportXlsx,
  _resetReconcileCache,
  _internal: {
    parseDateToIso,
    isoToDdMmYyyy,
    normalizeInvoiceNoLoose,
    normalizeScopeMonth,
  },
};
