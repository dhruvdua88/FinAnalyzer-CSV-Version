import React, { useMemo, useState, useEffect } from 'react';
import { LedgerEntry } from '../../types';
import { getUniqueLedgers, exportToExcel } from '../../services/dataService';
import { useTallyStore } from '../../services/tally';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { Search, Filter, Download, ChevronDown, ChevronUp, X, CheckSquare, Square, TrendingUp, TrendingDown, AlertCircle, Settings2 } from 'lucide-react';

interface VarianceAnalysisProps {
  data: LedgerEntry[];
}

// Interfaces for internal calculations
interface MonthlyData {
  monthKey: string; // YYYY-MM
  monthLabel: string; // MMM YYYY
  amount: number;
}

interface LedgerTrend {
  ledgerName: string;
  totalAmount: number;
  monthlyData: Record<string, number>; // key: YYYY-MM, value: amount
  maxVariancePct: number;
  maxVarianceAmount: number;
}

const VarianceAnalysis: React.FC<VarianceAnalysisProps> = ({ data }) => {
  // mst_group.is_revenue gives Tally's authoritative P&L-vs-BS verdict.
  // When the ZIP store is loaded we use it for auto-select (every P&L
  // ledger is picked), which is more accurate than the previous keyword
  // scan that missed e.g. "Commission Received" or "Foreign Exchange Gain"
  // that don't contain the literal words "expense" or "purchase".
  const store = useTallyStore();
  const ledgerIsRevenueMap = useMemo(() => {
    const map = new Map<string, boolean>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      const g = store.group(l.parent);
      // ledger.is_revenue is also populated; fall back to its group's flag
      // when the ledger itself doesn't carry one.
      const flag = l.is_revenue || (g?.is_revenue ?? false);
      map.set(l.name.trim().toLowerCase(), flag);
    }
    return map;
  }, [store]);
  // 1. Persistence for Ledger Selection
  const [selectedLedgers, setSelectedLedgers] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('variance_selected_ledgers');
      return saved ? JSON.parse(saved) : null; // Return null to trigger auto-detection
    } catch (e) {
      return null;
    }
  });

  const [ledgerSearchTerm, setLedgerSearchTerm] = useState('');
  const [isSelectionExpanded, setIsSelectionExpanded] = useState(false); // Collapsed by default to show data immediately
  
  // Analysis Settings
  const [varianceThreshold, setVarianceThreshold] = useState<number>(20); // %
  const [minAmountFilter, setMinAmountFilter] = useState<string>('1000'); // Absolute amount to ignore small noises

  const allLedgers = useMemo(() => getUniqueLedgers(data), [data]);

  // 2. Auto-Detect Expenses/Purchases if no previous selection
  useEffect(() => {
    if (selectedLedgers === null) {
      const autoSelected = allLedgers.filter(ledger => {
        // Prefer Tally's authoritative is_revenue flag from mst_group when
        // available — picks up every P&L ledger including ones whose names
        // don't contain the literal "expense" / "purchase".
        const isRev = ledgerIsRevenueMap.get(ledger.trim().toLowerCase());
        if (isRev !== undefined) return isRev;

        // Fallback: keyword scan against TallyPrimary / Group for live-loader
        // imports where the relational store isn't populated.
        const entry = data.find(d => d.Ledger === ledger);
        if (!entry) return false;

        const primary = (entry.TallyPrimary || '').toLowerCase();
        const group = (entry.Group || '').toLowerCase();

        return (
          primary.includes('expense') ||
          primary.includes('purchase') ||
          group.includes('expense') ||
          group.includes('purchase')
        );
      });
      setSelectedLedgers(autoSelected);
    }
  }, [allLedgers, data, selectedLedgers, ledgerIsRevenueMap]);

  // Persist changes
  useEffect(() => {
    if (selectedLedgers !== null) {
      localStorage.setItem('variance_selected_ledgers', JSON.stringify(selectedLedgers));
    }
  }, [selectedLedgers]);

  // 3. Prepare Pivot Data
  const { pivotData, allMonths, chartData } = useMemo(() => {
    if (!selectedLedgers || selectedLedgers.length === 0) {
      return { pivotData: [], allMonths: [], chartData: [] };
    }

    const monthsSet = new Set<string>();
    const ledgerMap = new Map<string, LedgerTrend>();

    // Init map
    selectedLedgers.forEach(l => {
      ledgerMap.set(l, {
        ledgerName: l,
        totalAmount: 0,
        monthlyData: {},
        maxVariancePct: 0,
        maxVarianceAmount: 0
      });
    });

    // Populate data
    data.forEach(entry => {
      if (!selectedLedgers.includes(entry.Ledger)) return;
      
      const date = new Date(entry.date);
      if (isNaN(date.getTime())) return;

      const monthKey = entry.date.substring(0, 7); // YYYY-MM
      monthsSet.add(monthKey);

      const record = ledgerMap.get(entry.Ledger)!;
      // Use absolute amount for expenses to handle debits correctly
      const amount = Math.abs(entry.amount); 
      
      record.totalAmount += amount;
      record.monthlyData[monthKey] = (record.monthlyData[monthKey] || 0) + amount;
    });

    const sortedMonths = Array.from(monthsSet).sort();

    // Calculate Variances
    const finalTrends = Array.from(ledgerMap.values()).map(trend => {
      let maxVarPct = 0;
      let maxVarAmt = 0;

      for (let i = 1; i < sortedMonths.length; i++) {
        const currMonth = sortedMonths[i];
        const prevMonth = sortedMonths[i-1];
        
        const currVal = trend.monthlyData[currMonth] || 0;
        const prevVal = trend.monthlyData[prevMonth] || 0;

        const diff = currVal - prevVal;
        
        if (prevVal !== 0) {
          const pct = Math.abs((diff / prevVal) * 100);
          if (pct > maxVarPct) maxVarPct = pct;
        } else if (currVal > 0) {
          // Infinite/New growth
          maxVarPct = 100; 
        }

        if (Math.abs(diff) > maxVarAmt) maxVarAmt = Math.abs(diff);
      }
      
      return { ...trend, maxVariancePct: maxVarPct, maxVarianceAmount: maxVarAmt };
    });

    // Filter by threshold logic for the *Display List*, but we return everything for Pivot
    // We will apply filtering in the render or a secondary memo if needed.
    
    // Prepare Chart Data (Top 5 by Variance Amount)
    const topVolatile = [...finalTrends]
      .filter(t => t.totalAmount > (parseFloat(minAmountFilter) || 0))
      .sort((a,b) => b.maxVarianceAmount - a.maxVarianceAmount)
      .slice(0, 5);

    const cData = sortedMonths.map(m => {
      const point: any = { month: m };
      topVolatile.forEach(t => {
        point[t.ledgerName] = t.monthlyData[m] || 0;
      });
      return point;
    });

    return { 
      pivotData: finalTrends, 
      allMonths: sortedMonths,
      chartData: cData
    };
  }, [data, selectedLedgers, minAmountFilter]);

  // 4. Filtering the Table View
  const filteredPivot = useMemo(() => {
    return pivotData.filter(row => {
      const meetsThreshold = row.maxVariancePct >= varianceThreshold;
      const meetsMinAmount = row.totalAmount >= (parseFloat(minAmountFilter) || 0);
      return meetsThreshold && meetsMinAmount;
    }).sort((a,b) => b.totalAmount - a.totalAmount);
  }, [pivotData, varianceThreshold, minAmountFilter]);

  // Handlers
  const filteredLedgersToSelect = useMemo(() => {
    if (!ledgerSearchTerm) return allLedgers;
    const terms = ledgerSearchTerm.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    return allLedgers.filter(ledger => {
      const lowerLedger = ledger.toLowerCase();
      return terms.every(term => lowerLedger.includes(term));
    });
  }, [allLedgers, ledgerSearchTerm]);

  const toggleLedger = (ledger: string) => {
    if (!selectedLedgers) return;
    setSelectedLedgers(prev => 
      prev!.includes(ledger) ? prev!.filter(l => l !== ledger) : [...prev!, ledger]
    );
  };

  const selectAllFiltered = () => {
    setSelectedLedgers(prev => {
      const newSet = new Set(prev || []);
      filteredLedgersToSelect.forEach(l => newSet.add(l));
      return Array.from(newSet);
    });
  };

  const deselectAllFiltered = () => {
    const toRemove = new Set(filteredLedgersToSelect);
    setSelectedLedgers(prev => (prev || []).filter(l => !toRemove.has(l)));
  };

  const handleExport = () => {
    const dataToExport = filteredPivot.map(row => {
      const flatRow: any = {
        'Ledger Name': row.ledgerName,
        'Total Amount': row.totalAmount,
        'Max Variance %': row.maxVariancePct.toFixed(2),
        'Max Deviation â‚¹': row.maxVarianceAmount
      };
      allMonths.forEach(m => {
        flatRow[m] = row.monthlyData[m] || 0;
      });
      return flatRow;
    });
    exportToExcel(dataToExport, `Variance_Analysis_${new Date().toISOString().slice(0,10)}`);
  };

  // Helper to color code cells
  const getCellColor = (curr: number, prev: number) => {
    if (prev === 0 && curr === 0) return '';
    if (prev === 0 && curr > 0) return 'bg-red-50 text-red-700'; // New expense
    
    const diff = curr - prev;
    const pct = (diff / prev) * 100;
    
    if (Math.abs(pct) < varianceThreshold) return '';
    if (pct > 0) return 'bg-red-50 text-red-700 font-medium'; // Increase in expense is bad usually
    return 'bg-green-50 text-green-700 font-medium'; // Decrease is good
  };

  const formatMonth = (isoMonth: string) => {
    const [y, m] = isoMonth.split('-');
    const date = new Date(parseInt(y), parseInt(m) - 1, 1);
    return date.toLocaleString('default', { month: 'short', year: '2-digit' });
  };

  if (selectedLedgers === null) {
    return <div className="p-8 text-center">Initializing Analysis...</div>;
  }

  return (
    <div className="space-y-6">
      {/* 1. Header & Controls */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
         <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col md:flex-row md:justify-between md:items-center gap-4">
             <div>
               <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                 <TrendingUp className="text-purple-600" />
                 Month-on-Month Variance Analysis
               </h2>
               <p className="text-sm text-slate-500">
                 Analyzing <span className="font-semibold text-slate-700">{filteredPivot.length}</span> ledgers (Purchase/Expenses) across <span className="font-semibold text-slate-700">{allMonths.length}</span> months.
               </p>
             </div>
             
             <div className="flex items-center gap-4">
               <div className="flex flex-col">
                  <span className="text-[10px] text-slate-500 font-semibold uppercase">Sensitivity (%)</span>
                  <input 
                    type="number" 
                    value={varianceThreshold} 
                    onChange={e => setVarianceThreshold(Number(e.target.value))}
                    className="w-24 px-2 py-1 text-sm border border-slate-300 rounded focus:ring-2 focus:ring-purple-500"
                  />
               </div>
               <div className="flex flex-col">
                  <span className="text-[10px] text-slate-500 font-semibold uppercase">Min Amount (â‚¹)</span>
                  <input 
                    type="number" 
                    value={minAmountFilter} 
                    onChange={e => setMinAmountFilter(e.target.value)}
                    className="w-24 px-2 py-1 text-sm border border-slate-300 rounded focus:ring-2 focus:ring-purple-500"
                  />
               </div>
               <button 
                  onClick={() => setIsSelectionExpanded(!isSelectionExpanded)}
                  className={`p-2 rounded-lg border transition-all ${isSelectionExpanded ? 'bg-purple-100 text-purple-700 border-purple-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
                  title="Configure Ledgers"
               >
                 <Settings2 size={20} />
               </button>
             </div>
         </div>

         {/* Collapsible Ledger Selection */}
         {isSelectionExpanded && (
          <div className="p-6 bg-slate-50/50 border-b border-slate-200 animate-in slide-in-from-top-2">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Filter Ledgers to Analyze</h3>
            <div className="flex flex-col md:flex-row gap-4 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
                <input 
                  type="text" 
                  placeholder="Search ledgers..." 
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  value={ledgerSearchTerm}
                  onChange={(e) => setLedgerSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={selectAllFiltered} className="px-3 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 border border-blue-200 flex items-center gap-2">
                  <CheckSquare size={16} /> Select All
                </button>
                <button onClick={deselectAllFiltered} className="px-3 py-2 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200 flex items-center gap-2">
                  <Square size={16} /> Deselect All
                </button>
              </div>
            </div>

            <div className="max-h-[200px] overflow-y-auto border border-slate-200 rounded-lg bg-white p-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {filteredLedgersToSelect.map(ledger => {
                  const isSelected = selectedLedgers.includes(ledger);
                  return (
                    <div 
                      key={ledger} 
                      onClick={() => toggleLedger(ledger)}
                      className={`flex items-center gap-3 p-2.5 rounded-md cursor-pointer border transition-all select-none ${isSelected ? 'bg-purple-50 border-purple-300 shadow-sm' : 'bg-white border-slate-200 hover:border-purple-300'}`}
                    >
                      <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isSelected ? 'bg-purple-600 border-purple-600' : 'bg-white border-slate-300'}`}>
                        {isSelected && <CheckSquare size={12} className="text-white" />}
                      </div>
                      <span className={`text-sm truncate ${isSelected ? 'text-purple-900 font-medium' : 'text-slate-600'}`} title={ledger}>{ledger}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Charts Section */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
           <div className="lg:col-span-3 bg-white p-6 rounded-xl shadow-sm border border-slate-200">
             <h3 className="text-slate-700 font-semibold mb-4 flex items-center gap-2">
               <TrendingUp size={18} className="text-purple-600"/>
               Trend: Top 5 High-Variance Ledgers
             </h3>
             <div className="h-64 w-full">
               <ResponsiveContainer width="100%" height="100%">
                 <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                   <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                   <XAxis dataKey="month" tickFormatter={formatMonth} stroke="#94a3b8" fontSize={12} />
                   <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(val) => `â‚¹${(val/1000).toFixed(0)}k`} />
                   <RechartsTooltip 
                     contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                     formatter={(value: number) => [`â‚¹${value.toLocaleString()}`, '']}
                   />
                   <Legend />
                   {Object.keys(chartData[0] || {}).filter(k => k !== 'month').map((key, index) => (
                     <Line 
                        key={key} 
                        type="monotone" 
                        dataKey={key} 
                        stroke={`hsl(${index * 60}, 70%, 50%)`} 
                        strokeWidth={2} 
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                     />
                   ))}
                 </LineChart>
               </ResponsiveContainer>
             </div>
           </div>
        </div>
      )}

      {/* 3. Detailed Pivot Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700">
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
           <h3 className="font-semibold text-slate-800">Monthly Breakdown</h3>
           <button onClick={handleExport} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors shadow-sm">
              <Download size={16} /> Export
           </button>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-slate-50 text-slate-500 font-medium">
              <tr>
                <th className="px-4 py-3 sticky left-0 bg-slate-50 z-10 border-b border-r border-slate-200 min-w-[200px]">Ledger Name</th>
                <th className="px-4 py-3 text-right border-b border-r border-slate-200 bg-slate-50 min-w-[120px]">Total</th>
                {allMonths.map(m => (
                  <th key={m} className="px-4 py-3 text-right border-b border-slate-200 min-w-[100px] whitespace-nowrap">
                    {formatMonth(m)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPivot.length > 0 ? filteredPivot.map((row) => (
                <tr key={row.ledgerName} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-700 sticky left-0 bg-white border-r border-slate-100 truncate max-w-[250px]" title={row.ledgerName}>
                    {row.ledgerName}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-slate-800 border-r border-slate-100 bg-slate-50/30">
                    {row.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                  {allMonths.map((m, idx) => {
                    const amount = row.monthlyData[m] || 0;
                    const prevAmount = idx > 0 ? row.monthlyData[allMonths[idx-1]] || 0 : 0;
                    const colorClass = idx > 0 ? getCellColor(amount, prevAmount) : '';
                    
                    return (
                      <td key={m} className={`px-4 py-3 text-right font-mono text-slate-600 border-r border-slate-50 ${colorClass}`}>
                        {amount > 0 ? amount.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '-'}
                      </td>
                    );
                  })}
                </tr>
              )) : (
                <tr>
                  <td colSpan={allMonths.length + 2} className="p-8 text-center text-slate-400">
                    <div className="flex flex-col items-center">
                      <AlertCircle size={32} className="mb-2 opacity-50"/>
                      <p>No variances found matching current threshold ({varianceThreshold}% and {'>'} INR {minAmountFilter})</p>
                      <p className="text-xs mt-1">Try lowering the sensitivity or adding more ledgers.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default VarianceAnalysis;
