/**
 * Domain types + table registry.
 *
 * The row shapes mirror the legacy baking app's SQLite schema exactly
 * (see legacy-baking/backend/internal/repo/repository.go) so data can be
 * imported from / exported to the original database without transformation.
 *
 * Every table additionally carries sync metadata columns (`updated_at`,
 * `deleted`) used for multi-device local-first replication. Those columns are
 * additive only: they never change the meaning of the original columns.
 */

export type Category = "dry" | "hybrid" | "liquid";

export type TableName =
  | "ingredients"
  | "flour_mixes"
  | "flour_mix_components"
  | "recipes"
  | "recipe_ingredients"
  | "recipe_mixes"
  | "recipe_main_liquids"
  | "recipe_categories";

export interface SyncMeta {
  /** epoch millis of the last write to this row on any device */
  updated_at: number;
  /** tombstone flag: deletes replicate across devices instead of vanishing */
  deleted: boolean;
  /** id of the device that produced this version (deterministic LWW tiebreak) */
  origin: string;
}

export interface IngredientRow extends SyncMeta {
  id: string;
  name: string;
  unit: string;
  created_at: string;
  price: number; // € per 1000 g
  category: Category;
  calories: number; // per 100 g
  protein: number;
  fats: number;
  carbs: number;
  sugar: number;
  fiber: number;
  hybrid_water: number; // fraction 0..1, e.g. 0.75 for egg
}

export interface FlourMixRow extends SyncMeta {
  id: string;
  name: string;
  created_at: string;
}

/** Component amounts are grams per 1000 g of mix. */
export interface FlourMixComponentRow extends SyncMeta {
  mix_id: string;
  ingredient_id: string;
  amount: number;
}

export interface RecipeRow extends SyncMeta {
  id: string;
  name: string;
  instructions: string;
  servings: number;
  hydration_percent: number; // baker's percentage, e.g. 70 for 70%
  created_at: string;
}

export interface RecipeIngredientRow extends SyncMeta {
  recipe_id: string;
  ingredient_id: string;
  amount: number; // grams used in the recipe
}

export interface RecipeMixRow extends SyncMeta {
  recipe_id: string;
  mix_id: string;
  amount: number; // grams of mix used in the recipe
}

/** Main liquids are stored as a percentage split of the target water. */
export interface RecipeMainLiquidRow extends SyncMeta {
  recipe_id: string;
  ingredient_id: string;
  percentage: number; // 0..100, should total 100 per recipe
}

/** Wire/replication form of any row (plain data: JSON-safe by design). */
export interface RowRecord<T = Record<string, unknown>> {
  table: TableName;
  pk: string;
  cols: T;
  updated_at: number;
  deleted: boolean;
  origin: string;
}

interface TableSpec {
  readonly columns: readonly string[];
  readonly pkColumns: readonly string[];
}

/** Column order is the single source of truth for SQL generation. */
export const TABLES = {
  ingredients: {
    columns: ["id", "name", "unit", "created_at", "price", "price_unit", "category", "calories", "protein", "fats", "carbs", "sugar", "fiber", "hybrid_water", "updated_at", "deleted", "origin"],
    pkColumns: ["id"],
  },
  flour_mixes: {
    columns: ["id", "name", "created_at", "updated_at", "deleted", "origin"],
    pkColumns: ["id"],
  },
  flour_mix_components: {
    columns: ["mix_id", "ingredient_id", "amount", "updated_at", "deleted", "origin"],
    pkColumns: ["mix_id", "ingredient_id"],
  },
  recipes: {
    columns: ["id", "name", "instructions", "category_id", "servings", "hydration_percent", "created_at", "updated_at", "deleted", "origin"],
    pkColumns: ["id"],
  },
  recipe_ingredients: {
    columns: ["recipe_id", "ingredient_id", "amount", "updated_at", "deleted", "origin"],
    pkColumns: ["recipe_id", "ingredient_id"],
  },
  recipe_mixes: {
    columns: ["recipe_id", "mix_id", "amount", "updated_at", "deleted", "origin"],
    pkColumns: ["recipe_id", "mix_id"],
  },
  recipe_main_liquids: {
    columns: ["recipe_id", "ingredient_id", "percentage", "updated_at", "deleted", "origin"],
    pkColumns: ["recipe_id", "ingredient_id"],
  },
  recipe_categories: {
    columns: ["id", "name", "color", "created_at", "updated_at", "deleted", "origin"],
    pkColumns: ["id"],
  },
} as const satisfies Record<TableName, TableSpec>;

export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

export const PK_SEPARATOR = "::";

export function pkOf(table: TableName, row: Record<string, unknown>): string {
  return TABLES[table].pkColumns.map((c) => String(row[c] ?? "")).join(PK_SEPARATOR);
}

export function pkParts(table: TableName, pk: string): Record<string, string> {
  const parts = pk.split(PK_SEPARATOR);
  const out: Record<string, string> = {};
  TABLES[table].pkColumns.forEach((c, i) => { out[c] = parts[i] ?? ""; });
  return out;
}

/** Split a row object into sync metadata + payload columns. */
export function splitRow(table: TableName, row: Record<string, unknown>): { cols: Record<string, unknown>; meta: SyncMeta } {
  const cols: Record<string, unknown> = {};
  for (const c of TABLES[table].columns) {
    if (c === "updated_at" || c === "deleted" || c === "origin") continue;
    cols[c] = row[c];
  }
  return {
    cols,
    meta: {
      updated_at: Number(row.updated_at ?? 0),
      deleted: Boolean(row.deleted),
      origin: String(row.origin ?? ""),
    },
  };
}

export function toRecord<T extends Record<string, unknown>>(table: TableName, row: T): RowRecord {
  const { cols, meta } = splitRow(table, row);
  return { table, pk: pkOf(table, row), cols, ...meta };
}

/** Turn a replication record back into a flat row object (SQL-shaped). */
export function fromRecord(record: RowRecord): Record<string, unknown> {
  return {
    ...record.cols,
    ...pkParts(record.table, record.pk),
    updated_at: record.updated_at,
    deleted: record.deleted,
    origin: record.origin,
  };
}
