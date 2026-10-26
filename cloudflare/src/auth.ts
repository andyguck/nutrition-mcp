import OAuthProvider, {
  AuthorizationError,
  OAuthError,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const READ_SCOPE = 'nutrition:read';
export const WRITE_SCOPE = 'nutrition:write';
export const MCP_SCOPES = [READ_SCOPE, WRITE_SCOPE, 'offline_access'] as const;
const CONNECTION_TTL_SECONDS = 365 * 24 * 60 * 60;

export interface AuthEnv {
  PUBLIC_ORIGIN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Worker secret containing comma-separated individual email addresses. */
  ALLOWED_EMAILS: string;
  OAUTH_KV: KVNamespace;
}

export interface Principal {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  scopes: string[];
}

interface AuthConfig {
  origin: string;
  issuer: string;
  audience: string;
  allowedEmails: ReadonlySet<string>;
}

/** Allows offline cryptographic tests without changing production verification. */
export interface AuthDependencies {
  accessKey?: JWTVerifyGetKey;
}

type AuthenticatedHandler = (request: Request, principal: Principal) => Response | Promise<Response>;
type HelperEnv = AuthEnv & { OAUTH_PROVIDER: OAuthHelpers };

class AuthConfigurationError extends Error {}

function emailAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u.test(value)) {
    throw new Error('Invalid identity');
  }
  return value.toLowerCase();
}

function readConfig(env: AuthEnv): AuthConfig {
  try {
    const origin = new URL(env.PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN || origin.username || origin.password) {
      throw new Error();
    }
    if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u.test(env.ACCESS_TEAM_DOMAIN) ||
        !/^[a-f0-9]{64}$/u.test(env.ACCESS_AUD) || typeof env.ALLOWED_EMAILS !== 'string') {
      throw new Error();
    }
    const entries = env.ALLOWED_EMAILS.split(',').map((entry) => emailAddress(entry.trim()));
    if (entries.length === 0 || entries.length > 20 || entries.some((entry) => entry.includes('*'))) throw new Error();
    return { origin: origin.origin, issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, allowedEmails: new Set(entries) };
  } catch {
    throw new AuthConfigurationError('Authentication is not configured.');
  }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function identityId(issuer: string, subject: string): Promise<string> {
  return digest(JSON.stringify([issuer, subject]));
}

// Public signing keys only; no tokens, identities, or user data enter this cache.
const keySets = new Map<string, JWTVerifyGetKey>();
function accessKey(issuer: string): JWTVerifyGetKey {
  let keySet = keySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    keySets.set(issuer, keySet);
  }
  return keySet;
}

/** Validates an Access application JWT, never a caller-supplied email header. */
export async function verifyAccessIdentity(token: string, env: AuthEnv, key?: JWTVerifyGetKey): Promise<Principal> {
  const config = readConfig(env);
  const { payload } = await jwtVerify(token, key ?? accessKey(config.issuer), {
    algorithms: ['RS256'],
    issuer: config.issuer,
    audience: config.audience,
    requiredClaims: ['iss', 'aud', 'sub', 'email', 'exp', 'iat', 'type'],
    clockTolerance: 5,
  });
  if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 256 ||
      typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 5) {
    throw new Error('Invalid identity');
  }
  const email = emailAddress(payload.email);
  if (!config.allowedEmails.has(email)) throw new Error('Identity is not allowed');
  return {
    id: await identityId(config.issuer, payload.sub), issuer: config.issuer,
    subject: payload.sub, email, scopes: [],
  };
}

/** Recheck saved grant identity against current configuration on every use. */
export async function readPrincipal(value: unknown, env: AuthEnv, effectiveScopes?: readonly string[]): Promise<Principal> {
  const config = readConfig(env);
  if (!value || typeof value !== 'object') throw new Error('Invalid grant');
  const props = value as Partial<Principal>;
  if (props.issuer !== config.issuer || typeof props.subject !== 'string' || !props.subject.trim() || props.subject.length > 256 ||
      !Array.isArray(props.scopes) || props.scopes.some((scope) => typeof scope !== 'string' || !MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number]))) {
    throw new Error('Invalid grant');
  }
  const email = emailAddress(props.email);
  const id = await identityId(config.issuer, props.subject);
  if (props.id !== id || !config.allowedEmails.has(email)) throw new Error('Invalid grant');
  const scopes = [...new Set(effectiveScopes ?? props.scopes)].filter((scope) => props.scopes!.includes(scope));
  return { id, issuer: config.issuer, subject: props.subject, email, scopes };
}

