import React, { useMemo, useState } from 'react';
import { LedgerEntry } from '../../types';
import { groupVouchers, getUniqueLedgers, exportToExcel } from '../../services/dataService';
import { buildLedgerPrimaryMap, isPlPrimaryGroup } from '../../services/tally';
import { Search, Filter, PieChart, Download, ChevronUp, ChevronDown, CheckSquare, Square, X, CheckCircle2, List, FileText } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend } from 'recharts';

interface GSTLedgerSummaryProps {
  data: LedgerEntry[];
  externalSelectedLedgers?: string[];
  onLedgersUpdate?: (ledgers: string[]) => void;
}

type ConstitutionType = 'Sales/Income' | 'Expense/Purchase' | 'Payment/Receipt' | 'Inter-GST Adjustment' | 'Other';

interface ConstitutionBreakdown {
  dr: number;
  cr: number;
  count: number;
}

interface ConstitutionTransaction {
  date: string;
  voucher_number: string;
  voucher_type: string;
  amount: number;
  isDebit: boolean;
  nature: ConstitutionType;
  contraLedgers: string[];
  narration: string;
}

interface LedgerConstitution {
  ledgerName: string;
  opening: number;
  closing: number;
  breakdown: Record<ConstitutionType, ConstitutionBreakdown>;
  transactions: ConstitutionTransaction[];
}

