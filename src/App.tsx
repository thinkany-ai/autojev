import { AddAgentDialog } from './components/add-agent-dialog';
import { ConnectionParamsDialog } from './components/connection-params-dialog';
import { GatewayActionMenu } from './components/gateway-action-menu';
import { AGENT_SELECTIONS_KEY, availableAgentSelections, parseAgentSelections } from './lib/agent-selections';
import { SpeedCell, SpeedTestToolbar, useModelSpeedTests } from './components/model-speed-tests';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DebugPage } from './components/debug-page';
import { WindowFrame } from './components/window-frame';
import { TrafficPage } from './components/traffic-page';
import { RoutesPage } from './components/routes-page';
import { sortProviders } from './lib/provider-sort';
import { providerTestError, type ProviderTestStatus } from './lib/provider-test';
import { providerIdentifier } from './lib/provider-name';
import { Select } from './components/select';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  FilePenLine,
  Terminal,
  Image as ImageIcon,
  ImageOff,
  ChartNoAxesCombined,
  ArrowRight,
  Bot,
  Box,
  Check,
  ChevronRight,
  ChevronDown,
  Download,
  LoaderCircle,
  CircleGauge,
  Cpu,
  Database,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Link2,
  Layers3,
  Network,
  Play,
  Plus,
  Power,
  RefreshCw,
  Unplug,
  Plug,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useAppUpdate } from './components/app-update';
import { SettingsDialog, type SettingsSection } from './components/settings-dialog';
import { usePreferences } from './lib/preferences-context';
import { SearchSelect } from './components/search-select';
import { BrandMark } from './components/brand-mark';
import { rangeStart, summarize } from './lib/traffic';
import {
  connectAgent,
  deleteModel,
  deleteProvider,
  detectAgents,
  openAgentConfig,
  launchAgent,
  getSnapshot,
  getRequestLogs,
  getGatewayHealth,
  resetGatewayHealth,
  importProviders,
  restoreAgent,
  saveModel,
  saveProvider,
  testProvider,
  testProviderDraft,
  toggleProxy,
  pauseProxy,
} from './lib/bridge';
import type {
  DashboardSnapshot,
  Model,
  Provider,
} from './types';

type Page = 'overview' | 'providers' | 'models' | 'router' | 'agents' | 'activity' | 'usage' | 'debug';

const EMPTY_PROVIDER: Provider = {
  id: '',
  name: '',
  kind: 'openrouter',
  base_url: 'https://openrouter.ai/api',
  enabled: true,
  has_api_key: false,
};

const EMPTY_MODEL: Model = {
  id: '',
  provider_id: '',
  model_id: '',
  name: '',
  tier: 'balanced',
  enabled: true,
  supports_tools: true,
  supports_vision: false,
  supports_reasoning: false,
  context_window: 1000000,
  api_type: '',
  input_price_known: false, output_price_known: false, cache_price_known: false,
  cache_cost_per_million: 0,
  input_cost_per_million: 0,
  output_cost_per_million: 0,
};

