import { createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import {
  handleOAuthRequest, hasScope, READ_SCOPE, readPrincipal, verifyAccessIdentity, WRITE_SCOPE,
  type AuthEnv, type Principal,
} from '../src/auth';

const ORIGIN = 'https://food.example.com';
const ISSUER = 'https://household.cloudflareaccess.com';
const AUDIENCE = 'a'.repeat(64);
const CALLBACK = 'https://chatgpt.com/connector_platform/oauth/callback';
let privateKey: CryptoKey;
let key: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  key = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] });
});

/** Isolated storage for OAuth protocol tests; no production data or credentials. */
class TestKv {
  private values = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();
  async get(name: string, options?: { type?: string } | string): Promise<unknown> {
    const item = this.values.get(name);
    if (!item || (item.expiration && item.expiration <= Date.now() / 1000)) return null;
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(item.value) : item.value;
  }
  async put(name: string, value: string, options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
    this.values.set(name, { value, expiration: options?.expiration ?? (options?.expirationTtl ? Date.now() / 1000 + options.expirationTtl : undefined), metadata: options?.metadata });
  }
  async delete(name: string) { this.values.delete(name); }
  async list(options?: { prefix?: string }) {
    return { keys: [...this.values].filter(([name]) => name.startsWith(options?.prefix ?? '')).map(([name, item]) => ({ name, expiration: item.expiration, metadata: item.metadata })), list_complete: true, cacheStatus: null };
  }
}

function environment(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return { PUBLIC_ORIGIN: ORIGIN, ACCESS_TEAM_DOMAIN: ISSUER, ACCESS_AUD: AUDIENCE,
    ALLOWED_EMAILS: 'alice@example.com,bob@example.com', OAUTH_KV: new TestKv() as unknown as KVNamespace, ...overrides };
}

async function accessToken(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ISSUER, aud: [AUDIENCE], sub: 'alice-subject', email: 'alice@example.com', type: 'app', iat: now, exp: now + 300, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}

async function call(env: AuthEnv, path: string, options: RequestInit = {}): Promise<Response> {
  return handleOAuthRequest(new Request(new URL(path, ORIGIN), options), env, createExecutionContext(),
    (_request, principal) => Response.json({ id: principal.id, scopes: principal.scopes }), { accessKey: key });
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function startConsent(env: AuthEnv, options: { scopes?: string; claims?: Record<string, unknown>; resource?: string } = {}) {
  const registration = await call(env, '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'Test <client>', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }) });
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = 'test-pkce-verifier-that-is-long-enough-and-unpredictable-in-production';
  const token = await accessToken(options.claims);
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
    scope: options.scopes ?? `${READ_SCOPE} ${WRITE_SCOPE} offline_access`, state: 'client-state', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', resource: options.resource ?? `${ORIGIN}/mcp` });
  const response = await call(env, `/authorize?${query}`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
  const html = await response.text();
  return { response, html, clientId: client.client_id, verifier, token, handle: /name="handle" value="([^"]+)"/u.exec(html)?.[1], cookie: cookieHeader(response) };
}

async function approve(env: AuthEnv, consent: Awaited<ReturnType<typeof startConsent>>, overrides: { cookie?: string; token?: string; origin?: string; decision?: string; extra?: string } = {}) {
  return call(env, '/authorize', { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Origin: overrides.origin ?? ORIGIN,
    Cookie: overrides.cookie ?? consent.cookie, 'Cf-Access-Jwt-Assertion': overrides.token ?? consent.token,
  }, body: new URLSearchParams({ handle: consent.handle ?? '', decision: overrides.decision ?? 'approve' }).toString() + (overrides.extra ?? '') });
}

async function connect(env: AuthEnv, options: Parameters<typeof startConsent>[1] = {}, formExtra = '') {
  const consent = await startConsent(env, options);
  expect(consent.response.status).toBe(200);
  const approved = await approve(env, consent, { extra: formExtra });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get('Location')!);
  expect(location.origin).toBe(new URL(CALLBACK).origin);
  expect(location.searchParams.get('state')).toBe('client-state');
  const exchange = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: consent.clientId, code: location.searchParams.get('code')!, redirect_uri: CALLBACK, code_verifier: consent.verifier, resource: `${ORIGIN}/mcp` }) });
  expect(exchange.status).toBe(200);
  const tokens = await exchange.json() as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  return { consent, ...tokens };
}

