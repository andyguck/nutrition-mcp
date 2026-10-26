# Deployment record

Status as of **2026-10-26**: the Worker now issues 365-day access tokens and grants for new connections, and **all 10 public smoke checks passed after deployment**. The user reports successful ChatGPT connections on desktop and mobile web, with an unresolved reconnect loop in the Android app. This report does not establish two-account isolation or live refresh acceptance.

Target MCP endpoint: `https://myfood.andyguck.com/mcp`. Setup and operating instructions are in [README.md](README.md).

## One-year lifetime deployment, 2026-10-26

- Deployed code/configuration: [`528b32d2c50fe3dd22edce76036e52ec02f5e825`](https://github.com/andyguck/nutrition-mcp/commit/528b32d2c50fe3dd22edce76036e52ec02f5e825).
- Active Worker version: **`80e1ca6f-9d91-4520-9e69-0b0ad6dc696e`**, observed at 100% traffic after the 2026-10-26 13:42 UTC deployment.
- Access, absolute refresh-grant and new dynamic-client registration lifetimes are 365 days. Existing credentials retain their recorded expiry; reconnect to obtain a new access token. Refresh cannot extend the original grant deadline.
- Local generated types, TypeScript, all **46 Worker tests**, the bundle build, and all **2,971 upstream tests** passed. Synthetic clock tests verified original access at days 31 and 364, expiry after day 365, and late refresh capped at the remaining grant lifetime.
- Independent review reran all 28 authentication tests successfully. [Worker CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40332632604) and [upstream CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40332640394) passed on the deployed source revision.
- All 10 public smoke checks below passed against this version. No real account was reauthorized and no food records were read or written by these checks.

The registered HTTPS redirect remains unchanged. The Android handoff requires a fresh device test; the longer access lifetime does not repair initial consent or callback failures. The ten-minute consent window and 24-hour Access browser session remain separate from OAuth access-token expiry.

## Original local and CI evidence, 2026-10-25

The implementation baseline is commit [`377f33d32845fb8d6f44d1c27143728754e6dbb3`](https://github.com/andyguck/nutrition-mcp/commit/377f33d32845fb8d6f44d1c27143728754e6dbb3). The deployment operator recorded these results:

| Check | Result |
| --- | --- |
| Local Worker checks | Generated types, TypeScript checks and 43 local Cloudflare runtime tests passed. |
| Local Worker bundle | Deployment dry run passed. |
| Final activation configuration | Generated types, TypeScript checks, all 43 runtime tests and deployment dry run passed with the configured Access audience. |
| Production dependency audit | Zero reported production dependency vulnerabilities. |
| Local upstream checks | 2,971 tests passed; upstream checks remain separate from the Worker. |
| [Cloudflare Worker CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40225307636) | Passed on the exact implementation baseline above. |
| [Upstream CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40225307689) | Passed on the same baseline. |
| [Activation Worker CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40227258194) | Passed on deployed code/configuration revision `8e74a100f5e039627c29ba652912e8154240ae11`. |
| [Activation upstream CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40227258230) | Passed on the same deployed revision. |

The runtime tests use synthetic identities and food. They exercise application behavior, including ownership and OAuth boundaries, without establishing live email delivery, ChatGPT authentication or production persistence. The original deployed code/configuration was commit [`8e74a100f5e039627c29ba652912e8154240ae11`](https://github.com/andyguck/nutrition-mcp/commit/8e74a100f5e039627c29ba652912e8154240ae11), matching the initial activated Worker version below. Its storage identifiers and activation configuration passed the local and activation CI checks above.

## Original activation, 2026-10-25

- Dedicated D1 database `myfood-nutrition` was created and its initial migration applied.
- Dedicated KV namespace `myfood-mcp-OAUTH_KV` was created and bound as `OAUTH_KV`.
- Worker `myfood-mcp` was deployed to the custom domain. `workers_dev` and preview URLs remain disabled.
- The account's Workers plan page showed **Paid** as the current plan, with a $5/month baseline plus usage. This service uses that existing account subscription; no billing plan changes were made. Additional usage remains metered across the account.
- The `ALLOWED_EMAILS` Worker secret was uploaded. Its value is intentionally absent from this record.
- Initial activated Worker version: **`8d0ea629-94c5-4eee-b7c1-31d751045336`**.
- Access application **My Food Tracker authorization** was created for exactly `myfood.andyguck.com/authorize`. Its household Allow policy contains the two privately verified individual emails and requires One-time PIN. The corresponding application audience is configured in the Worker.
- The saved Access configuration uses OTP only, with instant authentication enabled and WARP authentication disabled. Its Access session is 24 hours; HttpOnly, binding and path cookies are enabled with SameSite Lax. The launcher entry is hidden and managed OAuth is disabled. Access session length is separate from the Worker's OAuth token lifetime.

The deployment operator ran:

```sh
node scripts/smoke.mjs https://myfood.andyguck.com
```

| Public observation | Result |
| --- | --- |
| `GET /health` | 200 with the expected service response. |
| `GET /.well-known/oauth-authorization-server` | 200 with expected public OAuth metadata. |
| `GET /.well-known/oauth-protected-resource/mcp` | 200 with the canonical MCP resource metadata. |
| `GET /.well-known/oauth-protected-resource` | 404, as expected for the unscoped resource path. |
| `GET /mcp` | 401 with the OAuth resource challenge. |
| `POST /mcp` | 401 with the OAuth resource challenge. |
| `GET /oauth/token` | 405 without an Access browser challenge. |
| `GET /oauth/register` | 405 without an Access browser challenge. |
| `GET /authorize` | Redirected to the expected Access team sign-in. |
| `POST /authorize` | Redirected to the expected Access team sign-in. |

These results establish the observed public routing and authentication boundaries. The smoke check used no credentials, followed no redirects, and wrote no food records or OAuth registrations. It did not test PIN delivery or complete an authenticated session.

### Earlier bootstrap evidence

Initial bootstrap deployment version was `fc29f85b-eb7f-4609-9116-36923b5a1daa`. After bootstrap setup, the operator ran `node scripts/smoke.mjs --bootstrap https://myfood.andyguck.com`; the active version at that check was not separately recorded after secret upload. Health returned 200; authorization-server discovery, canonical MCP resource discovery and `/mcp` returned 503 with authentication configuration incomplete. Those checks established fail-closed bootstrap behavior before the activation recorded above.

## Remaining live acceptance

- [x] Create the dedicated Access application and OTP policy; privately verify the two individual emails and protection of `/authorize` GET and POST.
- [x] Configure the Access audience, deploy and record the active Worker version and matching source/configuration commit.
- [x] Pass all 10 public smoke checks.
- [x] Record the activation commit's CI results separately from the initial implementation baseline.
- [ ] Connect the plugin from each person's own ChatGPT account through email PIN and consent. Verify the displayed identity and independently stored profile/timezone.
- [ ] With agreed test meals, verify create/read/update/delete, retry deduplication, reconnect persistence and export pagination in the live service.
- [ ] Verify the two real accounts cannot list, search, export, update or delete each other's test records, including attempts using the other account's record ID. Check independently stored goals and timezone.
- [ ] Verify OAuth refresh, read-only permissions and removal of an email from the Worker allowlist against an existing token and refresh. Restore access only if intended.
- [ ] Record results and clean up the agreed test records. Keep identities, food contents, tokens, cookies and authorization URLs out of this public record.

Until the authenticated gates are recorded, describe this deployment as active with public checks passed, not as verified for ChatGPT use or production account separation.
