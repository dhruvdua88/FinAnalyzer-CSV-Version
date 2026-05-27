// One pure parser per table. Each takes a single raw row (header keys
// already lowercased) and returns the typed object defined in types.ts.
//
// Adding a column is a one-line change: append the field to the type, then
// read it here. Tables not yet seen in the wild (cost centre, payroll) have
// permissive parsers that capture whatever columns are present.

import { toText, toNumber, toBool, toIsoDate } from './helpers';
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

type Row = Record<string, any>;

export const parseVoucher = (r: Row): Voucher => ({
  guid: toText(r.guid),
  date: toIsoDate(r.date),
  voucher_type: toText(r.voucher_type),
  voucher_number: toText(r.voucher_number),
  reference_number: toText(r.reference_number),
  reference_date: toIsoDate(r.reference_date),
  narration: toText(r.narration),
  party_name: toText(r.party_name),
  place_of_supply: toText(r.place_of_supply),
  is_invoice: toBool(r.is_invoice),
  is_accounting_voucher: toBool(r.is_accounting_voucher),
  is_inventory_voucher: toBool(r.is_inventory_voucher),
  is_order_voucher: toBool(r.is_order_voucher),
});

export const parseAccountingLine = (r: Row, lineNo: number): AccountingLine => ({
  guid: toText(r.guid),
  ledger: toText(r.ledger),
  amount: toNumber(r.amount),
  amount_forex: toNumber(r.amount_forex),
  currency: toText(r.currency),
  line_no: lineNo,
});

export const parseLedger = (r: Row): Ledger => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
  alias: toText(r.alias),
  description: toText(r.description),
  notes: toText(r.notes),
  is_revenue: toBool(r.is_revenue),
  is_deemedpositive: toBool(r.is_deemedpositive),
  opening_balance: toNumber(r.opening_balance),
  closing_balance: toNumber(r.closing_balance),
  mailing_name: toText(r.mailing_name),
  mailing_address: toText(r.mailing_address),
  mailing_state: toText(r.mailing_state),
  mailing_country: toText(r.mailing_country),
  mailing_pincode: toText(r.mailing_pincode),
  email: toText(r.email),
  mobile: toText(r.mobile),
  it_pan: toText(r.it_pan),
  gstn: toText(r.gstn),
  gst_registration_type: toText(r.gst_registration_type),
  gst_supply_type: toText(r.gst_supply_type),
  gst_duty_head: toText(r.gst_duty_head),
  tax_rate: toNumber(r.tax_rate),
  bank_account_holder: toText(r.bank_account_holder),
  bank_account_number: toText(r.bank_account_number),
  bank_ifsc: toText(r.bank_ifsc),
  bank_swift: toText(r.bank_swift),
  bank_name: toText(r.bank_name),
  bank_branch: toText(r.bank_branch),
  bill_credit_period: toNumber(r.bill_credit_period),
});

export const parseGroup = (r: Row): Group => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
  primary_group: toText(r.primary_group),
  is_revenue: toBool(r.is_revenue),
  is_deemedpositive: toBool(r.is_deemedpositive),
  is_reserved: toBool(r.is_reserved),
  affects_gross_profit: toBool(r.affects_gross_profit),
  sort_position: toNumber(r.sort_position),
});

export const parseVoucherType = (r: Row): VoucherType => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
  numbering_method: toText(r.numbering_method),
  is_deemedpositive: toBool(r.is_deemedpositive),
  affects_stock: toBool(r.affects_stock),
});

export const parseStockItem = (r: Row): StockItem => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
  category: toText(r.category),
  alias: toText(r.alias),
  description: toText(r.description),
  part_number: toText(r.part_number),
  uom: toText(r.uom),
  alternate_uom: toText(r.alternate_uom),
  conversion: toNumber(r.conversion),
  opening_balance: toNumber(r.opening_balance),
  opening_rate: toNumber(r.opening_rate),
  opening_value: toNumber(r.opening_value),
  closing_balance: toNumber(r.closing_balance),
  closing_rate: toNumber(r.closing_rate),
  closing_value: toNumber(r.closing_value),
  costing_method: toText(r.costing_method),
  gst_type_of_supply: toText(r.gst_type_of_supply),
  gst_hsn_code: toText(r.gst_hsn_code),
  gst_hsn_description: toText(r.gst_hsn_description),
  gst_rate: toNumber(r.gst_rate),
  gst_taxability: toText(r.gst_taxability),
});

export const parseStockGroup = (r: Row): StockGroup => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
});

export const parseUom = (r: Row): Uom => ({
  guid: toText(r.guid),
  name: toText(r.name),
  formalname: toText(r.formalname),
  is_simple_unit: toBool(r.is_simple_unit),
  base_units: toText(r.base_units),
  additional_units: toText(r.additional_units),
  conversion: toNumber(r.conversion),
});

export const parseGodown = (r: Row): Godown => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
  address: toText(r.address),
});

export const parseGstEffectiveRate = (r: Row): GstEffectiveRate => ({
  item: toText(r.item),
  applicable_from: toIsoDate(r.applicable_from),
  hsn_description: toText(r.hsn_description),
  hsn_code: toText(r.hsn_code),
  duty_head: toText(r.duty_head),
  rate: toNumber(r.rate),
  rate_per_unit: toNumber(r.rate_per_unit),
  valuation_type: toText(r.valuation_type),
  is_rcm_applicable: toBool(r.is_rcm_applicable),
  nature_of_transaction: toText(r.nature_of_transaction),
  nature_of_goods: toText(r.nature_of_goods),
  supply_type: toText(r.supply_type),
  taxability: toText(r.taxability),
});

