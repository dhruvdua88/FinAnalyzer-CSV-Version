import React, { Suspense, lazy, useState, useEffect, useMemo } from 'react';
import FileUpload from './components/FileUpload';
import { LedgerEntry, AnalysisType, AuditSettings } from './types';
import { clearSqlData, fetchRowsFromSql, isSqlBackendAvailable, loadRowsIntoSql, SqlLoadSummary } from './services/sqlDataService';
import { TallyStore, TallyStoreProvider } from './services/tally';
import { LayoutDashboard, Receipt, FileSpreadsheet, ArrowLeft, BarChart3, FileInput, Ban, TrendingUp, BookOpen, ShieldCheck, Settings2, PieChart, FileText, Landmark, Clock3, Users2, Menu, X, Wallet, FileSearch, AlertTriangle, ShieldAlert, Moon, Sun } from 'lucide-react';

const GSTRateAnalysis = lazy(() => import('./components/modules/GSTRateAnalysis'));
const SalesRegister = lazy(() => import('./components/modules/SalesRegister'));
const TDSAnalysis = lazy(() => import('./components/modules/TDSAnalysis'));
const RCMAnalysis = lazy(() => import('./components/modules/RCMAnalysis'));
const GSTExpenseAnalysis = lazy(() => import('./components/modules/GSTExpenseAnalysis'));
const VarianceAnalysis = lazy(() => import('./components/modules/VarianceAnalysis'));
const LedgerAnalytics = lazy(() => import('./components/modules/LedgerAnalytics'));
const PartyLedgerMatrix = lazy(() => import('./components/modules/PartyLedgerMatrix'));
const RelatedPartyAnalysis = lazy(() => import('./components/modules/RelatedPartyAnalysis'));
const AuditSetup = lazy(() => import('./components/modules/AuditSetup'));
const GSTLedgerSummary = lazy(() => import('./components/modules/GSTLedgerSummary'));
const TrialBalanceAnalysis = lazy(() => import('./components/modules/TrialBalanceAnalysis'));
const DebtorAgeingFIFO = lazy(() => import('./components/modules/DebtorAgeingFIFO'));
const CreditorAgeingFIFO = lazy(() => import('./components/modules/CreditorAgeingFIFO'));
const PurchaseGSTRegister = lazy(() => import('./components/modules/PurchaseGSTRegister'));
const GSTR2BReconciliation = lazy(() => import('./components/modules/GSTR2BReconciliation'));
const VoucherBookView = lazy(() => import('./components/modules/VoucherBookView'));
const LedgerVoucherView = lazy(() => import('./components/modules/LedgerVoucherView'));
const CashFlowAnalysis = lazy(() => import('./components/modules/CashFlowAnalysis'));
const ProfitLossAnalysis = lazy(() => import('./components/modules/ProfitLossAnalysis'));
const ExceptionDensityHeatmapAnalytics = lazy(() => import('./components/modules/ExceptionDensityHeatmapAnalytics'));
const BalanceSheetCleanlinessAnalytics = lazy(() => import('./components/modules/BalanceSheetCleanlinessAnalytics'));
const ITC3BReconciliation = lazy(() => import('./components/modules/ITC3BReconciliation'));
const OrphanPLVouchers = lazy(() => import('./components/modules/OrphanPLVouchers'));

