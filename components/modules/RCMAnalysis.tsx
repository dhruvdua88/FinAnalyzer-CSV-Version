import React, { useMemo, useState, useEffect } from 'react';
import { LedgerEntry } from '../../types';
import { groupVouchers, getUniqueLedgers, exportToExcel } from '../../services/dataService';
import { useTallyStore, buildLedgerPrimaryMap, isPlPrimaryGroup } from '../../services/tally';
import { Search, Filter, AlertTriangle, CheckCircle2, Download, ChevronDown, ChevronUp, X, CheckSquare, Square, Calculator, Layers, Users, Info, Percent, SlidersHorizontal, ClipboardList } from 'lucide-react';

interface RCMAnalysisProps {
  data: LedgerEntry[];
  // Added external props for centralized audit settings
  externalSelectedLedgers?: string[];
  onLedgersUpdate?: (ledgers: string[]) => void;
}

interface VoucherDetail {
  date: string;
  voucher_number: string;
  party_name: string;
  expenseLedger: string;
  netAmount: number;
  isRcmDeducted: boolean;
  rcmAmount: number;
  calculatedRate: number;
  rcmLedgers: string[];
  narration: string;
  // Party master attributes (from mst_ledger.gst_registration_type when the
  // ZIP store is loaded). The Sec 9(4) flag fires when an UNREGISTERED
  // supplier was used and RCM was NOT deducted — the auditor should verify
  // that the purchase doesn't fall in the notified categories that mandate
  // RCM on unregistered supplies.
  partyGstRegType: string;
  sec9_4Flag: boolean;
}

interface SummaryGroup {
  key: string;
  totalExpense: number;
  totalRCM: number;
  vouchers: VoucherDetail[];
  complianceRate: number;
  avgAppliedRate: number;
  deductedCount: number;
  missedCount: number;
}

const RCM_CHECKLIST = [
  { label: "GTA Services", desc: "Transport by road" },
  { label: "Legal Services", desc: "Advocates/Firms" },
  { label: "Security Services", desc: "To Reg. Person" },
  { label: "Director Fees", desc: "To Body Corporate" },
  { label: "Sponsorship", desc: "To Corp/Firm" }
];

