/**
 * Recipe math — a faithful port of the legacy app's calculations.
 *
 * Reference implementation: legacy-baking/backend/internal/repo/repository.go
 * (`calculateRecipeTotals`, `GetRecipeWithDetails`) and the hydration box in
 * legacy-baking/frontend/src/pages/recipes/[id]/index.astro.
 *
 * Semantics preserved deliberately (do not "fix" without checking with the user):
 *  - The hydration base is **flour coming from flour mixes only** (mix components).
 *    A mix is defined by whatever its components add up to — call it the batch — and a
 *    recipe scales it proportionally: comp.amount * mixAmount / batchGrams. So a mix whose
 *    components total 703 g behaves exactly like one totalling 1000 g; you never have to
 *    top a mix up to 1000 g for recipes to work.
 *  - Hydration % is a baker's percentage of that flour weight.
 *  - Main liquid target = flourWeight × hydration% / 100. Hybrid/liquid ingredient
 *    water is **additive** (shown separately, it does NOT reduce the main liquid).
 *  - Main liquids are stored as a percentage split of the target water.
 *  - Cost is € per 1000 g of each ingredient; nutrition values are per 100 g.
 */

import type { Category } from "./types.ts";

export interface Nutrition {
  calories: number;
  protein: number;
  fats: number;
  carbs: number;
  sugar: number;
  fiber: number;
}

export const emptyNutrition = (): Nutrition => ({ calories: 0, protein: 0, fats: 0, carbs: 0, sugar: 0, fiber: 0 });

/** Any ingredient-like row carrying the fields the math needs. */
export interface IngredientLike {
  ingredient_id: string;
  name: string;
  category: Category;
  price: number; // €/1000g
  calories: number; // per 100g
  protein: number;
  fats: number;
  carbs: number;
  sugar: number;
  fiber: number;
  hybrid_water: number; // fraction 0..1
}

/** A direct ingredient used by a recipe, in grams. */
export interface IngredientUse extends IngredientLike {
  amount: number; // grams used in the recipe
}

/** A raw mix component as stored in `flour_mix_components` (grams per 1000 g of mix). */
export interface MixComponentPerKg {
  ingredient_id: string;
  name: string;
  amount_per_kg: number;
}

/** A flour mix used by a recipe (grams of mix) with its components resolved. */
export interface MixUse {
  mix_id: string;
  name: string;
  amount: number; // grams of mix used in the recipe
  components: ReadonlyArray<MixComponentPerKg & Partial<IngredientLike>>;
}

export interface MainLiquidRef {
  ingredient_id: string;
  name: string;
  percentage: number; // 0..100
}

export interface RecipeMathInput {
  hydration_percent: number;
  servings: number;
  ingredients: ReadonlyArray<IngredientUse>;
  mixes: ReadonlyArray<MixUse>;
  main_liquids: ReadonlyArray<MainLiquidRef>;
}

export interface ScaledComponent extends IngredientLike {
  amount: number; // grams actually present in the recipe
}

export interface MainLiquidAmount extends MainLiquidRef {
  amount: number; // grams to weigh out
}

export interface LiquidContribution {
  ingredient_id: string;
  name: string;
  category: Category;
  amount: number; // grams of the ingredient itself
  water: number; // grams of water it contributes
  hybrid_water: number; // fraction, for display
}

export interface RecipeTotals {
  /** grams of flour contributed by mix components — the hydration base */
  flour_weight_from_mixes: number;
  /** water carried by hybrid ingredients (butter, eggs, …) */
  hybrid_water_content: number;
  /** target water demanded by baker's percentage */
  target_water: number;
  /** water already present in liquid/hybrid ingredients listed on the recipe */
  water_from_liquids: number;
  /** target water + water carried by ingredients */
  total_liquid: number;
  effective_hydration_percent: number;
  main_liquids: ReadonlyArray<MainLiquidAmount>;
  main_liquid_percentage_total: number;
  liquid_contributions: ReadonlyArray<LiquidContribution>;
  scaled_mix_components: ReadonlyArray<ScaledComponent>;
  total_cost: number; // € for the whole recipe as stored
  nutrition: Nutrition; // whole recipe as stored
  total_weight: number; // grams of finished dough (approximate)
}

const addNutrition = (n: Nutrition, factor: number, i: IngredientLike): Nutrition => {
  n.calories += i.calories * factor;
  n.protein += i.protein * factor;
  n.fats += i.fats * factor;
  n.carbs += i.carbs * factor;
  n.sugar += i.sugar * factor;
  n.fiber += i.fiber * factor;
  return n;
};