function money(value: number | null) {
  if (value == null) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function timeAgo(value: string, t: (message: string, values: Record<string, number>) => string) {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return t('{count}s ago', { count: seconds });
  if (seconds < 3600) return t('{count}m ago', { count: Math.floor(seconds / 60) });
  return t('{count}h ago', { count: Math.floor(seconds / 3600) });
}

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export default function App() {
  const { t } = usePreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stopGatewayOpen, setStopGatewayOpen] = useState(false);
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const gatewayOperation = useRef(false);
  const gatewayButton = useRef<HTMLButtonElement>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const update = useAppUpdate();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); setSettingsOpen(true); }
      // The frameless window has no native close command, so handle ⌘W / Ctrl+W here; closing hides to the menu bar.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'w' && isTauri()) { event.preventDefault(); void getCurrentWindow().close(); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  useEffect(() => {
    let disposed=false; let unlisten: (() => void) | undefined;
    void listen<string>('gateway-lifecycle-error', event => { window.alert(event.payload); }).then(fn => { if(disposed)fn();else unlisten=fn; }).catch(() => {});
    return () => { disposed=true;unlisten?.(); };
  }, []);
  const [page, setPage] = useState<Page>('overview');
  const [busy, setBusy] = useState(false);
  const [toast, setToastState] = useState('');
  const [toastError, setToastError] = useState(false);
  const [toastVersion, setToastVersion] = useState(0);
  const setToast = (message: string, error = false) => { setToastState(message); setToastError(error); setToastVersion(version => version + 1); };
  const [providerTests, setProviderTests] = useState<Record<string, ProviderTestStatus>>({});
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [modelDeleteTarget, setModelDeleteTarget] = useState<Model | null>(null);
  const [deletingModel, setDeletingModel] = useState(false);
  const [providerModal, setProviderModal] = useState<Provider | null>(null);
  const [modelModal, setModelModal] = useState<Model | null>(null);

  useEffect(() => {
    getSnapshot().then(setSnapshot).catch((error) => setToast(String(error)));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast, toastVersion]);

  const run = async (work: () => Promise<DashboardSnapshot>, message: string, propagate = false) => {
    setBusy(true);
    try {
      setSnapshot(await work());
      setToast(message);
    } catch (error) {
      if (propagate) throw error;
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const changeGateway = async (mode: 'start' | 'pause' | 'stop') => {
    if (gatewayOperation.current) return;
    gatewayOperation.current = true; setGatewayBusy(true);
    try {
      setSnapshot(await (mode === 'pause' ? pauseProxy() : toggleProxy(mode === 'start')));
      setStopGatewayOpen(false);
      setToast(t(mode === 'pause' ? 'Gateway paused' : mode === 'stop' ? 'Gateway stopped; agent configurations restored' : 'Proxy started'));
    } catch (error) { setToast(error instanceof Error ? error.message : String(error), true); }
    finally { gatewayOperation.current = false; setGatewayBusy(false); }
  };

  if (!snapshot) {
    return (
      <div className="boot-screen">
        <div className="brand-mark"><BrandMark /></div>
        <span>{t("Starting local router…")}</span>
      </div>
    );
  }

  const navigation: Array<{ id: Page; label: string; icon: typeof Activity }> = [
    { id: 'overview', label: t("Overview"), icon: CircleGauge },
    { id: 'providers', label: t("Providers"), icon: Server },
    { id: 'models', label: t("Models"), icon: Cpu },
    { id: 'router', label: t("Routes"), icon: GitBranch },
    { id: 'agents', label: t("Agents"), icon: Bot },
    { id: 'debug', label: t("Debug"), icon: Play },
    { id: 'activity', label: t("Logs"), icon: Activity },
    { id: 'usage', label: t("Usage"), icon: ChartNoAxesCombined },
  ];

  return (
    <div className="app-shell">
      <WindowFrame/>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BrandMark /></div>
          <div><strong>AutoJev</strong><span>{t("MODEL ROUTER")}</span></div>
        </div>

        <nav>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={cx('nav-item', page === item.id && 'active')} onClick={() => setPage(item.id)}>
                <Icon size={17} />
                <span>{item.label}</span>
                
              </button>
            );
          })}
        </nav>

        {stopGatewayOpen && <GatewayActionMenu anchor={gatewayButton} busy={gatewayBusy} onClose={() => { if (!gatewayBusy) setStopGatewayOpen(false); }} onConfirm={pause => void changeGateway(pause ? 'pause' : 'stop')}/>}
        <div className="sidebar-bottom">
          <div className="proxy-mini">
            <div className="status-line"><span className={cx('status-dot', snapshot.proxy.running && !snapshot.proxy.paused && 'online')} />{snapshot.proxy.paused ? t("Gateway paused") : snapshot.proxy.running ? t("Proxy online") : t("Proxy stopped")}</div>
            </div>
          <button ref={gatewayButton} aria-haspopup={snapshot.proxy.running && !snapshot.proxy.paused ? "menu" : undefined} aria-expanded={stopGatewayOpen} aria-controls={stopGatewayOpen ? "gateway-action-menu" : undefined} className="icon-action" title={t(snapshot.proxy.running && !snapshot.proxy.paused ? 'Stop proxy' : 'Start proxy')} aria-label={t(snapshot.proxy.running && !snapshot.proxy.paused ? 'Stop proxy' : 'Start proxy')} aria-busy={gatewayBusy} disabled={busy || gatewayBusy} onClick={() => snapshot.proxy.running && !snapshot.proxy.paused ? setStopGatewayOpen(open => !open) : void changeGateway('start')}>
            {gatewayBusy ? <LoaderCircle size={17} className="import-spinner"/> : snapshot.proxy.running && !snapshot.proxy.paused ? <Power size={17}/> : <Play size={17}/>}
          </button>
        </div>
        <button className="settings-trigger" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /><span>{t('Settings')}</span>{update.update ? <span className="settings-update-dot" /> : <kbd>⌘ / Ctrl ,</kbd>}</button>
      </aside>

      <main className={page === 'debug' ? 'debug-main' : undefined}>
        <div className="page-content">
          {page === 'overview' && <Overview snapshot={snapshot} go={setPage} />}
          {page === 'providers' && (
            <ProvidersPage
              snapshot={snapshot}
              onImport={async (source) => {
                setBusy(true);
                try {
                  const result = await importProviders(source);
                  setSnapshot(result.snapshot);
                  const message = t('{imported} providers imported; {skipped} existing or incompatible entries skipped.', { imported: result.imported, skipped: result.skipped });
                  setToast(message);
                } catch (error) {
                  setToast(String(error));
                  getSnapshot().then(setSnapshot).catch(() => {});
                } finally { setBusy(false); }
              }}
              onAdd={() => setProviderModal({ ...EMPTY_PROVIDER })}
              onEdit={(provider) => setProviderModal({ ...provider })}
              onDelete={(id) => setDeleteTarget(snapshot.providers.find((provider) => provider.id === id) ?? null)}
              onToggle={async (provider) => {
                try {
                  setSnapshot(await saveProvider({ ...provider, enabled: !provider.enabled }));
                  setToast(t(provider.enabled ? 'Provider disabled' : 'Provider enabled'));
                } catch (error) { setToast(String(error), true); }
              }}
              testStates={providerTests}
              onTest={async (id) => {
                setProviderTests((previous) => ({ ...previous, [id]: 'testing' }));
                try {
                  await testProvider(id);
                  setProviderTests((previous) => ({ ...previous, [id]: 'success' }));
                  setToast(t('Test request succeeded.'));
                } catch (error) {
                  setProviderTests((previous) => ({ ...previous, [id]: 'error' }));
                  setToast(providerTestError(error, t), true);
                  getSnapshot().then(setSnapshot).catch(() => {});
                }
              }}
            />
          )}
          {page === 'models' && (
            <ModelsPage
              onNotify={setToast}
              onChange={setSnapshot}
              snapshot={snapshot}
              onAdd={() => setModelModal({ ...EMPTY_MODEL, provider_id: snapshot.providers.find((provider) => provider.enabled)?.id ?? '' })}
              onEdit={(model) => setModelModal({ ...model })}
              onDelete={(id) => setModelDeleteTarget(snapshot.models.find((model) => model.id === id) ?? null)}
            />
          )}
          {page === 'router' && <RoutesPage snapshot={snapshot} onChange={setSnapshot} />}
          {page === 'agents' && (
            <AgentsPage
              onChange={setSnapshot}
              onManageRoutes={() => setPage('router')}
              connecting={busy}
              snapshot={snapshot}
              onRefresh={async () => {
                setBusy(true);
                try { setSnapshot({ ...snapshot, agents: await detectAgents() }); setToast(t("Agent status refreshed")); } finally { setBusy(false); }
              }}
              onConnect={(id, routeId, routeIds) => run(() => connectAgent(id, routeId, routeIds), t("Agent connected to AutoJev"), true)}
              onRestore={(id) => run(() => restoreAgent(id), t("Original agent configuration restored"), true)}
            />
          )}
          {page === 'activity' && <TrafficPage key="logs" mode="logs" />}
          {page === 'debug' && <DebugPage snapshot={snapshot} />}
          {page === 'usage' && <TrafficPage key="usage" mode="usage" />}
        </div>
      </main>

      {settingsOpen && <SettingsDialog snapshot={snapshot} onChange={setSnapshot} section={settingsSection} onSectionChange={setSettingsSection} onClose={() => setSettingsOpen(false)} update={update} />}
      {deleteTarget && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingProvider) setDeleteTarget(null); }} onKeyDown={(event) => { if (event.key === 'Escape' && !deletingProvider) setDeleteTarget(null); }}>
        <div className="dialog provider-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-provider-title" aria-describedby="delete-provider-description">
          <h2 id="delete-provider-title">{t('Delete provider?')}</h2>
          <p id="delete-provider-description">{t('Delete {provider}? Its saved API key and associated models will also be removed. This cannot be undone.', { provider: deleteTarget.name })}</p>
          <div className="provider-dialog-actions"><button autoFocus type="button" className="button ghost" disabled={deletingProvider} onClick={() => setDeleteTarget(null)}>{t('Cancel')}</button><button type="button" className="button destructive" disabled={deletingProvider} onClick={async () => {
            if (deletingProvider) return;
            setDeletingProvider(true);
            try { setSnapshot(await deleteProvider(deleteTarget.id)); setDeleteTarget(null); setToast(t('Provider removed')); }
            catch (error) { setToast(String(error), true); }
            finally { setDeletingProvider(false); }
          }}>{deletingProvider ? <LoaderCircle size={15} className="import-spinner" /> : <Trash2 size={15} />}{t(deletingProvider ? 'Deleting…' : 'Delete')}</button></div>
        </div>
      </div>}
      {modelDeleteTarget && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !deletingModel) setModelDeleteTarget(null); }} onKeyDown={(event) => { if (event.key === 'Escape' && !deletingModel) setModelDeleteTarget(null); }}>
        <div className="dialog provider-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-model-title" aria-describedby="delete-model-description">
          <h2 id="delete-model-title">{t('Delete model?')}</h2>
          <p id="delete-model-description">{t('Delete {model}? This cannot be undone.', { model: modelDeleteTarget.name || modelDeleteTarget.model_id })}</p>
          <div className="provider-dialog-actions"><button autoFocus type="button" className="button ghost" disabled={deletingModel} onClick={() => setModelDeleteTarget(null)}>{t('Cancel')}</button><button type="button" className="button destructive" disabled={deletingModel} onClick={async () => {
            if (deletingModel) return;
            setDeletingModel(true);
            try { setSnapshot(await deleteModel(modelDeleteTarget.id)); setModelDeleteTarget(null); setToast(t('Model removed')); }
            catch (error) { setToast(String(error), true); }
            finally { setDeletingModel(false); }
          }}>{deletingModel ? <LoaderCircle size={15} className="import-spinner" /> : <Trash2 size={15} />}{t(deletingModel ? 'Deleting…' : 'Delete')}</button></div>
        </div>
      </div>}
      {providerModal && (
        <ProviderDialog
          onTestStatus={(status) => { if (providerModal.id) setProviderTests((previous) => ({ ...previous, [providerModal.id]: status })); if (status === 'error') getSnapshot().then(setSnapshot).catch(() => {}); }}
          initial={providerModal}
          onClose={() => setProviderModal(null)}
          onSave={async (provider, apiKey, addTestModel) => {
            setSnapshot(await saveProvider(provider, apiKey, addTestModel, providerModal.id || undefined, !providerModal.id));
            setProviderModal(null);
            setToast(t("Provider saved"));
          }}
        />
      )}
      {modelModal && (
        <ModelDialog
          onTestStatus={(id, status) => { setProviderTests((previous) => ({ ...previous, [id]: status })); if (status === 'error') getSnapshot().then(setSnapshot).catch(() => {}); }}
          initial={modelModal}
          providers={snapshot.providers}
          onClose={() => setModelModal(null)}
          onSave={async (model) => {
            setSnapshot(await saveModel(model));
            setModelModal(null);
            setToast(t('Model saved'));
          }}
        />
      )}
      {toast && <div className={cx("toast", toastError && "toast-error")} role={toastError ? "alert" : "status"} aria-live="polite">{toastError ? <X size={16} /> : <Check size={16} />}{toast}</div>}
    </div>
  );
}

