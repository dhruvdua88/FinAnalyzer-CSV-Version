/**
 * Generate the Schedule III financial statements and the Trial Balance from a
 * Tally ZIP, without opening the app. Useful for reviewing a client file or
 * diffing the output of a change.
 *
 * Usage: npx tsx scripts/exportStatements.ts <zip> [outDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx-js-style';
import { TallyStore } from '../services/tally';
import { getTrialBalance } from '../services/tally/queries';
import * as BS from '../services/balanceSheet';
import { buildFinancialStatementsWorkbook } from '../services/financialStatementsExcel';
import { buildTrialBalanceWorkbook } from '../services/trialBalanceExcel';
import { ageParties } from '../services/ageingFifo';

const main = async () => {
  const zip = process.argv[2];
  if (!zip) {
    console.error('usage: tsx scripts/exportStatements.ts <zip> [outDir]');
    process.exit(2);
  }
  const outDir = process.argv[3] || '.';
  mkdirSync(outDir, { recursive: true });

  const store = await TallyStore.fromZip(new Blob([new Uint8Array(readFileSync(zip))]));
  const branch = BS.buildBranchFromStore(store as any, store.meta?.companyName || 'Main', {});
  const entries = store.getLedgerEntries();

  const fs = buildFinancialStatementsWorkbook({
    branches: [branch],
    consolidated: null,
    companyTitle: branch.company,
    periodLabel: branch.periodLabel,
    primaryGroups: BS.collectPrimaryGroups([{ store: store as any, branchName: branch.branchName }], {}),
    payablesAgeing: ageParties(entries, 'creditor', branch.periodTo || undefined),
    receivablesAgeing: ageParties(entries, 'debtor', branch.periodTo || undefined),
  });

  const tb = buildTrialBalanceWorkbook({
    tb: getTrialBalance(store as any),
    companyTitle: branch.company,
    hideUnused: true,
  });

  const slug = (branch.company || 'company').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
  const stamp = (branch.periodTo || '').replace(/-/g, '');
  const fsPath = join(outDir, `${slug}_Financial_Statements_${stamp}.xlsx`);
  const tbPath = join(outDir, `${slug}_Trial_Balance_${stamp}.xlsx`);
  writeFileSync(fsPath, XLSX.write(fs, { type: 'buffer', bookType: 'xlsx', cellStyles: true }));
  writeFileSync(tbPath, XLSX.write(tb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }));

  console.log(`balance difference : ${BS.bsReconciliation(branch).toFixed(2)}`);
  console.log(`profit before tax  : ${BS.profitBeforeTax(branch).toFixed(2)}`);
  for (const d of branch.diagnostics) console.log(`${d.severity.toUpperCase()} ${d.code}: ${d.message}`);
  console.log(`\nwrote ${fsPath}\nwrote ${tbPath}`);
};

main().catch((e) => { console.error(e); process.exit(1); });
