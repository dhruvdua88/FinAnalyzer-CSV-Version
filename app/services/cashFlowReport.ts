// Cash Flow management report — a single self-contained HTML file.
//
// Same model as the Excel export (CashFlowExcelInput), so the two can never
// disagree: one set of figures, two renderings. Everything is inline — no CDN,
// no fonts to fetch, no <script> beyond the two toolbar buttons — so the file
// can be emailed and opened offline, and the PDF is produced by the browser's
// own print engine (File → Save as PDF), which makes it pixel-identical to the
// HTML rather than a re-drawn approximation.
//
// Charts are hand-rolled inline SVG. That keeps the report dependency-free and
// vector-crisp in print, where a canvas/raster chart would go fuzzy.

import type { CashFlowExcelInput } from './cashFlowExcel';

// ── Palette (mirrors excelStyles.PALETTE so the pack reads as one document) ──
const C = {
  band: '#0F2440',
  ink: '#0F172A',
  muted: '#64748B',
  line: '#CBD5E1',
  faint: '#F1F5F9',
  section: '#E2E8F0',
  paper: '#FFFFFF',
  inflow: '#047857',
  outflow: '#B91C1C',
  neutral: '#1D4ED8',
  accent: '#0EA5E9',
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Indian lakh/crore grouping, parentheses-negative, "Nil" for zero. */
const inr = (n: number, decimals = 2): string => {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) < 0.005) return 'Nil';
  const neg = n < 0;
  const [whole, frac] = Math.abs(n).toFixed(decimals).split('.');
  // Last three digits group normally; everything to the left groups in twos.
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  const out = frac ? `${grouped}.${frac}` : grouped;
  return neg ? `(${out})` : out;
};

/** Compact axis labels — a rupee axis in full digits is unreadable. */
const compact = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(a >= 1e8 ? 0 : 1)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)} L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)} K`;
  return n.toFixed(0);
};

const cls = (n: number): string => (n < 0 ? 'neg' : '');

// ── SVG chart primitives ──────────────────────────────────────────────────
interface Grouped { label: string; a: number; b: number; line: number }

/**
 * Grouped inflow/outflow bars with the running cash balance overlaid as a line
 * on its own scale. The one chart management actually reads.
 */
const groupedBarChart = (rows: Grouped[], w = 1080, h = 340): string => {
  if (!rows.length) return '<p class="empty">No monthly movement in the period.</p>';
  const m = { t: 24, r: 64, b: 52, l: 72 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const maxBar = Math.max(...rows.map((r) => Math.max(r.a, r.b)), 1);
  const lineVals = rows.map((r) => r.line);
  const lineMax = Math.max(...lineVals, 0);
  const lineMin = Math.min(...lineVals, 0);
  const lineSpan = lineMax - lineMin || 1;

  const bandW = iw / rows.length;
  const barW = Math.min(26, (bandW - 10) / 2);
  const yBar = (v: number) => m.t + ih - (v / maxBar) * ih;
  const yLine = (v: number) => m.t + ih - ((v - lineMin) / lineSpan) * ih;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = maxBar * f;
    const y = yBar(v);
    return `<line x1="${m.l}" y1="${y}" x2="${m.l + iw}" y2="${y}" stroke="${C.line}" stroke-width="1" stroke-dasharray="${f === 0 ? '0' : '3 3'}"/>`
      + `<text x="${m.l - 10}" y="${y + 4}" text-anchor="end" class="ax">${compact(v)}</text>`;
  }).join('');

  const bars = rows.map((r, i) => {
    const x = m.l + i * bandW + (bandW - barW * 2 - 4) / 2;
    return `<rect x="${x}" y="${yBar(r.a)}" width="${barW}" height="${Math.max(1, m.t + ih - yBar(r.a))}" fill="${C.inflow}" rx="2"><title>${esc(r.label)} — inflow ${inr(r.a)}</title></rect>`
      + `<rect x="${x + barW + 4}" y="${yBar(r.b)}" width="${barW}" height="${Math.max(1, m.t + ih - yBar(r.b))}" fill="${C.outflow}" rx="2"><title>${esc(r.label)} — outflow ${inr(r.b)}</title></rect>`;
  }).join('');

  const pts = rows.map((r, i) => `${m.l + i * bandW + bandW / 2},${yLine(r.line)}`).join(' ');
  const dots = rows.map((r, i) =>
    `<circle cx="${m.l + i * bandW + bandW / 2}" cy="${yLine(r.line)}" r="3.5" fill="${C.paper}" stroke="${C.neutral}" stroke-width="2"><title>${esc(r.label)} — closing cash ${inr(r.line)}</title></circle>`).join('');

  const xlabels = rows.map((r, i) =>
    `<text x="${m.l + i * bandW + bandW / 2}" y="${m.t + ih + 20}" text-anchor="middle" class="ax">${esc(r.label)}</text>`).join('');

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Monthly inflow, outflow and closing cash">
    ${ticks}${bars}
    <polyline points="${pts}" fill="none" stroke="${C.neutral}" stroke-width="2"/>${dots}
    <line x1="${m.l}" y1="${m.t + ih}" x2="${m.l + iw}" y2="${m.t + ih}" stroke="${C.ink}" stroke-width="1"/>
    ${xlabels}
  </svg>
  <div class="legend"><span><i style="background:${C.inflow}"></i>Inflow</span><span><i style="background:${C.outflow}"></i>Outflow</span><span><i class="ln" style="background:${C.neutral}"></i>Closing cash balance</span></div>`;
};