export function hasScope(principal: Principal, scope: typeof READ_SCOPE | typeof WRITE_SCOPE): boolean {
  return principal.scopes.includes(scope);
}

export async function tokenProps(options: TokenExchangeCallbackOptions<AuthEnv>) {
  try {
    const grantPrincipal = await readPrincipal(options.props, options.env);
    const principal = await readPrincipal(options.props, options.env, options.requestedScope);
    if (options.userId !== principal.id || options.resource !== `${readConfig(options.env).origin}/mcp`) throw new Error();
    const offlineApproved = options.scope.includes('offline_access') && grantPrincipal.scopes.includes('offline_access');
    if (options.grantType === 'refresh_token' && !offlineApproved) throw new Error();
    // Durable access requires the person's explicit offline_access consent.
    // Check the original grant, since a refresh can narrow its access token.
    return { accessTokenProps: principal, refreshTokenTTL: offlineApproved ? undefined : 0 };
  } catch {
    // invalid_grant also revokes this grant through the provider's callback handling.
    throw new OAuthError('invalid_grant', { description: 'Reconnect your food tracker account.' });
  }
}

function privateResponse(body: BodyInit | null, status = 200, headers?: HeadersInit): Response {
  const output = new Headers(headers);
  output.set('Cache-Control', 'no-store');
  output.set('Referrer-Policy', 'strict-origin');
  output.set('X-Content-Type-Options', 'nosniff');
  output.set('X-Frame-Options', 'DENY');
  return new Response(body, { status, headers: output });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function consentHtml(details: ConsentDescription, handle: string, principal: Principal): string {
  const descriptions: Record<string, string> = {
    [READ_SCOPE]: 'View your food diary, nutrition totals, and preferences.',
    [WRITE_SCOPE]: 'Add, edit, and delete entries in your food diary and update your preferences.',
    offline_access: 'Stay connected between chats until this connection expires or is revoked.',
  };
  const scopeItems = details.scope.map((scope) => `<li>${escapeHtml(descriptions[scope] ?? scope)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect My Food Tracker</title></head><body><main><h1>Connect My Food Tracker</h1><p>Signed in as <strong>${escapeHtml(principal.email)}</strong>.</p><p><strong>${escapeHtml(details.clientName)}</strong> requests access to your account.</p><p>${details.clientDomain ? `Client domain: <strong>${escapeHtml(details.clientDomain)}</strong>.` : 'This client registered itself; its name is not verified.'}</p><p>Return address: <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? '<p>This sends access to an app on this computer. Continue only if you started this connection.</p>' : ''}<ul>${scopeItems}</ul><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><button name="decision" value="approve">Connect</button> <button name="decision" value="deny">Cancel</button></form></main></body></html>`;
}

function validAuthRequest(request: AuthRequest, config: AuthConfig): boolean {
  return request.responseType === 'code' && request.codeChallengeMethod === 'S256' && !!request.codeChallenge &&
    request.scope.includes(READ_SCOPE) && request.scope.every((scope) => MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number])) &&
    request.resource === `${config.origin}/mcp`;
}

async function consentKey(handle: string): Promise<string> {
  return `nutrition:consent-user:${await digest(handle)}`;
}

