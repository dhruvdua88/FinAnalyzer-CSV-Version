import React, { useMemo, useState, useEffect } from 'react';
import { LedgerEntry, GSTRateResult } from '../../types';
import { groupVouchers, getUniqueLedgers, exportToExcel } from '../../services/dataService';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip } from 'recharts';
import { Search, Filter, AlertTriangle, CheckCircle2, XCircle, Download, ChevronDown, ChevronUp, CheckSquare, Square, ArrowUpDown, Table2, Layers, Users, X } from 'lucide-react';

interface GSTRateAnalysisProps {
  data: LedgerEntry[];
  externalSelectedLedgers?: string[];
  onLedgersUpdate?: (ledgers: string[]) => void;
}

const STANDARD_RATES = [5, 12, 18, 28];

const toISODate = (dateStr: string): string => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  return dateStr;
};

type SortKey = keyof GSTRateResult | 'statusDetail';
type SortDirection = 'asc' | 'desc';

interface LedgerSummary {
  ledgerName: string;
  count: number;
  totalSale: number;
  totalTax: number;
  avgRate: number;
}

interface PartySummary {
  partyName: string;
  totalSale: number;
  totalTax: number;
  avgRate: number;
  salesLedgers: string[];
}

const GSTRateAnalysis: React.FC<GSTRateAnalysisProps> = ({ data, externalSelectedLedgers, onLedgersUpdate }) => {
  // Use external state if provided, otherwise internal
  const [internalSelectedLedgers, setInternalSelectedLedgers] = useState<string[]>([]);
  
  const selectedGstLedgers = externalSelectedLedgers || internalSelectedLedgers;
  const setSelectedGstLedgers = (l: string[] | ((prev: string[]) => string[])) => {
    if (onLedgersUpdate) {
      const nextValue = typeof l === 'function' ? l(selectedGstLedgers) : l;
      onLedgersUpdate(nextValue);
    } else {
      setInternalSelectedLedgers(l);
    }
  };

  const [ledgerSearchTerm, setLedgerSearchTerm] = useState('');
  
  const [rateFilter, setRateFilter] = useState<string>('all');
  const [expandedVoucher, setExpandedVoucher] = useState<string | null>(null);
  const [isSelectionExpanded, setIsSelectionExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<'vouchers' | 'summary' | 'party'>('vouchers');
  
  const [sortConfig, setSortConfig] = useState<{ key: SortKey | 'ledgerName' | 'totalSale' | 'partyName'; direction: SortDirection }>({
    key: 'date',
    direction: 'desc'
  });

  const allLedgers = useMemo(() => getUniqueLedgers(data), [data]);
  
  const analysisResults = useMemo(() => {
    if (selectedGstLedgers.length === 0) return [];

    const voucherGroups = groupVouchers(data);
    const results: GSTRateResult[] = [];

    voucherGroups.forEach(group => {
      let totalTax = 0;
      let totalSale = 0;
      const taxLedgersInVoucher: string[] = [];
      const salesLedgersInVoucher: string[] = [];

      group.entries.forEach(entry => {
        if (selectedGstLedgers.includes(entry.Ledger)) {
          totalTax += Math.abs(entry.amount); 
          taxLedgersInVoucher.push(entry.Ledger);
        }

        const primary = (entry.TallyPrimary || '').toLowerCase();
        const groupName = (entry.Group || '').toLowerCase();
        
        const isSale = 
          primary.includes('sales') || 
          primary.includes('income') || 
          primary.includes('revenue') ||
          groupName.includes('sales');

        if (isSale) {
          totalSale += Math.abs(entry.amount);
          salesLedgersInVoucher.push(entry.Ledger);
        }
      });

      if (totalSale > 0) {
        let calculatedRate = 0;
        let status: GSTRateResult['status'] = 'Rate Issues';
        let statusDetail = '';

        // Master-declared rate from mst_stock_item (via the TallyStore shim).
        // Each accounting line carries the GST rate of the voucher's first
        // inventory item; we read the highest non-zero rate seen.
        const masterRate = Math.max(0, ...group.entries.map((e) => Number(e.gst_rate) || 0));
        const hsn = group.entries.find((e) => e.gst_hsn_code)?.gst_hsn_code || '';

        if (totalTax === 0) {
          status = 'GST Not Charged';
          statusDetail = 'No Tax Found';
        } else {
          calculatedRate = (totalTax / totalSale) * 100;

          let matched = false;

          // When master rate is on file, treat that as the reference. Falls
          // back to the standard-rate matcher otherwise — preserves the
          // legacy behaviour when the user imported via the live loader.
          if (masterRate > 0) {
            const tolerance = Math.max(0.5, masterRate * 0.02);
            if (Math.abs(calculatedRate - masterRate) <= tolerance) {
              status = 'Match';
              statusDetail = `Match ${masterRate}% (master)`;
              matched = true;
            } else {
              status = 'Rate Issues';
              statusDetail = `Master ${masterRate}% vs Derived ${calculatedRate.toFixed(2)}%`;
              matched = true;
            }
          }

          if (!matched) {
            for (const stdRate of STANDARD_RATES) {
              const tolerance = stdRate * 0.05;
              if (Math.abs(calculatedRate - stdRate) <= tolerance) {
                status = 'Match';
                statusDetail = `Match ${stdRate}%`;
                matched = true;
                break;
              }
            }
          }

          if (!matched) {
            status = 'Rate Issues';
            statusDetail = `${calculatedRate.toFixed(2)}% (Non-Std)`;
          }
        }

        const partyEntry = group.entries.find(e =>
          (e.TallyPrimary || '').toLowerCase().includes('debtor') ||
          (e.TallyPrimary || '').toLowerCase().includes('creditor')
        );
        const partyName = partyEntry ? partyEntry.Ledger : 'Unknown Party';

        results.push({
          voucher_number: group.voucher_number,
          date: group.date,
          party_name: partyName,
          saleAmount: totalSale,
          taxAmount: totalTax,
          calculatedRate: parseFloat(calculatedRate.toFixed(2)),
          masterRate: masterRate > 0 ? masterRate : undefined,
          hsn: hsn || undefined,
          taxLedgers: [...new Set(taxLedgersInVoucher)],
          salesLedgers: [...new Set(salesLedgersInVoucher)],
          status,
          statusDetail
        });
      }
    });

    return results;
  }, [data, selectedGstLedgers]);

  const filteredLedgersToSelect = useMemo(() => {
    if (!ledgerSearchTerm) return allLedgers;
    const terms = ledgerSearchTerm.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    return allLedgers.filter(ledger => {
      const lowerLedger = ledger.toLowerCase();
      return terms.every(term => lowerLedger.includes(term));
    });
  }, [allLedgers, ledgerSearchTerm]);

  const filteredAndSortedResults = useMemo(() => {
    let res = analysisResults;

    if (rateFilter !== 'all') {
      if (rateFilter === 'issues') res = res.filter(r => r.status === 'Rate Issues');
      else if (rateFilter === 'zero') res = res.filter(r => r.status === 'GST Not Charged');
      else {
        const rateTarget = parseFloat(rateFilter);
        if (!isNaN(rateTarget)) {
           res = res.filter(r => {
             const tolerance = rateTarget * 0.05;
             return Math.abs(r.calculatedRate - rateTarget) <= tolerance;
           });
        }
      }
    }

    res.sort((a, b) => {
      // @ts-ignore
      let aValue: any = a[sortConfig.key];
      // @ts-ignore
      let bValue: any = b[sortConfig.key];

      if (sortConfig.key === 'date') {
        aValue = new Date(aValue).getTime();
        bValue = new Date(bValue).getTime();
      }

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return res;
  }, [analysisResults, rateFilter, sortConfig]);

  // Ledger Summary Calculation
  const ledgerSummary = useMemo(() => {
    const summary: Record<string, LedgerSummary> = {};
    
    filteredAndSortedResults.forEach(r => {
      const primaryLedger = r.salesLedgers[0] || 'Unknown Ledger';
      
      if (!summary[primaryLedger]) {
        summary[primaryLedger] = {
          ledgerName: primaryLedger,
          count: 0,
          totalSale: 0,
          totalTax: 0,
          avgRate: 0
        };
      }
      
      summary[primaryLedger].count += 1;
      summary[primaryLedger].totalSale += r.saleAmount;
      summary[primaryLedger].totalTax += r.taxAmount;
    });

    return Object.values(summary).map(s => ({
      ...s,
      avgRate: s.totalSale > 0 ? (s.totalTax / s.totalSale) * 100 : 0
    })).sort((a,b) => b.totalSale - a.totalSale);
  }, [filteredAndSortedResults]);

  // Party Summary Calculation
  const partySummary = useMemo(() => {
    const summary: Record<string, PartySummary> = {};
    
    filteredAndSortedResults.forEach(r => {
      const pName = r.party_name || 'Unknown Party';
      if (!summary[pName]) {
        summary[pName] = {
          partyName: pName,
          totalSale: 0,
          totalTax: 0,
          avgRate: 0,
          salesLedgers: []
        };
      }
      
      summary[pName].totalSale += r.saleAmount;
      summary[pName].totalTax += r.taxAmount;
      
      r.salesLedgers.forEach(l => {
        if (!summary[pName].salesLedgers.includes(l)) {
          summary[pName].salesLedgers.push(l);
        }
      });
    });

    return Object.values(summary).map(s => ({
      ...s,
      avgRate: s.totalSale > 0 ? (s.totalTax / s.totalSale) * 100 : 0
    })).sort((a,b) => b.totalSale - a.totalSale);
  }, [filteredAndSortedResults]);

  const chartData = useMemo(() => {
    const counts = { Match: 0, Issues: 0, Zero: 0 };
    analysisResults.forEach(r => {
      if (r.status === 'Match') counts.Match++;
      else if (r.status === 'Rate Issues') counts.Issues++;
      else counts.Zero++;
    });
    return [
      { name: 'Matched', value: counts.Match, fill: '#10b981' }, 
      { name: 'Issues', value: counts.Issues, fill: '#f59e0b' }, 
      { name: 'Not Charged', value: counts.Zero, fill: '#ef4444' },
    ];
  }, [analysisResults]);

  const handleSort = (key: any) => {
    setSortConfig(current => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const toggleLedger = (ledger: string) => {
    setSelectedGstLedgers(prev => 
      prev.includes(ledger) ? prev.filter(l => l !== ledger) : [...prev, ledger]
    );
  };

  const selectAllFiltered = () => {
    setSelectedGstLedgers(prev => {
      const newSet = new Set(prev);
      filteredLedgersToSelect.forEach(l => newSet.add(l));
      return Array.from(newSet);
    });
  };

  const deselectAllFiltered = () => {
    const toRemove = new Set(filteredLedgersToSelect);
    setSelectedGstLedgers(prev => prev.filter(l => !toRemove.has(l)));
  };

  const handleExport = () => {
    const dateStr = new Date().toISOString().slice(0,10);

    if (viewMode === 'summary') {
      const exportData = ledgerSummary.map(r => ({
        'Sales Ledger': r.ledgerName,
        'Count': r.count,
        'Total Sales': r.totalSale,
        'Total GST': r.totalTax,
        'Avg Rate (%)': r.avgRate
      }));
      exportToExcel(exportData, `Sales_GST_Ledger_Summary_${dateStr}`);
    } else if (viewMode === 'party') {
      const exportData = partySummary.map(r => ({
        'Party Name': r.partyName,
        'Total Sales': r.totalSale,
        'Total GST': r.totalTax,
        'Avg Rate (%)': r.avgRate,
        'Sales Ledgers': r.salesLedgers.join(', ')
      }));
      exportToExcel(exportData, `Sales_GST_Party_Summary_${dateStr}`);
    } else {
      const exportData = filteredAndSortedResults.map(r => ({
        Date: toISODate(r.date),
        'Voucher No': r.voucher_number,
        Party: r.party_name,
        'Sale Amount': r.saleAmount,
        'Tax Amount': r.taxAmount,
        'Calculated Rate (%)': r.calculatedRate,
        'Status': r.status,
        'Status Detail': r.statusDetail,
        'Tax Ledgers': r.taxLedgers.join(', '),
        'Sales Ledgers': r.salesLedgers.join(', ')
      }));
      exportToExcel(exportData, `Sales_GST_Voucher_Analysis_${dateStr}`);
    }
  };

  const HeaderCell = ({ label, colKey, align = 'left' }: { label: string, colKey: string, align?: string }) => (
    <th 
      className={`px-4 py-3 cursor-pointer hover:bg-slate-100 transition-colors text-${align}`}
      onClick={() => handleSort(colKey)}
    >
      <div className={`flex items-center gap-1 ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'}`}>
        {label} 
        {sortConfig.key === colKey ? (
             <ArrowUpDown size={14} className={`ml-1 ${sortConfig.direction === 'asc' ? 'text-blue-600' : 'text-blue-600 rotate-180'}`} />
        ) : (
             <ArrowUpDown size={14} className="opacity-30 ml-1" />
        )}
      </div>
    </th>
  );

  const renderTableContent = () => {
    if (viewMode === 'vouchers') {
      return (
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
            <tr>
              <th className="px-4 py-3 w-10"></th>
              <HeaderCell label="Date" colKey="date" />
              <HeaderCell label="Voucher" colKey="voucher_number" />
              <HeaderCell label="Party" colKey="party_name" />
              <HeaderCell label="Sale Val" colKey="saleAmount" align="right" />
              <HeaderCell label="GST Val" colKey="taxAmount" align="right" />
              <HeaderCell label="Rate" colKey="calculatedRate" align="center" />
              <HeaderCell label="Status" colKey="statusDetail" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredAndSortedResults.map((row) => {
              const isMatch = row.status === 'Match';
              const isZero = row.status === 'GST Not Charged';
              return (
                <React.Fragment key={row.voucher_number}>
                  <tr 
                    className={`hover:bg-slate-50 transition-colors cursor-pointer ${expandedVoucher === row.voucher_number ? 'bg-blue-50/50' : ''}`}
                    onClick={() => setExpandedVoucher(expandedVoucher === row.voucher_number ? null : row.voucher_number)}
                  >
                    <td className="px-4 py-3 text-center text-slate-400">
                      {expandedVoucher === row.voucher_number ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </td>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{row.date}</td>
                    <td className="px-4 py-3 font-medium text-slate-900">{row.voucher_number}</td>
                    <td className="px-4 py-3 text-slate-600 truncate max-w-[200px]">{row.party_name}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">{row.saleAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">{row.taxAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td className="px-4 py-3 text-center font-mono">
                      {row.calculatedRate}%
                    </td>
                    <td className="px-4 py-3">
                       <div className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border
                         ${isMatch ? 'bg-green-50 text-green-700 border-green-200' : 
                           isZero ? 'bg-red-50 text-red-700 border-red-200' : 
                           'bg-amber-50 text-amber-700 border-amber-200'}
                       `}>
                         {isMatch ? <CheckCircle2 size={12} /> : isZero ? <XCircle size={12} /> : <AlertTriangle size={12} />}
                         {row.statusDetail}
                       </div>
                    </td>
                  </tr>
                  
                  {expandedVoucher === row.voucher_number && (
                    <tr className="bg-slate-50/50 shadow-inner">
                      <td colSpan={8} className="px-4 py-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs ml-8">
                          <div>
                            <h4 className="font-semibold text-slate-700 mb-1 flex items-center gap-1">Sales Ledgers</h4>
                            <ul className="text-slate-600 space-y-1 bg-white p-2 rounded border border-slate-200">
                              {row.salesLedgers.map(l => <li key={l}>• {l}</li>)}
                              {row.salesLedgers.length === 0 && <li className="text-slate-400 italic">None detected</li>}
                            </ul>
                          </div>
                          <div>
                            <h4 className="font-semibold text-slate-700 mb-1 flex items-center gap-1">Tax Ledgers</h4>
                            <ul className="text-slate-600 space-y-1 bg-white p-2 rounded border border-slate-200">
                              {row.taxLedgers.map(l => <li key={l}>• {l}</li>)}
                              {row.taxLedgers.length === 0 && <li className="text-slate-400 italic">None detected</li>}
                            </ul>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      );
    }

    if (viewMode === 'summary') {
      return (
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
            <tr>
              <th className="px-4 py-3">Sales Ledger</th>
              <th className="px-4 py-3 text-right">Count</th>
              <th className="px-4 py-3 text-right">Total Sales</th>
              <th className="px-4 py-3 text-right">Total GST</th>
              <th className="px-4 py-3 text-center">Avg Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ledgerSummary.length > 0 ? ledgerSummary.map(row => (
              <tr key={row.ledgerName} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-700">{row.ledgerName}</td>
                <td className="px-4 py-3 text-right text-slate-600">{row.count}</td>
                <td className="px-4 py-3 text-right font-mono text-slate-800">{row.totalSale.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                <td className="px-4 py-3 text-right font-mono text-blue-600">{row.totalTax.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                <td className="px-4 py-3 text-center text-slate-600">{row.avgRate.toFixed(2)}%</td>
              </tr>
            )) : (
               <tr><td colSpan={5} className="p-8 text-center text-slate-400">No data available for summary</td></tr>
            )}
          </tbody>
        </table>
      );
    }

    if (viewMode === 'party') {
      return (
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
            <tr>
              <th className="px-4 py-3">Party Name</th>
              <th className="px-4 py-3 text-right">Total Sales</th>
              <th className="px-4 py-3 text-right">Total GST</th>
              <th className="px-4 py-3 text-center">Avg Rate</th>
              <th className="px-4 py-3">Sales Ledgers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {partySummary.length > 0 ? partySummary.map(row => (
              <tr key={row.partyName} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-700 max-w-[200px] truncate" title={row.partyName}>{row.partyName}</td>
                <td className="px-4 py-3 text-right font-mono text-slate-800">{row.totalSale.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                <td className="px-4 py-3 text-right font-mono text-blue-600">{row.totalTax.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                <td className="px-4 py-3 text-center text-slate-600">{row.avgRate.toFixed(2)}%</td>
                <td className="px-4 py-3 text-slate-500 text-xs break-words max-w-[250px]">{row.salesLedgers.join(', ')}</td>
              </tr>
            )) : (
               <tr><td colSpan={5} className="p-8 text-center text-slate-400">No data available for summary</td></tr>
            )}
          </tbody>
        </table>
      );
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Configuration Panel */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div 
          className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer"
          onClick={() => setIsSelectionExpanded(!isSelectionExpanded)}
        >
          <h2 className="text-lg font-semibold flex items-center gap-2 text-slate-800">
            <Filter className="text-blue-600" size={20} />
            Step 1: Select GST Ledgers
            <span className="text-sm font-normal text-slate-500 ml-2">
              ({selectedGstLedgers.length} selected)
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
                  placeholder="Search ledgers (e.g., 'input 18', 'output sgst')..." 
                  className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  value={ledgerSearchTerm}
                  onChange={(e) => setLedgerSearchTerm(e.target.value)}
                />
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={selectAllFiltered} className="px-3 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors flex items-center gap-2 border border-blue-200">
                  <CheckSquare size={16} /> Select Visible
                </button>
                <button onClick={deselectAllFiltered} className="px-3 py-2 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors flex items-center gap-2 border border-slate-200">
                  <Square size={16} /> Deselect Visible
                </button>
              </div>
            </div>

            {selectedGstLedgers.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2 p-3 bg-blue-50/50 rounded-lg border border-blue-100">
                <span className="text-xs font-semibold text-blue-800 uppercase tracking-wider py-1">Selected:</span>
                {selectedGstLedgers.slice(0, 10).map(l => (
                  <span key={l} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-white text-blue-700 border border-blue-200 shadow-sm">
                    {l}
                    <button onClick={() => toggleLedger(l)} className="hover:text-red-500"><X size={12} /></button>
                  </span>
                ))}
                {selectedGstLedgers.length > 10 && (
                  <span className="text-xs text-slate-500 py-0.5">+{selectedGstLedgers.length - 10} more...</span>
                )}
                <button onClick={() => setSelectedGstLedgers([])} className="ml-auto text-xs text-red-600 hover:underline font-medium">Clear All</button>
              </div>
            )}

            <div className="max-h-[300px] overflow-y-auto border border-slate-200 rounded-lg bg-slate-50 p-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {filteredLedgersToSelect.map(ledger => {
                  const isSelected = selectedGstLedgers.includes(ledger);
                  return (
                    <div 
                      key={ledger} 
                      onClick={() => toggleLedger(ledger)}
                      className={`flex items-center gap-3 p-2.5 rounded-md cursor-pointer border transition-all select-none ${isSelected ? 'bg-blue-50 border-blue-300 shadow-sm' : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}`}
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

      {selectedGstLedgers.length === 0 ? (
        <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-xl p-12 text-center text-slate-500">
           <Filter size={48} className="mx-auto text-slate-300 mb-4" />
           <h3 className="text-lg font-medium text-slate-700">No GST Ledgers Selected</h3>
           <p className="max-w-md mx-auto mt-2">Please search and select the ledgers representing GST Tax (IGST, CGST, SGST, etc.) in the panel above to begin analysis.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col justify-center">
              <h3 className="text-sm font-medium text-slate-500 mb-1">Vouchers with Sales</h3>
              <p className="text-3xl font-bold text-slate-800">{analysisResults.length}</p>
              <div className="mt-2 text-xs text-slate-400">Total processed</div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 col-span-2">
              <h3 className="text-sm font-medium text-slate-500 mb-2">Validation Overview</h3>
              <div className="h-40 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis dataKey="name" type="category" width={80} tick={{fontSize: 12}} />
                    <RechartsTooltip cursor={{fill: 'transparent'}} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={30} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-center gap-4 bg-slate-50/50">
              <div className="flex items-center gap-4 flex-wrap">
                <h2 className="font-semibold text-slate-800">Sales GST Results</h2>
                <div className="flex gap-2 flex-wrap">
                   <div className="flex items-center gap-2 bg-slate-200 p-1 rounded-lg mr-2">
                        <button onClick={() => setViewMode('vouchers')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${viewMode === 'vouchers' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                          <Table2 size={14} /> Vouchers
                        </button>
                        <button onClick={() => setViewMode('summary')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${viewMode === 'summary' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                          <Layers size={14} /> Ledgers
                        </button>
                        <button onClick={() => setViewMode('party')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${viewMode === 'party' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
                          <Users size={14} /> Parties
                        </button>
                   </div>
                   <select 
                      value={rateFilter}
                      onChange={(e) => setRateFilter(e.target.value)}
                      className="px-3 py-1 text-xs rounded-full border border-slate-300 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                   >
                     <option value="all">All Vouchers</option>
                     <option value="issues">Issues Only</option>
                     <option value="zero">GST Not Charged</option>
                     <option disabled>──────────</option>
                     {STANDARD_RATES.map(rate => (
                        <option key={rate} value={rate.toString()}>{rate}% Rate</option>
                     ))}
                   </select>
                </div>
              </div>
              
              <button 
                onClick={handleExport}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 transition-colors shadow-sm"
              >
                <Download size={16} />
                Export
              </button>
            </div>
            
            <div className="overflow-x-auto">
              {renderTableContent()}
              {filteredAndSortedResults.length === 0 && (
                 <div className="p-12 text-center text-slate-400 flex flex-col items-center">
                   <Filter size={48} className="text-slate-200 mb-4" />
                   <p>No vouchers match the current filters.</p>
                 </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default GSTRateAnalysis;