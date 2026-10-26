#!/usr/bin/env node
// Credential-free deployment checks. Never print bodies, headers, or redirect URLs.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://myfood.andyguck.com';
const DEFAULT_ACCESS_TEAM = 'https://nameless-pond-a236.cloudflareaccess.com';
const RESOURCE_METADATA = '/.well-known/oauth-protected-resource/mcp';
const AUTH_METADATA = '/.well-known/oauth-authorization-server';
const TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 64 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function originOnly(input, accessTeam = false) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Expected an HTTPS origin.'); }
  assert(url.protocol === 'https:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash, 'Expected an HTTPS origin without credentials, path, query or fragment.');
  if (accessTeam) assert(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u.test(url.hostname), 'Expected a Cloudflare Access team origin.');
  return url.origin;
}

async function readJson(response) {
  assert(response.headers.get('Content-Type')?.includes('application/json'), 'Expected JSON; check for an intervening login page.');
  assert(response.body, 'Expected a JSON response body.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new Error('Response exceeded the smoke check size limit.');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new Error('Response was not valid JSON.'); }
  assert(data && typeof data === 'object' && !Array.isArray(data), 'Expected a JSON object.');
  return data;
}

export async function runSmoke({
  origin = DEFAULT_ORIGIN,
  accessTeam = DEFAULT_ACCESS_TEAM,
  bootstrap = false,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  origin = originOnly(origin);
  accessTeam = originOnly(accessTeam, true);
  let failures = 0;
  const request = async (path, options = {}) => {
    try {
      return await fetchImpl(new URL(path, origin), {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error('Request failed or timed out; check DNS, TLS and deployment status.');
    }
  };
  const check = async (label, fn) => {
    try { await fn(); log(`PASS ${label}`); }
    catch (error) {
      failures += 1;
      // All errors below are fixed diagnostic text, never a raw fetch/JSON error.
      log(`FAIL ${label}: ${error.message}`);
    }
  };
  const status = (response, expected) => {
    assert(response.status === expected, `Expected HTTP ${expected}; received HTTP ${response.status}.`);
  };

  await check('public health', async () => {
    const response = await request('/health');
    status(response, 200);
    const body = await readJson(response);
    assert(body.ok === true && body.service === 'myfood-mcp', 'Unexpected health response.');
  });

  if (bootstrap) {
    for (const path of [AUTH_METADATA, RESOURCE_METADATA, '/mcp']) {
      await check(`unconfigured service closes ${path}`, async () => {
        const response = await request(path);
        status(response, 503);
        await response.body?.cancel();
      });
    }
    log('Bootstrap checks do not establish authentication readiness. Run the normal check after configuration.');
    return failures === 0;
  }

  await check('public authorization-server discovery', async () => {
    const response = await request(AUTH_METADATA);
    status(response, 200);
    const body = await readJson(response);
    assert(body.issuer === origin, 'Unexpected authorization issuer.');
    assert(body.authorization_endpoint === `${origin}/authorize`, 'Unexpected authorization endpoint.');
    assert(body.token_endpoint === `${origin}/oauth/token`, 'Unexpected token endpoint.');
    assert(body.registration_endpoint === `${origin}/oauth/register`, 'Unexpected registration endpoint.');
    assert(body.revocation_endpoint === `${origin}/oauth/token`, 'Unexpected revocation endpoint.');
    assert(body.code_challenge_methods_supported?.includes('S256'), 'S256 PKCE is not advertised.');
    assert(body.scopes_supported?.includes('nutrition:read') && body.scopes_supported?.includes('nutrition:write'), 'Required nutrition scopes are missing.');
  });

  await check('public MCP resource discovery', async () => {
    const response = await request(RESOURCE_METADATA);
    status(response, 200);
    const body = await readJson(response);
    assert(body.resource === `${origin}/mcp`, 'Unexpected MCP resource audience.');
    assert(body.authorization_servers?.includes(origin), 'Expected authorization server is missing.');
  });

  await check('unscoped resource metadata returns 404', async () => {
    const response = await request('/.well-known/oauth-protected-resource');
    status(response, 404);
    await response.body?.cancel();
  });

  for (const method of ['GET', 'POST']) {
    await check(`unauthenticated MCP ${method} returns OAuth 401`, async () => {
      const response = await request('/mcp', {
        method,
        headers: { Accept: 'application/json, text/event-stream', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'myfood-public-smoke', version: '1' } } }) } : {}),
      });
      status(response, 401);
      const challenge = response.headers.get('WWW-Authenticate');
      assert(challenge?.startsWith('Bearer ') && challenge.includes(`${origin}${RESOURCE_METADATA}`), 'Missing canonical OAuth resource challenge.');
      await response.body?.cancel();
    });
  }

  for (const path of ['/oauth/token', '/oauth/register']) {
    await check(`public ${path} rejects GET without Access redirect`, async () => {
      const response = await request(path);
      status(response, 405);
      await response.body?.cancel();
    });
  }

  for (const method of ['GET', 'POST']) {
    await check(`Access protects /authorize ${method}`, async () => {
      const response = await request('/authorize', {
        method,
        headers: { Accept: 'text/html', ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: '' } : {}),
      });
      assert([302, 303, 307, 308].includes(response.status), `Expected an Access redirect; received HTTP ${response.status}.`);
      let location;
      try { location = new URL(response.headers.get('Location')); }
      catch { throw new Error('Missing or invalid Access redirect.'); }
      assert(location.origin === accessTeam && location.pathname.startsWith('/cdn-cgi/access/login'), 'Redirect did not target the expected Access team login.');
      await response.body?.cancel();
    });
  }

  log(failures === 0
    ? 'Public boundary checks passed. Email delivery, OAuth completion, refresh and account isolation still require authenticated acceptance.'
    : `${failures} public boundary check(s) failed. Authenticated readiness is not established.`);
  return failures === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/smoke.mjs [--bootstrap] [https://server-origin] [https://team.cloudflareaccess.com]');
  } else {
    const positional = args.filter((arg) => arg !== '--bootstrap');
    if (positional.length > 2 || positional.some((arg) => arg.startsWith('--'))) {
      console.error('Invalid arguments. Use --help for usage.');
      process.exitCode = 1;
    } else {
      try {
        const passed = await runSmoke({ origin: positional[0], accessTeam: positional[1], bootstrap: args.includes('--bootstrap') });
        if (!passed) process.exitCode = 1;
      } catch {
        console.error('Invalid configuration. Supply HTTPS origins without credentials, paths, queries or fragments.');
        process.exitCode = 1;
      }
    }
  }
}
