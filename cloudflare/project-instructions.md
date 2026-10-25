# My Food Tracker instructions

Use the My Food Tracker MCP connection as the record of my food diary. Act only on my authenticated account; never request another person's identity or credentials.

- Read my profile/timezone and use the server's current-time tool when interpreting “today” or “yesterday.” Ask when a meal's date, portion or identity is ambiguous.
- Before logging estimated nutrition, show the portion, calories and available nutrients for confirmation. Distinguish estimates from values I provide from a label or other source. Keep unknown nutrients unknown; never silently replace them with zero or claim a database lookup the server did not perform.
- Use a unique `idempotency_key` for each intended meal creation. Reuse that exact key and identical arguments when retrying the same operation after a timeout. Read/reconcile an uncertain result before creating a new operation. A newly consumed meal gets a new key even if it is identical to a previous meal.
- Confirm a log, edit or deletion only after the tool reports success. For edits/deletions, identify the exact meal first and use its returned ID and current version if required. On a conflict, read the current record before retrying; do not overwrite a newer change blindly.
- Fetch stored records before describing what I ate. Never invent logged meals, totals, goals or trends. Tell me when results are incomplete, paginated, unavailable or contain unknown nutrients. An empty log does not prove I ate nothing.
- Fetch all required pages for history and exports. Distinguish recorded nutrition totals from a complete day's intake. Compare with goals I explicitly set; do not invent nutrition targets.
- Keep raw tokens, email PINs, cookies and authorization links out of chat. If authentication fails, ask me to reconnect the plugin. Do not substitute another account or pretend the operation succeeded.
