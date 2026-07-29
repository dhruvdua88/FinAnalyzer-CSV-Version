// Turns an ingested set of returns into the summary the workbook and the UI render.
//
// The one judgement call worth stating: the GSTR-1 vs GSTR-3B comparison is made on
// the basis the taxpayer actually filed on. A QRMP filer reports outward supplies as
// IFF + IFF + quarterly GSTR-1 but pays through a QUARTERLY 3B, so comparing month by
// month invents differences that do not exist. Comparing quarter-wise for those
// quarters and month-wise otherwise is what makes the difference column meaningful.

import {
  addInto, fyLabel, fyShort, monthLabel, QUARTER_LABELS, subValue, sumValues, totalTax,
  zeroTax, zeroValue,
} from './gstReturnsIngest';
import type {
  GstDataset, Gstr1Period, Gstr2bPeriod, Gstr3bPeriod, GstFileReport, TaxHeads, ValueWithTax,
} from './gstReturnsIngest';

export type CompareStatus = 'match' | 'mismatch' | 'r1-only' | '3b-only' | '2b-only';

export interface GstMonthRow {
  period: string;
  monthIndex: number;
  quarter: number;
  label: string;
  r1?: Gstr1Period;
  b3?: Gstr3bPeriod;
  b2?: Gstr2bPeriod;
  itcCompare?: { b2: TaxHeads; b3: TaxHeads; diff: TaxHeads; status: CompareStatus };
}

/** One row of the outward comparison — a month, or a quarter for QRMP periods. */
export interface GstOutwardCompareRow {
  basis: 'month' | 'quarter';
  label: string;
  periods: string[];          // the GSTR-1 periods rolled into this row
  r1?: ValueWithTax;
  b3?: ValueWithTax;
  diff?: ValueWithTax;
  status: CompareStatus;
  note?: string;
}

export interface GstFySummary {
  fyStart: number;
  fy: string;
  fyShort: string;
  months: GstMonthRow[];
  outwardCompare: GstOutwardCompareRow[];
}

export interface GstSummaryModel {
  gstin: string | null;
  fys: GstFySummary[];
  reports: GstFileReport[];
  warnings: string[];
  totalPeriods: number;
}

const TOL = 0.5;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOL;

/** 3B outward for comparison = 3.1(a) taxable supplies + 3.1(b) zero-rated. */
const b3Outward = (b: Gstr3bPeriod): ValueWithTax => sumValues([b.outwardTaxable, b.outwardZero]);

export const buildGstSummary = (d: GstDataset): GstSummaryModel => {
  const fyStarts = [...new Set([...d.r1, ...d.b3, ...d.b2].map((x) => x.fyStart))].sort((a, b) => a - b);

  const fys: GstFySummary[] = fyStarts.map((fyStart) => {
    const r1 = d.r1.filter((x) => x.fyStart === fyStart);
    const b3 = d.b3.filter((x) => x.fyStart === fyStart);
    const b2 = d.b2.filter((x) => x.fyStart === fyStart);

    // The month universe is the union across all three forms — partial coverage is normal.
    const periods = [...new Set([...r1, ...b3, ...b2].map((x) => x.period))];
    const months: GstMonthRow[] = periods
      .map((period) => {
        const a = r1.find((x) => x.period === period);
        const b = b3.find((x) => x.period === period);
        const c = b2.find((x) => x.period === period);
        const row: GstMonthRow = {
          period,
          monthIndex: (a ?? b ?? c)!.monthIndex,
          quarter: (a ?? b ?? c)!.quarter,
          label: monthLabel(period),
          r1: a, b3: b, b2: c,
        };
        if (c && b) {
          const diff: TaxHeads = {
            igst: c.bucketTotals.itcavl.igst - b.itcNet.igst,
            cgst: c.bucketTotals.itcavl.cgst - b.itcNet.cgst,
            sgst: c.bucketTotals.itcavl.sgst - b.itcNet.sgst,
            cess: c.bucketTotals.itcavl.cess - b.itcNet.cess,
          };
          row.itcCompare = {
            b2: c.bucketTotals.itcavl, b3: b.itcNet, diff,
            status: (Object.values(diff) as number[]).every((v) => Math.abs(v) <= TOL) ? 'match' : 'mismatch',
          };
        } else if (c) {
          row.itcCompare = { b2: c.bucketTotals.itcavl, b3: zeroTax(), diff: zeroTax(), status: '2b-only' };
        } else if (b) {
          row.itcCompare = { b2: zeroTax(), b3: b.itcNet, diff: zeroTax(), status: '3b-only' };
        }
        return row;
      })
      .sort((x, y) => x.monthIndex - y.monthIndex);

    return {
      fyStart, fy: fyLabel(fyStart), fyShort: fyShort(fyStart),
      months,
      outwardCompare: buildOutwardCompare(r1, b3),
    };
  });

  return {
    gstin: d.gstin,
    fys,
    reports: d.reports,
    warnings: d.warnings,
    totalPeriods: new Set([...d.r1, ...d.b3, ...d.b2].map((x) => `${x.fyStart}-${x.period}`)).size,
  };
};

