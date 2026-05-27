const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parse2BJson,
  normalizeBooks,
  reconcile,
  STATUS,
} = require('../services/gstr2bReconciliation.cjs');

test('strict match: gstin + invoice + date', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '012026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              {
                inum: 'INV-001',
                dt: '19-01-2026',
                txval: 1000,
                igst: 0,
                cgst: 90,
                sgst: 90,
                cess: 0,
                rev: 'N',
              },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      {
        date: '2026-01-19',
        voucher_number: 'INV-001',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Purchase A/c',
        amount: -1000,
        TallyPrimary: 'Purchase Accounts',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-19',
        voucher_number: 'INV-001',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Input CGST',
        amount: -90,
        TallyPrimary: 'Duties & Taxes',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-19',
        voucher_number: 'INV-001',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Input SGST',
        amount: -90,
        TallyPrimary: 'Duties & Taxes',
        is_accounting_voucher: 1,
      },
    ],
    { selectedGstLedgers: ['Input CGST', 'Input SGST'] }
  );

  const result = reconcile(books, parsed.rows, { scope: { month: 'All' } });
  assert.equal(result.summary.byStatus[STATUS.MATCH], 1);
  assert.equal(result.invoiceMismatches.length, 0);
});

test('normalized invoice match: INV 001 vs INV/001', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '012026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              {
                inum: 'INV/001',
                dt: '20-01-2026',
                txval: 1000,
                igst: 180,
                cgst: 0,
                sgst: 0,
                cess: 0,
                rev: 'N',
              },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      {
        date: '2026-01-20',
        voucher_number: 'INV 001',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Purchase A/c',
        amount: -1000,
        TallyPrimary: 'Purchase Accounts',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-20',
        voucher_number: 'INV 001',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Input IGST',
        amount: -180,
        TallyPrimary: 'Duties & Taxes',
        is_accounting_voucher: 1,
      },
    ],
    { selectedGstLedgers: ['Input IGST'] }
  );

  const result = reconcile(books, parsed.rows, { scope: { month: 'All' } });
  assert.equal(result.summary.byStatus[STATUS.MATCH], 1);
});

test('only-in cases: one only in books and one only in 2B', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '012026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              {
                inum: 'INV-ONLY-2B',
                dt: '21-01-2026',
                txval: 800,
                igst: 0,
                cgst: 72,
                sgst: 72,
                cess: 0,
                rev: 'N',
              },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      {
        date: '2026-01-21',
        voucher_number: 'INV-ONLY-BOOKS',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Purchase A/c',
        amount: -500,
        TallyPrimary: 'Purchase Accounts',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-21',
        voucher_number: 'INV-ONLY-BOOKS',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Input CGST',
        amount: -45,
        TallyPrimary: 'Duties & Taxes',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-21',
        voucher_number: 'INV-ONLY-BOOKS',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Input SGST',
        amount: -45,
        TallyPrimary: 'Duties & Taxes',
        is_accounting_voucher: 1,
      },
    ],
    { selectedGstLedgers: ['Input CGST', 'Input SGST'] }
  );

  const result = reconcile(books, parsed.rows, { scope: { month: 'All' } });
  assert.equal(result.summary.byStatus[STATUS.ONLY_IN_BOOKS], 1);
  assert.equal(result.summary.byStatus[STATUS.ONLY_IN_2B], 1);
});

test('normalizeBooks excludes zero-tax purchase rows by default', () => {
  const books = normalizeBooks(
    [
      {
        date: '2026-01-25',
        voucher_number: 'INV-ZERO-TAX',
        gstin: '27AAAAB1234C1Z9',
        Ledger: 'Purchase A/c',
        amount: -1000,
        TallyPrimary: 'Purchase Accounts',
        is_accounting_voucher: 1,
      },
    ],
    { selectedGstLedgers: ['Input CGST', 'Input SGST'] }
  );

  assert.equal(books.length, 0);
});

test('reconcile supports multiple books periods in scope', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '012026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              { inum: 'INV-JAN', dt: '10-01-2026', txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, rev: 'N' },
              { inum: 'INV-FEB', dt: '10-02-2026', txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, rev: 'N' },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      { date: '2026-01-10', voucher_number: 'INV-JAN', gstin: '27AAAAB1234C1Z9', Ledger: 'Purchase A/c', amount: -1000, TallyPrimary: 'Purchase Accounts', is_accounting_voucher: 1 },
      { date: '2026-01-10', voucher_number: 'INV-JAN', gstin: '27AAAAB1234C1Z9', Ledger: 'Input IGST', amount: -180, TallyPrimary: 'Duties & Taxes', is_accounting_voucher: 1 },
      { date: '2026-02-10', voucher_number: 'INV-FEB', gstin: '27AAAAB1234C1Z9', Ledger: 'Purchase A/c', amount: -1000, TallyPrimary: 'Purchase Accounts', is_accounting_voucher: 1 },
      { date: '2026-02-10', voucher_number: 'INV-FEB', gstin: '27AAAAB1234C1Z9', Ledger: 'Input IGST', amount: -180, TallyPrimary: 'Duties & Taxes', is_accounting_voucher: 1 },
    ],
    { selectedGstLedgers: ['Input IGST'] }
  );

  const result = reconcile(books, parsed.rows, { scope: { months: ['01/2026', '02/2026'] } });
  assert.equal(result.summary.byStatus[STATUS.MATCH], 2);
});

