export interface LedgerEntry {
  guid: string;
  date: string;
  voucher_type: string;
  voucher_number: string;
  invoice_number?: string;
  Ledger: string;
  amount: number;
  Group: string;
  TallyParent: string;
  TallyPrimary: string;
  narration?: string;
  party_name?: string;
  gstin?: string;
  opening_balance?: number;
  closing_balance?: number;
  is_accounting_voucher?: number;
  is_master_ledger?: number;

  // ── Enrichments from the Tally XLSX export ────────────────────────────────
  // All optional. Existing modules ignore them; new/migrated modules read
  // them when present. Sourced from the relational TallyStore at shim time.
  gst_hsn_code?: string;            // mst_stock_item.gst_hsn_code
  gst_rate?: number;                // mst_stock_item.gst_rate
  gst_taxability?: string;          // mst_stock_item.gst_taxability
  pan?: string;                     // mst_ledger.it_pan
  gst_registration_type?: string;   // mst_ledger.gst_registration_type
  mailing_state?: string;           // mst_ledger.mailing_state
  place_of_supply?: string;         // trn_voucher.place_of_supply
  reference_date?: string;          // trn_voucher.reference_date (ISO)
  bill_reference?: string;          // trn_bill.name (joined per ledger)
  bill_credit_period?: number;      // mst_ledger.bill_credit_period
  is_invoice?: number;              // trn_voucher.is_invoice (0/1)

  // Retained for legacy flexibility — most modules read via typed members.
  [key: string]: any;
}

// ── TDS Section Definitions (B2) ──────────────────────────────────────────────
export interface TDSSectionRate {
  label: string;
  rate: number; // percentage, e.g. 2
}

export interface TDSSectionDef {
  code: string;           // e.g. "194C"
  label: string;          // e.g. "Contractors"
  singleTxnLimit: number; // per-payment threshold (₹). 0 = no limit (always applicable)
  annualLimit: number;    // aggregate annual threshold (₹). 0 = no limit
  defaultRate: number;    // % e.g. 2
  rates: TDSSectionRate[];
}

// Mapping a TDS ledger to an Indian TDS section
export interface TDSSectionMapping {
  ledger: string;
  sectionCode: string; // maps to TDSSectionDef.code
}

// Full threshold configuration stored in AuditSettings
export interface TDSThresholdConfig {
  enabled: boolean;           // if false, threshold logic is skipped
  sectionMappings: TDSSectionMapping[];
}

// Voucher-level TDS status (B6 statuses)
export type TDSVoucherStatus =
  | 'deducted'          // TDS correctly deducted
  | 'short_deducted'    // TDS deducted but amount < 95% of expected
  | 'missed'            // TDS applicable but not deducted
  | 'below_threshold';  // Exempt: single txn + YTD both below limits

// Audit annotation for any voucher row (D2)
export interface AuditAnnotation {
  key: string;       // voucher_key or group_key
  note: string;
  updatedAt: string; // ISO date string
}

export interface AuditSettings {
  salesGstLedgers: string[];
  purchaseGstLedgers: string[];
  tdsTaxLedgers: string[];
  rcmTaxLedgers: string[];
  blockedCreditLedgers: string[];
  relatedParties: string[];
  gstLedgerSummary: string[];
  partyMatrixProfile: PartyMatrixProfile;
  relatedPartyProfile?: RelatedPartyProfile;
  tdsThresholdConfig: TDSThresholdConfig;
  tdsAnnotations: AuditAnnotation[];
}

export interface PartyMatrixProfile {
  selectedPrimaryGroup: string;
  tdsLedgers: string[];
  gstLedgers: string[];
  rcmLedgers: string[];
}

// ── Related Party (AS-18) ────────────────────────────────────────────────────
//
// AS-18 (Indian GAAP) recognises six relationship buckets. We add a generic
// 'other-rp' for parties the user marks as related but doesn't want to
// commit to a specific category. Order matters — UI sorts use this order
// to put the most material (Holding/Subsidiary) at the top of the matrix.
export type RPRelationshipCategory =
  | 'holding'                        // Enterprise that controls reporting entity
  | 'subsidiary'                     // Reporting entity controls
  | 'fellow-subsidiary'              // Same parent
  | 'associate-jv'                   // Significant influence / joint control
  | 'kmp'                            // Key Managerial Personnel — directors, CFO, MD, CEO
  | 'kmp-relative'                   // Relative of KMP — spouse, children, parents, siblings
  | 'kmp-enterprise'                 // Enterprise where KMP/relative has significant influence
  | 'individual-significant-influence' // Individual (not KMP) with control or SI
  | 'other-rp';                      // Other related parties not fitting above

