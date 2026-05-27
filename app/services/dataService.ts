import Papa from 'papaparse';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

let xlsxModulePromise: Promise<typeof import('xlsx')> | null = null;
const getXlsxModule = () => {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import('xlsx');
  }
  return xlsxModulePromise;
};

/**
 * CLEAN NUMBER: Optimized for speed, avoids complex regex
 */
const cleanNumber = (value: any): number => {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'string') return 0;
  
  // High-performance string cleaning
  const cleaned = value.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

const parseAccountingVoucherFlag = (row: any): number => {
  const raw =
    row['is_accounting_voucher'] ??
    row['is_accounting'] ??
    row['Is Accounting Voucher'] ??
    row['IsAccountingVoucher'] ??
    row['is accounting voucher'];

  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;

  const text = String(raw).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return 1;
  if (text === '0' || text === 'false' || text === 'no' || text === 'n') return 0;
  return cleanNumber(raw) > 0 ? 1 : 0;
};

/**
 * NORMALIZE DATE: Handles 45758 (Excel) and "11/04/25" (Tally/CSV)
 */
const normalizeDate = (value: any, xlsx?: any): string => {
  if (!value) return '';

  // 1. Handle Excel Serial Numbers (Numbers > 30000 are usually dates)
  const numVal = Number(value);
  if (!isNaN(numVal) && numVal > 30000 && xlsx?.SSF?.parse_date_code) {
    try {
      const date = xlsx.SSF.parse_date_code(numVal);
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    } catch (e) { return String(value); }
  }

  // 2. Handle Strings strictly (DD/MM/YY is standard for Tally/Indian exports)
  const str = String(value).trim().split(' ')[0];
  // We prioritize DD/MM format to prevent US locale issues (April 11 vs Nov 4)
  const d = dayjs(str, ['DD/MM/YY', 'DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD'], true);
  
  return d.isValid() ? d.format('YYYY-MM-DD') : str;
};

/**
 * NORMALIZE DATA: High-performance loop
 * Avoiding '...row' spread preserves memory and prevents UI lag
 */
const normalizeData = (rawData: any[], xlsx?: any): any[] => {
  const len = rawData.length;
  const result = new Array(len);
  const now = Date.now();

  for (let i = 0; i < len; i++) {
    const row = rawData[i];
    result[i] = {
      guid: row['guid'] || `v-${i}-${now}`,
      date: normalizeDate(row['date'] || row['Date'], xlsx),
      voucher_type: row['voucher_type'] || '',
      voucher_number: row['voucher_number'] || row['Voucher No'] || 'UNKNOWN',
      invoice_number: row['invoice_number'] || row['Invoice No'] || row['Invoice Number'] || row['Inv No'] || '',
      reference_number: row['reference_number'] || '',
      narration: row['narration'] || '',
      // Explicitly check for "Party Name" as requested
      party_name: row['Party Name'] || row['party_name'] || row['Party'] || '',
      gstin: row['gstin'] || row['GSTIN'] || row['gstn'] || row['GSTN'] || row['Party GSTIN'] || row['party_gstin'] || row['CTIN'] || row['ctin'] || '',
      Ledger: row['Ledger'] || 'Unknown Ledger',
      amount: cleanNumber(row['amount']),
      Group: row['Group'] || '',
      opening_balance: cleanNumber(row['opening_balance']),
      closing_balance: cleanNumber(row['closing_balance']),
      TallyPrimary: row['TallyPrimary'] || '',
      is_revenue: row['is_revenue'] == '1' ? 1 : 0,
      is_accounting_voucher: parseAccountingVoucherFlag(row),
      is_master_ledger: cleanNumber(row['is_master_ledger']) > 0 ? 1 : 0,
    };
  }
  return result;
};

/**
 * PARSE FILE: Optimized for 500k+ rows
 */
export const parseFile = async (file: File): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    const isExcel = file.name.endsWith('.xls') || file.name.endsWith('.xlsx');

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = async (e: any) => {
        try {
          const XLSX = await getXlsxModule();
          const data = new Uint8Array(e.target.result);
          // 'dense' mode reduces memory usage significantly for large sheets
          const workbook = XLSX.read(data, { type: 'array', dense: true });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
          const normalized = normalizeData(jsonData, XLSX);
          resolve(normalized.filter((row) => row.is_accounting_voucher === 1));
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Worker: true runs parsing in a background thread to keep UI smooth
      Papa.parse(file, {
        header: true,
        skipEmptyLines: 'greedy',
        worker: true, 
        complete: (results: any) => {
          const normalized = normalizeData(results.data);
          resolve(normalized.filter((row) => row.is_accounting_voucher === 1));
        },
        error: (err: any) => reject(err),
      });
    }
  });
};

/**
 * GROUP VOUCHERS: Using Map for O(1) lookups
 */
export const groupVouchers = (entries: any[]): any[] => {
  const groups = new Map<string, any>();
  const len = entries.length;

  for (let i = 0; i < len; i++) {
    const entry = entries[i];
    const vNum = entry.voucher_number;
    
    let group = groups.get(vNum);
    if (!group) {
      group = {
        voucher_number: vNum,
        date: entry.date,
        voucher_type: entry.voucher_type,
        entries: [],
        totalAmount: 0,
      };
      groups.set(vNum, group);
    }
    group.entries.push(entry);
    group.totalAmount += Math.abs(entry.amount);
  }
  return Array.from(groups.values());
};

export const getUniqueLedgers = (entries: any[]): string[] => {
  const ledgers = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i].Ledger;
    if (l) ledgers.add(l);
  }
  return Array.from(ledgers).sort();
};

export const suggestGSTLedgers = (allLedgers: string[]): string[] => {
  const keys = ['gst', 'tax', 'duty', 'igst', 'cgst', 'sgst'];
  return allLedgers.filter(l => {
    const low = l.toLowerCase();
    return keys.some(k => low.includes(k));
  });
};

export const suggestTDSLedgers = (allLedgers: string[]): string[] => {
  const keys = ['tds', 'section', '194', '192', 'deducted'];
  return allLedgers.filter(l => {
    const low = l.toLowerCase();
    return keys.some(k => low.includes(k));
  });
};

export const exportToExcel = async (data: any[], fileName: string) => {
  try {
    const XLSX = await getXlsxModule();
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Analysis");
    // Use compression for large file exports
    XLSX.writeFile(workbook, `${fileName}.xlsx`, { compression: true });
  } catch (error) {
    console.error(error);
    window.alert('Unable to export Excel. Please retry.');
  }
};