function Overview({ snapshot, go }: { snapshot: DashboardSnapshot; go: (page: Page) => void }) {
  const { t } = usePreferences();
  const [showParams, setShowParams] = useState(false);
  const providers = snapshot.providers.filter((provider) => provider.enabled);
  const models = snapshot.models.filter((model) => model.enabled && providers.some((provider) => provider.id === model.provider_id));
  const [today, setToday] = useState<{ requests: number; tokens: number } | null>(null);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const totals = summarize(await getRequestLogs(rangeStart(1).toISOString()));
        if (!disposed) setToday({ requests: totals.requests, tokens: totals.input + totals.output });
      } catch {
        if (!disposed) setToday(null);
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const agents = snapshot.agents.filter((agent) => agent.connected);
  const running = snapshot.proxy.running && !snapshot.proxy.paused;

  return <div className="router-home">
    {showParams && <ConnectionParamsDialog snapshot={snapshot} onClose={() => setShowParams(false)}/>}
    <section className="overview-intro">
      <p>{t('Route every request to the right model.')}</p>
      <button className="button ghost" onClick={() => go('agents')}><Bot size={16} />{t('Connect an agent')}</button>
    </section>

    <section className="router-map" aria-label={t('Routing topology')}>
      <div className="router-map-bar"><button className="router-map-endpoint" title={t('Connection parameters')} onClick={() => setShowParams(true)}><Network size={14} /><code>127.0.0.1:{snapshot.proxy.port}</code><Link2 size={13} /></button><span className="status-line"><i className={cx('status-dot', running && 'online')} />{t(snapshot.proxy.paused ? 'Gateway paused' : running ? 'Proxy online' : 'Proxy stopped')}</span></div>
      <div className={cx("router-map-body", running && "routing-active")}>
        <div className="router-endpoints">
          <span className="router-map-label">{t('Agents')}</span>
          {(agents.length ? agents.slice(0, 3) : [{ id: 'empty', name: t('Connect an agent') }]).map((agent) => <button className="router-endpoint" key={agent.id} onClick={() => go('agents')}><span className="router-endpoint-logo">{agent.id === 'empty' ? <Bot size={21} /> : <AgentLogo id={agent.id} />}</span><strong>{agent.name}</strong><ChevronRight size={14} /></button>)}
          <small>{agents.length ? t('{count} connected', { count: agents.length }) : 'Codex · Claude Code · …'}</small>
        </div>
        <div className="router-wire" aria-hidden="true"><ArrowRight size={14} /></div>
        <button className="router-hub" onClick={() => go('router')} aria-label={t('Manage routes')}>
          <span className="router-hub-icon"><BrandMark /></span>
          <strong>AutoJev</strong>
        </button>
        <div className="router-wire" aria-hidden="true"><ArrowRight size={14} /></div>
        <div className="router-endpoints">
          <span className="router-map-label">{t('Models')}</span>
          {models.slice(0, 3).map((model) => <button className="router-endpoint" key={model.id} onClick={() => go('models')} title={model.name || model.model_id}>
            <span className="router-endpoint-logo"><ProviderLogo id={providerPreset(providers.find((provider) => provider.id === model.provider_id)!)} /></span><span><strong>{model.name || model.model_id}</strong><small>{providers.find((provider) => provider.id === model.provider_id)?.name}</small></span><ChevronRight size={14} />
          </button>)}
          {!models.length && <button className="router-endpoint" onClick={() => go('models')}><Plus size={21} /><strong>{t('Add model')}</strong><ChevronRight size={14} /></button>}
          <small>{t('{count} models connected', { count: models.length })}</small>
        </div>
      </div>
    </section>

    <section className="router-home-summary" aria-label={t('Overview')}>
      {([
        { page: 'providers', label: 'Providers', count: snapshot.providers.length, icon: Server },
        { page: 'models', label: 'Models', count: snapshot.models.length, icon: Cpu },
        { page: 'router', label: 'Routes', count: snapshot.routes.length, icon: GitBranch },
        { page: 'agents', label: 'Agents', count: snapshot.agents.filter((agent) => agent.installed || agent.custom).length, icon: Bot },
        { page: 'activity', label: 'Requests today', count: today?.requests, icon: Activity },
        { page: 'usage', label: 'Tokens today', count: today?.tokens, icon: ChartNoAxesCombined },
      ] as const).map(({ page, label, count, icon: Icon }) => <button key={page} onClick={() => go(page)}>
        <Icon size={20} /><span>{t(label)}</span><strong title={count?.toLocaleString()}>{count === undefined ? '—' : page === 'usage' ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count) : count.toLocaleString()}</strong><ChevronRight size={15} />
      </button>)}
    </section>
  </div>;
}

