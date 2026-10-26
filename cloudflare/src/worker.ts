import { handleOAuthRequest, type AuthEnv } from './auth';
import { createNutritionMcpHandler } from './mcp';

export type AppEnv = Env & Pick<AuthEnv, 'ALLOWED_EMAILS'>;
const MAX_BODY_BYTES = 256 * 1024;

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  // Consent needs strict-origin so browsers submit a usable Origin header.
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Limit streamed bodies too: Content-Length alone is not an input boundary. */
async function boundedRequest(request: Request): Promise<Request | null> {
  if (!request.body) return request;
  const length = request.headers.get('Content-Length');
  if (length && Number(length) > MAX_BODY_BYTES) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new Request(request, { body });
}

const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>My Food Tracker</title></head><body><main><h1>My Food Tracker</h1><p>A private food diary connected to ChatGPT.</p><p>Add this MCP server as a ChatGPT plugin using OAuth:</p><pre>https://myfood.andyguck.com/mcp</pre><p>Sign in with your allowed email address. Each account can access only its own meals, summaries, goals, and preferences.</p><p>After connecting, try “Log my lunch” or “Show my food diary for today.” Ask for an export to retrieve your records.</p><p>Nutrition estimates come from your conversation, not a clinical measurement or a verified food database.</p></main></body></html>`;

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN) return secure(new Response('Unknown host', { status: 421 }));
      if (url.pathname === '/health' && request.method === 'GET') {
        return secure(Response.json({ ok: true, service: 'myfood-mcp' }));
      }
      if (url.pathname === '/' && request.method === 'GET') {
        return secure(new Response(LANDING, { headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        } }));
      }
      if (url.pathname === '/robots.txt' && request.method === 'GET') {
        return secure(new Response('User-agent: *\nDisallow: /\n'));
      }
      if (!['/mcp', '/authorize', '/oauth/token', '/oauth/register',
        '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname)) {
        return secure(new Response('Not found', { status: 404 }));
      }
      if (['/authorize', '/oauth/token', '/oauth/register'].includes(url.pathname)) {
        const key = request.headers.get('CF-Connecting-IP') ?? 'local';
        const result = await env.AUTH_RATE_LIMIT.limit({ key: `${url.pathname}:${key}` });
        if (!result.success) return secure(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } }));
      }
      if (url.pathname === '/mcp') {
        const origin = request.headers.get('Origin');
        if (origin && origin !== env.PUBLIC_ORIGIN) return secure(new Response('Forbidden origin', { status: 403 }));
      }
      const bounded = await boundedRequest(request);
      if (!bounded) return secure(new Response('Request is too large', { status: 413 }));
      return secure(await handleOAuthRequest(bounded, env, ctx, async (authenticated, principal) => {
        const handler = createNutritionMcpHandler(env, principal);
        return handler.fetch(authenticated);
      }));
    } catch {
      // Never log OAuth URLs, identity claims, request bodies, or food data.
      console.error(JSON.stringify({ event: 'request_failed' }));
      return secure(Response.json({ error: 'temporarily_unavailable' }, { status: 503 }));
    }
  },
} satisfies ExportedHandler<AppEnv>;