const MODULE_LABELS: Record<AnalysisType, string> = {
  [AnalysisType.DASHBOARD]: 'Dashboard Overview',
  [AnalysisType.AUDIT_CONFIG]: 'Audit Configuration Manager',
  [AnalysisType.TRIAL_BALANCE]: 'Trial Balance Analysis',
  [AnalysisType.DEBTOR_AGEING]: 'Debtor Ageing (FIFO)',
  [AnalysisType.CREDITOR_AGEING]: 'Creditor Ageing (FIFO)',
  [AnalysisType.VOUCHER_BOOK_VIEW]: 'Voucher Book View',
  [AnalysisType.LEDGER_VOUCHER_VIEW]: 'Ledger Statement',
  [AnalysisType.GST_RATE]: 'Sales GST Rate Analysis',
  [AnalysisType.SALES_REGISTER]: 'Sales Register',
  [AnalysisType.PURCHASE_GST_REGISTER]: 'Purchase GST Register',
  [AnalysisType.GSTR2B_RECONCILIATION]: 'GSTR-2B Reconciliation',
  [AnalysisType.TDS_ANALYSIS]: 'TDS Analysis',
  [AnalysisType.RCM_ANALYSIS]: 'Reverse Charge (RCM) Analysis',
  [AnalysisType.GST_EXPENSE_ANALYSIS]: 'Blocked Credit Analysis',
  [AnalysisType.PROFIT_LOSS_ANALYSIS]: 'Profit & Loss Analysis',
  [AnalysisType.CASH_FLOW_ANALYSIS]: 'Cash Flow Analysis',
  [AnalysisType.VARIANCE_ANALYSIS]: 'Month-on-Month Variance Analysis',
  [AnalysisType.EXCEPTION_DENSITY_HEATMAP]: 'Exception Density Heatmap Analytics',
  [AnalysisType.BALANCE_SHEET_CLEANLINESS]: 'Balance Sheet Cleanliness Analytics',
  [AnalysisType.LEDGER_ANALYTICS]: 'Accounting Ledger Analytics',
  [AnalysisType.PARTY_LEDGER_MATRIX]: 'Party Ledger Transaction Matrix',
  [AnalysisType.RELATED_PARTY_ANALYSIS]: 'Related Party (RPT) Analysis',
  [AnalysisType.GST_LEDGER_SUMMARY]: 'GST Ledger Constitution Analysis',
  [AnalysisType.ITC_3B_RECONCILIATION]: 'ITC vs 3B Reconciliation',
  [AnalysisType.ORPHAN_PL_VOUCHERS]: 'Orphan P&L Vouchers',
};

type ModuleIcon = React.ComponentType<{ size?: number; className?: string }>;

const MODULE_ICONS: Record<AnalysisType, ModuleIcon> = {
  [AnalysisType.DASHBOARD]: LayoutDashboard,
  [AnalysisType.AUDIT_CONFIG]: Settings2,
  [AnalysisType.TRIAL_BALANCE]: Landmark,
  [AnalysisType.DEBTOR_AGEING]: Clock3,
  [AnalysisType.CREDITOR_AGEING]: Clock3,
  [AnalysisType.VOUCHER_BOOK_VIEW]: Receipt,
  [AnalysisType.LEDGER_VOUCHER_VIEW]: BookOpen,
  [AnalysisType.GST_RATE]: Receipt,
  [AnalysisType.SALES_REGISTER]: FileText,
  [AnalysisType.PURCHASE_GST_REGISTER]: FileText,
  [AnalysisType.GSTR2B_RECONCILIATION]: FileSearch,
  [AnalysisType.TDS_ANALYSIS]: FileSpreadsheet,
  [AnalysisType.RCM_ANALYSIS]: FileInput,
  [AnalysisType.GST_EXPENSE_ANALYSIS]: Ban,
  [AnalysisType.PROFIT_LOSS_ANALYSIS]: FileText,
  [AnalysisType.CASH_FLOW_ANALYSIS]: Wallet,
  [AnalysisType.VARIANCE_ANALYSIS]: TrendingUp,
  [AnalysisType.EXCEPTION_DENSITY_HEATMAP]: ShieldAlert,
  [AnalysisType.BALANCE_SHEET_CLEANLINESS]: AlertTriangle,
  [AnalysisType.LEDGER_ANALYTICS]: BookOpen,
  [AnalysisType.PARTY_LEDGER_MATRIX]: Users2,
  [AnalysisType.RELATED_PARTY_ANALYSIS]: ShieldCheck,
  [AnalysisType.GST_LEDGER_SUMMARY]: PieChart,
  [AnalysisType.ITC_3B_RECONCILIATION]: FileSearch,
  [AnalysisType.ORPHAN_PL_VOUCHERS]: AlertTriangle,
};

