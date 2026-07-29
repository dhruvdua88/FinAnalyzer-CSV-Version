/**
 * Build the GST returns summary workbook from a folder of portal downloads.
 * Usage: npx tsx scripts/exportGstSummary.ts <dir> <out.xlsx>
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx-js-style';
import { ingestGstFiles } from '../services/gst/gstReturnsIngest';
import { buildGstSummary } from '../services/gst/gstReturnsSummary';
import { buildGstSummaryWorkbook, gstSheetPolish } from '../services/gst/gstReturnsExcel';
import { polishXlsx } from '../services/xlsxPolish';

const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  return statSync(p).isDirectory() ? walk(p) : /\.(json|zip)$/i.test(e) ? [p] : [];
});

const main = async () => {
  const [dir, out] = process.argv.slice(2);
  const ds = await ingestGstFiles(walk(dir).map((p) => ({ name: p.split('/').slice(-2).join('/'), bytes: new Uint8Array(readFileSync(p)) })));
  const model = buildGstSummary(ds);
  const wb = buildGstSummaryWorkbook(model);
  console.log('GSTIN', model.gstin, '| R1', ds.r1.length, '3B', ds.b3.length, '2B', ds.b2.length);
  console.log('sheets:', wb.SheetNames.join(' | '));
  console.log('\nwarnings:'); model.warnings.forEach((w) => console.log('  •', w));
  for (const fy of model.fys) {
    console.log(`\n${fy.fy} — outward comparison`);
    for (const row of fy.outwardCompare) {
      console.log(`  ${row.basis.padEnd(7)} ${row.label.padEnd(14)} R1 ${(row.r1?.taxable ?? 0).toLocaleString('en-IN').padStart(16)}  3B ${(row.b3?.taxable ?? 0).toLocaleString('en-IN').padStart(16)}  Δ ${(row.diff?.taxable ?? 0).toLocaleString('en-IN').padStart(14)}  ${row.status}`);
    }
  }
  if (out) {
    const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }) as Buffer;
    const polished = await polishXlsx(new Uint8Array(raw), gstSheetPolish(model),
      { showGridLines: false, landscape: true, fitToWidth: true });
    writeFileSync(out, polished);
    console.log('\nwrote', out);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