describe('Access identity validation', () => {
  it('derives separate stable account IDs from validated issuer and subject', async () => {
    const alice = await verifyAccessIdentity(await accessToken(), environment(), key);
    const bob = await verifyAccessIdentity(await accessToken({ sub: 'bob-subject', email: 'bob@example.com' }), environment(), key);
    expect(alice.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(alice.id).not.toBe(bob.id);
    expect(alice.email).toBe('alice@example.com');
    expect((await verifyAccessIdentity(await accessToken(), environment(), key)).id).toBe(alice.id);
  });

  it.each([
    { iss: 'https://attacker.cloudflareaccess.com' }, { aud: ['b'.repeat(64)] },
    { exp: Math.floor(Date.now() / 1000) - 60 }, { nbf: Math.floor(Date.now() / 1000) + 300 },
    { iat: Math.floor(Date.now() / 1000) + 300 }, { sub: '' }, { type: 'service' },
    { email: 'outsider@example.com' }, { email: undefined }, { exp: undefined },
  ])('rejects invalid claims %j', async (claims) => {
    await expect(verifyAccessIdentity(await accessToken(claims), environment(), key)).rejects.toThrow();
  });

  it('rejects a forged signature and an unsupported algorithm', async () => {
    const parts = (await accessToken()).split('.');
    parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
    await expect(verifyAccessIdentity(parts.join('.'), environment(), key)).rejects.toThrow();
    const token = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: 'alice-subject', email: 'alice@example.com' }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
    await expect(verifyAccessIdentity(token, environment(), key)).rejects.toThrow();
  });

  it('rejects missing or wildcard allowlists and malformed authentication config', async () => {
    for (const overrides of [{ ALLOWED_EMAILS: '' }, { ALLOWED_EMAILS: '*@example.com' }, { ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: 'http://household.cloudflareaccess.com' }, { PUBLIC_ORIGIN: `${ORIGIN}/other` }]) {
      expect((await call(environment(overrides), '/mcp')).status).toBe(503);
    }
  });

  it('validates stored principal structure and current membership; narrows effective scopes', async () => {
    const env = environment();
    const alice: Principal = { ...await verifyAccessIdentity(await accessToken(), env, key), scopes: [READ_SCOPE, WRITE_SCOPE] };
    expect(hasScope(await readPrincipal(alice, env, [READ_SCOPE]), WRITE_SCOPE)).toBe(false);
    await expect(readPrincipal({ ...alice, id: 'b'.repeat(64) }, env)).rejects.toThrow();
    await expect(readPrincipal(alice, { ...env, ALLOWED_EMAILS: 'bob@example.com' })).rejects.toThrow();
  });
});