/** Horizontal bars — top counter-party groups by inflow or outflow. */
const hBarChart = (rows: Array<{ label: string; value: number }>, color: string, w = 520): string => {
  if (!rows.length) return '<p class="empty">Nothing to show.</p>';
  const rowH = 26;
  const h = rows.length * rowH + 12;
  const labelW = 190;
  const barMax = w - labelW - 96;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const bars = rows.map((r, i) => {
    const y = i * rowH + 6;
    const len = Math.max(2, (r.value / max) * barMax);
    return `<text x="${labelW - 8}" y="${y + 14}" text-anchor="end" class="lbl">${esc(r.label.length > 28 ? `${r.label.slice(0, 27)}…` : r.label)}</text>`
      + `<rect x="${labelW}" y="${y + 3}" width="${len}" height="14" fill="${color}" rx="2"><title>${esc(r.label)} — ${inr(r.value)}</title></rect>`
      + `<text x="${labelW + len + 8}" y="${y + 14}" class="val">${inr(r.value, 0)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img">${bars}</svg>`;
};

/** Net cash by activity — signed bars around a zero line. */
const activityChart = (rows: Array<{ label: string; value: number }>, w = 520, h = 240): string => {
  const m = { t: 20, r: 16, b: 40, l: 72 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  const zero = m.t + ih / 2;
  const scale = (v: number) => (v / max) * (ih / 2);
  const bandW = iw / rows.length;
  const barW = Math.min(72, bandW - 28);
  const bars = rows.map((r, i) => {
    const x = m.l + i * bandW + (bandW - barW) / 2;
    const len = Math.abs(scale(r.value));
    const y = r.value >= 0 ? zero - len : zero;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(1, len)}" rx="2" fill="${r.value >= 0 ? C.inflow : C.outflow}"><title>${esc(r.label)} — ${inr(r.value)}</title></rect>`
      + `<text x="${x + barW / 2}" y="${r.value >= 0 ? y - 7 : y + len + 15}" text-anchor="middle" class="val">${inr(r.value, 0)}</text>`
      + `<text x="${x + barW / 2}" y="${m.t + ih + 24}" text-anchor="middle" class="ax">${esc(r.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Net cash by activity">
    <line x1="${m.l}" y1="${zero}" x2="${m.l + iw}" y2="${zero}" stroke="${C.ink}" stroke-width="1"/>
    <text x="${m.l - 10}" y="${zero + 4}" text-anchor="end" class="ax">0</text>${bars}</svg>`;
};

// ── Table helpers ─────────────────────────────────────────────────────────
const num = (v: number | null, extra = ''): string =>
  v === null ? '<td class="n muted">—</td>' : `<td class="n ${cls(v)} ${extra}">${inr(v)}</td>`;

const statementTable = (i: CashFlowExcelInput): string => {
  const rows: string[] = [];
  (['Operating', 'Investing', 'Financing'] as const).forEach((activity) => {
    const buckets = i.statement.buckets.filter((b) => b.activity === activity);
    rows.push(`<tr class="sec"><td colspan="4">Cash flow from ${activity.toLowerCase()} activities</td></tr>`);
    if (!buckets.length) {
      rows.push('<tr><td class="ind muted">No flows classified to this activity</td><td colspan="3"></td></tr>');
    }
    buckets.forEach((b) => {
      rows.push(`<tr><td class="ind">${esc(b.bucket)}</td>${num(b.inflow)}${num(b.outflow)}${num(b.net)}</tr>`);
    });
    const t = i.statement.byActivity[activity];
    rows.push(`<tr class="sub"><td>Net cash from / (used in) ${activity.toLowerCase()} activities</td>${num(t.inflow)}${num(t.outflow)}${num(t.net)}</tr>`);
  });
  rows.push(`<tr class="adj"><td>Unclassified / contra adjustment</td><td></td><td></td>${num(i.statement.adjustmentNet)}</tr>`);
  rows.push(`<tr class="tot"><td>Net increase / (decrease) in cash &amp; cash equivalents</td><td></td><td></td>${num(i.statement.movement)}</tr>`);
  rows.push(`<tr><td>Opening cash &amp; cash equivalents</td><td></td><td></td>${num(i.statement.opening)}</tr>`);
  rows.push(`<tr class="tot grand"><td>Closing cash &amp; cash equivalents</td><td></td><td></td>${num(i.statement.closing)}</tr>`);
  if (i.cashPosition.referenceClosing !== null) {
    const d = i.cashPosition.reconciliationDiff ?? 0;
    const bad = Math.abs(d) >= 0.005;
    rows.push(`<tr><td class="muted">Closing cash per Tally ledger balances</td><td></td><td></td>${num(i.cashPosition.referenceClosing)}</tr>`);
    rows.push(`<tr class="sub"><td>Difference — must be Nil</td><td></td><td></td><td class="n ${bad ? 'bad' : ''}">${inr(d)}</td></tr>`);
  }
  return `<table class="fin"><thead><tr><th>Particulars</th><th class="n">Inflow</th><th class="n">Outflow</th><th class="n">Net</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
};

const LEDGER_ROWS_SHOWN = 25;

// ── Report ────────────────────────────────────────────────────────────────
export const buildCashFlowReportHtml = (i: CashFlowExcelInput, generatedOn: string): string => {
  const period = i.fromDate && i.toDate && i.fromDate !== '-'
    ? `For the period ${esc(i.fromDate)} to ${esc(i.toDate)}`
    : 'All periods in the dataset';

  let running = i.statement.opening;
  const monthly: Grouped[] = i.monthlySeries.map((mth) => {
    running += mth.inflow - mth.outflow;
    return { label: mth.monthLabel, a: mth.inflow, b: mth.outflow, line: running };
  });

  const topOut = [...i.primaryRows].filter((r) => r.outflow > 0).sort((a, b) => b.outflow - a.outflow)
    .slice(0, 8).map((r) => ({ label: r.label, value: r.outflow }));
  const topIn = [...i.primaryRows].filter((r) => r.inflow > 0).sort((a, b) => b.inflow - a.inflow)
    .slice(0, 8).map((r) => ({ label: r.label, value: r.inflow }));
  const byActivity = (['Operating', 'Investing', 'Financing'] as const)
    .map((a) => ({ label: a, value: i.statement.byActivity[a].net }));

  const recoDiff = i.cashPosition.reconciliationDiff;
  const recoBad = recoDiff !== null && Math.abs(recoDiff) >= 0.005;

  const kpi = (label: string, value: number, tone = ''): string =>
    `<div class="kpi ${tone}"><span class="k">${esc(label)}</span><strong class="${cls(value)}">${inr(value)}</strong></div>`;

  const ledgerRows = i.ledgerDetailRows.slice(0, LEDGER_ROWS_SHOWN).map((r) => `
    <tr><td>${esc(r.label)}</td><td>${esc(r.activity)}</td><td class="muted">${esc(r.primary)}</td>
    ${num(r.inflow)}${num(r.outflow)}${num(r.net)}
    <td class="n muted">${r.outflowShare.toFixed(1)}%</td><td class="n muted">${r.vouchers}</td></tr>`).join('');

  const cashRows = i.cashLedgerDetail.map((r) => {
    const bad = r.diff !== null && Math.abs(r.diff) >= 0.005;
    return `<tr><td>${esc(r.ledger)}</td>${num(r.opening)}${num(r.inflow)}${num(r.outflow)}${num(r.netMovement)}${num(r.closing)}${num(r.referenceClosing)}<td class="n ${bad ? 'bad' : 'muted'}">${r.diff === null ? '—' : inr(r.diff)}</td></tr>`;
  }).join('');

  const monthRows = monthly.map((m) => `<tr><td>${esc(m.label)}</td>${num(m.a)}${num(m.b)}${num(m.a - m.b)}${num(m.line)}</tr>`).join('');

  const reviewPoints: string[] = [
    'Classification is rule-based on the Tally primary group of the counter-party ledger. Ledgers grouped incorrectly in Tally will be classified incorrectly here.',
    'A large unclassified / contra adjustment usually means cash-to-bank transfers, or ledgers under a group the rules do not recognise.',
    'Inflow and outflow are shown gross; no netting has been applied within a bucket.',
  ];
  if (Math.abs(i.totals.blockedCapitalOutflow) >= 0.005) {
    reviewPoints.push(`Outflow of ${inr(i.totals.blockedCapitalOutflow)} sits in ledgers flagged as blocked capital — confirm the classification.`);
  }
  if (recoBad) {
    reviewPoints.push(`Computed closing cash differs from the Tally ledger closing balances by ${inr(recoDiff!)}. Resolve before circulating.`);
  }

  return `<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Cash Flow Report — ${esc(i.companyTitle)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #E9EDF2; color: ${C.ink};
    font: 13px/1.45 "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; }
  .sheet { max-width: 1180px; margin: 18px auto; background: ${C.paper}; padding: 0 0 28px;
    box-shadow: 0 1px 3px rgba(15,36,64,.16); }
  .bar { position: sticky; top: 0; z-index: 5; display: flex; gap: 8px; justify-content: flex-end;
    padding: 10px 14px; background: #F8FAFC; border-bottom: 1px solid ${C.line}; }
  .bar button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 6px; padding: 7px 14px;
    border: 1px solid ${C.band}; background: ${C.band}; color: #fff; }
  .bar button.ghost { background: #fff; color: ${C.band}; }
  header.band { background: ${C.band}; color: #fff; padding: 22px 32px; }
  header.band h1 { margin: 0; font-size: 21px; letter-spacing: .2px; }
  header.band .t { margin: 3px 0 0; font-size: 14px; font-weight: 600; opacity: .95; letter-spacing: 1.4px; }
  header.band .p { margin: 8px 0 0; font-size: 12.5px; opacity: .82; }
  section { padding: 0 32px; }
  h2 { font-size: 12.5px; letter-spacing: 1.1px; text-transform: uppercase; color: ${C.band};
    background: ${C.section}; padding: 7px 10px; margin: 26px 0 12px; border-radius: 3px; }
  h3 { font-size: 12.5px; margin: 0 0 8px; color: ${C.muted}; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 18px; }
  .kpi { border: 1px solid ${C.line}; border-radius: 6px; padding: 11px 13px; background: #FCFDFE; }
  .kpi .k { display: block; font-size: 11px; color: ${C.muted}; text-transform: uppercase; letter-spacing: .5px; }
  .kpi strong { display: block; margin-top: 5px; font-size: 17px; font-variant-numeric: tabular-nums; }
  .kpi.hero { background: ${C.band}; border-color: ${C.band}; }
  .kpi.hero .k { color: #A8BBD2; } .kpi.hero strong { color: #fff; }
  .flag { margin-top: 14px; padding: 10px 13px; border-radius: 6px; font-size: 12.5px;
    background: #FEF2F2; border: 1px solid #FECACA; color: #991B1B; }
  .flag.ok { background: #F0FDF4; border-color: #BBF7D0; color: #166534; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 5px 9px; border-bottom: 1px solid #EDF1F6; text-align: left; vertical-align: top; }
  thead th { background: ${C.section}; color: ${C.band}; font-size: 11.5px; text-transform: uppercase;
    letter-spacing: .4px; border-bottom: 1px solid ${C.line}; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  .muted { color: ${C.muted}; } .neg { color: ${C.outflow}; } .bad { color: ${C.outflow}; font-weight: 700; }
  .empty { color: ${C.muted}; font-style: italic; }
  table.fin td.ind { padding-left: 26px; }
  table.fin tr.sec td { background: ${C.section}; font-weight: 700; font-size: 12px;
    text-transform: uppercase; letter-spacing: .5px; padding-top: 8px; padding-bottom: 8px; }
  table.fin tr.sub td { background: ${C.faint}; font-weight: 700; border-top: 1px solid ${C.line}; }
  table.fin tr.adj td { font-style: italic; color: ${C.muted}; }
  table.fin tr.tot td { font-weight: 700; background: #E8EEF5; border-top: 1px solid #94A3B8; }
  table.fin tr.grand td { border-bottom: 3px double ${C.ink}; }
  tbody tr:nth-child(even) td { background-color: #FBFCFE; }
  table.fin tbody tr:nth-child(even) td { background-color: transparent; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; align-items: start; }
  .chart { width: 100%; height: auto; }
  .chart text.ax { font-size: 11px; fill: ${C.muted}; }
  .chart text.lbl { font-size: 11px; fill: ${C.ink}; }
  .chart text.val { font-size: 10.5px; fill: ${C.muted}; }
  .legend { display: flex; gap: 18px; font-size: 11.5px; color: ${C.muted}; margin-top: 4px; }
  .legend i { display: inline-block; width: 11px; height: 11px; border-radius: 2px; margin-right: 6px;
    vertical-align: -1px; }
  .legend i.ln { height: 3px; border-radius: 2px; vertical-align: 3px; }
  dl.basis { display: grid; grid-template-columns: 220px 1fr; gap: 5px 16px; margin: 0; font-size: 12.5px; }
  dl.basis dt { font-weight: 600; } dl.basis dd { margin: 0; color: #334155; }
  ol.points { margin: 8px 0 0; padding-left: 20px; font-size: 12.5px; color: #334155; }
  ol.points li { margin-bottom: 5px; }
  footer { margin: 26px 32px 0; padding-top: 12px; border-top: 1px solid ${C.line};
    font-size: 11.5px; color: ${C.muted}; }

  /* Print / PDF — the same document through the browser's own renderer, which
     is what makes the PDF identical to the screen rather than a re-drawing. */
  @page { size: A4 landscape; margin: 11mm; }
  @media print {
    body { background: #fff; }
    .sheet { max-width: none; margin: 0; box-shadow: none; }
    .bar { display: none; }
    section, footer { padding-left: 0; padding-right: 0; margin-left: 0; margin-right: 0; }
    header.band { padding: 14px 0 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    h2, thead th, table.fin tr.sec td, table.fin tr.sub td, table.fin tr.tot td, .kpi.hero,
    .flag, .kpi { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    thead { display: table-header-group; }
    tr, .kpi { break-inside: avoid; }
    /* A chart must travel with its heading — pinning break-inside on the <svg>
       alone strands the chart on the next page under a blank one. Keep the
       whole cell together instead. No forced page breaks: they leave
       half-empty pages, and break-inside already stops ugly splits. */
    .grid2 > div, .legend { break-inside: avoid; }
    .chart { break-before: avoid; }
    h2, h3 { break-after: avoid; }
  }
</style>
<div class="sheet">
  <div class="bar no-print">
    <button class="ghost" onclick="window.print()">Save as PDF / Print</button>
  </div>
  <header class="band">
    <h1>${esc(i.companyTitle)}</h1>
    <p class="t">CASH FLOW ANALYSIS</p>
    <p class="p">${period} &nbsp;•&nbsp; Prepared on ${esc(generatedOn)} &nbsp;•&nbsp; Amounts in Rupees (Rs.)</p>
  </header>

  <section>
    <div class="kpis">
      ${kpi('Opening cash', i.cashPosition.opening)}
      ${kpi('Total inflow', i.totals.inflow)}
      ${kpi('Total outflow', i.totals.outflow)}
      ${kpi('Net movement', i.cashPosition.periodMovement)}
      ${kpi('Closing cash', i.cashPosition.closing, 'hero')}
    </div>
    ${i.cashPosition.referenceClosing === null ? '' : recoBad
      ? `<p class="flag"><strong>Reconciliation break.</strong> Computed closing cash differs from the Tally ledger closing balances by ${inr(recoDiff!)}. Investigate before circulating this pack.</p>`
      : '<p class="flag ok"><strong>Reconciled.</strong> Computed closing cash agrees with the Tally ledger closing balances.</p>'}
  </section>

  <section>
    <h2>Cash flow statement</h2>
    ${statementTable(i)}
  </section>

  <section>
    <h2>Monthly cash flow and closing balance</h2>
    ${groupedBarChart(monthly)}
  </section>

  <section>
    <h2>Where the cash came from and went</h2>
    <div class="grid2">
      <div><h3>Net cash by activity</h3>${activityChart(byActivity)}</div>
      <div><h3>Top outflows by group</h3>${hBarChart(topOut, C.outflow)}</div>
    </div>
    <div class="grid2" style="margin-top:18px">
      <div><h3>Top inflows by group</h3>${hBarChart(topIn, C.inflow)}</div>
      <div><h3>Movement by month</h3>
        <table><thead><tr><th>Month</th><th class="n">Inflow</th><th class="n">Outflow</th><th class="n">Net</th><th class="n">Running cash</th></tr></thead>
        <tbody>${monthRows || '<tr><td colspan="5" class="empty">No monthly movement.</td></tr>'}</tbody></table>
      </div>
    </div>
  </section>

  <section>
    <h2>Movement in cash &amp; bank ledgers</h2>
    <table><thead><tr><th>Cash / bank ledger</th><th class="n">Opening</th><th class="n">Inflow</th>
      <th class="n">Outflow</th><th class="n">Net movement</th><th class="n">Closing</th>
      <th class="n">Per Tally</th><th class="n">Difference</th></tr></thead>
      <tbody>${cashRows || '<tr><td colspan="8" class="empty">No cash ledger selected.</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Flow by counter-party ledger</h2>
    <table><thead><tr><th>Counter-party ledger</th><th>Activity</th><th>Primary group</th>
      <th class="n">Inflow</th><th class="n">Outflow</th><th class="n">Net</th>
      <th class="n">Outflow %</th><th class="n">Vouchers</th></tr></thead>
      <tbody>${ledgerRows || '<tr><td colspan="8" class="empty">No flows in the period.</td></tr>'}</tbody></table>
    ${i.ledgerDetailRows.length > LEDGER_ROWS_SHOWN
      ? `<p class="empty" style="margin-top:8px">Showing the ${LEDGER_ROWS_SHOWN} largest by absolute net flow; ${i.ledgerDetailRows.length - LEDGER_ROWS_SHOWN} further ledgers are in the Excel export.</p>`
      : ''}
  </section>

  <section>
    <h2>Basis of preparation</h2>
    <dl class="basis">
      <dt>Period covered</dt><dd>${period.replace(/^For the period /, '')}</dd>
      <dt>Cash &amp; bank ledgers</dt><dd>${i.cashLedgers.length ? esc(i.cashLedgers.join(', ')) : 'None selected'}</dd>
      <dt>Method</dt><dd>Direct method — built from actual voucher movement in the cash &amp; bank ledgers.</dd>
      <dt>Classification</dt><dd>Each flow is classified to Operating, Investing or Financing from the Tally primary group of the counter-party ledger.</dd>
      <dt>Vouchers analysed</dt><dd>${i.totals.voucherCount.toLocaleString('en-IN')}</dd>
      <dt>Filters applied</dt><dd>Search: ${esc(i.filters.search || 'none')} &nbsp;|&nbsp; Direction: ${esc(i.filters.direction === 'all' ? 'all flows' : i.filters.direction)} &nbsp;|&nbsp; Minimum amount: ${esc(i.filters.minAmount || 'none')}</dd>
    </dl>
    <h3 style="margin-top:18px">Points for review</h3>
    <ol class="points">${reviewPoints.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
  </section>

  <footer>
    Generated by FinAnalyzer on ${esc(generatedOn)} from the imported Tally data. Figures are as extracted;
    classification of each flow is rule-based and should be reviewed before publication.
  </footer>
</div>`;
};