// AS-18 transaction categories. Para 23 of AS-18 lists these explicitly as
// the disclosure breakdown the auditor must produce. We keep the standard
// names so the Excel export can carry the exact wording into the note.
export type RPTransactionType =
  | 'sale-goods'
  | 'sale-services'
  | 'purchase-goods'
  | 'purchase-services'
  | 'rendering-services'
  | 'receiving-services'
  | 'agency-arrangements'
  | 'leasing-hire-purchase'
  | 'rd-transfer'
  | 'license-agreements'
  | 'finance-given'                  // loans / equity contributions GIVEN to RP
  | 'finance-received'               // loans / equity contributions RECEIVED from RP
  | 'interest-paid'
  | 'interest-received'
  | 'rent-paid'
  | 'rent-received'
  | 'remuneration'                   // Director / KMP compensation
  | 'reimbursement'
  | 'guarantees-given'
  | 'guarantees-received'
  | 'management-contracts'
  | 'dividend-paid'
  | 'dividend-received'
  | 'other';

export interface RPPartyTag {
  category: RPRelationshipCategory;
  // Free-text descriptor that goes straight into the AS-18 note. E.g.
  // "Mrs. Priya Sharma — wife of Mr. Anil Sharma (Director)" or
  // "ABC Industries Pvt Ltd — significantly influenced by Director Mr. X".
  notes?: string;
  // User flag — overrides the auto-detected materiality classification.
  isMaterial?: boolean;
}

export interface RPApprovalRecord {
  // Key is `${voucher_number}|${date}`.
  boardRef?: string;                  // resolution date / number
  shRef?: string;                     // shareholder approval ref (Sec 188)
  approved: boolean;
  notes?: string;
}

export interface RelatedPartyProfile {
  // Per-party relationship classification. Empty entry = not yet tagged.
  parties: Record<string, RPPartyTag>;

  // Per-ledger override: the user can pin a specific counter-ledger to an
  // AS-18 transaction type if the auto-classifier gets it wrong (e.g.,
  // an oddly-named "Sundry Income" ledger that's actually rent received).
  ledgerTxType: Record<string, RPTransactionType>;

  // Audit thresholds. All optional; sensible defaults applied in the worker
  // when missing.
  thresholds: {
    materialityRupees: number;        // single-tx flag threshold (default ₹10L)
    yearEndDays: number;              // window for "year-end concentration" (default 30)
    roundAmountUnit: number;          // round-amount detection (default ₹1L)
    section188TurnoverPct: number;    // Sec 188 SH-approval trigger (default 10%)
    annualTurnover: number;           // entity turnover for Sec 188 percent maths
  };

  // Per-voucher approval log (Section 188 / Companies Act 2013 trail).
  approvals: Record<string, RPApprovalRecord>;

  // Comparative previous-year figures, manually entered (since prior-year
  // dataset may not be in the current import). Indexed by relationship ×
  // transaction type. Optional.
  previousYearMatrix?: Record<string, Record<string, number>>;
}

export interface VoucherGroup {
  voucher_number: string;
  date: string;
  voucher_type: string;
  entries: LedgerEntry[];
  totalAmount: number; // Sum of absolute values for context
}

export interface GSTRateResult {
  voucher_number: string;
  date: string;
  party_name: string;
  saleAmount: number;
  taxAmount: number;
  calculatedRate: number;
  // ── Enrichment from mst_stock_item via TallyStore shim ────────────────────
  // Master-declared GST rate for the first stock item on the voucher.
  // Populated only when the ZIP import was used (legacy live-loader leaves
  // it undefined). When present, statusDetail will note the agreement or
  // mismatch between derived and master rates.
  masterRate?: number;
  hsn?: string;
  taxLedgers: string[];
  salesLedgers: string[];
  status: 'Match' | 'Rate Issues' | 'GST Not Charged';
  statusDetail: string; // e.g., "Match 18%" or "Differs from std"
}

