# Working on My Food Tracker

The household application is the independent `cloudflare/` package. Root `src/`
and `public/` preserve the upstream Bun/Supabase implementation. Reuse pure
upstream helpers when appropriate, but do not introduce Supabase, Bun, analytics,
or upstream account dependencies into the Worker bundle.

The requested production origin is `https://myfood.andyguck.com`. Cloudflare
Access email PIN protects only `/authorize`. The Worker verifies the Access JWT
and issues resource-bound OAuth tokens. MCP and OAuth discovery/token/registration
endpoints must remain reachable without a browser Access cookie. Every food
operation derives the owner from verified auth and scopes every SQL operation by
that owner. Never accept an account selector from a model or browser.

Keep emails in the `ALLOWED_EMAILS` Worker secret, not public source. Keep tokens,
food records, consent URLs, and private identity claims out of logs and Git. Keep
`workers_dev` and previews disabled. Missing auth settings must fail closed.

Use Node 24.15 or newer. Run from `cloudflare/`:

```sh
npm ci
npm run check
npm run build
```

Checks run in the local Cloudflare runtime with synthetic identities and food.
They do not establish live Access login, DNS routing, ChatGPT connectivity, or
production persistence. Record those results separately. Review account
separation, OAuth grants, retries, and concurrent edits when changing boundaries.

Protect meal creation with durable idempotency receipts and preserve them after
deletion. Updates/deletes require the caller's record version. Unknown nutrient
values remain null; do not silently convert them to zero. Date grouping uses each
person's timezone. Keep requests, results, and pagination bounded.

Root upstream checks remain separate: `bun install --frozen-lockfile`,
`bun run gen:all`, `bun run format:check`, `bun run typecheck`, `bun run test`.
Never publish the upstream MCP Registry identity from this fork.
