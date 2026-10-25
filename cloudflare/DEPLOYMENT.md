# Deployment record

Status as of **2026-10-25**: the Cloudflare deployment is bootstrapped and deliberately fails closed for authentication. **It is not ready for household onboarding yet.** The Access application and authenticated ChatGPT checks below remain pending.

Target MCP endpoint: `https://myfood.andyguck.com/mcp`. Setup and operating instructions are in [README.md](README.md).

## Local and CI evidence

The implementation baseline is commit [`377f33d32845fb8d6f44d1c27143728754e6dbb3`](https://github.com/andyguck/nutrition-mcp/commit/377f33d32845fb8d6f44d1c27143728754e6dbb3). The deployment operator recorded these results:

| Check | Result |
| --- | --- |
| Local Worker checks | Generated types, TypeScript checks and 43 local Cloudflare runtime tests passed. |
| Local Worker bundle | Deployment dry run passed. |
| Production dependency audit | Zero reported production dependency vulnerabilities. |
| Local upstream checks | 2,971 tests passed; upstream checks remain separate from the Worker. |
| [Cloudflare Worker CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40225307636) | Passed on the exact implementation baseline above. |
| [Upstream CI](https://github.com/andyguck/nutrition-mcp/actions/runs/40225307689) | Passed on the same baseline. |

The runtime tests use synthetic identities and food. They exercise application behavior, including ownership and OAuth boundaries, without establishing live email delivery, ChatGPT authentication or production persistence. The later storage identifiers and deployment configuration changes are not covered by the baseline CI claim.

## Observed live bootstrap state

- Dedicated D1 database `myfood-nutrition` was created and its initial migration applied.
- Dedicated KV namespace `myfood-mcp-OAUTH_KV` was created and bound as `OAUTH_KV`.
- Worker `myfood-mcp` was deployed to the custom domain. `workers_dev` and preview URLs remain disabled.
- The account's Workers plan page showed **Paid** as the current plan, with a $5/month baseline plus usage. This service uses that existing account subscription; no billing plan changes were made. Additional usage remains metered across the account.
- The `ALLOWED_EMAILS` Worker secret was uploaded. Its value is intentionally absent from this record.
- Initial bootstrap Worker version: `fc29f85b-eb7f-4609-9116-36923b5a1daa`. This is **not a final-version attestation**; the subsequent secret upload may have created a newer version. Record the active version after activation.
- The Access application and email policy are prepared in the dashboard; creation still awaits the required browser confirmation. The application audience is not yet configured in the Worker.

The deployment operator ran:

```sh
node scripts/smoke.mjs --bootstrap https://myfood.andyguck.com
```

| Public observation | Result |
| --- | --- |
| `GET /health` | 200 with the expected service response. |
| `GET /.well-known/oauth-authorization-server` | 503, authentication configuration incomplete. |
| `GET /.well-known/oauth-protected-resource/mcp` | 503, authentication configuration incomplete. |
| `GET /mcp` | 503, authentication configuration incomplete. |

These results establish reachable health and fail-closed bootstrap behavior only. No real food records were written by this smoke check.

## Remaining live acceptance

- [ ] Confirm the dedicated Access application and email policy are created. Protect only `/authorize`, including GET and POST; verify the two intended individual emails privately.
- [ ] Set the application's audience in Worker configuration, deploy, and record the final active Worker version and corresponding source/configuration revision.
- [ ] Pass the normal public smoke check: public discovery, MCP OAuth 401, public token/registration routes, and Access redirects for both authorization methods.
- [ ] Connect the plugin from each person's own ChatGPT account through email PIN and consent. Verify the displayed identity and independently stored profile/timezone.
- [ ] With agreed test meals, verify create/read/update/delete, retry deduplication, reconnect persistence and export pagination in the live service.
- [ ] Verify the two real accounts cannot list, search, export, update or delete each other's test records, including attempts using the other account's record ID. Check independently stored goals and timezone.
- [ ] Verify OAuth refresh, read-only permissions and removal of an email from the Worker allowlist against an existing token and refresh. Restore access only if intended.
- [ ] Record results and clean up the agreed test records. Keep identities, food contents, tokens, cookies and authorization URLs out of this public record.

Until these gates are recorded, do not describe this deployment as verified for ChatGPT use or for production account separation.
