import { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { usePreferences } from '../lib/preferences-context';
import { providerIdentifier } from '../lib/provider-name';
import { connectionParams, connectionSnippet, type ConnectionProtocol, type SnippetFormat } from '../lib/connection-params';
import { SearchSelect } from './search-select';
import type { DashboardSnapshot } from '../types';

export function ConnectionParamsDialog({ snapshot, onClose }: { snapshot: DashboardSnapshot; onClose: () => void }) {
  const { t } = usePreferences();
  const models = snapshot.models.filter(m => m.enabled && snapshot.providers.some(p => p.id === m.provider_id && p.enabled));
  const options = [
    ...snapshot.routes.filter(r => r.enabled && models.some(m => (r.strategy === 'jev' && r.all_models) || r.model_ids.includes(m.id))).map(r => ({ value: 'autojev/' + r.id, label: 'autojev/' + r.id, keywords: r.name, group: t('Routes') })).sort((a, b) => a.label.localeCompare(b.label)),
    ...models.map(m => ({ value: 'autojev/model/' + m.id, label: providerIdentifier(snapshot.providers.find(p => p.id === m.provider_id)!) + '/' + m.model_id, keywords: m.name, group: t('Models') })).sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const [protocol, setProtocol] = useState<ConnectionProtocol>('openai');
  const [format, setFormat] = useState<SnippetFormat>('env');
  const [model, setModel] = useState(options[0]?.value ?? '');
  const [client, setClient] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const port = snapshot.proxy.port;
  const params = connectionParams(port, protocol, model, client);
  const snippet = connectionSnippet(port, protocol, model, format, client);
  const copy = async (key: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setError(''); window.setTimeout(() => setCopied(current => current === key ? '' : current), 1500); }
    catch { setError(t('Could not copy to the clipboard')); }
  };
  const status = snapshot.proxy.paused ? t('The gateway is paused. Requests are rejected until you resume it.') : !snapshot.proxy.running ? t('The gateway is stopped. Start it before connecting a client.') : '';
  const field = (key: string, label: string, value: string) => <div className="connection-field">
    <span>{label}</span>
    <code title={value}>{value || '—'}</code>
    <button type="button" className="icon-action" disabled={!value} aria-label={t('Copy {name}', { name: label })} onClick={() => void copy(key, value)}>{copied === key ? <Check size={15}/> : <Copy size={15}/>}</button>
  </div>;
  return <div className="modal-backdrop" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}><div className="dialog provider-dialog connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div className="provider-dialog-header"><div><h2 id="connection-title">{t('Connection parameters')}</h2><p>{t('Use these values in any client that supports a custom API endpoint (BYOK).')}</p></div><button type="button" className="icon-action" aria-label={t('Close')} autoFocus onClick={onClose}><X size={20}/></button></div>
    {status && <p className="route-error" role="status">{status}</p>}
    <div className="debug-mode-tabs" role="tablist" aria-label={t('API protocol')}>
      {(['openai', 'anthropic'] as const).map(value => <button key={value} role="tab" aria-selected={protocol === value} onClick={() => setProtocol(value)}>{value === 'openai' ? t('OpenAI compatible') : 'Anthropic'}</button>)}
    </div>
    <div className="form-field connection-model"><span>{t('Model / route')}</span><SearchSelect label={t('Select model or route')} placeholder={t('Search models or routes…')} empty={t('No matching options')} options={options} value={model} onChange={setModel}/></div>
    <label className="form-field connection-model">{t('Client name (optional)')}<input value={client} placeholder="byok" maxLength={80} spellCheck={false} autoComplete="off" autoCapitalize="none" onChange={e => setClient(e.target.value)}/></label>
    <div className="connection-fields">
      {field('base', 'Base URL', params.baseUrl)}
      {field('key', 'API Key', params.apiKey)}
      {field('model', t('Model'), params.model)}
    </div>
    <p className="add-agent-help">{t('AutoJev does not check the key. Its suffix names the client in logs and usage; letters, digits, - and _ are kept.')}{protocol === 'anthropic' && ' ' + t('Anthropic clients add /v1/messages themselves, so the base URL has no /v1.')}</p>
    <div className="connection-snippet">
      <div className="connection-snippet-head">
        <div className="debug-mode-tabs" role="tablist" aria-label={t('Format')}>
          {(['env', 'json', 'curl'] as const).map(value => <button key={value} role="tab" aria-selected={format === value} onClick={() => setFormat(value)}>{value === 'env' ? t('Environment variables') : value === 'json' ? 'JSON' : 'cURL'}</button>)}
        </div>
        <button type="button" className="button ghost small" disabled={!model} onClick={() => void copy('snippet', snippet)}>{copied === 'snippet' ? <Check size={14}/> : <Copy size={14}/>}{t(copied === 'snippet' ? 'Copied' : 'Copy')}</button>
      </div>
      <pre>{snippet}</pre>
    </div>
    {error && <p className="route-error" role="alert">{error}</p>}
  </div></div>;
}