export const parseInventoryLine = (r: Row, lineNo: number): InventoryLine => ({
  guid: toText(r.guid),
  item: toText(r.item),
  quantity: toNumber(r.quantity),
  rate: toNumber(r.rate),
  amount: toNumber(r.amount),
  additional_amount: toNumber(r.additional_amount),
  discount_amount: toNumber(r.discount_amount),
  godown: toText(r.godown),
  tracking_number: toText(r.tracking_number),
  order_number: toText(r.order_number),
  order_duedate: toIsoDate(r.order_duedate),
  line_no: lineNo,
});

export const parseBatchLine = (r: Row): BatchLine => ({
  guid: toText(r.guid),
  item: toText(r.item),
  name: toText(r.name),
  quantity: toNumber(r.quantity),
  amount: toNumber(r.amount),
  godown: toText(r.godown),
  destination_godown: toText(r.destination_godown),
  tracking_number: toText(r.tracking_number),
});

export const parseBillRef = (r: Row): BillRef => ({
  guid: toText(r.guid),
  ledger: toText(r.ledger),
  name: toText(r.name),
  amount: toNumber(r.amount),
  billtype: toText(r.billtype),
  bill_credit_period: toNumber(r.bill_credit_period),
});

export const parseInventoryAdditionalCost = (r: Row): InventoryAdditionalCost => ({
  guid: toText(r.guid),
  ledger: toText(r.ledger),
  amount: toNumber(r.amount),
  additional_allocation_type: toText(r.additional_allocation_type),
  rate_of_invoice_tax: toNumber(r.rate_of_invoice_tax),
});

export const parseCostCategory = (r: Row): CostCategory => ({
  guid: toText(r.guid),
  name: toText(r.name),
  allocate_revenue: toBool(r.allocate_revenue),
  allocate_non_revenue: toBool(r.allocate_non_revenue),
});

export const parseCostCentre = (r: Row): CostCentre => ({
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
  category: toText(r.category),
});

export const parseEmployee = (r: Row): Employee => ({
  ...r,
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
});

export const parsePayhead = (r: Row): PayheadMaster => ({
  ...r,
  guid: toText(r.guid),
  name: toText(r.name),
});

// Cost allocations come from three tables whose column names differ slightly:
//   trn_cost_centre                    → costcentre
//   trn_cost_category_centre           → costcategory, costcentre
//   trn_cost_inventory_category_centre → item, costcategory, costcentre
// Older XLSX exports used the bare `category`/`centre` headers, so accept both.
export const parseCostAllocation = (r: Row): CostAllocation => ({
  guid: toText(r.guid),
  ledger: toText(r.ledger),
  item: toText(r.item),
  category: toText(r.costcategory ?? r.category),
  centre: toText(r.costcentre ?? r.centre),
  amount: toNumber(r.amount),
});

export const parseAttendance = (r: Row): Attendance => ({
  ...r,
  guid: toText(r.guid),
  employee: toText(r.employee_name ?? r.employee),
  attendance_type: toText(r.attendancetype_name ?? r.attendance_type),
  value: toNumber(r.time_value ?? r.type_value ?? r.value),
});

export const parseBankAllocation = (r: Row): BankAllocation => ({
  ...r,
  guid: toText(r.guid),
});

// trn_closingstock_ledger has no guid; its value column is `stock_value`
// (legacy XLSX exports called it `amount`). `stock_date` is the as-of date.
export const parseClosingStockLedger = (r: Row): ClosingStockLedger => ({
  ...r,
  guid: toText(r.guid),
  ledger: toText(r.ledger),
  stock_date: toIsoDate(r.stock_date),
  amount: toNumber(r.stock_value ?? r.amount),
});

export const parseOpeningBatchAllocation = (r: Row): OpeningBatchAllocation => ({
  ...r,
  guid: toText(r.guid),
});

export const parseOpeningBillAllocation = (r: Row): OpeningBillAllocation => ({
  ...r,
  guid: toText(r.guid),
});

export const parseAttendanceType = (r: Row): AttendanceType => ({
  ...r,
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
});

export const parseStockCategory = (r: Row): StockCategory => ({
  ...r,
  guid: toText(r.guid),
  name: toText(r.name),
  parent: toText(r.parent),
});

export const parseStockitemStandardCost = (r: Row): StockitemStandardCost => ({
  ...r,
  guid: toText(r.guid),
  item: toText(r.item),
  rate: toNumber(r.rate),
  date: toIsoDate(r.date),
});

export const parseStockitemStandardPrice = (r: Row): StockitemStandardPrice => ({
  ...r,
  guid: toText(r.guid),
  item: toText(r.item),
  rate: toNumber(r.rate),
  date: toIsoDate(r.date),
});

// config.xlsx is a name/value table — pivot it to a single ExportMeta object
// so callers don't have to .find() through rows for every key.
export const parseExportMeta = (rows: Row[]): ExportMeta => {
  const raw: Record<string, string> = {};
  for (const row of rows) {
    const name = toText(row.name);
    if (name) raw[name] = toText(row.value);
  }
  return {
    updateTimestamp: raw['Update Timestamp'] || '',
    companyName: raw['Company Name'] || raw['Company'] || '',
    periodFrom: raw['Period From'] || raw['From Date'] || '',
    periodTo: raw['Period To'] || raw['To Date'] || '',
    generatedAt: raw['Generated At'] || raw['Update Timestamp'] || '',
    raw,
  };
};