test('books GSTIN is picked from non-tax party line aliases', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '012026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              {
                inum: 'INV-ALIAS-1',
                dt: '15-01-2026',
                txval: 1000,
                igst: 180,
                cgst: 0,
                sgst: 0,
                cess: 0,
                rev: 'N',
              },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      {
        date: '2026-01-15',
        voucher_number: 'INV-ALIAS-1',
        Ledger: 'Purchase A/c',
        amount: -1000,
        TallyPrimary: 'Purchase Accounts',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-15',
        voucher_number: 'INV-ALIAS-1',
        Ledger: 'Input IGST',
        amount: -180,
        TallyPrimary: 'Duties & Taxes',
        is_accounting_voucher: 1,
      },
      {
        date: '2026-01-15',
        voucher_number: 'INV-ALIAS-1',
        Ledger: 'Sundry Creditors',
        amount: 1180,
        'Party GSTIN': '27AAAAB1234C1Z9',
        party_name: 'ABC Traders',
        TallyPrimary: 'Sundry Creditors',
        is_accounting_voucher: 1,
      },
    ],
    { selectedGstLedgers: ['Input IGST'] }
  );

  assert.equal(books.length, 1);
  assert.equal(books[0].supplierGstin, '27AAAAB1234C1Z9');

  const result = reconcile(books, parsed.rows, { scope: { month: 'All' } });
  assert.equal(result.summary.byStatus[STATUS.MATCH], 1);
});

test('invoice no match with date variance is classified as DATE_MISMATCH (not only-in)', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '022026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              { inum: 'INV-DATE-1', dt: '05-02-2026', txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, rev: 'N' },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      { date: '2026-02-20', voucher_number: 'INV-DATE-1', gstin: '27AAAAB1234C1Z9', Ledger: 'Purchase A/c', amount: -1000, TallyPrimary: 'Purchase Accounts', is_accounting_voucher: 1 },
      { date: '2026-02-20', voucher_number: 'INV-DATE-1', gstin: '27AAAAB1234C1Z9', Ledger: 'Input IGST', amount: -180, TallyPrimary: 'Duties & Taxes', is_accounting_voucher: 1 },
    ],
    { selectedGstLedgers: ['Input IGST'] }
  );

  const result = reconcile(books, parsed.rows, {
    scope: { month: 'All' },
    enableDateTolerance: true,
    dateToleranceDays: 2,
  });

  assert.equal(result.summary.byStatus[STATUS.DATE_MISMATCH], 1);
  assert.equal(result.summary.byStatus[STATUS.ONLY_IN_BOOKS], 0);
  assert.equal(result.summary.byStatus[STATUS.ONLY_IN_2B], 0);
});

test('amount-only fallback is disabled by default to avoid false-positive matches', () => {
  const parsed = parse2BJson({
    data: {
      gstin: '27ABCDE1234F1Z5',
      rtnprd: '022026',
      docdata: {
        b2b: [
          {
            ctin: '27AAAAB1234C1Z9',
            inv: [
              { inum: 'INV-2B-ONLY-1', dt: '07-02-2026', txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, rev: 'N' },
            ],
          },
        ],
      },
    },
  });

  const books = normalizeBooks(
    [
      { date: '2026-02-07', voucher_number: 'INV-BOOK-ONLY-1', gstin: '27AAAAB1234C1Z9', Ledger: 'Purchase A/c', amount: -1000, TallyPrimary: 'Purchase Accounts', is_accounting_voucher: 1 },
      { date: '2026-02-07', voucher_number: 'INV-BOOK-ONLY-1', gstin: '27AAAAB1234C1Z9', Ledger: 'Input IGST', amount: -180, TallyPrimary: 'Duties & Taxes', is_accounting_voucher: 1 },
    ],
    { selectedGstLedgers: ['Input IGST'] }
  );

  const result = reconcile(books, parsed.rows, { scope: { month: 'All' } });
  assert.equal(result.summary.byStatus[STATUS.ONLY_IN_BOOKS], 1);
  assert.equal(result.summary.byStatus[STATUS.ONLY_IN_2B], 1);
});