const GSTLedgerSummary: React.FC<GSTLedgerSummaryProps> = ({ data, externalSelectedLedgers, onLedgersUpdate }) => {
  const [internalSelectedLedgers, setInternalSelectedLedgers] = useState<string[]>([]);
  const selectedLedgers = externalSelectedLedgers || internalSelectedLedgers;
  
  const setSelectedLedgers = (l: string[] | ((prev: string[]) => string[])) => {
    if (onLedgersUpdate) {
      const nextValue = typeof l === 'function' ? l(selectedLedgers) : l;
      onLedgersUpdate(nextValue);
    } else {
      setInternalSelectedLedgers(l);
    }
  };

  const [ledgerSearchTerm, setLedgerSearchTerm] = useState('');
  const [isSelectionExpanded, setIsSelectionExpanded] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const allLedgers = useMemo(() => getUniqueLedgers(data), [data]);
  const ledgerPrimary = useMemo(() => buildLedgerPrimaryMap(data), [data]);

  const filteredLedgersToSelect = useMemo(() => {
    if (!ledgerSearchTerm) return allLedgers;
    const terms = ledgerSearchTerm.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    return allLedgers.filter(ledger => {
      const lowerLedger = ledger.toLowerCase();
      return terms.every(term => lowerLedger.includes(term));
    });
  }, [allLedgers, ledgerSearchTerm]);

  // CORE LOGIC: Group vouchers and classify entries for selected ledgers
  const constitutionData = useMemo(() => {
    if (selectedLedgers.length === 0) return [];

    const voucherGroups = groupVouchers(data);
    const ledgerMap = new Map<string, LedgerConstitution>();

    // Initialize map
    selectedLedgers.forEach(l => {
      // Find opening/closing from first occurrence
      const entry = data.find(d => d.Ledger === l);
      ledgerMap.set(l, {
        ledgerName: l,
        opening: entry?.opening_balance || 0,
        closing: entry?.closing_balance || 0,
        breakdown: {
          'Sales/Income': { dr: 0, cr: 0, count: 0 },
          'Expense/Purchase': { dr: 0, cr: 0, count: 0 },
          'Payment/Receipt': { dr: 0, cr: 0, count: 0 },
          'Inter-GST Adjustment': { dr: 0, cr: 0, count: 0 },
          'Other': { dr: 0, cr: 0, count: 0 },
        },
        transactions: []
      });
    });

    voucherGroups.forEach(group => {
      // Check if this voucher affects any selected GST ledger
      const involvedSelectedLedgers = group.entries.filter(e => selectedLedgers.includes(e.Ledger));
      if (involvedSelectedLedgers.length === 0) return;

      // Classify the Voucher Nature based on strict rules provided
      let nature: ConstitutionType = 'Other';
      
      // Rule 1: Expense/Purchase (fixed asset, expense, purchase)
      const hasExpenseOrAsset = group.entries.some(e => {
        const p = (e.TallyPrimary || '').toLowerCase();
        return p.includes('fixed asset') || p.includes('expense') || p.includes('purchase');
      });

      // Rule 2: Sales/Income
      const hasSalesOrIncome = group.entries.some(e => {
        const p = (e.TallyPrimary || '').toLowerCase();
        return p.includes('sales') || p.includes('income');
      });

      // Rule 3: Bank/Cash (and NO Sales/Expense)
      const hasBankOrCash = group.entries.some(e => {
        const p = (e.TallyPrimary || '').toLowerCase();
        return p.includes('bank') || p.includes('cash');
      });

      if (hasExpenseOrAsset) {
        nature = 'Expense/Purchase';
      } else if (hasSalesOrIncome) {
        nature = 'Sales/Income';
      } else if (hasBankOrCash) {
        // Since we are in the 'else' of hasExpense and hasSales, those conditions are false.
        // So this implies "NO sale or no expense".
        nature = 'Payment/Receipt';
      } else {
        // Rule 4: Only other GST ledgers selected (Intrahead)
        const allAreSelected = group.entries.every(e => selectedLedgers.includes(e.Ledger));
        if (allAreSelected) {
            nature = 'Inter-GST Adjustment';
        } else {
            // Rule 5: Rest uncategorized
            nature = 'Other';
        }
      }

      // Distribute amounts to the specific ledger bucket
      involvedSelectedLedgers.forEach(entry => {
        const rec = ledgerMap.get(entry.Ledger);
        if (rec) {
          // Rule 6: Sign Convention (-ve is Debit, +ve is Credit)
          const isDebit = entry.amount < 0;
          const absAmt = Math.abs(entry.amount);

          const bucket = rec.breakdown[nature];
          if (isDebit) bucket.dr += absAmt;
          else bucket.cr += absAmt;
          bucket.count += 1;

          // Identify Contra Ledgers (Significant other ledgers in voucher)
          const contra = group.entries
            .filter(e => e.Ledger !== entry.Ledger)
            .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
            .map(e => e.Ledger)
            .filter((val, idx, arr) => arr.indexOf(val) === idx) // Unique
            .slice(0, 3);

          rec.transactions.push({
            date: group.date,
            voucher_number: group.voucher_number,
            voucher_type: group.voucher_type,
            amount: absAmt,
            isDebit: isDebit,
            nature: nature,
            contraLedgers: contra,
            narration: entry.narration || ''
          });
        }
      });
    });

    return Array.from(ledgerMap.values());
  }, [data, selectedLedgers]);

  // Handlers
  const toggleLedger = (ledger: string) => {
    setSelectedLedgers(prev => 
      prev.includes(ledger) ? prev.filter(l => l !== ledger) : [...prev, ledger]
    );
  };

  const selectAllFiltered = () => {
    setSelectedLedgers(prev => {
      const newSet = new Set(prev);
      filteredLedgersToSelect.forEach(l => newSet.add(l));
      return Array.from(newSet);
    });
  };

  const deselectAllFiltered = () => {
    const toRemove = new Set(filteredLedgersToSelect);
    setSelectedLedgers(prev => prev.filter(l => !toRemove.has(l)));
  };

  const handleExport = () => {
    const flatData = constitutionData.flatMap(row => {
      // Return detail rows
      return row.transactions.map(t => {
        const drCr = t.isDebit ? '(Dr)' : '(Cr)';
        const amtFormatted = `${t.amount} ${drCr}`;
        return {
          'Ledger Name': row.ledgerName,
          'Date': t.date,
          'Voucher No': t.voucher_number,
          'Voucher Type': t.voucher_type,
          'Particulars': t.contraLedgers.join(', '),
          'Sales/Income': t.nature === 'Sales/Income' ? amtFormatted : '',
          'Expense/Purchase': t.nature === 'Expense/Purchase' ? amtFormatted : '',
          'Payment/Receipt': t.nature === 'Payment/Receipt' ? amtFormatted : '',
          'Adjustment/Other': (t.nature === 'Inter-GST Adjustment' || t.nature === 'Other') ? amtFormatted : '',
          'Narration': t.narration
        };
      });
    });
    exportToExcel(flatData, `GST_Detailed_Constitution_${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="space-y-6">
      {/* 1. Selection Panel */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div 
          className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer"
          onClick={() => setIsSelectionExpanded(!isSelectionExpanded)}
        >
          <h2 className="text-lg font-semibold flex items-center gap-2 text-slate-800">
            <Filter className="text-blue-600" size={20} />
            Configure GST Ledgers
            <span className="text-sm font-normal text-slate-500 ml-2">
              ({selectedLedgers.length} selected)
            </span>
          </h2>
          <div className="text-slate-400">
            {isSelectionExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </div>
        </div>
        
        {isSelectionExpanded && (
          <div className="p-6">
            <div className="flex flex-col md:flex-row gap-4 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
                <input 
                  type="text" 
                  placeholder="Search tax ledgers (e.g., 'Input', 'Output', 'IGST')..." 
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  value={ledgerSearchTerm}
                  onChange={(e) => setLedgerSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => setSelectedLedgers(allLedgers.filter(l => l.toLowerCase().includes('gst') && !isPlPrimaryGroup(ledgerPrimary.get(l))))} className="px-3 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 border border-blue-200">
                   Auto-Select 'GST'
                </button>
                <button onClick={selectAllFiltered} className="px-3 py-2 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200 flex items-center gap-2">
                  <CheckSquare size={16} /> All
                </button>
                <button onClick={deselectAllFiltered} className="px-3 py-2 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200 flex items-center gap-2">
                  <Square size={16} /> None
                </button>
              </div>
            </div>

            <div className="max-h-[200px] overflow-y-auto border border-slate-200 rounded-lg bg-slate-50 p-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {filteredLedgersToSelect.map(ledger => {
                  const isSelected = selectedLedgers.includes(ledger);
                  return (
                    <div 
                      key={ledger} 
                      onClick={() => toggleLedger(ledger)}
                      className={`flex items-center gap-3 p-2.5 rounded-md cursor-pointer border transition-all select-none ${isSelected ? 'bg-blue-50 border-blue-300 shadow-sm' : 'bg-white border-slate-200 hover:border-blue-300'}`}
                    >
                      <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isSelected ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>
                        {isSelected && <CheckCircle2 size={12} className="text-white" />}
                      </div>
                      <span className={`text-sm truncate ${isSelected ? 'text-blue-900 font-medium' : 'text-slate-600'}`} title={ledger}>{ledger}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {selectedLedgers.length === 0 ? (
        <div className="p-12 text-center bg-slate-100 rounded-xl border-2 border-dashed border-slate-200 text-slate-400">
           <PieChart size={48} className="mx-auto mb-4 opacity-20" />
           <p>Select GST Ledgers above to analyze their constitution.</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex justify-end">
            <button onClick={handleExport} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-bold hover:bg-emerald-700 transition-colors shadow-sm">
              <Download size={16} /> Export Detail Report
            </button>
          </div>

          <div className="grid grid-cols-1 gap-6">
             {constitutionData.map(ledger => {
               const isOpen = expandedRow === ledger.ledgerName;
               
               // Prepare Chart Data
               const chartData = Object.entries(ledger.breakdown).map(([key, val]) => ({
                 name: key,
                 Debit: (val as ConstitutionBreakdown).dr,
                 Credit: (val as ConstitutionBreakdown).cr
               }));

               const totalDr = Object.values(ledger.breakdown).reduce((sum: number, v) => sum + (v as ConstitutionBreakdown).dr, 0);
               const totalCr = Object.values(ledger.breakdown).reduce((sum: number, v) => sum + (v as ConstitutionBreakdown).cr, 0);

               return (
                 <div key={ledger.ledgerName} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div 
                      className={`p-6 cursor-pointer hover:bg-slate-50 transition-colors ${isOpen ? 'bg-slate-50 border-b border-slate-100' : ''}`}
                      onClick={() => setExpandedRow(isOpen ? null : ledger.ledgerName)}
                    >
                       <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                          <div className="flex items-center gap-4">
                             <div className="p-3 bg-blue-100 text-blue-700 rounded-lg">
                                <PieChart size={24} />
                             </div>
                             <div>
                               <h3 className="text-lg font-bold text-slate-800">{ledger.ledgerName}</h3>
                               <p className="text-sm text-slate-500 font-medium">
                                 Net Movement: <span className="font-mono text-slate-700">Dr {(totalDr as any).toLocaleString('en-IN')}</span> / <span className="font-mono text-slate-700">Cr {(totalCr as any).toLocaleString('en-IN')}</span>
                               </p>
                             </div>
                          </div>
                          
                          <div className="flex items-center gap-8 text-right">
                             <div>
                                <p className="text-[10px] uppercase font-bold text-slate-400 mb-1">Sales Impact</p>
                                <p className="font-mono font-bold text-green-600 text-lg">
                                  {ledger.breakdown['Sales/Income'].cr > 0 ? `Cr ${(ledger.breakdown['Sales/Income'].cr as any).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '-'}
                                </p>
                             </div>
                             <div>
                                <p className="text-[10px] uppercase font-bold text-slate-400 mb-1">Expense Impact</p>
                                <p className="font-mono font-bold text-amber-600 text-lg">
                                  {ledger.breakdown['Expense/Purchase'].dr > 0 ? `Dr ${(ledger.breakdown['Expense/Purchase'].dr as any).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '-'}
                                </p>
                             </div>
                             <div className="text-slate-400">
                               {isOpen ? <ChevronUp size={24} /> : <ChevronDown size={24} />}
                             </div>
                          </div>
                       </div>
                    </div>

                    {isOpen && (
                      <div className="p-6 bg-white animate-in slide-in-from-top-2">
                         <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                            {/* Breakdown Table */}
                            <div className="overflow-x-auto border border-slate-100 rounded-xl h-fit">
                               <table className="w-full text-sm text-left">
                                  <thead className="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-wider">
                                     <tr>
                                        <th className="px-4 py-3">Source Category</th>
                                        <th className="px-4 py-3 text-right">Debit (Dr)</th>
                                        <th className="px-4 py-3 text-right">Credit (Cr)</th>
                                        <th className="px-4 py-3 text-center">Txns</th>
                                     </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100">
                                     {Object.entries(ledger.breakdown).map(([cat, val]) => {
                                        const v = val as ConstitutionBreakdown;
                                        return (
                                        <tr key={cat}>
                                           <td className="px-4 py-3 font-medium text-slate-700 flex items-center gap-2">
                                              <div className={`w-2 h-2 rounded-full ${
                                                cat.includes('Sales') ? 'bg-green-500' : 
                                                cat.includes('Expense') ? 'bg-amber-500' :
                                                cat.includes('Payment') ? 'bg-blue-500' :
                                                cat.includes('Adjust') ? 'bg-purple-500' : 'bg-slate-300'
                                              }`}></div>
                                              {cat}
                                           </td>
                                           <td className="px-4 py-3 text-right font-mono text-slate-600">{v.dr > 0 ? (v.dr as any).toLocaleString('en-IN') : '-'}</td>
                                           <td className="px-4 py-3 text-right font-mono text-slate-600">{v.cr > 0 ? (v.cr as any).toLocaleString('en-IN') : '-'}</td>
                                           <td className="px-4 py-3 text-center text-slate-400 text-xs">{v.count}</td>
                                        </tr>
                                     )})}
                                     <tr className="bg-slate-50 font-bold border-t border-slate-200">
                                        <td className="px-4 py-3 text-slate-800">Total</td>
                                        <td className="px-4 py-3 text-right font-mono text-slate-800">{(totalDr as any).toLocaleString('en-IN')}</td>
                                        <td className="px-4 py-3 text-right font-mono text-slate-800">{(totalCr as any).toLocaleString('en-IN')}</td>
                                        <td className="px-4 py-3"></td>
                                     </tr>
                                  </tbody>
                               </table>
                            </div>

                            {/* Chart */}
                            <div className="h-[250px] w-full bg-slate-50 rounded-xl border border-slate-100 p-4">
                               <ResponsiveContainer width="100%" height="100%">
                                  <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                                     <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                                     <XAxis type="number" hide />
                                     <YAxis dataKey="name" type="category" width={100} tick={{fontSize: 10}} />
                                     <RechartsTooltip 
                                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                        formatter={(val: number) => [`₹${val.toLocaleString()}`, '']}
                                     />
                                     <Legend iconType="circle" wrapperStyle={{ fontSize: '10px' }} />
                                     <Bar dataKey="Debit" fill="#f59e0b" radius={[0, 4, 4, 0]} name="Debit (Dr)" stackId="a" />
                                     <Bar dataKey="Credit" fill="#10b981" radius={[0, 4, 4, 0]} name="Credit (Cr)" stackId="a" />
                                  </BarChart>
                               </ResponsiveContainer>
                            </div>
                         </div>
                         
                         {/* Detailed Transaction Table */}
                         <div className="border border-slate-200 rounded-xl overflow-hidden">
                            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex justify-between items-center">
                              <h4 className="font-bold text-slate-700 text-sm flex items-center gap-2">
                                <List size={16} className="text-blue-500" /> 
                                Voucher Detail Analysis
                              </h4>
                              <span className="text-xs text-slate-500 bg-white px-2 py-1 rounded border border-slate-200">
                                {ledger.transactions.length} Transactions
                              </span>
                            </div>
                            <div className="max-h-[500px] overflow-y-auto">
                              <table className="w-full text-sm text-left">
                                <thead className="bg-white text-slate-500 font-bold text-[10px] uppercase sticky top-0 z-10 shadow-sm">
                                  <tr>
                                    <th className="px-4 py-3 bg-slate-50">Date</th>
                                    <th className="px-4 py-3 bg-slate-50">Voucher No</th>
                                    <th className="px-4 py-3 bg-slate-50 w-1/5">Particulars</th>
                                    <th className="px-4 py-3 text-right bg-slate-50 text-green-600">Sales / Income</th>
                                    <th className="px-4 py-3 text-right bg-slate-50 text-amber-600">Exp / Purch</th>
                                    <th className="px-4 py-3 text-right bg-slate-50 text-blue-600">Pmt / Rcpt</th>
                                    <th className="px-4 py-3 text-right bg-slate-50 text-slate-600">Adj / Other</th>
                                    <th className="px-4 py-3 bg-slate-50 w-1/5">Narration</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                  {ledger.transactions.map((txn, idx) => {
                                      const formattedAmt = (
                                          <span className="font-mono">
                                              {txn.amount.toLocaleString('en-IN')} 
                                              <span className="text-[10px] ml-1 text-slate-400">{txn.isDebit ? 'Dr' : 'Cr'}</span>
                                          </span>
                                      );

                                      return (
                                          <tr key={idx} className="hover:bg-blue-50/30 transition-colors group">
                                            <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{txn.date}</td>
                                            <td className="px-4 py-3 font-medium text-slate-900">{txn.voucher_number}</td>
                                            <td className="px-4 py-3 text-slate-700">
                                              <div className="flex flex-col gap-0.5">
                                                {txn.contraLedgers.length > 0 ? txn.contraLedgers.map(c => (
                                                  <span key={c} className="text-xs truncate max-w-[150px] block" title={c}>• {c}</span>
                                                )) : <span className="text-xs text-slate-400 italic">No contra found</span>}
                                              </div>
                                            </td>
                                            
                                            {/* Sales/Income */}
                                            <td className="px-4 py-3 text-right">
                                              {txn.nature === 'Sales/Income' ? <span className="text-green-700 font-medium">{formattedAmt}</span> : <span className="text-slate-200">-</span>}
                                            </td>

                                            {/* Expense/Purchase */}
                                            <td className="px-4 py-3 text-right">
                                              {txn.nature === 'Expense/Purchase' ? <span className="text-amber-700 font-medium">{formattedAmt}</span> : <span className="text-slate-200">-</span>}
                                            </td>

                                            {/* Payment/Receipt */}
                                            <td className="px-4 py-3 text-right">
                                              {txn.nature === 'Payment/Receipt' ? <span className="text-blue-700 font-medium">{formattedAmt}</span> : <span className="text-slate-200">-</span>}
                                            </td>

                                            {/* Adj/Other */}
                                            <td className="px-4 py-3 text-right">
                                              {(txn.nature === 'Inter-GST Adjustment' || txn.nature === 'Other') ? <span className="text-slate-700 font-medium">{formattedAmt}</span> : <span className="text-slate-200">-</span>}
                                            </td>

                                            <td className="px-4 py-3 text-xs text-slate-400 italic max-w-xs truncate group-hover:whitespace-normal group-hover:text-slate-600">
                                              {txn.narration}
                                            </td>
                                          </tr>
                                      );
                                  })}
                                </tbody>
                              </table>
                            </div>
                         </div>
                      </div>
                    )}
                 </div>
               );
             })}
          </div>
        </div>
      )}
    </div>
  );
};

export default GSTLedgerSummary;