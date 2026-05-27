// Typed shape for each table in the Tally XLSX export. Field names match the
// XLSX columns exactly (lower-cased) so the parser can map row[col] → object
// without an intermediate alias dictionary. Optional fields are columns the
// exporter writes but that may be empty for any given row.

export interface Voucher {
  guid: string;
  date: string;                  // ISO
  voucher_type: string;
  voucher_number: string;
  reference_number: string;
  reference_date: string;        // ISO
  narration: string;
  party_name: string;
  place_of_supply: string;
  is_invoice: boolean;
  is_accounting_voucher: boolean;
  is_inventory_voucher: boolean;
  is_order_voucher: boolean;
}

export interface AccountingLine {
  guid: string;                  // voucher guid (joins to Voucher.guid)
  ledger: string;
  amount: number;
  amount_forex: number;
  currency: string;
  line_no: number;               // synthesised — order within the voucher
}

export interface Ledger {
  guid: string;
  name: string;
  parent: string;                // group name
  alias: string;
  description: string;
  notes: string;
  is_revenue: boolean;
  is_deemedpositive: boolean;
  opening_balance: number;
  closing_balance: number;
  mailing_name: string;
  mailing_address: string;
  mailing_state: string;
  mailing_country: string;
  mailing_pincode: string;
  email: string;
  mobile: string;
  it_pan: string;
  gstn: string;
  gst_registration_type: string;
  gst_supply_type: string;
  gst_duty_head: string;
  tax_rate: number;
  bank_account_holder: string;
  bank_account_number: string;
  bank_ifsc: string;
  bank_swift: string;
  bank_name: string;
  bank_branch: string;
  bill_credit_period: number;
}

export interface Group {
  guid: string;
  name: string;
  parent: string;
  primary_group: string;
  is_revenue: boolean;
  is_deemedpositive: boolean;
  is_reserved: boolean;
  affects_gross_profit: boolean;
  sort_position: number;
}

export interface VoucherType {
  guid: string;
  name: string;
  parent: string;
  numbering_method: string;
  is_deemedpositive: boolean;
  affects_stock: boolean;
}

export interface StockItem {
  guid: string;
  name: string;
  parent: string;                // stock group
  category: string;
  alias: string;
  description: string;
  part_number: string;
  uom: string;
  alternate_uom: string;
  conversion: number;
  opening_balance: number;
  opening_rate: number;
  opening_value: number;
  closing_balance: number;
  closing_rate: number;
  closing_value: number;
  costing_method: string;
  gst_type_of_supply: string;
  gst_hsn_code: string;
  gst_hsn_description: string;
  gst_rate: number;
  gst_taxability: string;
}

export interface StockGroup {
  guid: string;
  name: string;
  parent: string;
}

export interface Uom {
  guid: string;
  name: string;
  formalname: string;
  is_simple_unit: boolean;
  base_units: string;
  additional_units: string;
  conversion: number;
}

export interface Godown {
  guid: string;
  name: string;
  parent: string;
  address: string;
}

// mst_gst_effective_rate is item-and-date-keyed; query via store.gstRateAt().
export interface GstEffectiveRate {
  item: string;
  applicable_from: string;       // ISO
  hsn_description: string;
  hsn_code: string;
  duty_head: string;             // CGST / SGST / IGST
  rate: number;
  rate_per_unit: number;
  valuation_type: string;
  is_rcm_applicable: boolean;
  nature_of_transaction: string;
  nature_of_goods: string;
  supply_type: string;
  taxability: string;
}

export interface InventoryLine {
  guid: string;                  // voucher guid
  item: string;
  quantity: number;
  rate: number;
  amount: number;
  additional_amount: number;
  discount_amount: number;
  godown: string;
  tracking_number: string;
  order_number: string;
  order_duedate: string;
  line_no: number;
}

export interface BatchLine {
  guid: string;                  // voucher guid
  item: string;
  name: string;                  // batch name
  quantity: number;
  amount: number;
  godown: string;
  destination_godown: string;
  tracking_number: string;
}

export interface BillRef {
  guid: string;                  // voucher guid
  ledger: string;
  name: string;                  // bill name / reference
  amount: number;
  billtype: string;              // 'New Ref' | 'Agst Ref' | 'On Account' | 'Advance'
  bill_credit_period: number;
}

export interface InventoryAdditionalCost {
  guid: string;
  ledger: string;
  amount: number;
  additional_allocation_type: string;
  rate_of_invoice_tax: number;
}

export interface CostCategory {
  guid: string;
  name: string;
  allocate_revenue: boolean;
  allocate_non_revenue: boolean;
}

export interface CostCentre {
  guid: string;
  name: string;
  parent: string;
  category: string;
}

export interface Employee {
  guid: string;
  name: string;
  parent: string;
  // (additional columns appear in some exports; we keep them flexible)
  [key: string]: any;
}

export interface PayheadMaster {
  guid: string;
  name: string;
  [key: string]: any;
}

// Per-line cost-centre allocations (trn_cost_centre, trn_cost_category_centre, trn_cost_inventory_category_centre)
export interface CostAllocation {
  guid: string;                  // voucher guid
  ledger?: string;
  item?: string;
  category?: string;
  centre?: string;
  amount: number;
}

export interface Attendance {
  guid: string;
  employee: string;
  attendance_type: string;
  value: number;
  [key: string]: any;
}

export interface BankAllocation {
  guid: string;
  [key: string]: any;
}

export interface ClosingStockLedger {
  guid: string;
  ledger: string;
  stock_date: string;            // ISO; as-of date of the closing-stock figure
  amount: number;                // from stock_value
  [key: string]: any;
}

export interface OpeningBatchAllocation {
  guid: string;
  [key: string]: any;
}

export interface OpeningBillAllocation {
  guid: string;
  [key: string]: any;
}

export interface AttendanceType {
  guid: string;
  name: string;
  parent: string;
  [key: string]: any;
}

export interface StockCategory {
  guid: string;
  name: string;
  parent: string;
  [key: string]: any;
}

export interface StockitemStandardCost {
  guid: string;
  item: string;
  rate: number;
  date: string;
  [key: string]: any;
}

export interface StockitemStandardPrice {
  guid: string;
  item: string;
  rate: number;
  date: string;
  [key: string]: any;
}

// Top-level metadata pulled from config.xlsx (export timestamp etc.)
export interface ExportMeta {
  updateTimestamp: string;
  companyName: string;
  periodFrom: string;
  periodTo: string;
  generatedAt: string;
  raw: Record<string, string>;
}
