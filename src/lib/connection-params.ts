export type ConnectionProtocol = 'openai' | 'anthropic';
export type SnippetFormat = 'env' | 'json' | 'curl';

// Placeholder keys tag requests in logs; the local gateway does not authenticate them.
// The suffix must satisfy traffic.rs: 1-80 ASCII letters, digits, '-' or '_'.
export function clientKey(name: string) {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
  return 'autojev-local-' + (id || 'byok');
}

export function connectionParams(port: number, protocol: ConnectionProtocol, model: string, client = '') {
  // Anthropic SDKs append /v1/messages themselves; OpenAI-compatible clients expect the /v1 prefix.
  const origin = `http://127.0.0.1:${port}`;
  return { baseUrl: protocol === 'openai' ? origin + '/v1' : origin, apiKey: clientKey(client), model };
}

export function connectionSnippet(port: number, protocol: ConnectionProtocol, model: string, format: SnippetFormat, client = ''): string {
  const { baseUrl, apiKey } = connectionParams(port, protocol, model, client);
  if (format === 'env') return protocol === 'openai'
    ? `OPENAI_BASE_URL=${baseUrl}\nOPENAI_API_KEY=${apiKey}`
    : `ANTHROPIC_BASE_URL=${baseUrl}\nANTHROPIC_API_KEY=${apiKey}\nANTHROPIC_MODEL=${model}`;
  if (format === 'json') return JSON.stringify({ base_url: baseUrl, api_key: apiKey, model }, null, 2);
  const body = JSON.stringify(protocol === 'openai'
    ? { model, messages: [{ role: 'user', content: 'Hello' }] }
    : { model, max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] });
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return protocol === 'openai'
    ? `curl ${baseUrl}/chat/completions \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer ${apiKey}' \\\n  -d ${quote(body)}`
    : `curl ${baseUrl}/v1/messages \\\n  -H 'Content-Type: application/json' \\\n  -H 'x-api-key: ${apiKey}' \\\n  -H 'anthropic-version: 2023-06-01' \\\n  -d ${quote(body)}`;
}