/**
 * Choose the comparison basis per quarter from how the taxpayer actually filed.
 *
 * A quarter is compared QUARTER-WISE when its GSTR-1 side was filed under QRMP
 * (a quarterly return, or an IFF in month 1 or 2). Otherwise each month stands alone.
 * A taxpayer who switches frequency mid-year gets the right basis on each side of
 * the switch, which is exactly what the sample data does.
 */
const buildOutwardCompare = (r1: Gstr1Period[], b3: Gstr3bPeriod[]): GstOutwardCompareRow[] => {
  const rows: GstOutwardCompareRow[] = [];

  for (let q = 0; q < 4; q++) {
    const qr1 = r1.filter((x) => x.quarter === q);
    const qb3 = b3.filter((x) => x.quarter === q);
    if (qr1.length === 0 && qb3.length === 0) continue;

    const qrmp = qr1.some((x) => x.quarterly || x.iffInferred);

    if (qrmp) {
      const r1Total = qr1.length ? sumValues(qr1.map((x) => x.netOutward)) : undefined;
      const b3Total = qb3.length ? sumValues(qb3.map(b3Outward)) : undefined;
      const diff = r1Total && b3Total ? subValue(b3Total, r1Total) : undefined;
      rows.push({
        basis: 'quarter',
        label: QUARTER_LABELS[q],
        periods: qr1.map((x) => x.period),
        r1: r1Total, b3: b3Total, diff,
        status: !r1Total ? '3b-only' : !b3Total ? 'r1-only'
          : near(diff!.taxable, 0) && near(totalTax(diff!), 0) ? 'match' : 'mismatch',
        note: `Compared for the quarter: filed under QRMP as ${qr1.map((x) =>
          x.iffInferred ? `IFF ${monthLabel(x.period)}` : `GSTR-1 ${monthLabel(x.period)}`).join(' + ')}.`,
      });
    } else {
      const periods = [...new Set([...qr1, ...qb3].map((x) => x.period))]
        .sort((a, b) => (r1.concat(b3 as any).find((x) => x.period === a)!.monthIndex)
          - (r1.concat(b3 as any).find((x) => x.period === b)!.monthIndex));
      for (const period of periods) {
        const a = qr1.find((x) => x.period === period);
        const b = qb3.find((x) => x.period === period);
        const diff = a && b ? subValue(b3Outward(b), a.netOutward) : undefined;
        rows.push({
          basis: 'month',
          label: monthLabel(period),
          periods: a ? [period] : [],
          r1: a?.netOutward, b3: b ? b3Outward(b) : undefined, diff,
          status: !a ? '3b-only' : !b ? 'r1-only'
            : near(diff!.taxable, 0) && near(totalTax(diff!), 0) ? 'match' : 'mismatch',
        });
      }
    }
  }
  return rows;
};

/** Coverage cell text for the index matrix. */
export const coverageLabel = (row: GstMonthRow, form: 'r1' | 'b3' | 'b2'): string => {
  if (form === 'r1') {
    const r = row.r1;
    if (!r) return '—';
    if (!r.filed) return 'Saved (draft)';
    if (r.iffInferred) return 'Filed (IFF, inferred)';
    if (r.quarterly) return 'Filed (quarterly)';
    return 'Filed';
  }
  return row[form] ? 'Filed' : '—';
};

export const allMonths = (m: GstSummaryModel): GstMonthRow[] => m.fys.flatMap((f) => f.months);
export { zeroValue, addInto };
