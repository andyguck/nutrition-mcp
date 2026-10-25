import { z } from "zod";
// Reuse upstream's tested DST and wall-clock handling without its storage layer.
import {
  dateInTz,
  formatLocalDateTime,
  resolveWriteLoggedAt,
  validateTz,
  zonedDayStartUtc,
  zonedNextDayStartUtc,
} from "../../src/tz.js";

export const NUTRIENTS = [
  "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g",
  "added_sugar_g", "saturated_fat_g", "trans_fat_g", "sodium_mg", "caffeine_mg",
] as const;
export type Nutrient = typeof NUTRIENTS[number];
export type Nutrients = Record<Nutrient, number | null>;
const grams = z.number().finite().min(0).max(2000).nullable().optional();
export const nutrientShape = {
  calories: z.number().finite().min(0).max(20000).nullable().optional(),
  protein_g: grams,
  carbs_g: grams,
  fat_g: grams,
  fiber_g: grams,
  sugar_g: grams,
  added_sugar_g: grams,
  saturated_fat_g: grams,
  trans_fat_g: grams,
  sodium_mg: z.number().finite().min(0).max(100000).nullable().optional(),
  caffeine_mg: z.number().finite().min(0).max(10000).nullable().optional(),
};
const mealShape = {
  description: z.string().trim().min(1).max(2000),
  meal_type: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  logged_at: z.string().min(1).max(80).optional(),
  ...nutrientShape,
  nutrition_source: z.enum(["estimate", "label", "database", "unknown"]).optional(),
  notes: z.string().max(4000).nullable().optional(),
};
export const mealInputSchema = z.object({
  ...mealShape,
  idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
}).strict();
export const mealUpdateSchema = z.object(mealShape).partial().extend({
  expected_version: z.number().int().positive(),
}).strict().refine((input) => Object.entries(input).some(([key, value]) => key !== "expected_version" && value !== undefined), {
  message: "Provide at least one meal field to update.",
});
export const goalsSchema = z.object(nutrientShape).strict().refine(
  (input) => Object.values(input).some((value) => value !== undefined),
  { message: "Provide at least one goal; use null to clear a goal." },
);
export const timezoneSchema = z.string().min(1).max(100).refine(validateTz, "Invalid IANA timezone.");
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "1900-01-01" && value <= "2100-12-31";
}, "Provide a real calendar date between 1900 and 2100.");
export const rangeSchema = z.object({ start_date: dateSchema, end_date: dateSchema }).strict().refine(
  ({ start_date, end_date }) => end_date >= start_date && (Date.parse(end_date) - Date.parse(start_date)) / 86400000 < 366,
  { message: "Date ranges must be ordered and contain at most 366 days." },
);
export const paginationShape = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
};
export const listMealsSchema = z.object({
  start_date: dateSchema,
  end_date: dateSchema,
  query: z.string().trim().min(1).max(200).optional(),
  ...paginationShape,
}).strict();
export const exportSchema = z.object(paginationShape).strict();
const idSchema = z.uuid();

export type MealInput = z.input<typeof mealInputSchema>;
export type MealUpdate = z.input<typeof mealUpdateSchema>;
export type GoalsInput = z.input<typeof goalsSchema>;
export type DateRange = z.input<typeof rangeSchema>;
export type ListMealsInput = z.input<typeof listMealsSchema>;
export type ExportInput = z.input<typeof exportSchema>;
export type Meal = Nutrients & {
  id: string;
  description: string;
  meal_type: "breakfast" | "lunch" | "dinner" | "snack";
  logged_at: string;
  nutrition_source: "estimate" | "label" | "database" | "unknown";
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};
export type Profile = { timezone: string; created_at: string; updated_at: string };
export type Goals = Nutrients & { updated_at: string };
export type MealPage = { meals: Meal[]; next_cursor: string | null; timezone: string };
export type NutrientSummary = { total: number | null; recorded_meals: number; missing_meals: number; complete: boolean };
export type Summary = DateRange & {
  timezone: string;
  meal_count: number;
  nutrients: Record<Nutrient, NutrientSummary>;
  goals: Goals | null;
};