const MODULE_SECTIONS: Array<{ id: string; title: string; description: string; modules: AnalysisType[] }> = [
  {
    id: 'setup',
    title: 'Setup',
    description: 'Start here before running detailed checks.',
    modules: [AnalysisType.DASHBOARD, AnalysisType.AUDIT_CONFIG],
  },
  {
    id: 'core-audit',
    title: 'Core Audit',
    description: 'Ledger, party, and balance sheet intelligence.',
    modules: [
      AnalysisType.LEDGER_ANALYTICS,
      AnalysisType.VOUCHER_BOOK_VIEW,
      AnalysisType.LEDGER_VOUCHER_VIEW,
      AnalysisType.PARTY_LEDGER_MATRIX,
      AnalysisType.RELATED_PARTY_ANALYSIS,
      AnalysisType.TRIAL_BALANCE,
    ],
  },
  {
    id: 'ageing',
    title: 'Ageing',
    description: 'Receivables and payables ageing views.',
    modules: [AnalysisType.DEBTOR_AGEING, AnalysisType.CREDITOR_AGEING],
  },
  {
    id: 'gst-tax',
    title: 'GST & Tax',
    description: 'GST rates, registers, and tax compliance checks.',
    modules: [
      AnalysisType.GST_RATE,
      AnalysisType.SALES_REGISTER,
      AnalysisType.PURCHASE_GST_REGISTER,
      AnalysisType.GSTR2B_RECONCILIATION,
      AnalysisType.ITC_3B_RECONCILIATION,
      AnalysisType.GST_LEDGER_SUMMARY,
      AnalysisType.TDS_ANALYSIS,
      AnalysisType.RCM_ANALYSIS,
      AnalysisType.GST_EXPENSE_ANALYSIS,
    ],
  },
  {
    id: 'trends',
    title: 'Trends',
    description: 'Period-over-period movement analysis.',
    modules: [AnalysisType.PROFIT_LOSS_ANALYSIS, AnalysisType.CASH_FLOW_ANALYSIS, AnalysisType.VARIANCE_ANALYSIS],
  },
  {
    id: 'advanced-analytics',
    title: 'Advanced Analytics',
    description: 'Exception density and balance sheet hygiene diagnostics.',
    modules: [
      AnalysisType.EXCEPTION_DENSITY_HEATMAP,
      AnalysisType.BALANCE_SHEET_CLEANLINESS,
      AnalysisType.ORPHAN_PL_VOUCHERS,
    ],
  },
];

const QUERY_DRIVEN_SQL_MODULES = new Set<AnalysisType>([
  AnalysisType.SALES_REGISTER,
  AnalysisType.PURCHASE_GST_REGISTER,
  AnalysisType.ITC_3B_RECONCILIATION,
  AnalysisType.PROFIT_LOSS_ANALYSIS,
  AnalysisType.VOUCHER_BOOK_VIEW,
  AnalysisType.LEDGER_VOUCHER_VIEW,
]);