async function authorize(request: Request, env: HelperEnv, dependencies: AuthDependencies): Promise<Response> {
  const config = readConfig(env);
  if (new URL(request.url).pathname !== '/authorize') return privateResponse('Not found', 404);
  if (!['GET', 'POST'].includes(request.method)) return privateResponse('Method not allowed', 405, { Allow: 'GET, POST' });
  let principal: Principal;
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new Error();
    principal = await verifyAccessIdentity(token, env, dependencies.accessKey);
  } catch {
    return privateResponse('Sign in with an allowed email to connect your food tracker.', 403);
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!validAuthRequest(authRequest, config)) return privateResponse('Supported scopes and S256 PKCE are required.', 400);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      // Bind the page to the signed-in person as well as the helper's browser cookie.
      await env.OAUTH_KV.put(await consentKey(consent.handle), principal.id, { expirationTtl: 600 });
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      const redirectOrigin = new URL(authRequest.redirectUri).origin; // exact URI already checked by the provider
      consent.headers.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`);
      return privateResponse(consentHtml(details, consent.handle, principal), 200, consent.headers);
    }
    if (request.headers.get('Origin') !== config.origin ||
        request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
      return privateResponse('Invalid consent request.', 403);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 8192) return privateResponse('Consent request is too large.', 413);
    const text = new TextDecoder().decode(bytes);
    const form = new URLSearchParams(text);
    const handle = form.get('handle');
    const decision = form.get('decision');
    if (!handle || handle.length > 512 || form.getAll('handle').length !== 1 || form.getAll('decision').length !== 1 ||
        !['approve', 'deny'].includes(decision ?? '')) return privateResponse('Invalid consent request.', 400);
    const bindingKey = await consentKey(handle);
    if (await env.OAUTH_KV.get(bindingKey) !== principal.id) return privateResponse('Consent expired or account changed. Restart the connection.', 403);
    if (decision === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      await env.OAUTH_KV.delete(bindingKey);
      return privateResponse(null, 302, denied.headers);
    }
    // No authorization parameters or scopes are accepted from the browser form.
    const approved = await oauth.approveConsent(request, handle);
    await env.OAUTH_KV.delete(bindingKey);
    if (!validAuthRequest(approved.request, config)) return privateResponse('Invalid authorization request.', 400);
    principal.scopes = approved.request.scope;
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, userId: principal.id, scope: principal.scopes,
      metadata: { application: 'my-food-tracker' }, props: principal,
    });
    approved.headers.set('Location', redirectTo);
    return privateResponse(null, 302, approved.headers);
  } catch (error) {
    if (error instanceof AuthorizationError) return privateResponse('Authorization expired or is invalid. Restart the connection.', 400);
    return privateResponse('Unable to complete authorization. Restart the connection.', 503);
  }
}

/** Access protects ONLY /authorize; all other OAuth and MCP routes use bearer OAuth. */
export async function handleOAuthRequest(
  request: Request,
  env: AuthEnv,
  ctx: ExecutionContext,
  apiHandler: AuthenticatedHandler,
  dependencies: AuthDependencies = {},
): Promise<Response> {
  let config: AuthConfig;
  try { config = readConfig(env); }
  catch { return privateResponse('Authentication is not configured.', 503); }
  if (new URL(request.url).origin !== config.origin) return privateResponse('Not found', 404);
  const provider = new OAuthProvider<AuthEnv>({
    apiRoute: '/mcp',
    apiHandler: {
      async fetch(apiRequest, apiEnv, apiCtx) {
        if (new URL(apiRequest.url).pathname !== '/mcp') return privateResponse('Not found', 404);
        let principal: Principal;
        try {
          // OAuthProvider verifies resource audience and supplies effective token scopes.
          const auth = (apiCtx as ExecutionContext & { auth?: { scope: string[] } }).auth;
          if (!auth || !Array.isArray(auth.scope)) throw new Error();
          principal = await readPrincipal(apiCtx.props, apiEnv, auth.scope);
        } catch { return privateResponse('Forbidden', 403); }
        if (!hasScope(principal, READ_SCOPE)) return privateResponse('Read scope required.', 403);
        return apiHandler(apiRequest, principal);
      },
    },
    defaultHandler: { fetch: (authRequest, authEnv) => authorize(authRequest, authEnv as HelperEnv, dependencies) },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: CONNECTION_TTL_SECONDS,
    // Grants and client registrations must not expire before the access token.
    refreshTokenTTL: CONNECTION_TTL_SECONDS,
    clientRegistrationTTL: CONNECTION_TTL_SECONDS,
    scopesSupported: [...MCP_SCOPES], requiredScopes: [...MCP_SCOPES],
    resourceMetadata: { resource: `${config.origin}/mcp`, authorization_servers: [config.origin], bearer_methods_supported: ['header'], resource_name: 'My Food Tracker' },
    tokenExchangeCallback: tokenProps,
    // Override the library's default error logger: tokens and user data never enter logs.
    onError: () => undefined,
  });
  // The provider injects helpers into env; keep that mutation request-local.
  try { return await provider.fetch(request, { ...env }, ctx); }
  catch { return privateResponse('Authentication service unavailable.', 503); }
}
