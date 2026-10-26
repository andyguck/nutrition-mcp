import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport, type VersionNegotiationMode } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";
import { createNutritionMcpHandler } from "../src/mcp.js";
import { MAX_MEAL_PAGE_BYTES, NutritionStore, type Meal, type MealInput, type MealPage } from "../src/store.js";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
const NOW = Date.parse("2026-10-25T18:00:00.000Z");
const RANGE = { start_date: "2026-10-25", end_date: "2026-10-25" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});

function account(): { id: string; store: NutritionStore } {
  const id = crypto.randomUUID();
  return { id, store: new NutritionStore(env.DB, id, "America/Chicago", () => NOW) };
}

function meal(overrides: Partial<MealInput> = {}): MealInput {
  return { description: "Oatmeal (one bowl)", meal_type: "breakfast", calories: 350,
    logged_at: "2026-10-25T08:00:00-05:00", idempotency_key: crypto.randomUUID(), ...overrides };
}

describe("D1 food diary isolation and write safety", () => {
  it("isolates reads, edits, deletes, summaries, goals, profiles, and exports even with a known other-account id", async () => {
    const alice = account().store;
    const bob = account().store;
    const logged = (await alice.logMeal(meal())).meal;
    expect(await bob.getMeal(logged.id)).toBeNull();
    expect((await bob.listMeals(RANGE)).meals).toEqual([]);
    expect((await bob.listMeals({ ...RANGE, query: "Oatmeal" })).meals).toEqual([]);
    expect((await bob.getSummary(RANGE)).meal_count).toBe(0);
    expect((await bob.exportPage()).meals).toEqual([]);
    await expect(bob.updateMeal(logged.id, { description: "Changed", expected_version: 1 })).rejects.toMatchObject({ code: "not_found" });
    expect(await bob.deleteMeal(logged.id, 1)).toEqual({ deleted: false });
    expect((await alice.getMeal(logged.id))?.description).toBe("Oatmeal (one bowl)");
    await alice.setGoals({ calories: 2100 });
    await alice.setTimezone("Asia/Tokyo");
    expect(await bob.getGoals()).toBeNull();
    expect((await bob.getProfile()).timezone).toBe("America/Chicago");
    expect((await alice.exportPage()).goals?.calories).toBe(2100);
    expect((await alice.exportPage()).profile.timezone).toBe("Asia/Tokyo");
  });

  it("rejects client owner fields at the storage boundary", async () => {
    const store = account().store;
    await expect(store.logMeal({ ...meal(), ...{ user_id: "another-person" } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await store.exportPage()).meals).toEqual([]);
  });

  it("deduplicates concurrent retries including omitted logged_at, and binds the key to the payload", async () => {
    const store = account().store;
    const input = meal({ logged_at: undefined });
    const results = await Promise.all([store.logMeal(input), store.logMeal(input), store.logMeal(input)]);
    expect(new Set(results.map((result) => result.meal.id)).size).toBe(1);
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect((await store.listMeals(RANGE)).meals).toHaveLength(1);
    await expect(store.logMeal({ ...input, calories: 999 })).rejects.toMatchObject({ code: "conflict" });
    const other = account().store;
    expect((await other.logMeal({ ...input, calories: 999 })).deduplicated).toBe(false);
  });

  it("does not resurrect a deleted meal when the original operation is retried", async () => {
    const store = account().store;
    const input = meal();
    const logged = (await store.logMeal(input)).meal;
    expect(await store.deleteMeal(logged.id, logged.version)).toEqual({ deleted: true });
    expect(await store.deleteMeal(logged.id, logged.version)).toEqual({ deleted: false });
    await expect(store.logMeal(input)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.exportPage()).meals).toEqual([]);
  });

  it("requires a caller version and rejects stale edits or deletes", async () => {
    const store = account().store;
    const logged = (await store.logMeal(meal())).meal;
    const updated = await store.updateMeal(logged.id, { calories: null, notes: "new", expected_version: 1 });
    expect(updated.version).toBe(2);
    expect(updated.calories).toBeNull();
    await expect(store.updateMeal(logged.id, { calories: 200, expected_version: 1 })).rejects.toMatchObject({ code: "conflict" });
    await expect(store.deleteMeal(logged.id, 1)).rejects.toMatchObject({ code: "conflict" });
    // Runtime validation also protects non-MCP callers, not just TypeScript users.
    await expect(store.updateMeal(logged.id, JSON.parse('{"calories":200}'))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.deleteMeal(logged.id, undefined as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect((await store.getMeal(logged.id))?.notes).toBe("new");
  });

  it("rejects impossible amounts, inconsistent nutrient parts, invalid dates, and oversized ranges", async () => {
    const store = account().store;
    for (const fields of [{ calories: -1 }, { calories: Infinity }, { protein_g: 2001 }, { fat_g: 3, saturated_fat_g: 4 }, { sugar_g: 4, added_sugar_g: 5 }]) {
      await expect(store.logMeal(meal(fields))).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const logged_at of ["2026-02-30", "2026-03-08T02:30:00", "2026-12-25T00:00:00Z"]) {
      await expect(store.logMeal(meal({ logged_at }))).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(store.listMeals({ start_date: "2026-02-30", end_date: "2026-03-01" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.getSummary({ start_date: "2026-01-01", end_date: "2027-01-02" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.listMeals({ ...RANGE, limit: 101 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.setTimezone("Definitely/NotAZone")).rejects.toMatchObject({ code: "invalid_input" });
    expect((await store.exportPage()).meals).toEqual([]);
  });
});

describe("D1 dates, unknown nutrients, pagination, and exports", () => {
  it("uses exact local day boundaries across a 23-hour DST day", async () => {
    const store = account().store;
    for (const logged_at of ["2026-03-08T05:59:59Z", "2026-03-08T06:00:00Z", "2026-03-09T04:59:59Z", "2026-03-09T05:00:00Z"]) {
      await store.logMeal(meal({ logged_at }));
    }
    const page = await store.listMeals({ start_date: "2026-03-08", end_date: "2026-03-08" });
    expect(page.meals.map((entry) => entry.logged_at)).toEqual(["2026-03-09T04:59:59.000Z", "2026-03-08T06:00:00.000Z"]);
    await store.setTimezone("UTC");
    expect((await store.listMeals({ start_date: "2026-03-08", end_date: "2026-03-08" })).meals.map((entry) => entry.logged_at)).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T05:59:59.000Z"]);
  });

  it("keeps missing nutrients distinct from recorded zero and preserves partial-goal updates", async () => {
    const store = account().store;
    await store.logMeal(meal({ calories: null, protein_g: 0 }));
    await store.logMeal(meal({ calories: 100, protein_g: undefined }));
    await store.setGoals({ calories: 2000, protein_g: 120 });
    await store.setGoals({ calories: null });
    const summary = await store.getSummary(RANGE);
    expect(summary.meal_count).toBe(2);
    expect(summary.nutrients.calories).toEqual({ total: 100, recorded_meals: 1, missing_meals: 1, complete: false });
    expect(summary.nutrients.protein_g).toEqual({ total: 0, recorded_meals: 1, missing_meals: 1, complete: false });
    expect(summary.nutrients.sodium_mg).toEqual({ total: null, recorded_meals: 0, missing_meals: 2, complete: false });
    expect(summary.goals?.calories).toBeNull();
    expect(summary.goals?.protein_g).toBe(120);
  });

  it("paginates tied timestamps without duplicates, binds cursors to filters, and searches literal wildcard characters", async () => {
    const store = account().store;
    for (const description of ["Crème 🍓 100%_", "Crème 🍓 second", "Crème 🍓 third", "Other"]) await store.logMeal(meal({ description }));
    const first = await store.listMeals({ ...RANGE, query: "Crème 🍓", limit: 2 });
    expect(first.meals).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = await store.listMeals({ ...RANGE, query: "Crème 🍓", limit: 2, cursor: first.next_cursor! });
    expect(second.meals).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.meals, ...second.meals].map((entry) => entry.id)).size).toBe(3);
    expect((await store.listMeals({ ...RANGE, query: "%_" })).meals).toHaveLength(1);
    await expect(store.listMeals({ ...RANGE, query: "Other", cursor: first.next_cursor! })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.exportPage({ cursor: first.next_cursor! })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("bounds long Unicode export pages by bytes while retaining every record and isolating the other account", async () => {
    const store = account().store;
    const other = account().store;
    const allIds = new Set<string>();
    for (let i = 0; i < 12; i++) {
      allIds.add((await store.logMeal(meal({ description: "🥑".repeat(950), notes: "\u0000🍓".repeat(1300) }))).meal.id);
    }
    await other.logMeal(meal({ description: "Other person's private meal" }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const page = await store.exportPage({ limit: 100, cursor });
      expect(new TextEncoder().encode(JSON.stringify(page.meals)).byteLength).toBeLessThanOrEqual(MAX_MEAL_PAGE_BYTES);
      expect(new TextEncoder().encode(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: { data: page } })).byteLength).toBeLessThan(256 * 1024);
      seen.push(...page.meals.map((entry) => entry.id));
      cursor = page.next_cursor ?? undefined;
      pageCount++;
      expect(pageCount).toBeLessThan(20);
    } while (cursor);
    expect(pageCount).toBeGreaterThan(1);
    expect(seen).toHaveLength(12);
    expect(new Set(seen)).toEqual(allIds);
    expect((await other.exportPage()).meals).toHaveLength(1);
  });
});

async function withClient<T>(id: string, scopes: string[], mode: VersionNegotiationMode, run: (client: Client) => Promise<T>): Promise<T> {
  const handler = createNutritionMcpHandler(env, { id, scopes });
  const client = new Client({ name: "myfood-test", version: "1" }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL("https://myfood.andyguck.com/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(String(url), init)),
  });
  await client.connect(transport);
  try {
    await client.listTools();
    return await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

describe("real MCP HTTP transport against D1", () => {
  it.each(["legacy", { pin: "2026-07-28" }] as const)("logs and reads with account isolation on %j", async (mode) => {
    const { id, store } = account();
    await withClient(id, ["nutrition:read", "nutrition:write"], mode, async (client) => {
      const result = await client.callTool({ name: "log_meal", arguments: meal() });
      expect(result.isError).toBeFalsy();
      const data = (result.structuredContent as { data: { meal: Meal } }).data;
      expect(data.meal.description).toBe("Oatmeal (one bowl)");
      expect((await store.getMeal(data.meal.id))?.calories).toBe(350);
      const read = await client.callTool({ name: "get_meals_by_date", arguments: { date: "2026-10-25" } });
      expect((read.structuredContent as { data: MealPage }).data.meals).toHaveLength(1);
    });
    await withClient(account().id, ["nutrition:read"], mode, async (client) => {
      const read = await client.callTool({ name: "export_all_data", arguments: {} });
      expect((read.structuredContent as { data: MealPage }).data.meals).toEqual([]);
    });
  });

  it("does not expose write tools to a read-only grant and denies an attempted direct write", async () => {
    const { id, store } = account();
    await withClient(id, ["nutrition:read"], "legacy", async (client) => {
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name === "get_nutrition_summary")).toBe(true);
      expect(tools.some((tool) => tool.name === "log_meal")).toBe(false);
      expect(tools.some((tool) => tool.name === "delete_meal")).toBe(false);
      const attempt = await client.callTool({ name: "log_meal", arguments: meal() }).then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      if (attempt.kind === "result") expect(attempt.result.isError).toBe(true);
      else expect(attempt.error).toBeInstanceOf(Error);
      expect((await store.exportPage()).meals).toEqual([]);
    });
  });
});