/** Grams a mix's own components add up to (its "batch"). Falls back to 1000 when empty. */
export const mixBatchGrams = (components: ReadonlyArray<{ amount_per_kg: number }>): number =>
  components.reduce((sum, c) => sum + (Number(c.amount_per_kg) || 0), 0);

/** Components are grams *within the mix's own batch* → scale to the grams the recipe uses. */
export function scaleMixComponents(mix: MixUse): ScaledComponent[] {
  const batch = mixBatchGrams(mix.components);
  const factor = mix.amount / (batch > 0 ? batch : 1000);
  return mix.components.map((c) => ({
    ingredient_id: c.ingredient_id,
    name: c.name,
    category: c.category ?? "dry",
    price: c.price ?? 0,
    calories: c.calories ?? 0,
    protein: c.protein ?? 0,
    fats: c.fats ?? 0,
    carbs: c.carbs ?? 0,
    sugar: c.sugar ?? 0,
    fiber: c.fiber ?? 0,
    hybrid_water: c.hybrid_water ?? 0,
    amount: c.amount_per_kg * factor,
  }));
}

export function computeRecipeTotals(input: RecipeMathInput): RecipeTotals {
  const nutrition = emptyNutrition();
  let flourFromMixes = 0;
  let hybridWater = 0;
  let waterFromLiquids = 0;
  let totalCost = 0;
  let directWeight = 0;

  const contributions: LiquidContribution[] = [];

  // Direct ingredients: cost + nutrition always count; only hybrid/liquid ones feed the liquid breakdown.
  for (const ing of input.ingredients) {
    totalCost += (ing.amount * ing.price) / 1000;
    directWeight += ing.amount;
    addNutrition(nutrition, ing.amount / 100, ing);

    if (ing.category === "hybrid") {
      const water = ing.amount * ing.hybrid_water;
      hybridWater += water;
      waterFromLiquids += water;
      contributions.push({
        ingredient_id: ing.ingredient_id, name: ing.name, category: ing.category,
        amount: ing.amount, water, hybrid_water: ing.hybrid_water,
      });
    } else if (ing.category === "liquid") {
      waterFromLiquids += ing.amount;
      contributions.push({
        ingredient_id: ing.ingredient_id, name: ing.name, category: ing.category,
        amount: ing.amount, water: ing.amount, hybrid_water: 0,
      });
    }
  }

  // Mix components are the hydration base.
  const scaledComponents: ScaledComponent[] = [];
  let mixWeight = 0;
  for (const mix of input.mixes) {
    mixWeight += mix.amount;
    for (const comp of scaleMixComponents(mix)) {
      scaledComponents.push(comp);
      flourFromMixes += comp.amount;
      totalCost += (comp.amount * comp.price) / 1000;
      addNutrition(nutrition, comp.amount / 100, comp);
    }
  }

  const targetWater = (flourFromMixes * input.hydration_percent) / 100;

  const mainLiquids: MainLiquidAmount[] = input.main_liquids.map((ml) => ({
    ...ml,
    amount: (targetWater * ml.percentage) / 100,
  }));
  const pctTotal = input.main_liquids.reduce((sum, ml) => sum + ml.percentage, 0);

  const totalLiquid = targetWater + waterFromLiquids;
  const effectiveHydration = flourFromMixes > 0 ? (totalLiquid / flourFromMixes) * 100 : 0;

  return {
    flour_weight_from_mixes: flourFromMixes,
    hybrid_water_content: hybridWater,
    target_water: targetWater,
    water_from_liquids: waterFromLiquids,
    total_liquid: totalLiquid,
    effective_hydration_percent: effectiveHydration,
    main_liquids: mainLiquids,
    main_liquid_percentage_total: pctTotal,
    liquid_contributions: contributions,
    scaled_mix_components: scaledComponents,
    total_cost: totalCost,
    nutrition,
    total_weight: directWeight + mixWeight + mainLiquids.reduce((s, m) => s + m.amount, 0),
  };
}