describe('OAuth and browser consent', () => {
  it('serves discovery and bearer challenges without an Access browser cookie', async () => {
    const env = environment();
    const metadata = await call(env, '/.well-known/oauth-authorization-server');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`, revocation_endpoint: `${ORIGIN}/oauth/token` });
    const response = await call(env, '/.well-known/oauth-protected-resource/mcp');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, scopes_supported: [READ_SCOPE, WRITE_SCOPE] });
    // RFC 9728 metadata is canonical to /mcp; the root identifies another resource.
    expect((await call(env, '/.well-known/oauth-protected-resource')).status).toBe(404);
    const mcp = await call(env, '/mcp', { method: 'POST' });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect((await call(env, '/authorize')).status).toBe(403);
  });

  it('escapes client data, exposes the signed-in identity, and sets safe compatible browser headers', async () => {
    const consent = await startConsent(environment());
    expect(consent.response.status).toBe(200);
    expect(consent.html).toContain('Test &#60;client&#62;');
    expect(consent.html).toContain('alice@example.com');
    expect(consent.html).toContain('chatgpt.com');
    expect(consent.response.headers.get('Referrer-Policy')).toBe('strict-origin');
    expect(consent.response.headers.get('Content-Security-Policy')).toContain("form-action 'self' https://chatgpt.com");
    expect(consent.response.headers.get('Cache-Control')).toBe('no-store');
    expect(consent.cookie).toContain('__Host-');
  });

  it('blocks missing browser binding, cross-origin posts, account switching, and handle reuse', async () => {
    const env = environment();
    const consent = await startConsent(env);
    expect((await approve(env, consent, { cookie: '' })).status).toBe(400);
    expect((await approve(env, consent, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await approve(env, consent, { token: await accessToken({ sub: 'bob-subject', email: 'bob@example.com' }) })).status).toBe(403);
    expect((await approve(env, consent)).status).toBe(302);
    expect((await approve(env, consent)).status).toBe(403);
  });

  it('allows denial without issuing an authorization code', async () => {
    const env = environment();
    const consent = await startConsent(env);
    const denied = await approve(env, consent, { decision: 'deny' });
    const location = new URL(denied.headers.get('Location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.has('code')).toBe(false);
    expect((await approve(env, consent)).status).toBe(403);
  });

  it('completes PKCE independently for both accounts', async () => {
    const env = environment();
    const alice = await connect(env);
    const bob = await connect(env, { claims: { sub: 'bob-subject', email: 'bob@example.com' } });
    const aliceResponse = await call(env, '/mcp', { headers: { Authorization: `Bearer ${alice.access_token}` } });
    const bobResponse = await call(env, '/mcp', { headers: { Authorization: `Bearer ${bob.access_token}` } });
    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);
    const aliceBody = await aliceResponse.json() as { id: string };
    const bobBody = await bobResponse.json() as { id: string };
    expect(aliceBody.id).not.toBe(bobBody.id);
  });

  it('does not issue a refresh token without offline access consent', async () => {
    const env = environment();
    const connection = await connect(env, { scopes: READ_SCOPE });
    expect(connection.access_token).toBeTruthy();
    expect(connection.refresh_token).toBeUndefined();
    const response = await call(env, '/mcp', { headers: { Authorization: `Bearer ${connection.access_token}` } });
    expect(response.status).toBe(200);
    expect((await response.json() as { scopes: string[] }).scopes).toEqual([READ_SCOPE]);
  });

  it.each([READ_SCOPE, `${READ_SCOPE} ${WRITE_SCOPE} offline_access`])('keeps the original access token valid for 365 days with scopes %s', async (scopes) => {
    const issuedAt = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt);
    try {
      const env = environment();
      const connection = await connect(env, { scopes });
      expect(connection.expires_in).toBe(31_536_000);
      for (const days of [31, 364]) {
        clock.mockReturnValue(issuedAt + days * 86_400_000);
        expect((await call(env, '/mcp', { headers: { Authorization: `Bearer ${connection.access_token}` } })).status).toBe(200);
      }
      clock.mockReturnValue(issuedAt + 365 * 86_400_000 + 1000);
      expect((await call(env, '/mcp', { headers: { Authorization: `Bearer ${connection.access_token}` } })).status).toBe(401);
    } finally { clock.mockRestore(); }
  });

  it('refreshes after a long idle period without extending the original 365-day grant', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt);
    try {
      const env = environment();
      const connection = await connect(env);
      clock.mockReturnValue(issuedAt + 364 * 86_400_000);
      const refresh = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.consent.clientId, refresh_token: connection.refresh_token }) });
      expect(refresh.status).toBe(200);
      const refreshed = await refresh.json() as { access_token: string; refresh_token: string; expires_in: number };
      expect(refreshed.expires_in).toBe(86_400);
      expect((await call(env, '/mcp', { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(200);
      clock.mockReturnValue(issuedAt + 365 * 86_400_000 + 1000);
      expect((await call(env, '/mcp', { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status).toBe(401);
      const expired = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.consent.clientId, refresh_token: refreshed.refresh_token }) });
      expect(expired.status).toBe(400);
      expect(await expired.json()).toMatchObject({ error: 'invalid_grant' });
    } finally { clock.mockRestore(); }
  });

  it('never widens read-only scopes from form input or a refresh', async () => {
    const env = environment();
    const connection = await connect(env, { scopes: `${READ_SCOPE} offline_access` },
      '&scope=nutrition%3Awrite&redirect_uri=https%3A%2F%2Fattacker.example%2Fcallback&client_id=attacker&resource=https%3A%2F%2Fattacker.example%2Fmcp');
    const response = await call(env, '/mcp', { headers: { Authorization: `Bearer ${connection.access_token}` } });
    expect((await response.json() as { scopes: string[] }).scopes).not.toContain(WRITE_SCOPE);
    const refresh = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.consent.clientId, refresh_token: connection.refresh_token, scope: READ_SCOPE }) });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as { access_token: string };
    const refreshedResponse = await call(env, '/mcp', { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
    expect((await refreshedResponse.json() as { scopes: string[] }).scopes).toEqual([READ_SCOPE]);
  });

  it('passes narrowed token scopes to tools even when the saved grant permits writing', async () => {
    const env = environment();
    const connection = await connect(env);
    const refresh = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.consent.clientId, refresh_token: connection.refresh_token, scope: READ_SCOPE }) });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as { access_token: string };
    const response = await call(env, '/mcp', { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
    expect((await response.json() as { scopes: string[] }).scopes).toEqual([READ_SCOPE]);
  });

  it('revokes a connection through the advertised token endpoint', async () => {
    const env = environment();
    const connection = await connect(env);
    const revoke = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: connection.consent.clientId, token: connection.refresh_token, token_type_hint: 'refresh_token' }) });
    expect(revoke.status).toBe(200);
    expect((await call(env, '/mcp', { headers: { Authorization: `Bearer ${connection.access_token}` } })).status).toBe(401);
  });

  it('blocks an existing access token and refresh immediately after allowlist removal', async () => {
    const env = environment();
    const connection = await connect(env);
    const removed = { ...env, ALLOWED_EMAILS: 'bob@example.com' };
    expect((await call(removed, '/mcp', { headers: { Authorization: `Bearer ${connection.access_token}` } })).status).toBe(403);
    const refresh = await call(removed, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: connection.consent.clientId, refresh_token: connection.refresh_token }) });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects the wrong resource and PKCE verifier without a usable token', async () => {
    const env = environment();
    const wrongResource = await startConsent(env, { resource: 'https://other.example/mcp' });
    expect(wrongResource.response.status).toBe(400);
    const consent = await startConsent(env);
    const approved = await approve(env, consent);
    const code = new URL(approved.headers.get('Location')!).searchParams.get('code')!;
    const exchange = await call(env, '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: consent.clientId, code, redirect_uri: CALLBACK, code_verifier: 'wrong-verifier-long-enough-to-be-valid-but-not-the-correct-one' }) });
    expect(exchange.status).toBe(400);
    expect(await exchange.json()).toMatchObject({ error: 'invalid_grant' });
  });
});