export class StoreError extends Error {
  constructor(public readonly code: "invalid_input" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "StoreError";
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Do not echo untrusted raw inputs or include health information in errors.
    throw new StoreError("invalid_input", result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
  }
  return result.data;
}

function assertNutrients(values: Partial<Nutrients>): void {
  for (const [part, whole] of [["added_sugar_g", "sugar_g"], ["saturated_fat_g", "fat_g"], ["trans_fat_g", "fat_g"]] as const) {
    if (values[part] != null && values[whole] != null && values[part]! > values[whole]!) {
      throw new StoreError("invalid_input", `${part} cannot exceed ${whole}.`);
    }
  }
  if (values.saturated_fat_g != null && values.trans_fat_g != null && values.fat_g != null && values.saturated_fat_g + values.trans_fat_g > values.fat_g + 0.01) {
    throw new StoreError("invalid_input", "Saturated and trans fat together cannot exceed total fat.");
  }
}

function nutrientValues(input: Partial<Nutrients>): Nutrients {
  return Object.fromEntries(NUTRIENTS.map((key) => [key, input[key] ?? null])) as Nutrients;
}

const MEAL_COLUMNS = `id, description, meal_type, logged_at, ${NUTRIENTS.join(", ")}, nutrition_source, notes, version, created_at, updated_at`;
const GOAL_COLUMNS = `${NUTRIENTS.join(", ")}, updated_at`;
const cursorSchema = z.object({ v: z.literal(1), at: z.iso.datetime(), id: idSchema, filter: z.string().max(1000) }).strict();
// MCP carries data twice (text and structured content). Leave room for both,
// JSON escaping, page metadata, profile, and goals within a 256 KiB response.
export const MAX_MEAL_PAGE_BYTES = 60 * 1024;

function boundedPage(rows: Meal[], limit: number, filter: string): Pick<MealPage, "meals" | "next_cursor"> {
  let bytes = 2;
  const meals: Meal[] = [];
  for (const row of rows.slice(0, limit)) {
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (bytes + size > MAX_MEAL_PAGE_BYTES) break;
    meals.push(row);
    bytes += size;
  }
  if (rows.length && !meals.length) throw new Error("Meal exceeds response budget.");
  return { meals, next_cursor: rows.length > meals.length ? encodeCursor(meals[meals.length - 1], filter) : null };
}

function encodeCursor(meal: Meal, filter: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, at: meal.logged_at, id: meal.id, filter }));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function decodeCursor(value: string | undefined, filter: string): { at: string; id: string } | null {
  if (!value) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const decoded = cursorSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (decoded.filter !== filter) throw new Error("filter mismatch");
    return decoded;
  } catch {
    throw new StoreError("invalid_input", "Invalid cursor, or the date range, search, or timezone changed. Start a new page request.");
  }
}

