/**
 * Effect-TS validation boundaries.
 *
 * Every value crossing a boundary (form input, hub payload, seed file, DB row) is
 * decoded through a Schema before reaching domain logic. Untyped JSON is not
 * allowed inside the app — this is the main mechanism for "reduce the errors".
 */

import { Data, Effect, Schema } from "effect";
import type { Category } from "./types.ts";

// --- Typed domain errors (they live in the Effect error channel) ---

export class ValidationError extends Data.TaggedError("ValidationError")<{ field: string; reason: string }> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{ table: string; id: string }> {}
export class ConflictError extends Data.TaggedError("ConflictError")<{ table: string; pk: string }> {}
export class StorageError extends Data.TaggedError("StorageError")<{ cause: string }> {}
export class SyncError extends Data.TaggedError("SyncError")<{ cause: string }> {}

// --- Sync metadata columns shared by every table ---

const syncColumns = {
  updated_at: Schema.Number,
  deleted: Schema.Boolean,
  origin: Schema.String,
} as const;

// --- Row schemas (mirror the legacy SQLite schema + additive sync columns) ---

export const IngredientSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  unit: Schema.String,
  created_at: Schema.String,
  price: Schema.Number, // € per 1000 g
  price_unit: Schema.optional(Schema.NullOr(Schema.String)), // legacy column, carried through untouched
  category: Schema.Literal("dry", "hybrid", "liquid"),
  calories: Schema.Number, // per 100 g
  protein: Schema.Number,
  fats: Schema.Number,
  carbs: Schema.Number,
  sugar: Schema.Number,
  fiber: Schema.Number,
  hybrid_water: Schema.Number, // fraction 0..1
  ...syncColumns,
});

export const FlourMixSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
  ...syncColumns,
});

export const FlourMixComponentSchema = Schema.Struct({
  mix_id: Schema.String,
  ingredient_id: Schema.String,
  amount: Schema.Number, // grams per 1000 g of mix
  ...syncColumns,
});

export const RecipeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  instructions: Schema.String,
  category_id: Schema.optional(Schema.NullOr(Schema.String)), // FK -> recipe_categories.id
  servings: Schema.Int.pipe(Schema.positive()),
  hydration_percent: Schema.Number.pipe(Schema.between(0, 300)),
  created_at: Schema.String,
  ...syncColumns,
});

export const RecipeCategorySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  created_at: Schema.String,
  ...syncColumns,
});

export const RecipeIngredientLinkSchema = Schema.Struct({
  recipe_id: Schema.String,
  ingredient_id: Schema.String,
  amount: Schema.Number, // grams used in the recipe
  ...syncColumns,
});

export const RecipeMixLinkSchema = Schema.Struct({
  recipe_id: Schema.String,
  mix_id: Schema.String,
  amount: Schema.Number, // grams of mix used in the recipe
  ...syncColumns,
});

export const RecipeMainLiquidLinkSchema = Schema.Struct({
  recipe_id: Schema.String,
  ingredient_id: Schema.String,
  percentage: Schema.Number, // percentage split of the target water
  ...syncColumns,
});

// --- Registry used by generic import/export/sync code ---

export const ROW_SCHEMAS = {
  ingredients: IngredientSchema,
  flour_mixes: FlourMixSchema,
  flour_mix_components: FlourMixComponentSchema,
  recipes: RecipeSchema,
  recipe_ingredients: RecipeIngredientLinkSchema,
  recipe_mixes: RecipeMixLinkSchema,
  recipe_main_liquids: RecipeMainLiquidLinkSchema,
  recipe_categories: RecipeCategorySchema,
} as const;

// --- Form input DTOs ---

export const IngredientInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String.pipe(Schema.nonEmptyString()),
  category: Schema.Literal("dry", "hybrid", "liquid"),
  price: Schema.Number.pipe(Schema.nonNegative()),
  hybrid_water: Schema.Number.pipe(Schema.between(0, 1)),
  calories: Schema.Number.pipe(Schema.nonNegative()),
  protein: Schema.Number.pipe(Schema.nonNegative()),
  fats: Schema.Number.pipe(Schema.nonNegative()),
  carbs: Schema.Number.pipe(Schema.nonNegative()),
  sugar: Schema.Number.pipe(Schema.nonNegative()),
  fiber: Schema.Number.pipe(Schema.nonNegative()),
});

export const MixInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String.pipe(Schema.nonEmptyString()),
  components: Schema.Array(
    Schema.Struct({
      ingredient_id: Schema.String.pipe(Schema.nonEmptyString()),
      amount: Schema.Number.pipe(Schema.nonNegative()),
    }),
  ),
});

export const RecipeInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String.pipe(Schema.nonEmptyString()),
  instructions: Schema.String,
  category_id: Schema.optional(Schema.NullOr(Schema.String)), // FK -> recipe_categories.id
  servings: Schema.Int.pipe(Schema.positive()),
  hydration_percent: Schema.Number.pipe(Schema.between(0, 300)),
  ingredients: Schema.Array(
    Schema.Struct({ ingredient_id: Schema.String, amount: Schema.Number }),
  ),
  mixes: Schema.Array(
    Schema.Struct({ mix_id: Schema.String, amount: Schema.Number }),
  ),
  main_liquids: Schema.Array(
    Schema.Struct({ ingredient_id: Schema.String, percentage: Schema.Number }),
  ),
});

export type RecipeCategory = typeof RecipeCategorySchema.Type;

export type IngredientInput = typeof IngredientInputSchema.Type;
export type MixInput = typeof MixInputSchema.Type;
export type RecipeInput = typeof RecipeInputSchema.Type;

// --- Decode helpers ---

const toValidation = (label: string) =>
  (err: unknown): ValidationError =>
    new ValidationError({ field: label, reason: String((err as Error)?.message ?? err).slice(0, 400) });

/** Decode an unknown payload into a schema's type, mapping failures to ValidationError. */
export function decode<A>(schema: Schema.Schema<A, any, never>, label: string) {
  return (input: unknown): Effect.Effect<A, ValidationError> =>
    (Schema.decodeUnknown(schema as any)(input) as Effect.Effect<A, unknown>).pipe(Effect.mapError(toValidation(label)));
}

/** Coerce a raw form field to a finite number. */
export const numField = (raw: unknown, fallback = 0): number => {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
};

export type Ingredient = typeof IngredientSchema.Type;
export type FlourMix = typeof FlourMixSchema.Type;
export type FlourMixComponent = typeof FlourMixComponentSchema.Type;
export type Recipe = typeof RecipeSchema.Type;
export type RecipeIngredientLink = typeof RecipeIngredientLinkSchema.Type;
export type RecipeMixLink = typeof RecipeMixLinkSchema.Type;
export type RecipeMainLiquidLink = typeof RecipeMainLiquidLinkSchema.Type;

export type CategoryT = Category;