// Standard Indian TDS sections (used as default definitions in TDS module)
export const TDS_SECTION_DEFAULTS: TDSSectionDef[] = [
  { code: '194C',    label: 'Contractors',                  singleTxnLimit: 30000,   annualLimit: 100000,  defaultRate: 2,   rates: [{ label: 'Ind/HUF', rate: 1 }, { label: 'Others', rate: 2 }] },
  { code: '194J',    label: 'Professional/Technical Svcs',  singleTxnLimit: 30000,   annualLimit: 30000,   defaultRate: 10,  rates: [{ label: 'Technical', rate: 2 }, { label: 'Professional', rate: 10 }] },
  { code: '194H',    label: 'Commission / Brokerage',       singleTxnLimit: 15000,   annualLimit: 15000,   defaultRate: 5,   rates: [{ label: 'All', rate: 5 }] },
  { code: '194I(a)', label: 'Rent – Plant & Machinery',     singleTxnLimit: 240000,  annualLimit: 240000,  defaultRate: 2,   rates: [{ label: 'All', rate: 2 }] },
  { code: '194I(b)', label: 'Rent – Land/Building/Furn',   singleTxnLimit: 240000,  annualLimit: 240000,  defaultRate: 10,  rates: [{ label: 'All', rate: 10 }] },
  { code: '194A',    label: 'Interest (Non-bank)',          singleTxnLimit: 5000,    annualLimit: 5000,    defaultRate: 10,  rates: [{ label: 'All', rate: 10 }] },
  { code: '194Q',    label: 'Purchase of Goods (>50L)',     singleTxnLimit: 5000000, annualLimit: 5000000, defaultRate: 0.1, rates: [{ label: 'All', rate: 0.1 }] },
  { code: '194M',    label: 'Payment by Ind/HUF (>50L)',    singleTxnLimit: 5000000, annualLimit: 5000000, defaultRate: 5,   rates: [{ label: 'All', rate: 5 }] },
  { code: '194O',    label: 'E-commerce Operator',          singleTxnLimit: 500000,  annualLimit: 500000,  defaultRate: 1,   rates: [{ label: 'All', rate: 1 }] },
  { code: 'OTHER',   label: 'Other / Not Mapped',           singleTxnLimit: 0,       annualLimit: 0,       defaultRate: 0,   rates: [] },
];

export enum AnalysisType {
  DASHBOARD = 'DASHBOARD',
  TRIAL_BALANCE = 'TRIAL_BALANCE',
  DEBTOR_AGEING = 'DEBTOR_AGEING',
  CREDITOR_AGEING = 'CREDITOR_AGEING',
  VOUCHER_BOOK_VIEW = 'VOUCHER_BOOK_VIEW',
  LEDGER_VOUCHER_VIEW = 'LEDGER_VOUCHER_VIEW',
  GST_RATE = 'GST_RATE',
  SALES_REGISTER = 'SALES_REGISTER',
  PURCHASE_GST_REGISTER = 'PURCHASE_GST_REGISTER',
  GSTR2B_RECONCILIATION = 'GSTR2B_RECONCILIATION',
  TDS_ANALYSIS = 'TDS_ANALYSIS',
  RCM_ANALYSIS = 'RCM_ANALYSIS',
  GST_EXPENSE_ANALYSIS = 'GST_EXPENSE_ANALYSIS',
  PROFIT_LOSS_ANALYSIS = 'PROFIT_LOSS_ANALYSIS',
  CASH_FLOW_ANALYSIS = 'CASH_FLOW_ANALYSIS',
  VARIANCE_ANALYSIS = 'VARIANCE_ANALYSIS',
  EXCEPTION_DENSITY_HEATMAP = 'EXCEPTION_DENSITY_HEATMAP',
  BALANCE_SHEET_CLEANLINESS = 'BALANCE_SHEET_CLEANLINESS',
  LEDGER_ANALYTICS = 'LEDGER_ANALYTICS',
  PARTY_LEDGER_MATRIX = 'PARTY_LEDGER_MATRIX',
  RELATED_PARTY_ANALYSIS = 'RELATED_PARTY_ANALYSIS',
  AUDIT_CONFIG = 'AUDIT_CONFIG',
  GST_LEDGER_SUMMARY = 'GST_LEDGER_SUMMARY',
  ITC_3B_RECONCILIATION = 'ITC_3B_RECONCILIATION',
  ORPHAN_PL_VOUCHERS = 'ORPHAN_PL_VOUCHERS',
}
