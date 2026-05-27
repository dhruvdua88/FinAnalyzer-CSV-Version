import React, { useMemo, useState } from 'react';
import { LedgerEntry } from '../../types';
import { exportToExcel } from '../../services/dataService';
import { Search, Filter, AlertTriangle, CheckCircle2, Download, Layers, Users, BookOpen, ArrowUpDown, Info, Ban, Activity } from 'lucide-react';

interface LedgerAnalyticsProps {
  data: LedgerEntry[];
}

interface LedgerStats {
  name: string;
  parent: string;
  primary: string;
  opening: number;
  closing: number;
  netChange: number;
  status: 'active' | 'slow' | 'zero' | 'abnormal';
  statusLabel: string;
}

const LedgerAnalytics: React.FC<LedgerAnalyticsProps> = ({ data }) => {
  const [viewMode, setViewMode] = useState<'ledger' | 'primary'>('ledger');
  const [searchTerm, setSearchTerm] = useState('');
  const [primaryFilter, setPrimaryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const analysis = useMemo(() => {
    const ledgerMap = new Map<string, LedgerStats>();

    data.forEach(entry => {
      const name = entry.Ledger;
      if (!name) return;

      if (!ledgerMap.has(name)) {
        const opening = entry.opening_balance || 0;
        const closing = entry.closing_balance || 0;
        const netChange = closing - opening;
        const primary = entry.TallyPrimary || 'Other';
        const parent = entry.TallyParent || 'Other';
        
        let status: LedgerStats['status'] = 'active';
        let statusLabel = 'Active';

        const isZero = opening === 0 && closing === 0;
        const isSlow = !isZero && opening === closing;

        // Abnormal Balance Logic
        // Debtors with Credit (negative) balance or Creditors with Debit (positive) balance
        const isDebtor = primary.toLowerCase().includes('debtor');
        const isCreditor = primary.toLowerCase().includes('creditor');
        let isAbnormal = false;

        if (isDebtor && closing < 0) {
          isAbnormal = true;
          statusLabel = 'Abnormal (Cr. Balance in Debtor)';
        } else if (isCreditor && closing > 0) {
          isAbnormal = true;
          statusLabel = 'Abnormal (Dr. Balance in Creditor)';
        }

        if (isAbnormal) status = 'abnormal';
        else if (isZero) { status = 'zero'; statusLabel = 'Zero Balance'; }
        else if (isSlow) { status = 'slow'; statusLabel = 'Slow Moving / No Change'; }

        ledgerMap.set(name, {
          name, parent, primary, opening, closing, netChange, status, statusLabel
        });
      }
    });

    return Array.from(ledgerMap.values());
  }, [data]);

  const uniquePrimaries = useMemo(() => 
    Array.from(new Set(analysis.map(a => a.primary))).sort()
  , [analysis]);

  const filteredData = useMemo(() => {
    return analysis.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            item.parent.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesPrimary = primaryFilter === 'all' || item.primary === primaryFilter;
      const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
      return matchesSearch && matchesPrimary && matchesStatus;
    });
  }, [analysis, searchTerm, primaryFilter, statusFilter]);

  const primarySummary = useMemo(() => {
    const summaryMap = new Map<string, { name: string, totalCount: number, slowCount: number, zeroCount: number, abnormalCount: number, totalClosing: number }>();
    
    filteredData.forEach(item => {
      let group = summaryMap.get(item.primary);
      if (!group) {
        group = { name: item.primary, totalCount: 0, slowCount: 0, zeroCount: 0, abnormalCount: 0, totalClosing: 0 };
        summaryMap.set(item.primary, group);
      }
      group.totalCount++;
      group.totalClosing += item.closing;
      if (item.status === 'slow') group.slowCount++;
      if (item.status === 'zero') group.zeroCount++;
      if (item.status === 'abnormal') group.abnormalCount++;
    });

    return Array.from(summaryMap.values()).sort((a, b) => b.totalCount - a.totalCount);
  }, [filteredData]);

  const handleExport = () => {
    exportToExcel(filteredData, `Ledger_Analytics_${new Date().toISOString().slice(0, 10)}`);
  };

  const getStatusBadge = (status: LedgerStats['status'], label: string) => {
    switch (status) {
      case 'abnormal': return <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-[10px] font-bold border border-red-200">{label}</span>;
      case 'slow': return <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full text-[10px] font-bold border border-amber-200">{label}</span>;
      case 'zero': return <span className="bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full text-[10px] font-bold border border-slate-200">{label}</span>;
      default: return <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-[10px] font-bold border border-green-200">{label}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex justify-between items-start mb-2">
            <div className="p-2 bg-blue-50 rounded-lg text-blue-600"><BookOpen size={20} /></div>
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Total Ledgers</span>
          </div>
          <p className="text-2xl font-black text-slate-800">{analysis.length}</p>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex justify-between items-start mb-2">
            <div className="p-2 bg-red-50 rounded-lg text-red-600"><AlertTriangle size={20} /></div>
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Abnormal Balances</span>
          </div>
          <p className="text-2xl font-black text-red-600">{analysis.filter(a => a.status === 'abnormal').length}</p>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex justify-between items-start mb-2">
            <div className="p-2 bg-amber-50 rounded-lg text-amber-600"><Activity size={20} /></div>
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Slow Moving</span>
          </div>
          <p className="text-2xl font-black text-amber-600">{analysis.filter(a => a.status === 'slow').length}</p>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex justify-between items-start mb-2">
            <div className="p-2 bg-slate-50 rounded-lg text-slate-400"><Ban size={20} /></div>
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Zero Balance</span>
          </div>
          <p className="text-2xl font-black text-slate-500">{analysis.filter(a => a.status === 'zero').length}</p>
        </div>
      </div>

      {/* Control Bar */}
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row justify-between gap-4">
          <div className="flex bg-slate-100 p-1 rounded-xl w-fit">
            <button onClick={() => setViewMode('ledger')} className={`px-5 py-2 rounded-lg text-xs font-black uppercase tracking-tight flex items-center gap-2 transition-all ${viewMode === 'ledger' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}><Layers size={14} /> By Ledger</button>
            <button onClick={() => setViewMode('primary')} className={`px-5 py-2 rounded-lg text-xs font-black uppercase tracking-tight flex items-center gap-2 transition-all ${viewMode === 'primary' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}><Users size={14} /> By Primary Group</button>
          </div>
          <div className="flex flex-wrap gap-3 flex-1 justify-end">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
              <input type="text" placeholder="Search accounts or groups..." className="w-full pl-10 pr-4 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
            <button onClick={handleExport} className="px-5 py-2 bg-green-600 text-white rounded-lg text-xs font-black uppercase tracking-tight hover:bg-green-700 flex items-center gap-2 shadow-sm"><Download size={14} /> Export XLS</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-slate-100">
          <div className="flex items-center gap-3">
            <Filter size={14} className="text-slate-400" />
            <select className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm" value={primaryFilter} onChange={(e) => setPrimaryFilter(e.target.value)}>
              <option value="all">All Primary Groups</option>
              {uniquePrimaries.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <Activity size={14} className="text-slate-400" />
            <select className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All Statuses</option>
              <option value="active">Only Active</option>
              <option value="abnormal">Only Abnormal Balances</option>
              <option value="slow">Only Slow Moving</option>
              <option value="zero">Only Zero Balances</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {viewMode === 'ledger' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 text-slate-500 font-black uppercase text-[10px] tracking-widest border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4">Ledger Name</th>
                  <th className="px-6 py-4">Parent / Primary</th>
                  <th className="px-6 py-4 text-right">Opening (₹)</th>
                  <th className="px-6 py-4 text-right">Closing (₹)</th>
                  <th className="px-6 py-4 text-right">Net Change</th>
                  <th className="px-6 py-4 text-center">Audit Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredData.map((item, idx) => (
                  <tr key={idx} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-bold text-slate-900">{item.name}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="text-slate-600 font-medium">{item.parent}</p>
                      <p className="text-[10px] text-slate-400 font-bold">{item.primary}</p>
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-slate-500">{item.opening.toLocaleString('en-IN')}</td>
                    <td className={`px-6 py-4 text-right font-mono font-bold ${item.closing < 0 ? 'text-red-600' : 'text-slate-900'}`}>{item.closing.toLocaleString('en-IN')}</td>
                    <td className={`px-6 py-4 text-right font-mono ${item.netChange === 0 ? 'text-slate-300' : 'text-blue-600 font-bold'}`}>
                      {item.netChange > 0 ? '+' : ''}{item.netChange.toLocaleString('en-IN')}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {getStatusBadge(item.status, item.statusLabel)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50 text-slate-500 font-black uppercase text-[10px] tracking-widest border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4">Primary Group Name</th>
                  <th className="px-6 py-4 text-center">Ledgers</th>
                  <th className="px-6 py-4 text-center">Abnormal</th>
                  <th className="px-6 py-4 text-center">Slow</th>
                  <th className="px-6 py-4 text-center">Zero</th>
                  <th className="px-6 py-4 text-right">Total Net Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {primarySummary.map((group, idx) => (
                  <tr key={idx} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-bold text-slate-900">{group.name}</td>
                    <td className="px-6 py-4 text-center font-bold text-blue-600 bg-blue-50/30">{group.totalCount}</td>
                    <td className={`px-6 py-4 text-center font-bold ${group.abnormalCount > 0 ? 'text-red-600 bg-red-50/50' : 'text-slate-300'}`}>{group.abnormalCount}</td>
                    <td className={`px-6 py-4 text-center font-bold ${group.slowCount > 0 ? 'text-amber-600 bg-amber-50/50' : 'text-slate-300'}`}>{group.slowCount}</td>
                    <td className={`px-6 py-4 text-center font-bold ${group.zeroCount > 0 ? 'text-slate-400 bg-slate-50/50' : 'text-slate-300'}`}>{group.zeroCount}</td>
                    <td className={`px-6 py-4 text-right font-mono font-bold ${group.totalClosing < 0 ? 'text-red-600' : 'text-slate-900'}`}>{group.totalClosing.toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {filteredData.length === 0 && (
          <div className="p-20 text-center text-slate-400">
            <Info size={48} className="mx-auto mb-4 opacity-10" />
            <p className="text-lg font-medium">No results found matching your filters.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default LedgerAnalytics;