/** Display view at a given number of servings (read-only scaling — no DB writes). */
export interface RecipeView {
  scale: number; // multiplier applied to everything
  servings_target: number;
  flour_weight_from_mixes: number;
  target_water: number;
  hybrid_water_content: number;
  water_from_liquids: number;
  total_liquid: number;
  effective_hydration_percent: number;
  dry_ingredients: ReadonlyArray<IngredientUse>;
  liquid_ingredients: ReadonlyArray<IngredientUse>;
  mixes: ReadonlyArray<{ mix_id: string; name: string; amount: number; components: ReadonlyArray<ScaledComponent> }>;
  main_liquids: ReadonlyArray<MainLiquidAmount>;
  main_liquid_percentage_total: number;
  total_cost: number;
  cost_per_serving: number;
  nutrition_per_serving: Nutrition;
  nutrition_per_100g: Nutrition;
}

const scaleNutrition = (n: Nutrition, k: number): Nutrition => ({
  calories: n.calories * k, protein: n.protein * k, fats: n.fats * k, carbs: n.carbs * k, sugar: n.sugar * k, fiber: n.fiber * k,
});

export function buildRecipeView(input: RecipeMathInput, targetServings: number): RecipeView {
  const totals = computeRecipeTotals(input);
  const baseServings = input.servings > 0 ? input.servings : 1;
  const servingsTarget = targetServings > 0 ? targetServings : baseServings;
  const k = servingsTarget / baseServings;

  const scaled = (i: IngredientUse): IngredientUse => ({ ...i, amount: i.amount * k });

  return {
    scale: k,
    servings_target: servingsTarget,
    flour_weight_from_mixes: totals.flour_weight_from_mixes * k,
    target_water: totals.target_water * k,
    hybrid_water_content: totals.hybrid_water_content * k,
    water_from_liquids: totals.water_from_liquids * k,
    total_liquid: totals.total_liquid * k,
    effective_hydration_percent: totals.effective_hydration_percent,
    dry_ingredients: input.ingredients.filter((i) => i.category === "dry").map(scaled),
    liquid_ingredients: input.ingredients.filter((i) => i.category !== "dry").map(scaled),
    mixes: input.mixes.map((m) => ({ mix_id: m.mix_id, name: m.name, amount: m.amount * k, components: scaleMixComponents({ ...m, amount: m.amount * k }) })),
    main_liquids: totals.main_liquids.map((m) => ({ ...m, amount: m.amount * k })),
    main_liquid_percentage_total: totals.main_liquid_percentage_total,
    total_cost: totals.total_cost * k,
    cost_per_serving: (totals.total_cost * k) / servingsTarget,
    nutrition_per_serving: scaleNutrition(totals.nutrition, k / servingsTarget),
    nutrition_per_100g: totals.total_weight > 0 ? scaleNutrition(totals.nutrition, 100 / totals.total_weight) : emptyNutrition(),
  };
}

/** Cheap summary for list/grid cards. */
export interface RecipeSummary { total_cost: number; calories: number; flour_weight: number; total_weight: number }

export function summarizeRecipe(input: RecipeMathInput): RecipeSummary {
  const t = computeRecipeTotals(input);
  return { total_cost: t.total_cost, calories: t.nutrition.calories, flour_weight: t.flour_weight_from_mixes, total_weight: t.total_weight };
}

/** Cost of 1 kg of a flour mix, whatever its components happen to total. */
export const mixCostPerKg = (components: ReadonlyArray<{ amount: number; price: number }>): number => {
  const batch = components.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  if (batch <= 0) return 0;
  const batchCost = components.reduce((sum, c) => sum + (c.amount * (c.price ?? 0)) / 1000, 0);
  return (batchCost / batch) * 1000;
};

/** Nutrition totals of 100 g of a flour mix. */
export const mixNutritionPer100g = (
  components: ReadonlyArray<{ amount: number; calories: number; protein: number; fats: number; carbs: number; sugar: number; fiber: number }>,
): Nutrition => {
  const total = components.reduce((sum, c) => sum + c.amount, 0) || 1;
  const factor = 100 / total;
  return components.reduce((acc, c) => {
    acc.calories += (c.calories ?? 0) * c.amount * factor / 100;
    acc.protein += (c.protein ?? 0) * c.amount * factor / 100;
    acc.fats += (c.fats ?? 0) * c.amount * factor / 100;
    acc.carbs += (c.carbs ?? 0) * c.amount * factor / 100;
    acc.sugar += (c.sugar ?? 0) * c.amount * factor / 100;
    acc.fiber += (c.fiber ?? 0) * c.amount * factor / 100;
    return acc;
  }, emptyNutrition());
};
