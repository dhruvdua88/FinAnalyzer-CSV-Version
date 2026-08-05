// Post-processing for workbooks written by xlsx-js-style.
//
// The library writes cells, styles, merges, column widths, margins, autofilters
// and defined names, but it does NOT emit three things that matter on a wide
// financial sheet:
//
//   • freeze panes      — `ws['!freeze']` is accepted and then silently dropped
//   • gridline control  — statements read better without the grid
//   • page setup        — landscape and fit-to-one-page-wide for printing
//
// So we open the finished .xlsx (it is a ZIP), splice the three elements into
// each worksheet at their schema-mandated positions, and repackage. Element
// ORDER inside <worksheet> is fixed by the OOXML schema — put them in the wrong
// place and Excel refuses the file — hence the explicit anchors below.

import JSZip from 'jszip';

export interface SheetPolish {
  /** Rows/columns to freeze, e.g. { rows: 4, cols: 1 } freezes 4 rows and column A. */
  freeze?: { rows: number; cols: number };
  showGridLines?: boolean;
  landscape?: boolean;
  fitToWidth?: boolean;
}

const colName = (n: number): string => {
  let s = '';
  let x = n;
  while (x >= 0) { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; }
  return s;
};

const paneXml = (rows: number, cols: number): string => {
  if (rows <= 0 && cols <= 0) return '';
  const top = `${colName(cols)}${rows + 1}`;
  const active = cols > 0 && rows > 0 ? 'bottomRight' : cols > 0 ? 'topRight' : 'bottomLeft';
  const attrs = [
    cols > 0 ? `xSplit="${cols}"` : '',
    rows > 0 ? `ySplit="${rows}"` : '',
    `topLeftCell="${top}"`,
    `activePane="${active}"`,
    'state="frozen"',
  ].filter(Boolean).join(' ');
  return `<pane ${attrs}/><selection pane="${active}" activeCell="${top}" sqref="${top}"/>`;
};

const sheetViewsXml = (p: SheetPolish): string =>
  `<sheetViews><sheetView showGridLines="${p.showGridLines === false ? 0 : 1}" workbookViewId="0">`
  + `${p.freeze ? paneXml(p.freeze.rows, p.freeze.cols) : ''}</sheetView></sheetViews>`;

/** Excel's own defaults; pageSetup is only valid immediately after pageMargins. */
const MARGINS_XML =
  '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';

const pageSetupXml = (p: SheetPolish): string =>
  `<pageSetup paperSize="9" orientation="${p.landscape ? 'landscape' : 'portrait'}"`
  + `${p.fitToWidth ? ' fitToWidth="1" fitToHeight="0"' : ''}/>`;

/**
 * Splice the missing worksheet elements in. Keyed by sheet NAME, resolved to the
 * underlying sheetN.xml through the workbook relationships.
 */
export const polishXlsx = async (
  data: ArrayBuffer | Uint8Array,
  perSheet: Record<string, SheetPolish>,
  defaults: SheetPolish = {},
): Promise<Uint8Array> => {
  const zip = await JSZip.loadAsync(data);

  // sheet name -> r:id -> target path
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wbXml || !relsXml) return new Uint8Array(data as ArrayBuffer);

  const relTarget = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTarget.set(m[1], m[2].replace(/^\/?xl\//, ''));
  }
  const sheetPath = new Map<string, string>();
  for (const m of wbXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = relTarget.get(m[2]);
    if (target) sheetPath.set(decodeXml(m[1]), `xl/${target}`);
  }

  for (const [name, path] of sheetPath) {
    const file = zip.file(path);
    if (!file) continue;
    const polish = { ...defaults, ...(perSheet[name] ?? {}) };
    let xml = await file.async('string');

    // The library emits an empty <sheetViews><sheetView .../></sheetViews>, so the
    // existing element is rewritten rather than a second one inserted — two would
    // be schema-invalid. sheetViews sits after <sheetPr>/<dimension> and before
    // <sheetFormatPr>/<cols>/<sheetData>.
    const views = sheetViewsXml(polish);
    if (/<sheetViews>[\s\S]*?<\/sheetViews>/.test(xml)) {
      xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, views);
    } else if (/<sheetViews\s*\/>/.test(xml)) {
      xml = xml.replace(/<sheetViews\s*\/>/, views);
    } else {
      const afterDimension = /(<dimension[^>]*\/>)/.exec(xml);
      if (afterDimension) xml = xml.replace(afterDimension[1], `${afterDimension[1]}${views}`);
      else xml = xml.replace(/(<worksheet[^>]*>)/, `$1${views}`);
    }

    // pageSetup must sit immediately after pageMargins, and the pair must come
    // BEFORE any of the elements the schema orders after them — in practice
    // <ignoredErrors>, which xlsx-js-style emits whenever a sheet carries
    // numbers-stored-as-text. Appending at the end of <worksheet> puts them in
    // the wrong order and Excel refuses the file outright ("unreadable
    // content"), while LibreOffice happily opens it — so this must be anchored,
    // never appended.
    if (!/<pageSetup[^>]*\/>/.test(xml)) {
      const setup = pageSetupXml(polish);
      if (/<pageMargins[^>]*\/>/.test(xml)) {
        xml = xml.replace(/(<pageMargins[^>]*\/>)/, `$1${setup}`);
      } else {
        // No margins written at all — emit the pair together at the right anchor.
        const block = `${MARGINS_XML}${setup}`;
        const anchor = /<(ignoredErrors|smartTags|drawing|legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(xml);
        xml = anchor
          ? xml.replace(anchor[0], `${block}${anchor[0]}`)
          : xml.replace('</worksheet>', `${block}</worksheet>`);
      }
    }
    // fitToPage has to be declared on sheetPr for fitToWidth to take effect.
    if (polish.fitToWidth && !/<sheetPr[^>]*>/.test(xml)) {
      xml = xml.replace(/(<worksheet[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    }

    zip.file(path, xml);
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
};

const decodeXml = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** Trigger a browser download of polished workbook bytes. */
export const downloadPolished = (bytes: Uint8Array, filename: string): void => {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
