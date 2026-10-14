import { describe, expect, it } from 'vitest';
import { clientKey, connectionParams, connectionSnippet } from './connection-params';
import { parseCurl } from './debug-curl';
describe('manual connection parameters', () => {
  it('uses the /v1 prefix only for OpenAI-compatible clients', () => {
    expect(connectionParams(9527, 'openai', 'autojev/fast').baseUrl).toBe('http://127.0.0.1:9527/v1');
    expect(connectionParams(9526, 'anthropic', 'autojev/fast').baseUrl).toBe('http://127.0.0.1:9526');
  });
  it('produces cURL commands the debug console accepts', () => {
    for (const protocol of ['openai', 'anthropic'] as const) {
      const parsed = parseCurl(connectionSnippet(9527, protocol, "autojev/it's", 'curl'), 9527);
      expect(parsed.endpoint).toBe(protocol === 'openai' ? 'chat/completions' : 'messages');
      expect(parsed.body.model).toBe("autojev/it's");
    }
  });
  it('includes the model in JSON', () => {
    expect(JSON.parse(connectionSnippet(9527, 'openai', 'autojev/model/m1', 'json'))).toEqual({ base_url: 'http://127.0.0.1:9527/v1', api_key: 'autojev-local-byok', model: 'autojev/model/m1' });
  });
  it('derives a log-safe key from the client name', () => {
    expect(clientKey('')).toBe('autojev-local-byok');
    expect(clientKey('  My Cursor! ')).toBe('autojev-local-my-cursor');
    expect(clientKey('客户端')).toBe('autojev-local-byok');
    expect(clientKey('a'.repeat(79) + ' b')).toBe('autojev-local-' + 'a'.repeat(79));
    expect(connectionSnippet(9527, 'anthropic', 'autojev/fast', 'env', 'cline')).toContain('ANTHROPIC_API_KEY=autojev-local-cline');
  });
});
