# My Food Tracker on Cloudflare

This directory is a household-focused Workers adaptation of [Nutrition MCP](https://github.com/akutishevsky/nutrition-mcp). The deployed ChatGPT server URL is **`https://myfood.andyguck.com/mcp`**. Each person connects with their own email; the Worker scopes food operations to the authenticated account.

Public routing, OAuth discovery and Access sign-in redirects have passed live checks. Each person's first ChatGPT sign-in and authenticated acceptance checks remain to be completed; see [DEPLOYMENT.md](DEPLOYMENT.md). To connect, go directly to [Connect each ChatGPT account](#connect-each-chatgpt-account).

The deployment uses a Worker for Streamable HTTP MCP and OAuth, D1 for nutrition records, Workers KV for OAuth state, and Cloudflare Access email one-time PIN for browser sign-in. It needs no container, Supabase account, always-on computer, or OpenAI API key. The upstream Bun/Supabase application remains at the repository root; its setup instructions and hosted service are separate from this deployment.

## Scope and cost

This first version supports meal creation, editing and deletion; date/range/history queries and search; nutrition summaries and goals; profile timezone and current time; and paginated JSON export. View data by asking ChatGPT to read it. There is no separate diary dashboard or in-chat chart widget yet. The upstream USDA/barcode lookups, saved meals, water/weight/body measurements, Apple Health, CSV import, account deletion and full export ZIP are not part of this port. Nutrition values supplied by ChatGPT still need review; the server does not infer or verify them against a food database.

A Worker fits the short request/SQL workload and avoids a running container and external database. For two people, expected traffic and storage should fit the included allowances, but this is an estimate, not a measured bill:

| Service | Current allowance / baseline |
| --- | --- |
| Workers Free | 100,000 requests/day; 10 ms CPU per invocation. Verify OAuth and summary requests fit that CPU limit. |
| Workers Paid | $5 USD/month minimum **per account**, shared with its other Workers; usage above included allowances can cost more. |
| D1 Free | 5 million rows read/day, 100,000 rows written/day, 5 GB total storage. |
| Workers KV Free | 100,000 reads/day, 1,000 writes/day, 1 GB storage. OAuth setup/refresh consumes KV operations. |
| Cloudflare Access Free | Up to 50 users, enough for this two-person deployment. |

This deployment uses the account's existing **Workers Paid** subscription, confirmed in the Cloudflare dashboard. Adding this Worker did not create another $5 base subscription or change the billing plan; usage remains metered across the account. The Free allowances above are a comparison for a new account, where OAuth and summary CPU usage would need verification. Domain registration and ChatGPT access are separate. Check the account's total usage after onboarding. Pricing checked 2026-10-25: [Workers and KV](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Access plans](https://www.cloudflare.com/plans/).

## How sign-in and isolation work

1. ChatGPT discovers the OAuth server and opens `/authorize` in the user's browser.
2. Cloudflare Access sends a PIN to an approved email. The Worker verifies the Access JWT signature, issuer, application audience, expiry, subject and email allowlist.
3. The user reviews the signed-in email, client and permissions, then approves. OAuth authorization uses PKCE; `@cloudflare/workers-oauth-provider` issues the MCP tokens.
4. ChatGPT presents its OAuth bearer token to `/mcp`. The server derives the account from the verified Access issuer and subject; tools cannot select another account by supplying an email or user ID. D1 reads and writes are scoped to that account.

The same hostname serves both accounts. Each person must authorize their own connection in their own ChatGPT account. Separate browser profiles help avoid accidentally approving as the other person; always inspect the email on the consent screen. Reconnecting with the same Access identity retains the diary. Changing the Access team/identity provider or recreating an identity can change its subject and require an explicit data migration.

`ALLOWED_EMAILS` is checked on existing MCP token use and token exchange/refresh, as well as browser sign-in. To remove access, remove the email from **both** that Worker secret and the Access Allow policy. After the updated secret is active, existing bearer calls fail and refresh fails; changing only the Access policy does not revoke already-issued MCP tokens. This disables access without deleting food records. Restoring the same identity's access can restore its diary.

## Deploy

Use Node.js 24.15+. Start at the repository root, enter `cloudflare` as shown below, and run the remaining package commands there. Keep Cloudflare credentials in the host's normal Wrangler login store or secret manager. Do not paste tokens, email PINs, cookies, authorization URLs or real food records into Git, issue reports, build logs or chat.

### 1. Install and validate locally

```sh
cd cloudflare
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run check
npm run build
```

The sample allowlist contains fictional addresses. `.dev.vars` is ignored by Git. Local tests use synthetic identities and local storage; they do not establish a live Access/ChatGPT connection. `npm run build` is a deployment dry run. The production origin/authentication guards also apply in `npm run dev`: the default localhost URL does not match the configured public origin. Use the runtime tests for local authentication coverage; there is no development authentication bypass.

### 2. Configure email sign-in

In the Cloudflare account that owns `andyguck.com`:

1. Enable Zero Trust and add **One-time PIN** under **Zero Trust → Integrations → Identity providers** if it is not already enabled. New organizations do not necessarily have OTP enabled automatically. [OTP setup](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
2. Add a **self-hosted** Access application with public hostname `myfood.andyguck.com` and path **`/authorize`**. Protect that path for all HTTP methods, including the consent form's POST.
3. Add an **Allow** policy whose **Emails** selector contains only the two intended individual addresses. Use One-time PIN as the application's login method. Do not allow an entire email domain or Everyone.
4. Copy that application's **Application Audience (AUD) Tag** to `ACCESS_AUD` in `wrangler.jsonc`; set `ACCESS_TEAM_DOMAIN` to your exact `https://<team>.cloudflareaccess.com` issuer. Keep `PUBLIC_ORIGIN` equal to the final HTTPS origin without a trailing slash.

Use hostname/path protection, not **Protect this Worker** or **Protect all Workers**. Those broader settings can intercept the OAuth backchannel. Check existing wildcard/domain/account rules too. [Worker Access options](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)

| Route | Required handling |
| --- | --- |
| `/authorize` (GET and POST) | Access email login, followed by Worker JWT validation and consent. |
| `/mcp` | No Access browser challenge. Worker OAuth bearer authentication; anonymous requests return 401. |
| `/oauth/token`, `/oauth/register` | Publicly reachable OAuth protocol endpoints; their own protocol validation applies. |
| `/.well-known/oauth-authorization-server` | Public authorization-server JSON discovery; no browser login or challenge. |
| `/.well-known/oauth-protected-resource/mcp` | Public resource JSON discovery for `/mcp`; no browser login or challenge. The unscoped root metadata path returns 404 because it describes a different resource. |
| `/health`, `/` | Public health/landing information only. |

If an existing broader Access application covers this hostname, explicitly exempt only the required public routes using path-specific applications/policies, or narrow that application's coverage. Preserve `/authorize` protection. Do not add an Everyone bypass to the sign-in path. ChatGPT cannot complete Cloudflare's browser login during a server-to-server MCP or token request.

### 3. Provision storage and publish

Authenticate on the host and confirm the target account:

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create myfood-nutrition
npx wrangler kv namespace create myfood-mcp-OAUTH_KV --binding OAUTH_KV
```

Record the returned D1 `database_id` and KV `id` in the respective bindings in `wrangler.jsonc`. Preserve binding names `DB` and `OAUTH_KV`. Reuse the existing resources for subsequent deployments; creating new ones would point the service at an empty diary/token store. The custom domain in this config lets Wrangler provision the Worker hostname in the account's active zone. [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

```sh
npm run db:remote
npm run deploy
npx wrangler secret put ALLOWED_EMAILS
```

At the secret prompt, enter the two approved addresses separated by a comma. Match the Access policy. Do not place real addresses in the public config or on the shell command line. Initial deployment before the secret exists is deliberately closed: health can succeed while OAuth/MCP returns 503. A missing or malformed AUD, team domain or allowlist also prevents authentication.

Keep `workers_dev` and `preview_urls` disabled. Do not expose an alternate hostname to bypass the intended domain. Secrets and storage bindings must be configured for each separately deployed environment.

### 4. Verify the live boundary

```sh
node scripts/smoke.mjs https://myfood.andyguck.com
```

If the Access team differs from `wrangler.jsonc`'s original team, pass its HTTPS origin as a second argument. For a deliberately incomplete deployment, `node scripts/smoke.mjs --bootstrap` only checks health and fail-closed discovery/MCP behavior; it is **not** readiness acceptance.

The normal smoke check uses no credentials and writes no food data or OAuth registrations. It checks health, public discovery, an unauthenticated MCP 401 challenge, public OAuth route reachability, and Access redirects on GET/POST `/authorize`. It never follows redirects or prints response bodies, cookies, tokens or login URLs. A passing smoke check proves only those observed public boundaries.

Before real use, complete these authenticated acceptance checks in both accounts:

- Sign in by email, inspect the consent identity, connect, and read the profile/timezone.
- Log a clearly marked test meal, read it back, update it and delete it. Retry an identical create with the same idempotency key and confirm that it does not duplicate.
- Confirm the other account cannot list, search, export, update or delete that meal, even with its ID. Verify both accounts retain their own goals and timezone across reconnects.
- Check today/date queries around local midnight, a nutrition total with an unknown nutrient, pagination and export completion.
- Exercise token refresh and a read-only scope grant. Validate email removal against both an existing token and refresh, then restore only if intended.
- Confirm Worker/Access logs and exported diagnostics do not include meal contents or authentication material.

Record the deployed Worker version and the results. Local tests, a successful deploy and a health response are not proof that email delivery, ChatGPT OAuth, refresh or account isolation works in production.

## Connect each ChatGPT account

1. In your own ChatGPT account on the web, open **Plugins → + → Add custom MCP server**.
2. Name it **My Food Tracker**, enter `https://myfood.andyguck.com/mcp` as the Server URL and select **OAuth**. Use a supported automatic registration option; no manually supplied client ID or secret is needed. If the UI offers scopes, request `nutrition:read nutrition:write offline_access`.
3. Review the warning, create the plugin and install it. Complete the browser email-PIN flow and approve only when your own email appears on the consent screen.
4. Ask “Show my profile and timezone,” then complete an agreed test meal using the acceptance checks above. Repeat the setup from the other person's own ChatGPT account.

Workspace permissions or security restrictions may limit custom servers. The server supports client metadata documents and dynamic client registration. No Cloudflare API token or service token belongs in ChatGPT. [Official OpenAI setup instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server), [MCP authentication](https://developers.openai.com/plugins/build/auth).

Refresh tokens are issued only when the client requests and the user approves `offline_access`. Without it, the connection lasts for the one-hour access token and then requires authorization again. Authorization-server metadata advertises this scope; resource metadata and bearer challenges omit it, so verify that ChatGPT includes it when connecting.

Add [project-instructions.md](project-instructions.md) to a ChatGPT project's instructions if desired. Example requests:

- “Show my profile and timezone. Use America/Chicago for my diary.”
- “I ate two eggs and one slice of toast. Estimate the nutrition and let me check it before logging.”
- “Show what I logged today and the total calories and protein.”
- “Compare my logged totals with my goals for the last seven days. Mark incomplete days.”
- “Export my food tracker data, fetching every page.”

If sign-in stalls, first run the public smoke check and inspect Access path coverage. A 503 can indicate missing or malformed authentication settings or a temporary service failure; an Access HTML response on `/mcp`, discovery or `/oauth/token` indicates overly broad Access protection. If the wrong diary appears, check the signed-in email and reconnect using a separate browser profile. Never treat a failed tool call or empty result as confirmation that data was saved or deleted.

## Data operations

Exports are paginated tool results for the current account. Follow returned cursors until no next page remains; keep the saved export private. Database-level backups contain both people's records and OAuth storage contains sensitive grants: restrict operator access, keep backups outside the public repository, and use Cloudflare's documented [D1 backups/Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) procedures. Rolling back Worker code does not roll back database migrations or restore deleted records.

OAuth metadata advertises `/oauth/token` as the revocation endpoint as well as the token endpoint; there is no separate `/revoke` route. Use the client's disconnect/revoke flow where supported. Removing a local ChatGPT connection alone should not be treated as proof of server-side token revocation.

To update the service, review changes, run local checks/build, review any migration's data impact, apply required migrations, deploy and repeat the smoke/authenticated checks relevant to the change. The upstream application's privacy/terms pages and support contacts do not describe this independently hosted household deployment.