const RCMAnalysis: React.FC<RCMAnalysisProps> = ({ data, externalSelectedLedgers, onLedgersUpdate }) => {
  // Party GST registration-type lookup from mst_ledger
  const store = useTallyStore();
  const partyRegTypeByName = useMemo(() => {
    const map = new Map<string, string>();
    if (!store) return map;
    for (const l of store.ledgers.values()) {
      const t = (l.gst_registration_type || '').trim();
      if (t) map.set(l.name.trim().toLowerCase(), t);
    }
    return map;
  }, [store]);
  // Use external state if provided, otherwise internal
  const [internalSelectedLedgers, setInternalSelectedLedgers] = useState<string[]>([]);
  
  const selectedTaxLedgers = externalSelectedLedgers || internalSelectedLedgers;
  const setSelectedTaxLedgers = (l: string[] | ((prev: string[]) => string[])) => {
    if (onLedgersUpdate) {
      const nextValue = typeof l === 'function' ? l(selectedTaxLedgers) : l;
      onLedgersUpdate(nextValue);
    } else {
      setInternalSelectedLedgers(l);
    }
  };

  const [viewMode, setViewMode] = useState<'ledger' | 'party'>('ledger');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [isSelectionExpanded, setIsSelectionExpanded] = useState(true);
  const [showChecklist, setShowChecklist] = useState(false);
  
  const [taxLedgerSearch, setTaxLedgerSearch] = useState('');
  const [mainSearch, setMainSearch] = useState('');
  const [minLedgerThreshold, setMinLedgerThreshold] = useState<string>('0');
  const [minVoucherThreshold, setMinVoucherThreshold] = useState<string>('0');
  const [statusFilter, setStatusFilter] = useState<'all' | 'deducted' | 'missed'>('all');
  const [rateFilter, setRateFilter] = useState<string>('all');

  const allLedgers = useMemo(() => getUniqueLedgers(data), [data]);
  const ledgerPrimary = useMemo(() => buildLedgerPrimaryMap(data), [data]);

  const analysisGroups = useMemo(() => {
    if (selectedTaxLedgers.length === 0) return [];
    const voucherGroups = groupVouchers(data);
    const groupsMap = new Map<string, SummaryGroup>();

    voucherGroups.forEach(group => {
      const rcmEntries = group.entries.filter((e: any) => selectedTaxLedgers.includes(e.Ledger));
      const voucherRcmAmount = rcmEntries.reduce((sum: number, e: any) => sum + Math.abs(e.amount), 0);
      const isDeducted = voucherRcmAmount > 0;

      const expenseEntries = group.entries.filter((e: any) => {
        const primary = (e.TallyPrimary || '').toLowerCase();
        return primary.includes('expense') || primary.includes('purchase');
      });

      expenseEntries.forEach((entry: any) => {
        const netAmount = Math.abs(entry.amount);
        if (netAmount < parseFloat(minVoucherThreshold || '0')) return;
        if (statusFilter === 'deducted' && !isDeducted) return;
        if (statusFilter === 'missed' && isDeducted) return;

        const itemRate = netAmount > 0 ? (voucherRcmAmount / netAmount) * 100 : 0;
        if (rateFilter !== 'all') {
          if (!isDeducted || Math.abs(itemRate - parseFloat(rateFilter)) > 0.2) return;
        }

        const groupKey = viewMode === 'ledger' ? entry.Ledger : (entry.party_name || 'N/A');
        let groupObj = groupsMap.get(groupKey);
        if (!groupObj) {
          groupObj = { key: groupKey, totalExpense: 0, totalRCM: 0, vouchers: [], complianceRate: 0, avgAppliedRate: 0, deductedCount: 0, missedCount: 0 };
          groupsMap.set(groupKey, groupObj);
        }

        groupObj.totalExpense += netAmount;
        groupObj.totalRCM += isDeducted ? voucherRcmAmount : 0;
        if (isDeducted) groupObj.deductedCount++; else groupObj.missedCount++;

        const partyKey = String(entry.party_name || '').trim().toLowerCase();
        const partyGstRegType = partyRegTypeByName.get(partyKey) || '';
        // Sec 9(4): supplier unregistered + RCM not deducted → flag for review.
        const sec9_4Flag = !isDeducted && /^unregistered$/i.test(partyGstRegType);
        groupObj.vouchers.push({
          date: entry.date, voucher_number: entry.voucher_number, party_name: entry.party_name || 'N/A',
          expenseLedger: entry.Ledger, netAmount, isRcmDeducted: isDeducted, rcmAmount: voucherRcmAmount,
          calculatedRate: parseFloat(itemRate.toFixed(2)), rcmLedgers: rcmEntries.map(e => e.Ledger as string),
          narration: entry.narration || '',
          partyGstRegType, sec9_4Flag,
        });
      });
    });

    return Array.from(groupsMap.values()).map(g => ({
      ...g,
      complianceRate: g.vouchers.length > 0 ? (g.deductedCount / g.vouchers.length) * 100 : 0,
      avgAppliedRate: g.totalExpense > 0 ? (g.totalRCM / g.totalExpense) * 100 : 0
    }))
    .filter(g => g.totalExpense >= parseFloat(minLedgerThreshold || '0'))
    .sort((a, b) => b.totalExpense - a.totalExpense);
  }, [data, selectedTaxLedgers, viewMode, minVoucherThreshold, statusFilter, rateFilter, minLedgerThreshold, partyRegTypeByName]);

  const filteredGroups = useMemo(() => {
    if (!mainSearch.trim()) return analysisGroups;
    return analysisGroups.filter(g => g.key.toLowerCase().includes(mainSearch.toLowerCase()));
  }, [analysisGroups, mainSearch]);

  const handleExport = () => {
    const exportData = filteredGroups.flatMap(g => g.vouchers.map(v => ({
      [viewMode === 'ledger' ? 'Expense Ledger' : 'Party']: g.key,
      Date: v.date, 'Voucher No': v.voucher_number, Party: v.party_name, 'Net Amount': v.netAmount,
      'RCM Paid': v.isRcmDeducted ? 'Yes' : 'No', 'Rate %': v.calculatedRate, 'RCM Amount': v.rcmAmount, Narration: v.narration
    })));
    exportToExcel(exportData, `RCM_Analysis_${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer" onClick={() => setIsSelectionExpanded(!isSelectionExpanded)}>
          <div className="flex items-center gap-3">
            <div className="bg-purple-600 p-2 rounded-lg text-white"><Calculator size={18} /></div>
            <div><h2 className="text-lg font-bold text-slate-800">Step 1: Configure RCM Tax Ledgers</h2><p className="text-xs text-slate-500">Pick ledgers used for booking RCM liability</p></div>
          </div>
          <div className="flex items-center gap-3"><span className="text-sm font-semibold bg-purple-100 text-purple-700 px-3 py-1 rounded-full">{selectedTaxLedgers.length} selected</span>{isSelectionExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}</div>
        </div>
        {isSelectionExpanded && (
          <div className="p-6">
            <div className="flex flex-col md:flex-row gap-4 mb-4">
              <div className="relative flex-1"><Search className="absolute left-3 top-2.5 text-slate-400" size={18} /><input type="text" placeholder="Search RCM tax ledgers..." className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-500" value={taxLedgerSearch} onChange={(e) => setTaxLedgerSearch(e.target.value)} /></div>
              <div className="flex gap-2"><button onClick={() => setSelectedTaxLedgers(allLedgers.filter(l => l.toLowerCase().includes('rcm') && !isPlPrimaryGroup(ledgerPrimary.get(l))))} className="px-4 py-2 bg-purple-50 text-purple-700 rounded-lg text-sm font-medium hover:bg-purple-100 border border-purple-200">Auto-Select 'RCM'</button><button onClick={() => setSelectedTaxLedgers([])} className="px-4 py-2 bg-slate-50 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 border border-slate-200">Clear</button></div>
            </div>
            <div className="max-h-[150px] overflow-y-auto border border-slate-200 rounded-lg bg-slate-50 p-2"><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">{allLedgers.filter(l => !taxLedgerSearch || l.toLowerCase().includes(taxLedgerSearch.toLowerCase())).map(ledger => { const isSelected = selectedTaxLedgers.includes(ledger); return (<div key={ledger} onClick={() => setSelectedTaxLedgers(prev => isSelected ? prev.filter(l => l !== ledger) : [...prev, ledger])} className={`flex items-center gap-3 p-2 rounded-md cursor-pointer border transition-all ${isSelected ? 'bg-purple-50 border-purple-300' : 'bg-white border-slate-200'}`}><div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSelected ? 'bg-purple-600 border-purple-600' : 'bg-white border-slate-300'}`}>{isSelected && <CheckSquare size={12} className="text-white" />}</div><span className="text-sm truncate">{ledger}</span></div>);})}</div></div>
          </div>
        )}
      </div>

      {selectedTaxLedgers.length === 0 ? (
        <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-xl p-16 text-center text-slate-500"><AlertTriangle size={56} className="mx-auto text-slate-300 mb-4" /><h3 className="text-xl font-bold text-slate-700">RCM Configuration Required</h3><p className="mt-2">Pick your RCM liability ledgers in Step 1 to begin the audit.</p></div>
      ) : (
        <>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 space-y-6">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
               <div className="flex bg-slate-100 p-1 rounded-xl"><button onClick={() => setViewMode('ledger')} className={`px-6 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${viewMode === 'ledger' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-500'}`}><Layers size={16} /> By Ledger</button><button onClick={() => setViewMode('party')} className={`px-6 py-2 rounded-lg text-sm font-bold flex items-center gap-2 ${viewMode === 'party' ? 'bg-white text-purple-700 shadow-sm' : 'text-slate-500'}`}><Users size={16} /> By Party</button></div>
               <div className="flex flex-wrap gap-3 flex-1 w-full justify-end"><div className="relative flex-1 max-w-md"><Search className="absolute left-3 top-2.5 text-slate-400" size={16} /><input type="text" placeholder={`Search ${viewMode}...`} className="w-full pl-9 pr-4 py-2 text-sm border border-slate-300 rounded-lg" value={mainSearch} onChange={(e) => setMainSearch(e.target.value)} /></div><button onClick={handleExport} className="px-6 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700 flex items-center gap-2 shadow-sm"><Download size={16} /> Export View</button></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
               <div><label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Min. Ledger Vol (₹)</label><input type="number" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" value={minLedgerThreshold} onChange={(e) => setMinLedgerThreshold(e.target.value)} /></div>
               <div><label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Min. Voucher Dr. (₹)</label><input type="number" className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" value={minVoucherThreshold} onChange={(e) => setMinVoucherThreshold(e.target.value)} /></div>
               <div><label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">RCM Status</label><select className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}><option value="all">Show All</option><option value="deducted">Only Paid</option><option value="missed">Only Missed</option></select></div>
               <div><label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">RCM Rate Filter</label><select className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg" value={rateFilter} onChange={(e) => setRateFilter(e.target.value)}><option value="all">All Rates</option><option value="5">5% (GTA/Motor)</option><option value="12">12% (Rent/GTA)</option><option value="18">18% (Legal/Director)</option></select></div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between px-2"><div className="flex items-center gap-2 text-xs text-slate-400 font-bold uppercase tracking-wider"><SlidersHorizontal size={14} /> Audit Results: {filteredGroups.length} Matches</div></div>
            {filteredGroups.map((group) => {
              const isOpen = expandedKey === group.key;
              return (
                <div key={group.key} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all duration-300">
                  <div className={`p-5 flex flex-col md:flex-row md:items-center justify-between gap-6 cursor-pointer hover:bg-slate-50 transition-colors ${isOpen ? 'bg-slate-50 border-b border-slate-100' : ''}`} onClick={() => setExpandedKey(isOpen ? null : group.key)}>
                    <div className="flex items-center gap-4 flex-1 min-w-0"><div className={`p-3 rounded-xl shrink-0 ${group.complianceRate === 100 ? 'bg-green-100 text-green-700' : group.complianceRate > 0 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{viewMode === 'ledger' ? <Layers size={22} /> : <Users size={22} />}</div><div className="min-w-0"><h3 className="font-extrabold text-slate-900 truncate text-lg">{group.key}</h3><p className="text-sm font-medium text-slate-500">{group.vouchers.length} Txns • {group.deductedCount} Paid • {group.missedCount} Missed</p></div></div>
                    <div className="flex items-center gap-10 shrink-0"><div className="text-right"><p className="text-[10px] uppercase font-bold text-slate-400">Total Vol</p><p className="font-mono font-bold text-slate-900">₹{group.totalExpense.toLocaleString('en-IN')}</p></div><div className="text-right hidden sm:block"><p className="text-[10px] uppercase font-bold text-slate-400">Avg Rate</p><p className="font-mono font-bold text-purple-600 text-base flex items-center justify-end gap-1"><Percent size={14} />{group.avgAppliedRate.toFixed(2)}%</p></div><div className="text-right"><p className="text-[10px] uppercase font-bold text-slate-400">Compliance</p><div className="flex items-center gap-2"><div className="w-20 h-2 bg-slate-200 rounded-full overflow-hidden hidden lg:block"><div className={`h-full transition-all duration-500 ${group.complianceRate > 90 ? 'bg-green-500' : group.complianceRate > 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${group.complianceRate}%` }} /></div><p className={`font-bold ${group.complianceRate > 90 ? 'text-green-600' : group.complianceRate > 50 ? 'text-amber-600' : 'text-red-600'}`}>{group.complianceRate.toFixed(0)}%</p></div></div><div className="text-slate-400">{isOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}</div></div>
                  </div>
                  {isOpen && (
                    <div className="p-0 border-t border-slate-100 bg-white animate-in slide-in-from-top-2 duration-300 overflow-x-auto"><table className="w-full text-sm text-left border-collapse"><thead className="bg-slate-50 text-slate-500 font-bold uppercase border-b border-slate-200"><tr><th className="px-6 py-4">Date</th><th className="px-6 py-4">Voucher No</th><th className="px-6 py-4">{viewMode === 'ledger' ? 'Party' : 'Expense Ledger'}</th><th className="px-6 py-4 text-right bg-slate-100/50">Dr. Amt (₹)</th><th className="px-6 py-4 text-center">Status</th><th className="px-6 py-4 text-center">Rate (%)</th><th className="px-6 py-4 text-right">RCM (₹)</th><th className="px-6 py-4">Narration</th></tr></thead><tbody className="divide-y divide-slate-100">{group.vouchers.map((v, idx) => (<tr key={idx} className="hover:bg-slate-50 transition-colors"><td className="px-6 py-4 text-slate-600 whitespace-nowrap">{v.date}</td><td className="px-6 py-4 font-bold text-slate-900">{v.voucher_number}</td><td className="px-6 py-4 text-slate-700 font-medium truncate max-w-[220px]">
  <div className="truncate">{viewMode === 'ledger' ? v.party_name : v.expenseLedger}</div>
  {v.partyGstRegType && viewMode === 'ledger' && (
    <div className={`text-[10px] mt-0.5 truncate ${v.sec9_4Flag ? 'text-rose-600 font-bold' : 'text-slate-400 italic'}`}
         title={v.sec9_4Flag ? 'Sec 9(4) CGST: RCM may be applicable on unregistered supplies — verify notification category' : v.partyGstRegType}>
      {v.sec9_4Flag ? `⚠ ${v.partyGstRegType} · Sec 9(4)?` : v.partyGstRegType}
    </div>
  )}
</td><td className="px-6 py-4 text-right font-mono font-extrabold text-slate-900 bg-slate-50/50">₹{v.netAmount.toLocaleString('en-IN')}</td><td className="px-6 py-4 text-center"><span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black uppercase border-2 ${v.isRcmDeducted ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-700 border-red-200'}`}>{v.isRcmDeducted ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}{v.isRcmDeducted ? 'Paid' : 'Missed'}</span></td><td className="px-6 py-4 text-center">{v.isRcmDeducted ? <span className="font-mono font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-100">{v.calculatedRate}%</span> : '-'}</td><td className="px-6 py-4 text-right font-mono text-slate-500 font-semibold">{v.rcmAmount > 0 ? `₹${v.rcmAmount.toLocaleString('en-IN')}` : '-'}</td><td className="px-6 py-4 text-slate-400 italic truncate max-w-xs">{v.narration}</td></tr>))}</tbody></table></div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

export default RCMAnalysis;