function ProviderImport({ onImport }: { onImport: (source: 'ccswitch' | 'termany') => Promise<void> }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const start = async (source: 'ccswitch' | 'termany') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpen(false);
    trigger.current?.focus();
    setPending(true);
    try { await onImport(source); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <div ref={container} className="provider-import" onKeyDown={(event) => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="button ghost" disabled={pending} aria-expanded={open} aria-controls="provider-import-options" onClick={() => setOpen(!open)}>
      {pending ? <LoaderCircle size={16} className="import-spinner" /> : <Download size={16} />}
      {pending ? t('Importing…') : t('Import')}<ChevronDown size={14} />
    </button>
    {open && <div id="provider-import-options" className="provider-import-menu">
      {(['ccswitch', 'termany'] as const).map((source) => <button key={source} type="button" onClick={() => void start(source)}>
        <Download size={14} />{t('Import from {source}', { source: source === 'ccswitch' ? 'CC Switch' : 'Termany' })}
      </button>)}
    </div>}

  </div>;
}

function ProvidersPage({ snapshot, onAdd, onEdit, onDelete, onTest, onImport, testStates, onToggle }: { onToggle: (provider: Provider) => Promise<void>; testStates: Record<string, ProviderTestStatus>; onImport: (source: 'ccswitch' | 'termany') => Promise<void>; snapshot: DashboardSnapshot; onAdd: () => void; onEdit: (p: Provider) => void; onDelete: (id: string) => void; onTest: (id: string) => void }) {
  const { t } = usePreferences();
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const toggle = async (provider: Provider) => {
    if (toggling[provider.id]) return;
    setToggling((previous) => ({ ...previous, [provider.id]: true }));
    try { await onToggle(provider); }
    finally { setToggling((previous) => ({ ...previous, [provider.id]: false })); }
  };
  const providers = sortProviders(snapshot.providers, testStates);
  return (
    <div className="stack lg">
      <PageIntro title={t("Providers")} body={t("Keys are stored in the local database.")} action={<div className="provider-actions"><ProviderImport onImport={onImport} /><button className="button primary" onClick={onAdd}><Plus size={16} /> {t("Add provider")}</button></div>} />
      <div className="table-panel provider-table-panel">
        <table className="provider-table">
          <thead><tr><th>{t('Provider')}</th><th>{t('Base URL')}</th><th>{t('Enabled status')}</th><th>{t('API key')}</th><th className="provider-actions-heading">{t('Actions')}</th></tr></thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td><div className="provider-table-name"><span className="provider-table-icon"><ProviderLogo id={providerPreset(provider)} /></span><div><strong>{provider.name}</strong><small>{provider.id}</small></div></div></td>
                <td><code className="provider-table-url" title={provider.base_url}>{provider.base_url}</code></td>
                <td><div className="provider-enabled-cell"><button type="button" role="switch" aria-checked={provider.enabled} aria-label={t('Enable {provider}', { provider: provider.name })} disabled={toggling[provider.id]} className={cx('switch', provider.enabled && 'on')} onClick={() => void toggle(provider)}><span /></button><span>{t(provider.enabled ? 'ENABLED' : 'DISABLED')}</span></div></td>
                <td><span className="provider-table-key"><KeyRound size={14} />{provider.kind === 'ollama' ? t('No API key required') : provider.has_api_key ? t('API key saved locally') : t('API key required')}</span></td>
                <td><div className="row-actions"><button className="icon-action" disabled={testStates[provider.id] === 'testing'} title={t(testStates[provider.id] === 'testing' ? 'Testing…' : 'Test')} aria-label={t(testStates[provider.id] === 'testing' ? 'Testing…' : 'Test')} onClick={() => onTest(provider.id)}>{testStates[provider.id] === 'testing' ? <LoaderCircle size={15} className="import-spinner" /> : <Play size={15} />}</button><button className="icon-action" onClick={() => onEdit(provider)} title={t('Configure')} aria-label={t('Configure')}><Settings2 size={15} /></button><button className="icon-action danger" onClick={() => onDelete(provider.id)} title={t('Delete')} aria-label={t('Delete')}><Trash2 size={15} /></button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {snapshot.providers.length === 0 && <EmptyState icon={<Server />} title={t('No providers yet')} body={t('Add a provider or import from CC Switch or Termany.')} />}
      </div>
    </div>
  );
}

function ModelTestErrorDialog({ model, detail, onClose, title = 'Model test failed' }: { model: string; detail: string; onClose: () => void; title?: string }) {
  const { t } = usePreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="dialog provider-dialog model-test-error-dialog" aria-labelledby="model-test-error-title" aria-describedby="model-test-error-detail" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <div className="provider-dialog-header"><div><h2 id="model-test-error-title">{t(title)}</h2><p>{model}</p></div><button className="icon-action" aria-label={t('Close')} onClick={onClose}><X size={20}/></button></div>
    <div id="model-test-error-detail" className="model-test-error-detail">{detail}</div>
    <div className="provider-dialog-actions"><button autoFocus className="button primary" onClick={onClose}>{t('Close')}</button></div>
  </dialog>;
}

function ModelsPage({ snapshot, onAdd, onEdit, onDelete, onChange, onNotify }: { onNotify: (message: string, error?: boolean) => void; onChange: (snapshot: DashboardSnapshot) => void; snapshot: DashboardSnapshot; onAdd: () => void; onEdit: (m: Model) => void; onDelete: (id: string) => void }) {
  const { t } = usePreferences();
  const [health, setHealth] = useState(snapshot.health ?? []);
  const [clearingCooldown, setClearingCooldown] = useState<Record<string, boolean>>({});
  const healthEpoch = useRef(0);
  useEffect(() => {
    let stopped = false, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const epoch = healthEpoch.current;
      try { const next = await getGatewayHealth(); if (!stopped && epoch === healthEpoch.current) setHealth(next); }
      catch { /* Retain the last known state until the next refresh. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const clearCooldown = async (id: string) => {
    healthEpoch.current++;
    setClearingCooldown(previous => ({ ...previous, [id]: true }));
    try {
      const next = await resetGatewayHealth(id);
      healthEpoch.current++;
      setHealth(next.health ?? []); onChange(next); onNotify(t('Cooldown cleared'));
    } catch (error) { onNotify(t(String(error instanceof Error ? error.message : error)), true); }
    finally { setClearingCooldown(previous => ({ ...previous, [id]: false })); }
  };
  const speedTests = useModelSpeedTests();
  const [dismissedSpeedJob, setDismissedSpeedJob] = useState(false);
  useEffect(() => { if (speedTests.view?.job.running) setDismissedSpeedJob(false); }, [speedTests.view?.job.running]);
  const speedError = speedTests.error || (!speedTests.view?.job.running && !dismissedSpeedJob ? speedTests.view?.job.error : '');
  useEffect(() => {
    if (!speedError) return;
    onNotify(t(speedError), true);
    speedTests.dismissError();
    setDismissedSpeedJob(true);
  }, [speedError, onNotify, t, speedTests.dismissError]);
  const testable = snapshot.models.filter(m => m.enabled && snapshot.providers.some(p => p.id === m.provider_id && p.enabled));
  const selectedCount = testable.filter(model => speedTests.selected.includes(model.id)).length;
  const [tests, setTests] = useState<Record<string, ProviderTestStatus>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const toggle = async (model: Model) => {
    setToggling(previous => ({ ...previous, [model.id]: true }));
    try { onChange(await saveModel({ ...model, enabled: !model.enabled })); onNotify(t(model.enabled ? 'Model disabled' : 'Model enabled')); }
    catch (error) { onNotify(t(String(error)), true); }
    finally { setToggling(previous => ({ ...previous, [model.id]: false })); }
  };
  const test = async (model: Model) => {
    const provider = snapshot.providers.find(p => p.id === model.provider_id);
    if (!provider) return;
    setTests(previous => ({ ...previous, [model.id]: 'testing' }));
    try {
      await testProviderDraft({ ...provider, api_type: model.api_type || provider.api_type, test_model: model.model_id });
      setTests(previous => ({ ...previous, [model.id]: 'success' }));
      onNotify(t('Test request succeeded.'));
    } catch (error) {
      setTests(previous => ({ ...previous, [model.id]: 'error' }));
      onNotify(providerTestError(error, t), true);
      try { onChange(await getSnapshot()); } catch { /* Keep the test failure visible. */ }
    }
  };
  return (
    <div className="stack lg">
      <PageIntro title={t("Models")} body={t("Add only models you actually want agents to use. Tier and capability metadata drive the local router.")} action={<div className="model-speed-actions"><SpeedTestToolbar tests={speedTests} models={testable}/><button className="button primary" onClick={onAdd}><Plus size={16} />  {t("Add model")}</button></div>} />
      <div className="table-panel provider-table-panel">
        <table className="provider-table models-table">
        <thead><tr><th className="model-speed-check"><label className="model-selection"><input autoComplete="off" autoCapitalize="none" ref={element => { if (element) element.indeterminate = selectedCount > 0 && selectedCount < testable.length; }} type="checkbox" aria-label={t("Select all enabled models")} disabled={!testable.length} checked={testable.length > 0 && selectedCount === testable.length} onChange={e => speedTests.select(e.target.checked ? testable.map(m => m.id) : [])}/></label></th><th>{t("MODEL")}</th><th>{t("Enabled status")}</th><th title={t('Time until the first content arrives. Lower is faster.') + ' ' + t('Output tokens per second after the first content. Higher is faster.')}>{t('First response / Output speed')}</th><th>{t("INPUT / OUTPUT")}</th><th>{t("Model information")}</th><th className="provider-actions-heading">{t("Actions")}</th></tr></thead>
        <tbody>
        {snapshot.models.map((model) => {
          const provider = snapshot.providers.find(p => p.id === model.provider_id);
          const modelHealth = health.find(h => h.model_id === model.id && h.state !== 'healthy');
          return (
          <tr key={model.id} className={speedTests.selected.includes(model.id) ? 'is-selected' : undefined}>
            <td className="model-speed-check"><label className="model-selection"><input autoComplete="off" autoCapitalize="none" type="checkbox" aria-label={t("Select model for speed test") + ": " + model.provider_id + "/" + model.model_id} disabled={!testable.some(m => m.id === model.id)} checked={speedTests.selected.includes(model.id)} onChange={() => speedTests.toggle(model.id)}/></label></td>
            <td><div className="provider-table-name"><span className="provider-table-icon"><ProviderLogo id={provider ? providerPreset(provider) : 'custom-openai'}/></span><div><strong>{model.name || model.model_id}</strong><small>{provider ? providerIdentifier(provider) : model.provider_id}/{model.model_id}</small></div></div></td>
            <td><div className="provider-enabled-cell"><button type="button" role="switch" aria-checked={model.enabled} aria-label={t('Enable {provider}', { provider: model.name })} disabled={toggling[model.id]} className={cx('switch', model.enabled && 'on')} onClick={() => void toggle(model)}><span/></button><span>{t(model.enabled ? 'ENABLED' : 'DISABLED')}</span></div>{modelHealth && <div className="model-health-status" title={modelHealth.last_status ? `HTTP ${modelHealth.last_status}` : t('Connection failed')}><span>{t(modelHealth.state === 'cooldown' ? 'Cooling down' : modelHealth.state === 'probing' ? 'Checking recovery' : 'Awaiting recovery')}{modelHealth.retry_after_seconds > 0 ? ` · ${modelHealth.retry_after_seconds}s` : ''}</span><button type="button" className="icon-action" title={t('Clear cooldown')} aria-label={t('Clear cooldown') + ': ' + (model.name || model.model_id)} disabled={clearingCooldown[model.id]} onClick={() => void clearCooldown(model.id)}><RefreshCw size={13} className={clearingCooldown[model.id] ? 'import-spinner' : ''}/></button></div>}</td>
            <td><SpeedCell result={speedTests.view?.models[model.id]} running={speedTests.view?.job.running === true && speedTests.view.job.current_models.includes(model.id)}/></td>
            <td><code className="provider-table-url">{(model.input_price_known ?? model.input_cost_per_million > 0) ? `$${model.input_cost_per_million}` : t('Unknown')} / {(model.output_price_known ?? model.output_cost_per_million > 0) ? `$${model.output_cost_per_million}` : t('Unknown')}</code></td>
            <td><div className="model-info-cell"><span className={model.supports_vision ? 'model-image-supported' : 'model-image-unsupported'} role="img" aria-label={t(model.supports_vision ? 'Supports image input' : 'Image input not marked as supported')} title={t(model.supports_vision ? 'Supports image input' : 'Image input not marked as supported')}>{model.supports_vision ? <ImageIcon size={16} aria-hidden="true"/> : <ImageOff size={16} aria-hidden="true"/>}</span><span title={t('Context length (tokens)') + ': ' + (model.context_window > 0 ? model.context_window.toLocaleString() : t('Unknown'))}>{model.context_window > 0 ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(model.context_window) : '—'}</span></div></td>
            <td><div className="row-actions"><button className="icon-action" disabled={!provider || tests[model.id] === 'testing'} title={t('Test')} aria-label={t('Test')} onClick={() => void test(model)}>{tests[model.id] === 'testing' ? <LoaderCircle size={15} className="import-spinner"/> : <Play size={15}/>}</button><button className="icon-action" title={t("Configure")} aria-label={t("Configure")} onClick={() => onEdit(model)}><Settings2 size={15} /></button><button className="icon-action danger" title={t("Delete")} aria-label={t("Delete")} onClick={() => onDelete(model.id)}><Trash2 size={15} /></button></div></td>
          </tr>
        ); })}
        </tbody></table>
        {snapshot.models.length === 0 && <EmptyState icon={<Cpu />} title={t("No models in the pool")} body={t("Add at least one model before starting the proxy.")} />}
      </div>
    </div>
  );
}

function AgentsPage({ snapshot, onRefresh, onConnect, onRestore, onChange, onManageRoutes, connecting }: { connecting: boolean; onManageRoutes: () => void; onChange: (snapshot: DashboardSnapshot) => void; snapshot: DashboardSnapshot; onRefresh: () => Promise<void>; onConnect: (id: string, routeId: string, routeIds: string[]) => Promise<void>; onRestore: (id: string) => Promise<void> }) {
  const { t } = usePreferences();
  const [operationError, setOperationError] = useState<{name: string; detail: string} | null>(null);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const batchLock = useRef(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchResult, setBatchResult] = useState<{ succeeded: string[]; failed: { name: string; error: string }[] } | null>(null);
  const operate = async (id: string, name: string, work: () => Promise<void>) => {
    if (activeAgent) return;
    setActiveAgent(id); setOperationError(null);
    try { await work(); }
    catch (e) { setOperationError({name, detail: t(e instanceof Error ? e.message : String(e))}); }
    finally { setActiveAgent(null); }
  };
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    try { return parseAgentSelections(localStorage.getItem(AGENT_SELECTIONS_KEY)); }
    catch { return {}; }
  });
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [showParams, setShowParams] = useState(false);
  const [editingCustom, setEditingCustom] = useState<DashboardSnapshot['agents'][number] | undefined>();
  useEffect(() => {
    try { localStorage.setItem(AGENT_SELECTIONS_KEY, JSON.stringify(selections)); }
    catch { setError(t('Could not save model and route selections.')); }
  }, [selections, t]);
  const agents = snapshot.agents.filter(agent => agent.custom || (agent.installed && agent.can_connect !== false));
  const availableRoutes = snapshot.routes.filter(route => route.enabled && snapshot.models.some(m => ((route.strategy === 'jev' && route.all_models) || route.model_ids.includes(m.id)) && m.enabled && snapshot.providers.some(p => p.id === m.provider_id && p.enabled))).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const detect = async () => {
    setDetecting(true); setError('');
    try { await onRefresh(); } catch { setError(t('Could not detect agents. Try again.')); }
    finally { setDetecting(false); }
  };
  const availableBindings = new Set([
    ...availableRoutes.map(route => route.id),
    ...snapshot.models.filter(model => model.enabled && snapshot.providers.some(provider => provider.id === model.provider_id && provider.enabled)).map(model => 'model/' + model.id),
  ]);
  const savedSelections = (agent: DashboardSnapshot['agents'][number]) => selections[agent.id] ?? snapshot.agent_catalogs?.[agent.id]?.map(entry => entry.binding) ?? (agent.route_id ? [agent.route_id] : []);
  const batchTargets = snapshot.agents.map(agent => ({ agent, chosen: availableAgentSelections(savedSelections(agent), availableBindings) }))
    .filter(({ agent, chosen }) => agent.connected && agent.installed && agent.can_connect !== false && chosen.length > 0);
  const injectAll = async () => {
    if (batchLock.current || connecting || activeAgent || detecting || !batchTargets.length) return;
    batchLock.current = true;
    setActiveAgent('batch'); setOperationError(null); setBatchResult(null);
    const targets = batchTargets.map(({ agent, chosen }) => ({ agent, chosen: [...chosen] }));
    const result: { succeeded: string[]; failed: { name: string; error: string }[] } = { succeeded: [], failed: [] };
    setBatchProgress({ done: 0, total: targets.length });
    try {
      for (const [index, { agent, chosen }] of targets.entries()) {
        try {
          onChange(await connectAgent(agent.id, chosen[0], chosen, true));
          setSelections(previous => ({ ...previous, [agent.id]: chosen }));
          result.succeeded.push(agent.name);
        } catch (e) { result.failed.push({ name: agent.name, error: t(e instanceof Error ? e.message : String(e)) }); }
        setBatchProgress({ done: index + 1, total: targets.length });
      }
      setBatchResult(result);
    } finally { batchLock.current = false; setBatchProgress(null); setActiveAgent(null); }
  };
  return <div className="stack lg">
    {operationError && <ModelTestErrorDialog title="Agent operation failed" model={operationError.name} detail={operationError.detail} onClose={() => setOperationError(null)}/>}
    <PageIntro title={t('Agents')} body={t('Detected local agents. Select a route to connect to AutoJev.')} action={<div className="provider-actions agent-page-actions"><button className="button ghost" disabled={detecting || connecting || activeAgent !== null} onClick={() => void detect()}><RefreshCw size={16} className={detecting ? 'import-spinner' : ''}/>{t(detecting ? 'Detecting…' : 'Detect again')}</button><button className="button ghost" disabled={connecting || detecting || activeAgent !== null || !batchTargets.length} title={t('Update configurations for connected agents only. Disconnected agents remain disconnected.')} onClick={() => void injectAll()}>{batchProgress ? <LoaderCircle size={16} className="import-spinner"/> : <Plug size={16}/>} {batchProgress ? t('Updating {done}/{total}', batchProgress) : t('Batch update configurations')}</button><button className="button primary" disabled={connecting || activeAgent !== null} onClick={() => { setError(''); setEditingCustom(undefined); setAdding(true); }}><Plus size={16}/>{t('Add agent')}</button></div>} />
    <div className="agent-list-toolbar"><div><button className="text-button" onClick={onManageRoutes}><GitBranch size={16}/>{t('Manage routes')}</button>{!availableRoutes.length && <p>{t('Create a route to use multiple models, or select a model directly.')}</p>}</div><button className="text-button" onClick={() => setShowParams(true)}><Link2 size={16}/>{t('Connect other clients manually')}</button></div>
    {showParams && <ConnectionParamsDialog snapshot={snapshot} onClose={() => setShowParams(false)}/>}
    {batchResult && <div className="agent-batch-result" role="status">
      <div><strong>{t('Update complete: {success} succeeded, {failed} failed', { success: batchResult.succeeded.length, failed: batchResult.failed.length })}</strong><button className="icon-action" aria-label={t('Close')} onClick={() => setBatchResult(null)}><X size={15}/></button></div>
      {!!batchResult.succeeded.length && <p>{batchResult.succeeded.join(' · ')}<br/>{t('Restart the corresponding clients to refresh their model lists.')}</p>}
      {batchResult.failed.map(item => <p className="route-error" key={item.name}>{item.name}: {item.error}</p>)}
    </div>}
    {error && <p className="route-error" role="alert">{error}</p>}
    <div className="table-panel provider-table-panel agent-table-panel">
      <table className="provider-table agent-table">
        <thead><tr><th>{t('Agent')}</th><th>{t('Configuration file')}</th><th>{t('Status')}</th><th>{t('Model / route')}</th><th className="provider-actions-heading">{t('Actions')}</th></tr></thead>
        <tbody>{agents.map(agent => {
          let selected = agent.route_id ?? '';
          const options = [
            ...availableRoutes.map(route => ({ value: route.id, label: route.id, keywords: route.name, group: t('Routes'), icon: <GitBranch size={18}/> })),
            ...snapshot.models.filter(model => model.enabled && snapshot.providers.some(p => p.id === model.provider_id && p.enabled)).map(model => {
              const provider = snapshot.providers.find(p => p.id === model.provider_id)!;
              return { value: 'model/' + model.id, label: providerIdentifier(provider) + '/' + model.model_id, keywords: model.name + ' ' + provider.name, group: t('Models'), icon: <ProviderLogo id={providerPreset(provider)}/> };
            }).sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))
          ];
          const saved = savedSelections(agent);
          const chosen = availableAgentSelections(saved, availableBindings);
          const unavailable = saved.filter(binding => !availableBindings.has(binding));
          selected = chosen[0] ?? '';
          const allSelected = options.length > 0 && options.every(option => chosen.includes(option.value));
          const valid = options.some(option => option.value === selected) && chosen.includes(selected) && chosen.every(id => options.some(o => o.value === id));
          return <tr key={agent.id}>
            <td><div className="provider-table-name"><span className="provider-table-icon"><AgentLogo id={agent.id} icon={agent.icon}/></span><div className="agent-name-details"><strong>{agent.name}</strong><div className="agent-launch-command"><code title={[agent.command, ...(agent.args ?? [])].join(' ')}>{agent.custom ? (agent.command ?? '').split(/[\\/]/).filter(Boolean).pop() : [agent.command, ...(agent.args ?? []).map(arg => /[\s'"$`\\]/.test(arg) ? JSON.stringify(arg) : arg)].join(' ')}</code><button type="button" className="icon-action" disabled={!agent.installed || activeAgent === agent.id} title={t('Open in terminal')} aria-label={t('Open {name} in terminal', { name: agent.name })} onClick={() => void operate(agent.id, agent.name, () => launchAgent(agent.id))}>{activeAgent === agent.id ? <LoaderCircle size={15} className="import-spinner"/> : <Terminal size={15}/>}</button></div>{!agent.custom && agent.can_connect === false && <small title={agent.connection_note ? t(agent.connection_note) : undefined}>{t('Connection unavailable')}</small>}</div></div></td>
            <td><div className="agent-config-paths">{agent.config_path ? agent.config_path.split(', ').map((path, index) => <div className="agent-config-path" key={path}>
              <code className="provider-table-url" title={path}>{path}</code>
              {/\.(?:jsonc?|toml|ya?ml|env|ini|conf|cfg)$/i.test(path) && <button type="button" className="icon-action" title={t('Open configuration in text editor')} aria-label={t('Open configuration in text editor') + ': ' + path} onClick={() => { void openAgentConfig(agent.id, index).catch(e => setOperationError({ name: agent.name, detail: t(String(e)) })); }}><FilePenLine size={15}/></button>}
            </div>) : '—'}</div></td>
            <td><span className={cx('tag', agent.connected ? 'green' : 'muted')}>{t(agent.connected ? 'CONNECTED' : agent.installed ? 'Not connected' : 'NOT FOUND')}</span></td>
            <td><div className="agent-route-select"><SearchSelect value="" values={chosen} bulkActions={<><span className="search-select-total">{t('Total {count} options', { count: options.length })}</span><label className="search-select-all">
              <span className="model-selection"><input type="checkbox" autoComplete="off" autoCapitalize="none" checked={allSelected} ref={node => { if (node) node.indeterminate = chosen.length > 0 && !allSelected; }} onChange={event => {
                const next = event.target.checked ? [...chosen.filter(id => options.some(option => option.value === id)), ...options.filter(option => !chosen.includes(option.value)).map(option => option.value)] : [];
                setSelections(previous => ({ ...previous, [agent.id]: next }));
              }}/></span>{t('Select all')}
            </label></>} selectionControls={<label className="agent-default-selection">
              <span>{t('Default model / route')}</span>
              <select value={selected} disabled={!chosen.length || connecting || activeAgent !== null} onChange={event => {
                const value = event.target.value;
                if (chosen.includes(value)) setSelections(previous => ({ ...previous, [agent.id]: [value, ...chosen.filter(id => id !== value)] }));
              }}>
                {!chosen.length && <option value="">{t('Not selected')}</option>}
                {chosen.map(value => <option key={value} value={value}>{options.find(option => option.value === value)?.label ?? `${t('Unavailable selection')} · ${value}`}</option>)}
              </select>
            </label>} onChange={() => {}} onToggle={value => {
              const next = chosen.includes(value) ? chosen.filter(id => id !== value) : [...chosen, value];
              setSelections(previous => ({ ...previous, [agent.id]: next }));
            }} label={t(chosen.length ? 'Selected models / routes' : 'Not selected')} placeholder={t('Search models or routes…')} empty={t('No matching options')} disabled={connecting || activeAgent !== null || !options.length || agent.can_connect === false} options={options.map(o => o.value === chosen[0] ? { ...o, label: `${o.label} · ${t('Default model')}` } : o)}/>
              {unavailable.length > 0 && <small className="agent-selection-notice" role="status">{t('Unavailable selections excluded: {names}', { names: unavailable.map(binding => snapshot.models.find(model => 'model/' + model.id === binding)?.name ?? snapshot.routes.find(route => route.id === binding)?.name ?? snapshot.agent_catalogs?.[agent.id]?.find(entry => entry.binding === binding)?.name ?? binding).join(' · ') })}{' '}{t(chosen.length ? 'The first remaining selection is the default.' : 'Select a model or route before connecting.')}</small>}
            </div></td>
            <td><div className="row-actions">{agent.custom && <button className="icon-action" disabled={connecting || activeAgent !== null || agent.connected} title={t(agent.connected ? 'Disconnect the agent before editing its configuration' : 'Configure')} aria-label={t('Configure')} onClick={() => { setEditingCustom(agent); setAdding(true); }}><Settings2 size={15}/></button>}<button className="icon-action" disabled={connecting || activeAgent !== null} onClick={() => {
              const reason = !agent.installed ? 'Agent executable was not found. Detect again after installing it.' : agent.can_connect === false ? (agent.connection_note || 'Connection unavailable') : !selected ? 'Select a model or route before connecting.' : !valid ? 'Some selected models or routes are unavailable. Remove the unavailable selections or enable their models and providers.' : '';
              if (reason) { setOperationError({ name: agent.name, detail: t(reason) }); return; }
              void operate(agent.id, agent.name, async () => { await onConnect(agent.id, selected, chosen); setSelections(previous => ({ ...previous, [agent.id]: chosen })); });
            }} title={t(agent.connected ? 'Reconnect to AutoJev' : 'Connect to AutoJev')} aria-label={t(agent.connected ? 'Reconnect to AutoJev' : 'Connect to AutoJev')}>{activeAgent === agent.id ? <LoaderCircle size={16} className="import-spinner"/> : agent.connected ? <RefreshCw size={16}/> : <Plug size={16}/>}</button>{agent.connected && <button className="icon-action" disabled={connecting || activeAgent !== null} onClick={() => void operate(agent.id, agent.name, () => onRestore(agent.id))} title={t('Disconnect and restore original configuration')} aria-label={t('Disconnect and restore original configuration')}><Unplug size={16}/></button>}</div></td>
          </tr>;
        })}</tbody>
      </table>
      {!agents.length && <EmptyState icon={<Bot/>} title={t('No supported agents detected')} body={t('Install a supported agent and detect again, or add one manually.')} />}
    </div>
    {adding && <AddAgentDialog initial={editingCustom} onClose={() => setAdding(false)} onSaved={onChange}/>}
  </div>;
}

function AgentLogo({ id, icon }: { id: string; icon?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (icon && !failed) return <img className="agent-brand-logo" src={icon} alt="" onError={() => setFailed(true)}/>;
  if (id.startsWith('custom-') || failed) return <Bot size={20}/>;
  const extension = id === 'fastclaw' ? 'png' : id === 'hermes' ? 'webp' : 'svg';
  return <img className={cx('agent-brand-logo', id === 'kimi' && 'kimi-brand-logo', ['cursor', 'opencode', 'grok'].includes(id) && 'monochrome-logo')} src={`/icons/agents/${id}${['gemini', 'claude', 'codex', 'kimi', 'openclaw'].includes(id) ? '-color' : ''}.${extension}`} alt="" onError={() => setFailed(true)}/>;
}

function EventList({ events, detailed }: { events: DashboardSnapshot['events']; detailed?: boolean }) {
  const { t } = usePreferences();
  if (!events.length) return <EmptyState icon={<Activity />} title={t("No routes yet")} body={t("Connect an agent or use the route preview to generate the first decision.")} />;
  return <div className="event-list">{events.map((event) => <div className="event-row" key={event.id}><span className={cx('event-icon', event.source)}>{event.source === 'jev' ? <Sparkles size={15} /> : <GitBranch size={15} />}</span><div className="event-main"><strong>{event.model_name}</strong><span>{event.endpoint} · {event.provider_name}{detailed ? ` · ${event.reason}` : ''}</span></div>{detailed && <code>{event.estimated_input_tokens.toLocaleString()} tok</code>}<div className="event-cost"><strong>{money(event.estimated_cost)}</strong><span className="positive">−{money(event.estimated_savings)}</span></div><time>{timeAgo(event.created_at, t)}</time></div>)}</div>;
}

const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', kind: 'openai_compatible', url: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai_compatible', url: 'https://api.deepseek.com' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', url: 'https://openrouter.ai/api' },
  { id: 'ollama', name: 'Ollama', kind: 'ollama', url: 'http://127.0.0.1:11434' },
  { id: 'custom-openai', name: 'OpenAI Compatible', kind: 'openai_compatible', url: '' },
  { id: 'custom-anthropic', name: 'Anthropic Compatible', kind: 'openai_compatible', url: '' },
] as const;

function providerPreset(provider: Provider) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === provider.preset);
  if (preset) return preset.id;
  let host = '';
  try { host = new URL(provider.base_url).hostname; } catch { /* Use protocol fallback. */ }
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'api.openai.com') return 'openai';
  if (host === 'openrouter.ai' || provider.kind === 'openrouter') return 'openrouter';
  if (provider.kind === 'ollama') return 'ollama';
  return provider.api_type === 'messages' ? 'custom-anthropic' : 'custom-openai';
}

