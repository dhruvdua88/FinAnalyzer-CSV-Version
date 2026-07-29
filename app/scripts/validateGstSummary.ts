/**
 * GST returns summary validator.
 *
 * Drives the real ingestion + summary code over a directory of portal downloads and
 * asserts the figures. Expected values were derived independently in Python straight
 * off the JSONs, so a green run cross-checks this code rather than restating it.
 *
 * Usage: npx tsx scripts/validateGstSummary.ts <dir> [fixturesDir]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ingestGstFiles, totalTax } from '../services/gst/gstReturnsIngest';
import type { GstSourceInput } from '../services/gst/gstReturnsIngest';
import { buildGstSummary } from '../services/gst/gstReturnsSummary';

let pass = 0;
let fail = 0;
const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const check = (name: string, actual: number, expected: number, tol = 0.01): void => {
  const ok = Math.abs(actual - expected) <= tol;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(56)} ${inr(actual).padStart(18)}${ok ? '' : `   expected ${inr(expected)}`}`);
};
const checkTrue = (name: string, actual: boolean, detail = ''): void => {
  actual ? pass++ : fail++;
  console.log(`  ${actual ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(56)} ${actual ? 'true' : `false  ${detail}`}`);
};
const checkEq = (name: string, actual: string, expected: string): void =>
  checkTrue(name, actual === expected, `got ${actual}, expected ${expected}`);
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(json|zip)$/i.test(entry)) out.push(p);
  }
  return out;
};
const load = (paths: string[]): GstSourceInput[] =>
  paths.map((p) => ({ name: p.split('/').slice(-2).join('/'), bytes: new Uint8Array(readFileSync(p)) }));

const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

const main = async () => {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: tsx scripts/validateGstSummary.ts <dir> [fixturesDir]'); process.exit(2); }

  // ── Part 1: the real portal downloads ───────────────────────────────────────
  const ds = await ingestGstFiles(load(walk(dir)));
  const model = buildGstSummary(ds);

  console.log(`\n\x1b[1mGST returns\x1b[0m ${ds.gstin}  —  R1 ${ds.r1.length} · 3B ${ds.b3.length} · 2B ${ds.b2.length}`);

  section('Ingestion');
  checkEq('GSTIN', ds.gstin ?? '', '07AALCC3686L1Z2');
  check('files rejected', ds.reports.filter((r) => r.status === 'rejected').length, 0, 0);
  checkEq('GSTR-1 periods', ds.r1.map((x) => x.period).join(','), '052025,062025,092025,112025,122025,022026,032026');
  checkEq('GSTR-3B periods', ds.b3.map((x) => x.period).join(','), '062025,092025,122025,012026,022026,032026');
  checkEq('GSTR-2B periods', ds.b2.map((x) => x.period).join(','), '062025,092025,122025,012026,022026,032026');
  checkTrue('identical extracted copies collapsed',
    ds.reports.filter((r) => r.status === 'duplicate-ignored').length >= 7,
    `${ds.reports.filter((r) => r.status === 'duplicate-ignored').length} duplicates`);
  check('financial years', model.fys.length, 1, 0);
  checkEq('months in Apr→Mar order', model.fys[0].months.map((m) => m.monthIndex).join(','), '1,2,5,7,8,9,10,11');

  section('GSTR-1 filing frequency and IFF inference');
  const r1 = (p: string) => ds.r1.find((x) => x.period === p)!;
  checkEq('IFF months', ds.r1.filter((x) => x.iffInferred).map((x) => x.period).join(','), '052025,112025');
  checkEq('quarterly months', ds.r1.filter((x) => x.quarterly).map((x) => x.period).join(','), '062025,092025,122025');
  checkEq('monthly months', ds.r1.filter((x) => x.filingTyp === 'M').map((x) => x.period).join(','), '022026,032026');
  checkTrue('all GSTR-1 files filed', ds.r1.every((x) => x.filed));
  check('QRMP duplicates removed', ds.r1.reduce((s, x) => s + x.qrmpDedupedDocs, 0), 0, 0);

  section('GSTR-1 figures (b2b + cdnr raw sums)');
  const R1_EXPECTED: Array<[string, number, number, number, number, number, number]> = [
    // period, taxable, igst, cgst, sgst, b2b invoices, cdnr notes
    ['052025', 5360192.00, 30634.56, 467100.00, 467100.00, 6, 0],
    ['062025', 2595000.00, 0, 233550.00, 233550.00, 2, 0],
    ['092025', 28685000.00, 162000.00, 2500650.00, 2500650.00, 8, 0],
    ['112025', 15190000.00, 1800000.00, 467100.00, 467100.00, 5, 0],
    ['122025', 146055204.92, 0, 13144968.44, 13144968.44, 3, 2],  // b2b 141,055,204.92 + two credit notes of 2,500,000 each
    ['022026', 190000.00, 0, 17100.00, 17100.00, 2, 0],
    ['032026', 11526000.00, 2074680.00, 0, 0, 2, 0],
  ];
  for (const [period, tx, ig, cg, sg, nb, nc] of R1_EXPECTED) {
    const r = r1(period);
    const raw = ['b2b', 'cdnr'].map((k) => r.sections.find((s) => s.key === k)?.total)
      .filter(Boolean)
      .reduce((a, v) => ({ taxable: a.taxable + v!.taxable, igst: a.igst + v!.igst, cgst: a.cgst + v!.cgst, sgst: a.sgst + v!.sgst, cess: a.cess + v!.cess }),
        { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    check(`${period} taxable`, raw.taxable, tx);
    check(`${period} IGST`, raw.igst, ig);
    check(`${period} CGST`, raw.cgst, cg);
    check(`${period} SGST`, raw.sgst, sg);
    check(`${period} b2b invoices`, r.b2bInvCount, nb, 0);
    check(`${period} credit/debit notes`, r.cdnrNoteCount, nc, 0);
  }

  section('GSTR-3B figures');
  const B3_EXPECTED: Array<[string, number, number, number, number, number, number, number]> = [
    ['062025', 7955192.00, 30634.56, 700650.00, 700650.00, 575684.46, 62761.10, 62761.10],
    ['092025', 28685000.00, 162000.00, 2500650.00, 2500650.00, 594933.39, 94936.75, 94936.75],
    ['122025', 151245204.92, 1800000.00, 12712068.44, 12712068.44, 553717.71, 60781.80, 60781.80],
    ['012026', 0, 0, 0, 0, 150828.17, 36751.77, 36751.77],
    ['022026', 190000.00, 0, 17100.00, 17100.00, 110546.48, 1980.00, 1980.00],
    ['032026', 11621000.00, 2074680.00, 8550.00, 8550.00, 11157.89, 524.50, 524.50],
  ];
  for (const [period, tx, ig, cg, sg, ii, ic, is] of B3_EXPECTED) {
    const b = ds.b3.find((x) => x.period === period)!;
    check(`${period} outward taxable`, b.outwardTaxable.taxable, tx);
    check(`${period} outward IGST`, b.outwardTaxable.igst, ig);
    check(`${period} outward CGST`, b.outwardTaxable.cgst, cg);
    check(`${period} outward SGST`, b.outwardTaxable.sgst, sg);
    check(`${period} net ITC IGST`, b.itcNet.igst, ii);
    check(`${period} net ITC CGST`, b.itcNet.cgst, ic);
    check(`${period} net ITC SGST`, b.itcNet.sgst, is);
  }

  section('GSTR-2B figures');
  const B2_ROWS: Array<[string, string, string, string, number, number, number, number]> = [
    ['062025', 'itcavl', 'nonrevsup', 'b2b', 3925455.00, 575802.46, 62897.10, 62897.10],
    ['062025', 'itcavl', 'nonrevsup', 'cdnr', 1521.00, 76.00, 0, 0],
    ['062025', 'itcavl', 'othersup', 'cdnr', 9310.00, 194.00, 136.00, 136.00],
    ['092025', 'itcavl', 'nonrevsup', 'b2b', 4610263.15, 632899.71, 94936.75, 94936.75],
    ['092025', 'itcavl', 'othersup', 'cdnr', 210924.00, 37966.32, 0, 0],
    ['092025', 'itcunavl', 'nonrevsup', 'b2b', 54205.41, 0, 2566.43, 2566.43],
    ['122025', 'itcavl', 'nonrevsup', 'b2b', 3833618.05, 553725.91, 60949.80, 60949.80],
    ['012026', 'itcavl', 'nonrevsup', 'b2b', 1246287.31, 150828.17, 36751.77, 36751.77],
    ['032026', 'itcavl', 'othersup', 'cdnr', 13602.00, 394.00, 178.50, 178.50],
  ];
  for (const [period, bucket, group, sec, tx, ig, cg, sg] of B2_ROWS) {
    const b = ds.b2.find((x) => x.period === period)!;
    const row = b.rows.find((r) => r.bucket === bucket && r.group === group && r.section === sec);
    checkTrue(`${period} ${bucket}/${group}/${sec} present`, !!row);
    if (!row) continue;
    check(`${period} ${bucket}/${group}/${sec} taxable`, row.total.taxable, tx);
    check(`${period} ${bucket}/${group}/${sec} IGST`, row.total.igst, ig);
    check(`${period} ${bucket}/${group}/${sec} CGST`, row.total.cgst, cg);
    check(`${period} ${bucket}/${group}/${sec} SGST`, row.total.sgst, sg);
  }

  section('GSTR-2B documents and cross-check');
  const B2_DOCS: Array<[string, number, number, number, number]> = [
    // period, docdata taxable, b2b available, b2b unavailable, cdnr
    ['062025', 3936286.00, 43, 0, 3],
    ['092025', 4875392.56, 51, 8, 4],
    ['122025', 3840814.05, 52, 0, 3],
    ['012026', 1246287.31, 10, 0, 0],
    ['022026', 666961.00, 9, 0, 1],
    ['032026', 105678.95, 15, 0, 2],
  ];
  for (const [period, tx, avl, unavl, cdnr] of B2_DOCS) {
    const b = ds.b2.find((x) => x.period === period)!;
    check(`${period} documents taxable`, b.docdataTaxable, tx);
    check(`${period} B2B with ITC`, b.docCounts.b2bAvl, avl, 0);
    check(`${period} B2B without ITC`, b.docCounts.b2bUnavl, unavl, 0);
    check(`${period} credit/debit notes`, b.docCounts.cdnr, cdnr, 0);
    checkTrue(`${period} documents tie to the ITC summary`, b.crossCheckOk, `delta ${inr(b.crossCheckDelta)}`);
  }
  check('09/2025 ITC blocked under reason P', ds.b2.find((x) => x.period === '092025')!.unavailReasons['P'] ?? 0, 8, 0);

  section('Outward comparison — basis follows the filing frequency');
  const cmp = model.fys[0].outwardCompare;
  const row = (label: string) => cmp.find((r) => r.label.startsWith(label));
  checkEq('Q1 compared quarter-wise', row('Q1')?.basis ?? '', 'quarter');
  check('Q1 difference', row('Q1')?.diff?.taxable ?? NaN, 0);
  check('Q2 difference', row('Q2')?.diff?.taxable ?? NaN, 0);
  check('Q3 difference', row('Q3')?.diff?.taxable ?? NaN, 0);
  checkEq('Feb 2026 compared month-wise', row('Feb 2026')?.basis ?? '', 'month');
  check('Feb 2026 difference', row('Feb 2026')?.diff?.taxable ?? NaN, 0);
  check('Mar 2026 difference', row('Mar 2026')?.diff?.taxable ?? NaN, 95000.00);
  checkEq('Jan 2026 has 3B but no GSTR-1', row('Jan 2026')?.status ?? '', '3b-only');

  section('ITC comparison (2B vs 3B, both monthly)');
  const m = (p: string) => model.fys[0].months.find((x) => x.period === p)!;
  check('Jan 2026 IGST difference', m('012026').itcCompare!.diff.igst, 0);
  check('Jan 2026 CGST difference', m('012026').itcCompare!.diff.cgst, 0);
  check('Sep 2025 IGST difference', m('092025').itcCompare!.diff.igst, 75932.64);
  check('Jun 2025 IGST difference', m('062025').itcCompare!.diff.igst, 388.00);
  check('Jun 2025 CGST difference', m('062025').itcCompare!.diff.cgst, 272.00);

  // ── Part 2: synthetic fixtures for what the sample cannot exercise ──────────
  const fixturesDir = process.argv[3];
  if (fixturesDir) {
    section('Edge cases (synthetic fixtures)');
    const fx = await ingestGstFiles(load(walk(fixturesDir)));

    const f = (p: string) => fx.r1.find((x) => x.period === p);
    check('chunked download merged into one period', f('072026')?.netOutward.taxable ?? NaN, 120000.00);
    checkTrue('IFF inferred for month 1 of a quarter', f('042026')?.iffInferred === true);
    checkTrue('IFF inferred for month 2 of a quarter', f('052026')?.iffInferred === true);
    check('IFF net of its credit note', f('042026')?.netOutward.taxable ?? NaN, 90000.00);
    check('quarterly GSTR-1 de-duplicated against the IFFs', f('062026')?.netOutward.taxable ?? NaN, 300000.00);
    check('documents removed as already in the IFF', f('062026')?.qrmpDedupedDocs ?? NaN, 2, 0);
    checkTrue('QRMP de-duplication reported', fx.warnings.some((w) => /QRMP de-duplication/.test(w)));
    check('filed copy beats the saved draft', f('082026')?.netOutward.taxable ?? NaN, 222222.00);
    checkTrue('superseded copy reported', fx.reports.some((r) => r.status === 'superseded'));
    check('every awkward GSTR-1 section read', f('092026')?.netOutward.taxable ?? NaN, 800000.00);  // 100k b2b + 250k b2cl + 50k b2cs + 400k exp − 10k credit note + 20k advances − 10k advances adjusted
    checkTrue('rubbish files rejected with a reason',
      fx.reports.filter((r) => r.status === 'rejected' && r.reason).length >= 2);
    checkTrue('a valid return still ingests alongside rejects', fx.b3.length > 0);
    check('BOM-prefixed 3B parsed', fx.b3.find((x) => x.period === '102026')?.outwardTaxable.taxable ?? NaN, 700000.00);
    const stringy = fx.b2.find((x) => x.period === '112026');
    check('quoted numbers coerced', stringy?.rows.find((r) => r.section === 'b2b')?.total.taxable ?? NaN, 50000.00);
    checkTrue('unknown ITC reason carried through raw', (stringy?.unavailReasons['ZZ'] ?? 0) === 1);
    checkTrue('unknown IMS status carried through raw', (stringy?.imsStatuses['Q'] ?? 0) === 1);
    checkTrue('nested ZIP of ZIPs unpacked without name collisions',
      !!f('122026') && !!f('012027'));
    const fxModel = buildGstSummary(fx);
    checkTrue('multiple financial years split', fxModel.fys.length >= 2, `${fxModel.fys.length} FYs`);

    // In-memory checks that need no file on disk.
    const mismatch = await ingestGstFiles([
      { name: 'a.json', bytes: enc({ gstin: '07AAAAA0000A1Z5', ret_period: '042026', sup_details: { osup_det: { txval: -500 } }, itc_elg: {} }) },
      { name: 'b.json', bytes: enc({ gstin: '09BBBBB1111B1Z5', ret_period: '052026', sup_details: {}, itc_elg: {} }) },
    ]);
    check('negative outward value preserved', mismatch.b3[0]?.outwardTaxable.taxable ?? NaN, -500);
    checkTrue('second GSTIN rejected with both GSTINs named',
      mismatch.reports.some((r) => r.status === 'rejected' && /07AAAAA0000A1Z5/.test(r.reason ?? '') && /09BBBBB1111B1Z5/.test(r.reason ?? '')));

    const itcOrder = await ingestGstFiles([{
      name: 'ty.json',
      bytes: enc({
        gstin: '07AAAAA0000A1Z5', ret_period: '062026', sup_details: {},
        itc_elg: { itc_avl: [{ ty: 'OTH', iamt: 10 }, { ty: 'IMPG', iamt: 20 }], itc_net: { iamt: 30 } },
      }),
    }]);
    check('ITC matched on type, not array position', itcOrder.b3[0].itcAvail['OTH'].igst, 10);
  }

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((e) => { console.error('validator crashed:', e); process.exit(2); });
