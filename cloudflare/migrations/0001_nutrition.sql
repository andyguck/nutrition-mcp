-- The Worker obtains user_id from verified authentication, never tool arguments.
-- Nutrition tables deliberately do not depend on a particular OAuth provider.
CREATE TABLE nutrition_profiles (
  user_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),
  meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast','lunch','dinner','snack')),
  logged_at TEXT NOT NULL,
  calories REAL CHECK(calories IS NULL OR calories BETWEEN 0 AND 20000),
  protein_g REAL CHECK(protein_g IS NULL OR protein_g BETWEEN 0 AND 2000),
  carbs_g REAL CHECK(carbs_g IS NULL OR carbs_g BETWEEN 0 AND 2000),
  fat_g REAL CHECK(fat_g IS NULL OR fat_g BETWEEN 0 AND 2000),
  fiber_g REAL CHECK(fiber_g IS NULL OR fiber_g BETWEEN 0 AND 2000),
  sugar_g REAL CHECK(sugar_g IS NULL OR sugar_g BETWEEN 0 AND 2000),
  added_sugar_g REAL CHECK(added_sugar_g IS NULL OR added_sugar_g BETWEEN 0 AND 2000),
  saturated_fat_g REAL CHECK(saturated_fat_g IS NULL OR saturated_fat_g BETWEEN 0 AND 2000),
  trans_fat_g REAL CHECK(trans_fat_g IS NULL OR trans_fat_g BETWEEN 0 AND 2000),
  sodium_mg REAL CHECK(sodium_mg IS NULL OR sodium_mg BETWEEN 0 AND 100000),
  caffeine_mg REAL CHECK(caffeine_mg IS NULL OR caffeine_mg BETWEEN 0 AND 10000),
  nutrition_source TEXT NOT NULL CHECK(nutrition_source IN ('estimate','label','database','unknown')),
  notes TEXT CHECK(notes IS NULL OR length(notes) <= 4000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX meals_user_time ON meals(user_id, logged_at DESC, id DESC);

-- Receipts survive meal deletion. Replaying an old request must never recreate it.
CREATE TABLE meal_operations (
  user_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  meal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, operation_key)
);

CREATE TABLE nutrition_goals (
  user_id TEXT PRIMARY KEY,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  fiber_g REAL,
  sugar_g REAL,
  added_sugar_g REAL,
  saturated_fat_g REAL,
  trans_fat_g REAL,
  sodium_mg REAL,
  caffeine_mg REAL,
  updated_at TEXT NOT NULL
);