function ProviderLogo({ id }: { id: string }) {
  if (id.startsWith('custom-')) return <Server size={18} aria-hidden="true" />;
  return <img alt="" className={cx('provider-logo', ['openai', 'ollama'].includes(id) && 'monochrome-logo')} src={`/icons/providers/${id}${['deepseek', 'anthropic', 'openrouter'].includes(id) ? '-color' : ''}.svg`} />;
}

function normalizeApiType(value?: string) {
  return value === 'responses' || value === 'messages' ? value : 'chat_completions';
}

function ProviderDialog({ initial, onClose, onSave, onTestStatus }: { onTestStatus: (status: ProviderTestStatus) => void; initial: Provider; onClose: () => void; onSave: (p: Provider, key?: string, addTestModel?: boolean) => Promise<void> }) {
  const { t } = usePreferences();
  const edit = Boolean(initial.id);
  const inferred = PROVIDER_PRESETS.find((p) => p.id === initial.preset)?.id || PROVIDER_PRESETS.find((p) => p.url && initial.base_url.startsWith(p.url))?.id || (initial.api_type === 'messages' ? 'custom-anthropic' : 'custom-openai');
  const [provider, setProvider] = useState(() => ({ ...initial, id: initial.id || crypto.randomUUID(), name: initial.name || (inferred.startsWith('custom-') ? 'Custom' : PROVIDER_PRESETS.find((p) => p.id === inferred)?.name) || '', preset: inferred, api_type: normalizeApiType(initial.api_type), test_model: initial.test_model || '' }));
  const [identifier, setIdentifier] = useState(initial.id || (inferred.startsWith('custom-') ? 'custom' : inferred));
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [testFailed, setTestFailed] = useState(false);
  const [testedFingerprint, setTestedFingerprint] = useState('');
  const fingerprint = () => JSON.stringify([provider.base_url.trim(), provider.api_type, provider.kind, provider.test_model.trim(), apiKey]);
  const form = useRef<HTMLFormElement>(null);
  const changePreset = (id: string) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)!;
    setProvider({ ...provider, preset: preset.id, kind: preset.kind, base_url: preset.url, name: id.startsWith('custom-') ? 'Custom' : preset.name, api_type: id === 'custom-anthropic' ? 'messages' : 'chat_completions', test_model: '' });
    if (!edit) setIdentifier(id.startsWith('custom-') ? 'custom' : id);
    setTestResult('');
  };
  const draft = () => ({ ...provider, id: identifier.trim(), name: provider.name.trim() || identifier.trim() });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (testing) return;
    setTesting(true); setTestResult('');
    try { await onSave(draft(), apiKey || undefined, !edit && testedFingerprint === fingerprint()); }
    catch (error) { setTestFailed(true); setTestResult(t(String(error instanceof Error ? error.message : error))); }
    finally { setTesting(false); }
  };
  const test = async () => {
    if (testing || !form.current?.reportValidity()) return;
    if (!provider.test_model.trim()) { setTestFailed(true); setTestResult(t('Enter a test model')); onTestStatus('error'); return; }
    setTestedFingerprint(''); setTesting(true); setTestResult(''); setTestFailed(false); onTestStatus('testing');
    try { await testProviderDraft({ ...draft(), id: initial.id || draft().id }, apiKey || undefined); setTestedFingerprint(fingerprint()); if (!edit) setProvider(previous => ({ ...previous, enabled: true })); setTestResult(t('Test request succeeded.')); onTestStatus('success'); }
    catch (error) {
      setTestFailed(true);
      setTestResult(providerTestError(error, t));
      onTestStatus('error');
    }
    finally { setTesting(false); }
  };
  let base = provider.base_url.trim().replace(/\/+$/, '');
  if (!base.endsWith('/v1')) base += '/v1';
  const endpoint = `${base}/${provider.api_type === 'messages' ? 'messages' : provider.api_type === 'responses' ? 'responses' : 'chat/completions'}`;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !testing && onClose()}>
    <div className="dialog provider-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title">
      <div className="provider-dialog-header"><div><h2 id="provider-dialog-title">{t(edit ? 'Edit provider' : 'Create provider')}</h2><p>{t(edit ? 'Update provider configuration.' : 'Add a new upstream API provider.')}</p></div><button type="button" className="icon-action" disabled={testing} onClick={onClose} aria-label={t('Close')}><X size={20} /></button></div>
      <form autoComplete="off" ref={form} onSubmit={submit} className="provider-dialog-form">
        <fieldset disabled={testing}>
          <div className="field-pair">
            <div className="form-field"><span>{t('Provider type')}</span><SearchSelect value={provider.preset} disabled={testing} label={t('Provider type')} placeholder={t('Search providers…')} empty={t('No providers found')} onChange={changePreset} options={[...PROVIDER_PRESETS.filter((p) => !p.id.startsWith('custom-')).sort((a, b) => a.name.localeCompare(b.name, 'en')), ...PROVIDER_PRESETS.filter((p) => p.id.startsWith('custom-'))].map((p) => ({ value: p.id, label: t(p.name), icon: <ProviderLogo id={p.id} />, group: p.id.startsWith('custom-') ? t('Custom') : t('Recommended'), keywords: `${p.name} ${p.id} ${p.url}` }))} /></div>
            <label className="form-field"><span>{t('API type')}</span><Select searchable={false} value={provider.api_type} onChange={(e) => { setProvider({ ...provider, api_type: e.target.value }); setTestResult(''); }}><option value="chat_completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="messages">Anthropic Messages</option></Select></label>
          </div>
          <div className="field-pair">
            <label className="form-field"><span>{t('Provider name')}</span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required pattern="[a-zA-Z0-9_-]+" value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></label>
            <label className="form-field"><span>{t('Display name')} <small>{t('(optional)')}</small></span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={provider.name} placeholder={identifier} onChange={(e) => setProvider({ ...provider, name: e.target.value })} /></label>
          </div>
          <label className="form-field"><span>{t('Base URL')}</span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required type="url" value={provider.base_url} placeholder="https://api.example.com/v1" onChange={(e) => setProvider({ ...provider, base_url: e.target.value })} /></label>
          <label className="form-field"><span>{t('API key')}</span><div className="secret-input"><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={apiKey} type={showKey ? 'text' : 'password'} placeholder={provider.has_api_key ? t('Leave blank to keep the stored credential.') : provider.kind === 'ollama' ? t('No API key required') : 'sk-…'} onChange={(e) => setApiKey(e.target.value)} /><button type="button" aria-label={t('API key')} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
          <div className="form-field"><label htmlFor="provider-test-model">{t('Test model')}</label><div className="provider-test-fields"><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} id="provider-test-model" value={provider.test_model} placeholder={t('Enter a model ID')} onChange={(e) => setProvider({ ...provider, test_model: e.target.value })} /><Select searchable={false} aria-label={t('Test type')} value="text" onChange={() => {}}><option value="text">{t('Text generation')}</option></Select></div><p className="provider-test-help">{t('Send a minimal text request using the selected API format to verify the URL and credential. Upstream usage charges may apply.')}</p><p className="provider-test-endpoint">{t('Test endpoint')}: <code>{endpoint}</code></p></div>
        </fieldset>
        {testResult && <p className={cx('provider-test-result', testFailed && 'error')} role="status">{testResult}</p>}
        <div className="provider-dialog-actions"><button type="button" className="button ghost" disabled={testing} onClick={() => void test()}>{testing ? <LoaderCircle size={16} className="import-spinner" /> : <Play size={16} />}{t(testing ? 'Testing…' : 'Test')}</button><button className="button primary" type="submit" disabled={testing}>{t('Save provider')}</button></div>
      </form>
    </div>
  </div>;
}