const App: React.FC = () => {
  const [data, setData] = useState<LedgerEntry[]>([]);
  const [store, setStore] = useState<TallyStore | null>(null);
  const [activeModule, setActiveModule] = useState<AnalysisType>(AnalysisType.DASHBOARD);
  const [hasDataset, setHasDataset] = useState(false);
  const [isSqlMode, setIsSqlMode] = useState(false);
  const [sqlNote, setSqlNote] = useState('');
  const [isModuleDataLoading, setIsModuleDataLoading] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [dashboardSummary, setDashboardSummary] = useState<SqlLoadSummary>({
    totalRows: 0,
    uniqueVouchers: 0,
    minDate: '',
    maxDate: '',
  });
  
  // Centralized Audit Settings
  const [settings, setSettings] = useState<AuditSettings>(() => {
    const defaults: AuditSettings = {
      salesGstLedgers: [],
      purchaseGstLedgers: [],
      tdsTaxLedgers: [],
      rcmTaxLedgers: [],
      blockedCreditLedgers: [],
      relatedParties: [],
      gstLedgerSummary: [],
      partyMatrixProfile: {
        selectedPrimaryGroup: '',
        tdsLedgers: [],
        gstLedgers: [],
        rcmLedgers: [],
      },
      relatedPartyProfile: {
        parties: {},
        ledgerTxType: {},
        thresholds: {
          materialityRupees: 1_000_000,
          yearEndDays: 30,
          roundAmountUnit: 100_000,
          section188TurnoverPct: 10,
          annualTurnover: 0,
        },
        approvals: {},
      },
      tdsThresholdConfig: { enabled: false, sectionMappings: [] },
      tdsAnnotations: [],
    };

    try {
      const saved = localStorage.getItem('finanalyzer_audit_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...defaults,
          ...parsed,
          partyMatrixProfile: {
            ...defaults.partyMatrixProfile,
            ...(parsed?.partyMatrixProfile || {}),
          },
          relatedPartyProfile: {
            ...defaults.relatedPartyProfile!,
            ...(parsed?.relatedPartyProfile || {}),
            thresholds: {
              ...defaults.relatedPartyProfile!.thresholds,
              ...((parsed?.relatedPartyProfile?.thresholds) || {}),
            },
          },
          tdsThresholdConfig: {
            ...defaults.tdsThresholdConfig,
            ...(parsed?.tdsThresholdConfig || {}),
          },
          tdsAnnotations: Array.isArray(parsed?.tdsAnnotations) ? parsed.tdsAnnotations : [],
        };
      }
    } catch (e) {}
    return defaults;
  });

  // ── Dark mode (D4) ─────────────────────────────────────────────────────────
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try { return localStorage.getItem('finanalyzer_dark_mode') === 'true'; } catch { return false; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    try { localStorage.setItem('finanalyzer_dark_mode', String(darkMode)); } catch {}
  }, [darkMode]);

  // ── Update checker (A4) ────────────────────────────────────────────────────
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const meta = await fetch('/metadata.json').then((r) => r.json());
        if (!meta?.updateCheckUrl) return;
        const latest = await fetch(meta.updateCheckUrl).then((r) => r.json());
        if (latest?.version && meta?.version && latest.version !== meta.version) {
          setUpdateAvailable(latest.version);
        }
      } catch { /* silently skip if unreachable */ }
    };
    check();
  }, []);

  useEffect(() => {
    localStorage.setItem('finanalyzer_audit_settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setIsMobileNavOpen(false);
  }, [activeModule]);

  useEffect(() => {
    if (!isMobileNavOpen) return;

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMobileNavOpen(false);
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onEscape);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onEscape);
    };
  }, [isMobileNavOpen]);

  const isAccountingVoucherEntry = (entry: LedgerEntry): boolean => {
    const raw = entry?.is_accounting_voucher;
    if (raw === undefined || raw === null || String(raw).trim() === '') return true;
    const text = String(raw).trim().toLowerCase();
    if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return true;
    if (text === '0' || text === 'false' || text === 'no' || text === 'n') return false;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed > 0 : false;
  };

  const isMasterLedgerEntry = (entry: LedgerEntry): boolean => {
    const raw = entry?.is_master_ledger;
    if (raw === undefined || raw === null || String(raw).trim() === '') return false;
    const text = String(raw).trim().toLowerCase();
    if (text === '1' || text === 'true' || text === 'yes' || text === 'y') return true;
    if (text === '0' || text === 'false' || text === 'no' || text === 'n') return false;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed > 0 : false;
  };

  const summarizeRows = (rows: LedgerEntry[]): SqlLoadSummary => {
    const transactionalRows = rows.filter((row) => isAccountingVoucherEntry(row) && !isMasterLedgerEntry(row));
    let minDate = '';
    let maxDate = '';
    const voucherSet = new Set<string>();

    transactionalRows.forEach((row) => {
      if (row.voucher_number) voucherSet.add(row.voucher_number);
      if (row.date) {
        if (!minDate || row.date < minDate) minDate = row.date;
        if (!maxDate || row.date > maxDate) maxDate = row.date;
      }
    });

    return {
      totalRows: transactionalRows.length,
      uniqueVouchers: voucherSet.size,
      minDate,
      maxDate,
    };
  };

  const handleDataLoaded = async (parsedData: LedgerEntry[], parsedStore: TallyStore | null) => {
    const accountingRows = parsedData.filter(isAccountingVoucherEntry);
    setStore(parsedStore);
    setActiveModule(AnalysisType.DASHBOARD);
    setSqlNote('');
    setIsModuleDataLoading(true);

    const sqlAvailable = await isSqlBackendAvailable();

    if (sqlAvailable) {
      try {
        const summary = await loadRowsIntoSql(accountingRows);
        setIsSqlMode(true);
        setHasDataset(true);
        setData([]);
        setDashboardSummary(summary);
        setIsModuleDataLoading(false);
        return;
      } catch (error: any) {
        const message = error?.message || 'SQL load failed. Falling back to in-memory mode.';
        setSqlNote(message);
      }
    } else {
      setSqlNote('SQL backend unavailable. Running in in-memory fallback mode.');
    }

    setIsSqlMode(false);
    setHasDataset(true);
    setData(accountingRows);
    setDashboardSummary(summarizeRows(accountingRows));
    setIsModuleDataLoading(false);
  };

  const updateSettings = (newSettings: Partial<AuditSettings>) => {
    setSettings((prev) => ({
      ...prev,
      ...newSettings,
      partyMatrixProfile: {
        ...prev.partyMatrixProfile,
        ...(newSettings.partyMatrixProfile || {}),
      },
      // RelatedPartyProfile is replaced wholesale (not deep-merged) when
      // the module emits an update — its inner shape (parties dict, ledger
      // overrides, approvals dict) makes deep merge ambiguous.
      relatedPartyProfile:
        newSettings.relatedPartyProfile !== undefined
          ? newSettings.relatedPartyProfile
          : prev.relatedPartyProfile,
    }));
  };

  const transactionData = useMemo(
    () => data.filter((entry) => isAccountingVoucherEntry(entry) && !isMasterLedgerEntry(entry)),
    [data]
  );

  useEffect(() => {
    if (!hasDataset || !isSqlMode) return;

    let cancelled = false;

    const loadFromSql = async () => {
      setIsModuleDataLoading(true);
      try {
        if (activeModule === AnalysisType.DASHBOARD) {
          if (cancelled) return;
          setData([]);
        } else if (QUERY_DRIVEN_SQL_MODULES.has(activeModule)) {
          if (cancelled) return;
          // These modules use optimized module-specific SQL APIs and avoid loading full rowset.
          setData([]);
        } else {
          const rows = await fetchRowsFromSql();
          if (cancelled) return;
          setData(rows.filter(isAccountingVoucherEntry));
        }
      } catch (error: any) {
        if (cancelled) return;
        const message = error?.message || 'SQL query failed. Falling back to in-memory mode.';
        setSqlNote(message);
        setIsSqlMode(false);
      } finally {
        if (!cancelled) setIsModuleDataLoading(false);
      }
    };

    loadFromSql();
    return () => {
      cancelled = true;
    };
  }, [activeModule, hasDataset, isSqlMode]);

  const resetDataset = () => {
    setActiveModule(AnalysisType.DASHBOARD);
    setData([]);
    setStore(null);
    setHasDataset(false);
    setIsSqlMode(false);
    setSqlNote('');
    setIsModuleDataLoading(false);
    setDashboardSummary({
      totalRows: 0,
      uniqueVouchers: 0,
      minDate: '',
      maxDate: '',
    });
    clearSqlData();
  };

  const activeSection = useMemo(
    () => MODULE_SECTIONS.find((section) => section.modules.includes(activeModule))?.title ?? 'Setup',
    [activeModule]
  );

  const SidebarContent: React.FC<{ isMobile?: boolean; onClose?: () => void }> = ({ isMobile = false, onClose }) => (
    <>
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <BarChart3 className="text-blue-400" />
          FinAnalyzer
        </h1>
        {isMobile && (
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="text-slate-300 hover:text-white p-1 rounded-md hover:bg-slate-800"
          >
            <X size={18} />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Audit modules">
        {MODULE_SECTIONS.map((section) => (
          <section key={section.id} className="mb-6">
            <h3 className="px-2 text-[11px] tracking-wide font-semibold uppercase text-slate-400">{section.title}</h3>
            <p className="px-2 mt-1 text-[11px] text-slate-500">{section.description}</p>
            <div className="mt-2 space-y-1">
              {section.modules.map((module) => {
                const Icon = MODULE_ICONS[module];
                const isActive = activeModule === module;
                return (
                  <button
                    key={module}
                    onClick={() => {
                      setActiveModule(module);
                      onClose?.();
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                      isActive
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon size={17} className={isActive ? 'text-blue-100' : 'text-slate-400'} />
                    <span className="text-sm leading-tight">{MODULE_LABELS[module]}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>

      <div className="p-4 border-t border-slate-800">
        <button
          onClick={() => {
            resetDataset();
            onClose?.();
          }}
          className="w-full flex items-center gap-2 text-sm text-slate-300 hover:text-white transition-colors"
        >
          <ArrowLeft size={16} />
          Change File
        </button>
      </div>
    </>
  );

  const Sidebar = () => (
    <aside className="w-80 bg-slate-900 text-white fixed inset-y-0 left-0 hidden lg:flex flex-col overflow-hidden z-20">
      <SidebarContent />
    </aside>
  );

  const DashboardPreview = () => {
    const totalRows = dashboardSummary.totalRows;
    const uniqueVouchers = dashboardSummary.uniqueVouchers;
    const dateRange = { start: dashboardSummary.minDate, end: dashboardSummary.maxDate };

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-slate-500 text-sm font-medium">Total Ledger Entries</h3>
            <p className="text-3xl font-bold text-slate-800 mt-2">{totalRows.toLocaleString()}</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-slate-500 text-sm font-medium">Unique Vouchers</h3>
            <p className="text-3xl font-bold text-blue-600 mt-2">{uniqueVouchers.toLocaleString()}</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-slate-500 text-sm font-medium">Data Range</h3>
            <p className="text-lg font-bold text-slate-800 mt-2">{dateRange.start} - {dateRange.end}</p>
            <p className="text-xs text-slate-400 mt-1">Based on entry dates</p>
          </div>
        </div>
        
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-8 text-center">
            <h2 className="text-xl font-semibold text-blue-900 mb-2">Ready to Analyze</h2>
            <p className="text-blue-700 mb-6">Start by configuring your ledger mappings or jump into a module.</p>
            <div className="flex justify-center gap-4 flex-wrap">
              <button onClick={() => setActiveModule(AnalysisType.AUDIT_CONFIG)} className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2">
                <Settings2 size={18} /> Audit Setup
              </button>
              <button onClick={() => setActiveModule(AnalysisType.LEDGER_ANALYTICS)} className="bg-blue-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors shadow-sm">Ledger Analytics</button>
              <button onClick={() => setActiveModule(AnalysisType.RELATED_PARTY_ANALYSIS)} className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-medium hover:bg-indigo-700 transition-colors shadow-sm">RPT Audit</button>
            </div>
        </div>
      </div>
    );
  };

  if (!hasDataset) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-4 py-3 sm:px-6">
           <div className="max-w-7xl mx-auto flex items-center gap-2">
             <BarChart3 className="text-blue-600" />
             <span className="font-bold text-xl text-slate-900">FinAnalyzer Pro</span>
           </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          <FileUpload onDataLoaded={handleDataLoaded} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {isMobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            onClick={() => setIsMobileNavOpen(false)}
            aria-label="Close menu"
            className="absolute inset-0 bg-slate-950/50"
          />
          <aside className="absolute inset-y-0 left-0 w-[min(85vw,22rem)] bg-slate-900 text-white shadow-2xl flex flex-col">
            <SidebarContent isMobile onClose={() => setIsMobileNavOpen(false)} />
          </aside>
        </div>
      )}
      <Sidebar />
      <div className="flex-1 lg:ml-80 transition-all">
        <header className="sticky top-0 z-10 bg-white/90 backdrop-blur-md border-b border-slate-200 px-4 py-3 md:px-6 lg:px-8 lg:py-4 flex flex-col gap-3 lg:flex-row lg:justify-between lg:items-center">
          <div className="flex items-start gap-3">
            <button
              onClick={() => setIsMobileNavOpen(true)}
              className="lg:hidden inline-flex items-center justify-center mt-0.5 w-9 h-9 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100"
              aria-label="Open navigation menu"
            >
              <Menu size={18} />
            </button>
            <div>
              <h2 className="text-lg md:text-xl font-bold text-slate-800 break-words">
                {MODULE_LABELS[activeModule] || 'Dashboard Overview'}
              </h2>
              <p className="text-xs text-slate-500 mt-1">{activeSection}</p>
            </div>
          </div>
          <div className="w-full lg:w-auto flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between lg:justify-end gap-2 md:gap-3">
            {/* Dark mode toggle */}
            <button
              onClick={() => setDarkMode((d) => !d)}
              title={darkMode ? 'Switch to Light mode' : 'Switch to Dark mode'}
              className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div className="text-left sm:text-right">
              <div className="text-sm text-slate-500">{dashboardSummary.totalRows} records loaded</div>
              <div className={`text-xs ${isSqlMode ? 'text-emerald-700' : 'text-amber-700'}`}>
                {isSqlMode ? 'Mode: SQL (low-memory)' : 'Mode: In-memory fallback'}
              </div>
            </div>
          </div>
        </header>
        
        <main className="p-4 sm:p-6 lg:p-8">
          {updateAvailable && (
            <div className="mb-4 px-4 py-3 rounded-lg border border-blue-200 bg-blue-50 text-blue-800 text-sm flex items-center justify-between gap-3">
              <span>A new version <strong>v{updateAvailable}</strong> is available. Download it to get the latest improvements.</span>
              <button onClick={() => setUpdateAvailable(null)} className="text-blue-600 hover:text-blue-800 font-bold text-xs shrink-0">Dismiss</button>
            </div>
          )}
          {sqlNote && (
            <div className="mb-4 px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm">
              {sqlNote}
            </div>
          )}
          {isModuleDataLoading && (
            <div className="mb-4 px-4 py-3 rounded-lg border border-blue-200 bg-blue-50 text-blue-800 text-sm">
              Loading data from {isSqlMode ? 'SQL backend' : 'memory'}...
            </div>
          )}
          {isSqlMode && isModuleDataLoading && activeModule !== AnalysisType.DASHBOARD ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500">
              Loading module dataset...
            </div>
          ) : (
            <TallyStoreProvider store={store}>
            <Suspense
              fallback={
                <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500">
                  Loading module UI...
                </div>
              }
            >
              {activeModule === AnalysisType.DASHBOARD && <DashboardPreview />}
              {activeModule === AnalysisType.AUDIT_CONFIG && (
                <AuditSetup data={transactionData} settings={settings} onUpdate={updateSettings} />
              )}
              {activeModule === AnalysisType.TRIAL_BALANCE && <TrialBalanceAnalysis data={data} />}
              {activeModule === AnalysisType.DEBTOR_AGEING && <DebtorAgeingFIFO data={transactionData} />}
              {activeModule === AnalysisType.CREDITOR_AGEING && <CreditorAgeingFIFO data={transactionData} />}
              {activeModule === AnalysisType.GST_RATE && (
                <GSTRateAnalysis
                  data={transactionData}
                  externalSelectedLedgers={settings.salesGstLedgers}
                  onLedgersUpdate={(l) => updateSettings({ salesGstLedgers: l })}
                />
              )}
              {activeModule === AnalysisType.SALES_REGISTER && (
                <SalesRegister data={transactionData} externalSelectedLedgers={settings.salesGstLedgers} />
              )}
              {activeModule === AnalysisType.PURCHASE_GST_REGISTER && (
                <PurchaseGSTRegister data={transactionData} />
              )}
              {activeModule === AnalysisType.GSTR2B_RECONCILIATION && (
                <GSTR2BReconciliation
                  data={transactionData}
                  selectedGstLedgers={settings.purchaseGstLedgers}
                  selectedRcmLedgers={settings.rcmTaxLedgers}
                />
              )}
              {activeModule === AnalysisType.ITC_3B_RECONCILIATION && (
                <ITC3BReconciliation
                  data={transactionData}
                  externalSelectedLedgers={settings.purchaseGstLedgers}
                  externalRcmLedgers={settings.rcmTaxLedgers}
                  onLedgersUpdate={(l) => updateSettings({ purchaseGstLedgers: l })}
                />
              )}
              {activeModule === AnalysisType.TDS_ANALYSIS && (
                <TDSAnalysis
                  data={transactionData}
                  externalSelectedLedgers={settings.tdsTaxLedgers}
                  onLedgersUpdate={(l) => updateSettings({ tdsTaxLedgers: l })}
                  thresholdConfig={settings.tdsThresholdConfig}
                  onThresholdConfigUpdate={(cfg) => updateSettings({ tdsThresholdConfig: cfg })}
                  annotations={settings.tdsAnnotations}
                  onAnnotationsUpdate={(notes) => updateSettings({ tdsAnnotations: notes })}
                  isSqlMode={isSqlMode}
                />
              )}
              {activeModule === AnalysisType.RCM_ANALYSIS && (
                <RCMAnalysis
                  data={transactionData}
                  externalSelectedLedgers={settings.rcmTaxLedgers}
                  onLedgersUpdate={(l) => updateSettings({ rcmTaxLedgers: l })}
                />
              )}
              {activeModule === AnalysisType.GST_EXPENSE_ANALYSIS && (
                <GSTExpenseAnalysis
                  data={transactionData}
                  externalSelectedLedgers={settings.blockedCreditLedgers}
                  onLedgersUpdate={(l) => updateSettings({ blockedCreditLedgers: l })}
                />
              )}
              {activeModule === AnalysisType.PROFIT_LOSS_ANALYSIS && <ProfitLossAnalysis data={transactionData} />}
              {activeModule === AnalysisType.CASH_FLOW_ANALYSIS && <CashFlowAnalysis data={transactionData} />}
              {activeModule === AnalysisType.VARIANCE_ANALYSIS && <VarianceAnalysis data={transactionData} />}
              {activeModule === AnalysisType.EXCEPTION_DENSITY_HEATMAP && (
                <ExceptionDensityHeatmapAnalytics data={transactionData} />
              )}
              {activeModule === AnalysisType.BALANCE_SHEET_CLEANLINESS && (
                <BalanceSheetCleanlinessAnalytics data={transactionData} />
              )}
              {activeModule === AnalysisType.ORPHAN_PL_VOUCHERS && (
                <OrphanPLVouchers data={transactionData} />
              )}
              {activeModule === AnalysisType.LEDGER_ANALYTICS && <LedgerAnalytics data={transactionData} />}
              {activeModule === AnalysisType.VOUCHER_BOOK_VIEW && <VoucherBookView data={transactionData} />}
              {activeModule === AnalysisType.LEDGER_VOUCHER_VIEW && <LedgerVoucherView data={transactionData} />}
              {activeModule === AnalysisType.PARTY_LEDGER_MATRIX && (
                <PartyLedgerMatrix
                  data={data}
                  externalProfile={settings.partyMatrixProfile}
                  onProfileUpdate={(profile) => updateSettings({ partyMatrixProfile: profile })}
                />
              )}
              {activeModule === AnalysisType.RELATED_PARTY_ANALYSIS && (
                <RelatedPartyAnalysis
                  data={transactionData}
                  externalProfile={settings.relatedPartyProfile}
                  onProfileUpdate={(profile) => updateSettings({ relatedPartyProfile: profile })}
                />
              )}
              {activeModule === AnalysisType.GST_LEDGER_SUMMARY && (
                <GSTLedgerSummary
                  data={transactionData}
                  externalSelectedLedgers={settings.gstLedgerSummary}
                  onLedgersUpdate={(l) => updateSettings({ gstLedgerSummary: l })}
                />
              )}
            </Suspense>
            </TallyStoreProvider>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
