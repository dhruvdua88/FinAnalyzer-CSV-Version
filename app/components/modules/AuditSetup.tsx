import React, { useState, useRef } from 'react';
import { AuditSettings, LedgerEntry } from '../../types';
import { getUniqueLedgers, exportToExcel } from '../../services/dataService';
import { Download, Upload, Trash2, ShieldCheck, Receipt, Calculator, Ban, FileSpreadsheet, CheckCircle2, AlertCircle, FileJson, FileCode } from 'lucide-react';

interface AuditSetupProps {
  data: LedgerEntry[];
  settings: AuditSettings;
  onUpdate: (settings: Partial<AuditSettings>) => void;
}

const AuditSetup: React.FC<AuditSetupProps> = ({ data, settings, onUpdate }) => {
  const [importStatus, setImportStatus] = useState<{ type: 'success' | 'error', msg: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allLedgers = getUniqueLedgers(data);

  const handleExportJson = () => {
    const dataStr = JSON.stringify(settings, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `Audit_Profile_${new Date().toISOString().slice(0, 10)}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        // Basic validation
        if (typeof imported === 'object' && imported !== null) {
          onUpdate(imported);
          setImportStatus({ type: 'success', msg: 'Audit profile imported successfully!' });
          setTimeout(() => setImportStatus(null), 3000);
        } else {
          throw new Error('Invalid format');
        }
      } catch (err) {
        setImportStatus({ type: 'error', msg: 'Failed to import. Ensure the file is a valid FinAnalyzer JSON profile.' });
        setTimeout(() => setImportStatus(null), 5000);
      }
    };
    reader.readAsText(file);
  };

  const handleReset = () => {
    if (confirm('Are you sure you want to clear all mappings? This cannot be undone.')) {
      onUpdate({
        salesGstLedgers: [],
        purchaseGstLedgers: [],
        tdsTaxLedgers: [],
        rcmTaxLedgers: [],
        blockedCreditLedgers: [],
        relatedParties: [],
        partyMatrixProfile: {
          selectedPrimaryGroup: '',
          tdsLedgers: [],
          gstLedgers: [],
          rcmLedgers: [],
        }
      });
    }
  };

  const MappingCard = ({ icon: Icon, color, title, count, list }: { icon: any, color: string, title: string, count: number, list: string[] }) => (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between h-full group hover:border-indigo-300 transition-all">
      <div>
        <div className={`p-3 rounded-xl w-fit mb-4 ${color}`}>
          <Icon size={24} />
        </div>
        <h3 className="text-lg font-black text-slate-800 mb-1">{title}</h3>
        <p className="text-slate-500 text-sm font-medium">{count} Ledgers Mapped</p>
      </div>
      
      <div className="mt-4 pt-4 border-t border-slate-50">
        <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
          {list.length > 0 ? list.slice(0, 5).map(l => (
            <span key={l} className="text-[10px] font-bold bg-slate-100 text-slate-600 px-2 py-0.5 rounded truncate max-w-[120px]">{l}</span>
          )) : (
            <span className="text-[10px] italic text-slate-400">No ledgers selected</span>
          )}
          {list.length > 5 && <span className="text-[10px] font-bold text-indigo-600">+{list.length - 5} more</span>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header with Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Audit Configuration</h1>
          <p className="text-slate-500 font-medium">Manage master mappings and persist settings across audit sessions.</p>
        </div>
        
        <div className="flex flex-wrap gap-3">
          <button 
            onClick={handleExportJson}
            className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-bold flex items-center gap-2 hover:bg-indigo-700 shadow-lg shadow-indigo-600/20 active:scale-95 transition-all"
          >
            <FileJson size={18} /> Export Profile
          </button>
          
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="px-6 py-3 bg-white text-slate-700 border border-slate-200 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-50 active:scale-95 transition-all"
          >
            <Upload size={18} /> Import Profile
          </button>
          
          <button 
            onClick={handleReset}
            className="p-3 text-red-500 hover:bg-red-50 rounded-xl transition-colors"
            title="Reset All"
          >
            <Trash2 size={24} />
          </button>
          <input type="file" ref={fileInputRef} onChange={handleImportJson} className="hidden" accept=".json" />
        </div>
      </div>

      {importStatus && (
        <div className={`p-4 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2 ${
          importStatus.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {importStatus.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
          <span className="font-bold text-sm">{importStatus.msg}</span>
        </div>
      )}

      {/* Overview Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
        <MappingCard 
          icon={Receipt} 
          color="bg-blue-100 text-blue-700" 
          title="Sales GST" 
          count={settings.salesGstLedgers.length} 
          list={settings.salesGstLedgers} 
        />
        <MappingCard 
          icon={Receipt} 
          color="bg-cyan-100 text-cyan-700" 
          title="Purchase GST" 
          count={settings.purchaseGstLedgers.length} 
          list={settings.purchaseGstLedgers} 
        />
        <MappingCard 
          icon={FileSpreadsheet} 
          color="bg-emerald-100 text-emerald-700" 
          title="TDS Master" 
          count={settings.tdsTaxLedgers.length} 
          list={settings.tdsTaxLedgers} 
        />
        <MappingCard 
          icon={Calculator} 
          color="bg-purple-100 text-purple-700" 
          title="RCM Master" 
          count={settings.rcmTaxLedgers.length} 
          list={settings.rcmTaxLedgers} 
        />
        <MappingCard 
          icon={Ban} 
          color="bg-amber-100 text-amber-700" 
          title="Blocked Credit" 
          count={settings.blockedCreditLedgers.length} 
          list={settings.blockedCreditLedgers} 
        />
        <MappingCard 
          icon={ShieldCheck} 
          color="bg-indigo-100 text-indigo-700" 
          title="Related Parties" 
          count={settings.relatedParties.length} 
          list={settings.relatedParties} 
        />
      </div>

      {/* Detailed Instruction / Pro Tips */}
      <div className="bg-slate-900 text-slate-400 p-8 rounded-3xl space-y-4">
        <h3 className="text-white font-bold text-xl">Configuration Guide</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 text-sm leading-relaxed">
          <div className="space-y-2">
            <p className="font-bold text-slate-200 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-green-500" /> Persistent Mappings
            </p>
            <p>Mappings are automatically saved in your browser. Even if you refresh or upload a new file, your core tax and party ledgers will remain tagged if they match by name.</p>
          </div>
          <div className="space-y-2">
            <p className="font-bold text-slate-200 flex items-center gap-2">
              <FileCode size={16} className="text-indigo-400" /> Portable Profiles
            </p>
            <p>Exporting a JSON profile allows you to share the "Audit Intelligence" with colleagues or move it between different computers seamlessly.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuditSetup;