async function hashPayload(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A request-bound store. The authenticated owner is never accepted in data inputs. */
export class NutritionStore {
  private readonly defaultTimezone: string;

  constructor(private readonly db: D1Database, private readonly userId: string, defaultTimezone = "America/Chicago", private readonly now: () => number = Date.now) {
    if (!userId || userId.length > 300) throw new Error("A verified principal is required.");
    this.defaultTimezone = parse(timezoneSchema, defaultTimezone);
  }

  async getProfile(): Promise<Profile> {
    const now = new Date(this.now()).toISOString();
    await this.db.prepare("INSERT INTO nutrition_profiles (user_id, timezone, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
      .bind(this.userId, this.defaultTimezone, now, now).run();
    const profile = await this.db.prepare("SELECT timezone, created_at, updated_at FROM nutrition_profiles WHERE user_id = ?")
      .bind(this.userId).first<Profile>();
    if (!profile) throw new Error("Profile storage unavailable.");
    return profile;
  }

  async setTimezone(timezone: string): Promise<Profile> {
    parse(timezoneSchema, timezone);
    const now = new Date(this.now()).toISOString();
    const profile = await this.db.prepare("INSERT INTO nutrition_profiles (user_id, timezone, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at RETURNING timezone, created_at, updated_at")
      .bind(this.userId, timezone, now, now).first<Profile>();
    if (!profile) throw new Error("Profile storage unavailable.");
    return profile;
  }

  async today(): Promise<string> {
    return dateInTz(new Date(this.now()), (await this.getProfile()).timezone);
  }

  private loggedAt(raw: string | undefined, timezone: string): string {
    if (raw === undefined) return new Date(this.now()).toISOString();
    try {
      const instant = resolveWriteLoggedAt(raw, timezone, this.now()).instant;
      // Upstream intentionally shifts a nonexistent DST wall time forward.
      // This port rejects it so a precise user-entered time never silently moves.
      const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(raw.trim());
      if (local && formatLocalDateTime(instant, timezone) !== `${local[1]} ${local[2]}:${local[3] ?? "00"}`) throw new Error("nonexistent local time");
      if (instant.getUTCFullYear() < 1900 || instant.getUTCFullYear() > 2100) throw new Error("out of range");
      return instant.toISOString();
    } catch {
      throw new StoreError("invalid_input", "logged_at must be a real past date or timestamp. Local times use your profile timezone; use an explicit UTC offset for ambiguous times.");
    }
  }

  async logMeal(raw: MealInput): Promise<{ meal: Meal; deduplicated: boolean }> {
    const input = parse(mealInputSchema, raw);
    assertNutrients(input);
    const { timezone } = await this.getProfile();
    // Hash semantic request fields in a fixed order. Omitted time remains null,
    // so a retry does not acquire a fresh key merely because time has passed.
    const payloadHash = await hashPayload({
      description: input.description,
      meal_type: input.meal_type,
      logged_at: input.logged_at ?? null,
      local_timezone: input.logged_at && !/(Z|[+-]\d{2}:?\d{2})$/.test(input.logged_at) ? timezone : null,
      ...nutrientValues(input),
      nutrition_source: input.nutrition_source ?? "unknown",
      notes: input.notes ?? null,
    });
    const receipt = await this.db.prepare("SELECT payload_hash, meal_id FROM meal_operations WHERE user_id = ? AND operation_key = ?")
      .bind(this.userId, input.idempotency_key).first<{ payload_hash: string; meal_id: string }>();
    if (receipt) return this.replayedMeal(receipt, payloadHash);

    const id = crypto.randomUUID();
    const now = new Date(this.now()).toISOString();
    const meal: Meal = {
      id, description: input.description, meal_type: input.meal_type,
      logged_at: this.loggedAt(input.logged_at, timezone), ...nutrientValues(input),
      nutrition_source: input.nutrition_source ?? "unknown", notes: input.notes ?? null,
      version: 1, created_at: now, updated_at: now,
    };
    const values = [id, meal.description, meal.meal_type, meal.logged_at, ...NUTRIENTS.map((key) => meal[key]), meal.nutrition_source, meal.notes, meal.version, now, now];
    // Both statements commit together. Only the winner of the operation key
    // can insert a meal; a concurrent retry then reads that winner's receipt.
    await this.db.batch([
      this.db.prepare("INSERT INTO meal_operations (user_id, operation_key, payload_hash, meal_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, operation_key) DO NOTHING")
        .bind(this.userId, input.idempotency_key, payloadHash, id, now),
      this.db.prepare(`INSERT INTO meals (user_id, ${MEAL_COLUMNS}) SELECT ?, ${values.map(() => "?").join(", ")} WHERE EXISTS (SELECT 1 FROM meal_operations WHERE user_id = ? AND operation_key = ? AND meal_id = ?)`)
        .bind(this.userId, ...values, this.userId, input.idempotency_key, id),
    ]);
    const stored = await this.db.prepare("SELECT payload_hash, meal_id FROM meal_operations WHERE user_id = ? AND operation_key = ?")
      .bind(this.userId, input.idempotency_key).first<{ payload_hash: string; meal_id: string }>();
    if (!stored) throw new Error("Meal receipt unavailable.");
    const result = await this.replayedMeal(stored, payloadHash);
    return { ...result, deduplicated: stored.meal_id !== id };
  }

  private async replayedMeal(receipt: { payload_hash: string; meal_id: string }, hash: string): Promise<{ meal: Meal; deduplicated: boolean }> {
    if (receipt.payload_hash !== hash) throw new StoreError("conflict", "This idempotency key was already used for different meal data. Use a new key for a new operation.");
    const meal = await this.getMeal(receipt.meal_id);
    if (!meal) throw new StoreError("conflict", "This operation previously logged a meal that was later deleted. It has not been recreated. Use a new key only if you intend to log it again.");
    return { meal, deduplicated: true };
  }

  async getMeal(id: string): Promise<Meal | null> {
    parse(idSchema, id);
    return this.db.prepare(`SELECT ${MEAL_COLUMNS} FROM meals WHERE user_id = ? AND id = ?`).bind(this.userId, id).first<Meal>();
  }

  async updateMeal(id: string, raw: MealUpdate): Promise<Meal> {
    parse(idSchema, id);
    const input = parse(mealUpdateSchema, raw);
    const existing = await this.getMeal(id);
    if (!existing) throw new StoreError("not_found", "Meal not found.");
    if (input.expected_version !== existing.version) throw new StoreError("conflict", "The meal changed. Read it again before editing.");
    const { expected_version: _version, ...fields } = input;
    const suppliedFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const updated: Meal = { ...existing, ...suppliedFields, logged_at: existing.logged_at };
    if (input.logged_at !== undefined) updated.logged_at = this.loggedAt(input.logged_at, (await this.getProfile()).timezone);
    assertNutrients(updated);
    const columns = ["description", "meal_type", "logged_at", ...NUTRIENTS, "nutrition_source", "notes"] as const;
    const meal = await this.db.prepare(`UPDATE meals SET ${columns.map((key) => `${key} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE user_id = ? AND id = ? AND version = ? RETURNING ${MEAL_COLUMNS}`)
      .bind(...columns.map((key) => updated[key]), new Date(this.now()).toISOString(), this.userId, id, existing.version).first<Meal>();
    if (!meal) throw new StoreError("conflict", "The meal changed. Read it again before editing.");
    return meal;
  }

  async deleteMeal(id: string, expectedVersion: number): Promise<{ deleted: boolean }> {
    parse(idSchema, id);
    parse(z.number().int().positive(), expectedVersion);
    const deleted = await this.db.prepare("DELETE FROM meals WHERE user_id = ? AND id = ? AND version = ? RETURNING id")
      .bind(this.userId, id, expectedVersion).first<{ id: string }>();
    if (!deleted && await this.getMeal(id)) throw new StoreError("conflict", "The meal changed. Read it again before deleting.");
    return { deleted: deleted !== null };
  }

  private async range(input: DateRange): Promise<DateRange & { timezone: string; from: string; to: string }> {
    const dates = parse(rangeSchema, input);
    const { timezone } = await this.getProfile();
    return { ...dates, timezone, from: zonedDayStartUtc(dates.start_date, timezone).toISOString(), to: zonedNextDayStartUtc(dates.end_date, timezone).toISOString() };
  }

  async listMeals(raw: ListMealsInput): Promise<MealPage & DateRange> {
    const input = parse(listMealsSchema, raw);
    const { start_date, end_date, timezone, from, to } = await this.range({ start_date: input.start_date, end_date: input.end_date });
    const filter = JSON.stringify([start_date, end_date, input.query ?? null, timezone]);
    const cursor = decodeCursor(input.cursor, filter);
    const where = ["user_id = ?", "logged_at >= ?", "logged_at < ?"];
    const bindings: (string | number)[] = [this.userId, from, to];
    if (input.query) {
      where.push("(description LIKE ? ESCAPE '\\' OR COALESCE(notes, '') LIKE ? ESCAPE '\\')");
      const pattern = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
      bindings.push(pattern, pattern);
    }
    if (cursor) {
      where.push("(logged_at < ? OR (logged_at = ? AND id < ?))");
      bindings.push(cursor.at, cursor.at, cursor.id);
    }
    const result = await this.db.prepare(`SELECT ${MEAL_COLUMNS} FROM meals WHERE ${where.join(" AND ")} ORDER BY logged_at DESC, id DESC LIMIT ?`)
      .bind(...bindings, input.limit + 1).all<Meal>();
    return { start_date, end_date, timezone, ...boundedPage(result.results, input.limit, filter) };
  }

  async getSummary(raw: DateRange): Promise<Summary> {
    const { start_date, end_date, timezone, from, to } = await this.range(raw);
    const aggregation = NUTRIENTS.map((key) => `SUM(${key}) AS ${key}, COUNT(${key}) AS ${key}_count`).join(", ");
    const row = await this.db.prepare(`SELECT COUNT(*) AS meal_count, ${aggregation} FROM meals WHERE user_id = ? AND logged_at >= ? AND logged_at < ?`)
      .bind(this.userId, from, to).first<Record<string, number | null>>();
    if (!row) throw new Error("Summary unavailable.");
    const count = row.meal_count ?? 0;
    const nutrients = Object.fromEntries(NUTRIENTS.map((key) => {
      const recorded = row[`${key}_count`] ?? 0;
      return [key, { total: row[key] == null ? null : Math.round(row[key]! * 1000) / 1000, recorded_meals: recorded, missing_meals: count - recorded, complete: count > 0 && recorded === count }];
    })) as Record<Nutrient, NutrientSummary>;
    return { start_date, end_date, timezone, meal_count: count, nutrients, goals: await this.getGoals() };
  }

  async getGoals(): Promise<Goals | null> {
    return this.db.prepare(`SELECT ${GOAL_COLUMNS} FROM nutrition_goals WHERE user_id = ?`).bind(this.userId).first<Goals>();
  }

  async setGoals(raw: GoalsInput): Promise<Goals> {
    const input = parse(goalsSchema, raw);
    // Build column names only from our closed allowlist. Unspecified goals keep
    // their values even when another request updates a different goal.
    const keys = NUTRIENTS.filter((key) => input[key] !== undefined);
    const goals = await this.db.prepare(`INSERT INTO nutrition_goals (user_id, ${keys.join(", ")}, updated_at) VALUES (?, ${keys.map(() => "?").join(", ")}, ?) ON CONFLICT(user_id) DO UPDATE SET ${keys.map((key) => `${key} = excluded.${key}`).join(", ")}, updated_at = excluded.updated_at RETURNING ${GOAL_COLUMNS}`)
      .bind(this.userId, ...keys.map((key) => input[key] ?? null), new Date(this.now()).toISOString()).first<Goals>();
    if (!goals) throw new Error("Goals storage unavailable.");
    return goals;
  }

  async exportPage(raw: ExportInput = {}): Promise<MealPage & { profile: Profile; goals: Goals | null; format_version: 1 }> {
    const input = parse(exportSchema, raw);
    const cursor = decodeCursor(input.cursor, "export-v1");
    const bindings: (string | number)[] = [this.userId];
    let where = "user_id = ?";
    if (cursor) {
      where += " AND (logged_at < ? OR (logged_at = ? AND id < ?))";
      bindings.push(cursor.at, cursor.at, cursor.id);
    }
    const result = await this.db.prepare(`SELECT ${MEAL_COLUMNS} FROM meals WHERE ${where} ORDER BY logged_at DESC, id DESC LIMIT ?`)
      .bind(...bindings, input.limit + 1).all<Meal>();
    const profile = await this.getProfile();
    return { format_version: 1, profile, goals: await this.getGoals(), timezone: profile.timezone, ...boundedPage(result.results, input.limit, "export-v1") };
  }
}
