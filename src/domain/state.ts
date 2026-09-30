/** State assembly: replication records -> typed collections + lookup indexes. */

import { Effect, Schema } from "effect";
import type { IngredientUse, MainLiquidRef, MixUse, RecipeMathInput } from "./calc.ts";
import { ROW_SCHEMAS, ValidationError } from "./schema.ts";
import type {
  FlourMix, FlourMixComponent, Ingredient, Recipe, RecipeCategory, RecipeIngredientLink, RecipeMainLiquidLink, RecipeMixLink,
} from "./schema.ts";
import { TABLE_NAMES, fromRecord, type RowRecord, type TableName } from "./types.ts";

export interface AppState {
  readonly ingredients: ReadonlyMap<string, Ingredient>;
  readonly mixes: ReadonlyMap<string, FlourMix>;
  readonly mixComponents: ReadonlyArray<FlourMixComponent>;
  readonly recipes: ReadonlyMap<string, Recipe>;
  readonly recipeIngredients: ReadonlyArray<RecipeIngredientLink>;
  readonly recipeMixes: ReadonlyArray<RecipeMixLink>;
  readonly mainLiquids: ReadonlyArray<RecipeMainLiquidLink>;
  readonly categories: ReadonlyMap<string, RecipeCategory>;
  /** rows that failed schema decoding (surfaced as a warning instead of crashing) */
  readonly invalidRows: number;
}

const BUCKETS: Record<TableName, string> = {
  ingredients: "ingredients", flour_mixes: "mixes", recipes: "recipes",
  flour_mix_components: "mixComponents", recipe_ingredients: "recipeIngredients",
  recipe_mixes: "recipeMixes", recipe_main_liquids: "mainLiquids",
  recipe_categories: "categories",
};

export function buildState(records: Iterable<RowRecord>): Effect.Effect<AppState, ValidationError> {
  return Effect.gen(function* () {
    const ingredients = new Map<string, Ingredient>();
    const mixes = new Map<string, FlourMix>();
    const recipes = new Map<string, Recipe>();
    const mixComponents: FlourMixComponent[] = [];
    const recipeIngredients: RecipeIngredientLink[] = [];
    const recipeMixes: RecipeMixLink[] = [];
    const mainLiquids: RecipeMainLiquidLink[] = [];
    const categories = new Map<string, RecipeCategory>();
    let invalid = 0;

    for (const record of records) {
      if (!TABLE_NAMES.includes(record.table) || record.deleted) continue;
      const row = fromRecord(record);
      const attempt = Schema.decodeUnknown(ROW_SCHEMAS[record.table] as never)(row) as unknown as Effect.Effect<Record<string, unknown>, unknown, never>;
      const decoded = yield* attempt.pipe(Effect.catchAll(() => Effect.succeed(undefined)));

      if (!decoded) { invalid += 1; continue; }

      switch (BUCKETS[record.table]) {
        case "ingredients": ingredients.set(String(decoded.id), decoded as unknown as Ingredient); break;
        case "mixes": mixes.set(String(decoded.id), decoded as unknown as FlourMix); break;
        case "recipes": recipes.set(String(decoded.id), decoded as unknown as Recipe); break;
        case "mixComponents": mixComponents.push(decoded as unknown as FlourMixComponent); break;
        case "recipeIngredients": recipeIngredients.push(decoded as unknown as RecipeIngredientLink); break;
        case "recipeMixes": recipeMixes.push(decoded as unknown as RecipeMixLink); break;
        case "mainLiquids": mainLiquids.push(decoded as unknown as RecipeMainLiquidLink); break;
        default: categories.set(String(decoded.id), decoded as unknown as RecipeCategory); break;
      }
    }

    return { ingredients, mixes, mixComponents, recipes, recipeIngredients, recipeMixes, mainLiquids, categories, invalidRows: invalid } satisfies AppState;
  });
}

/** Components of a mix: grams within whatever that mix happens to add up to. */
export const componentsOf = (state: AppState, mixId: string): FlourMixComponent[] =>
  state.mixComponents.filter((c) => c.mix_id === mixId);

/** Grams the mix's own components total (its "batch"); recipes scale against this. */
export const mixTotalGrams = (components: ReadonlyArray<{ amount: number }>): number =>
  components.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);

/** Assemble exactly what the calculator needs for one stored recipe. */
export function recipeMathInput(state: AppState, recipeId: string): RecipeMathInput | undefined {
  const recipe = state.recipes.get(recipeId);
  if (!recipe) return undefined;

  const ingredients: IngredientUse[] = [];
  for (const link of state.recipeIngredients) {
    if (link.recipe_id !== recipeId) continue;
    const ing = state.ingredients.get(link.ingredient_id);
    if (!ing) continue; // legacy JOIN semantics: dangling references are ignored
    ingredients.push({
      ingredient_id: ing.id, name: ing.name, category: ing.category, price: ing.price,
      calories: ing.calories, protein: ing.protein, fats: ing.fats, carbs: ing.carbs,
      sugar: ing.sugar, fiber: ing.fiber, hybrid_water: ing.hybrid_water, amount: link.amount,
    });
  }

  const mixes: MixUse[] = [];
  for (const link of state.recipeMixes) {
    if (link.recipe_id !== recipeId) continue;
    const mix = state.mixes.get(link.mix_id);
    if (!mix) continue;
    mixes.push({
      mix_id: mix.id, name: mix.name, amount: link.amount,
      components: componentsOf(state, mix.id).map((c) => {
        const ing = state.ingredients.get(c.ingredient_id);
        return {
          ingredient_id: c.ingredient_id, name: ing?.name ?? "(deleted)", amount_per_kg: c.amount, // grams inside the mix batch
          category: ing?.category ?? "dry", price: ing?.price ?? 0, calories: ing?.calories ?? 0,
          protein: ing?.protein ?? 0, fats: ing?.fats ?? 0, carbs: ing?.carbs ?? 0,
          sugar: ing?.sugar ?? 0, fiber: ing?.fiber ?? 0, hybrid_water: ing?.hybrid_water ?? 0,
        };
      }),
    });
  }

  const mainLiquids: MainLiquidRef[] = [];
  for (const link of state.mainLiquids) {
    if (link.recipe_id !== recipeId) continue;
    const ing = state.ingredients.get(link.ingredient_id);
    if (!ing) continue;
    mainLiquids.push({ ingredient_id: ing.id, name: ing.name, percentage: link.percentage });
  }

  return {
    hydration_percent: recipe.hydration_percent, servings: recipe.servings,
    ingredients, mixes, main_liquids: mainLiquids,
  };
}