function ModelDialog({ initial, providers, onClose, onSave, onTestStatus }: { onTestStatus: (id: string, status: ProviderTestStatus) => void; initial: Model; providers: Provider[]; onClose: () => void; onSave: (m: Model) => Promise<void> }) {
  const { t } = usePreferences();
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const initialProvider = enabledProviders.find((p) => p.id === initial.provider_id);
  const [model, setModel] = useState({ ...initial, provider_id: initialProvider?.id ?? '', api_type: normalizeApiType(initial.api_type || initialProvider?.api_type), cache_cost_per_million: initial.cache_cost_per_million ?? 0 });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState('');
  const [failed, setFailed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const edit = Boolean(initial.id);
  const provider = enabledProviders.find((p) => p.id === model.provider_id);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (testing || saving || !provider) return;
    setSaving(true); setResult('');
    try { await onSave({ ...model, id: model.id || crypto.randomUUID(), model_id: model.model_id.trim(), name: model.name.trim() || model.model_id.trim() }); }
    catch (error) { setFailed(true); setResult(providerTestError(error, t)); }
    finally { setSaving(false); }
  };
  const test = async () => {
    if (testing || !form.current?.reportValidity() || !provider) return;
    setTesting(true); setResult(''); setFailed(false); onTestStatus(provider.id, 'testing');
    try {
      await testProviderDraft({ ...provider, api_type: model.api_type, test_model: model.model_id.trim() });
      setResult(t('Test request succeeded.')); onTestStatus(provider.id, 'success');
    } catch (error) { setFailed(true); setResult(providerTestError(error, t)); onTestStatus(provider.id, 'error'); }
    finally { setTesting(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !testing && !saving) onClose(); }}>
    <div className="dialog provider-dialog" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
      <div className="provider-dialog-header"><div><h2 id="model-dialog-title">{t(edit ? 'Configure model' : 'Add model')}</h2><p>{t('Configure a model and test it with the provider’s saved API key.')}</p></div><button type="button" className="icon-action" disabled={testing || saving} onClick={onClose} aria-label={t('Close')}><X size={20} /></button></div>
      <form autoComplete="off" ref={form} className="provider-dialog-form" onSubmit={submit} onChange={() => setResult('')}>
        {!enabledProviders.length && <p className="provider-test-help">{t('Enable a provider before adding a model.')}</p>}
        <fieldset disabled={testing || saving}>
          <div className="field-pair">
            <div className="form-field"><span>{t('Provider')}</span><Select required aria-label={t('Provider')} renderIcon={(id) => { const selected = enabledProviders.find((p) => p.id === id); return selected ? <ProviderLogo id={providerPreset(selected)} /> : null; }} value={provider?.id ?? ''} onChange={(event) => {
              const next = enabledProviders.find((p) => p.id === event.target.value);
              setModel({ ...model, provider_id: event.target.value, api_type: normalizeApiType(next?.api_type) }); setResult('');
            }}><option value="">{t('Select provider')}</option>{enabledProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
            <div className="form-field"><span>{t('API type')}</span><Select searchable={false} aria-label={t('API type')} value={model.api_type} onChange={(event) => { setModel({ ...model, api_type: event.target.value }); setResult(''); }}><option value="chat_completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="messages">Anthropic Messages</option></Select></div>
          </div>
          <div className="field-pair">
            <label className="form-field"><span>{t('Provider model ID')}</span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required value={model.model_id} placeholder={t('Enter a model ID')} onChange={(event) => setModel({ ...model, model_id: event.target.value })} /></label>
            <label className="form-field"><span>{t('Display name')} <small>{t('(optional)')}</small></span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={model.name} placeholder={model.model_id || t('Display name')} onChange={(event) => setModel({ ...model, name: event.target.value })} /></label>
          </div>
          <div className="model-cost-fields">
            <label className="form-field"><span>{t('Input cost')}</span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type="number" min="0" step="any" placeholder={t('Unknown')} value={(model.input_price_known ?? (model.input_cost_per_million ?? 0) > 0) ? model.input_cost_per_million : ''} onChange={(event) => setModel({ ...model, input_price_known: event.target.value !== '', input_cost_per_million: Number(event.target.value) })} /></label>
            <label className="form-field"><span>{t('Output cost')}</span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type="number" min="0" step="any" placeholder={t('Unknown')} value={(model.output_price_known ?? (model.output_cost_per_million ?? 0) > 0) ? model.output_cost_per_million : ''} onChange={(event) => setModel({ ...model, output_price_known: event.target.value !== '', output_cost_per_million: Number(event.target.value) })} /></label>
            <label className="form-field"><span>{t('Cache cost')}</span><input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type="number" min="0" step="any" placeholder={t('Unknown')} value={(model.cache_price_known ?? (model.cache_cost_per_million ?? 0) > 0) ? model.cache_cost_per_million : ''} onChange={(event) => setModel({ ...model, cache_price_known: event.target.value !== '', cache_cost_per_million: Number(event.target.value) })} /></label>
          </div>
          <p className="provider-test-help">{t('Prices in USD per 1M tokens. Cache cost is the cached input price.')} {t('Leave pricing blank if unknown; enter 0 only for a confirmed free rate.')}</p>
          <div className="field-pair model-capability-fields">
            <div className="form-field"><label className="model-image-label" htmlFor="model-image-input">{t('Image input')}</label><div className="model-image-control"><input id="model-image-input" autoComplete="off" autoCapitalize="none" type="checkbox" checked={model.supports_vision} onChange={event => setModel({ ...model, supports_vision: event.target.checked })}/></div></div>
            <label className="form-field"><span>{t('Context length (tokens)')}</span><input autoComplete="off" autoCapitalize="none" type="number" min="1" max="9007199254740991" step="1" placeholder={t('Unknown')} value={model.context_window || ''} onChange={event => setModel({ ...model, context_window: event.target.value === '' ? 0 : Number(event.target.value) })}/></label>
          </div>
          <p className="provider-test-help">{t('Image requests only use models marked as supporting image input. Context length is informational only.')}</p>
          <p className="provider-test-help">{t('Testing sends a minimal text request using the saved API key. Upstream usage charges may apply.')}</p>
        </fieldset>
        {result && <p className={cx('provider-test-result', failed && 'error')} role="status">{result}</p>}
        <div className="provider-dialog-actions"><button type="button" className="button ghost" disabled={testing || saving || !provider} onClick={() => void test()}>{testing ? <LoaderCircle size={16} className="import-spinner" /> : <Play size={16} />}{t(testing ? 'Testing…' : 'Test')}</button><button type="submit" className="button primary" disabled={testing || saving || !provider}><Save size={15} />{t('Save model')}</button></div>
      </form>
    </div>
  </div>;
}

function Toggle({ checked, onChange, title, body }: { checked: boolean; onChange: (v: boolean) => void; title: string; body: string }) {
  return <label className="toggle-row"><button type="button" role="switch" aria-checked={checked} className={cx('switch', checked && 'on')} onClick={() => onChange(!checked)}><span /></button><span><strong>{title}</strong><small>{body}</small></span></label>;
}

function PanelHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="panel-head"><div><span>{eyebrow}</span><h3>{title}</h3></div>{action}</div>;
}

function PageIntro({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return <section className="page-intro"><div><h2>{title}</h2><p>{body}</p></div>{action}</section>;
}

function FieldLabel({ label, help }: { label: string; help?: string }) {
  return <label className="field-label"><span>{label}</span>{help && <small>{help}</small>}</label>;
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{body}</p></div>;
}
