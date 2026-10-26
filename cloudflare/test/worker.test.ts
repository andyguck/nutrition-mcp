import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker, { type AppEnv } from '../src/worker';
import type { Meal } from '../src/store';

const origin = 'https://myfood.andyguck.com';
const issuer = 'https://nameless-pond-a236.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const configured = { ...env, ACCESS_AUD: audience, ALLOWED_EMAILS: 'alice@example.com,bob@example.com' } as AppEnv;
let signingKey: CryptoKey;

async function request(path: string, init: RequestInit = {}, configuration = configured) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`${origin}${path}`, init), configuration, context);
  await waitOnExecutionContext(context);
  return response;
}

beforeAll(async () => {
  const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
  const keys = await generateKeyPair('RS256', { extractable: true });
  signingKey = keys.privateKey;
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'worker-test', alg: 'RS256', use: 'sig' };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error('Unexpected network request in integration test');
  });
});
afterAll(() => vi.restoreAllMocks());

async function login(email: string, subject: string) {
  const registered = await request('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Household integration test', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  expect(registered.status).toBe(201);
  const client = await registered.json() as { client_id: string };
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...hashed)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const access = await new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'worker-test' })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(signingKey);
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: callback,
    scope: 'nutrition:read nutrition:write offline_access', state: crypto.randomUUID(),
    code_challenge: challenge, code_challenge_method: 'S256', resource: `${origin}/mcp` });
  const consent = await request(`/authorize?${query}`, { headers: { 'Cf-Access-Jwt-Assertion': access } });
  expect(consent.status).toBe(200);
  const cookie = consent.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  const handle = /name="handle" value="([^"]+)"/.exec(await consent.text())?.[1];
  expect(handle).toBeTruthy();
  const approved = await request('/authorize', { method: 'POST', headers: {
    'Cf-Access-Jwt-Assertion': access, Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ handle: handle!, decision: 'approve' }) });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get('Location')!).searchParams.get('code')!;
  const exchanged = await request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: callback,
      code, code_verifier: verifier, resource: `${origin}/mcp` }) });
  expect(exchanged.status).toBe(200);
  return (await exchanged.json() as { access_token: string }).access_token;
}

async function rpc(token: string, method: string, params: Record<string, unknown>) {
  const response = await request('/mcp', { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }) });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text.split('\n').find((line) => line.startsWith('data: '))!.slice(6) : text;
  return JSON.parse(json) as { result: { isError?: boolean; structuredContent: { data: { meal: Meal; meals: Meal[]; deduplicated?: boolean } }; tools?: { name: string }[] }; error?: unknown };
}

describe('Worker public boundary', () => {
  it('serves a public liveness response but no diary data', async () => {
    const response = await request('/health');
    expect(await response.json()).toEqual({ ok: true, service: 'myfood-mcp' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('/agents/private')).status).toBe(404);
    expect((await request('/api/meals')).status).toBe(404);
  });
  it('fails closed before account configuration and rejects unknown hosts', async () => {
    expect((await request('/mcp', { method: 'POST' }, { ...env, ALLOWED_EMAILS: '' })).status).toBe(503);
    const context = createExecutionContext();
    expect((await worker.fetch(new Request('https://unexpected.workers.dev/health'), configured, context)).status).toBe(421);
  });
  it('discovers OAuth without a browser login and challenges unauthenticated MCP', async () => {
    const metadata = await request('/.well-known/oauth-protected-resource/mcp');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${origin}/mcp` });
    const denied = await request('/mcp', { method: 'POST' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toContain('resource_metadata');
    expect(denied.headers.has('Location')).toBe(false);
  });
  it('rejects foreign browser origins and oversized streamed bodies', async () => {
    expect((await request('/mcp', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(300000)); controller.close(); } });
    expect((await request('/oauth/register', { method: 'POST', body })).status).toBe(413);
  });
});

it('runs two OAuth accounts through actual Worker, KV, MCP, and D1 without crossing diaries', async () => {
  const alice = await login('alice@example.com', 'alice-live-test-subject');
  const bob = await login('bob@example.com', 'bob-live-test-subject');
  const initial = await rpc(alice, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  expect(initial.error).toBeUndefined();
  const list = await rpc(alice, 'tools/list', {});
  expect(list.result.tools?.some((tool) => tool.name === 'log_meal')).toBe(true);
  const operation = { description: 'Integration fixture meal', meal_type: 'lunch', calories: 450,
    nutrition_source: 'estimate', idempotency_key: 'worker-e2e-unique-operation' };
  const logged = await rpc(alice, 'tools/call', { name: 'log_meal', arguments: operation });
  expect(logged.result.isError).not.toBe(true);
  const meal = logged.result.structuredContent.data.meal;
  const denied = await rpc(bob, 'tools/call', { name: 'get_meal', arguments: { id: meal.id } });
  expect(denied.result.isError).toBe(true);
  const bobMeals = await rpc(bob, 'tools/call', { name: 'export_all_data', arguments: {} });
  expect(bobMeals.result.structuredContent.data.meals).toEqual([]);
  const replay = await rpc(alice, 'tools/call', { name: 'log_meal', arguments: operation });
  expect(replay.result.structuredContent.data).toMatchObject({ deduplicated: true, meal: { id: meal.id } });
  const reconnect = await login('alice@example.com', 'alice-live-test-subject');
  const readAgain = await rpc(reconnect, 'tools/call', { name: 'get_meal', arguments: { id: meal.id } });
  expect(readAgain.result.structuredContent.data.meal.id).toBe(meal.id);
});
