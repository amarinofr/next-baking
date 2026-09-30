import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";

import { buildRecipeView, computeRecipeTotals, type IngredientUse, type MixUse } from "../src/domain/calc.ts";
import { nextDuplicateName, parseDuplicateName } from "../src/domain/duplicate.ts";
import { changesSince, mergeChangesets } from "../src/domain/syncMerge.ts";
import type { RowRecord } from "../src/domain/types.ts";

const ing = (over: Partial<IngredientUse>): IngredientUse => ({
  ingredient_id: "x", name: "x", category: "dry", price: 0, calories: 0, protein: 0, fats: 0, carbs: 0, sugar: 0, fiber: 0, hybrid_water: 0, amount: 0, ...over,
});

// Legacy acceptance test (PLAN.md §Verification #5) — additive hydration model.
test("hydration math matches the legacy acceptance case", () => {
  const mix: MixUse = {
    mix_id: "m1", name: "GF flour", amount: 800,
    components: [{ ingredient_id: "flour", name: "Rice flour", amount_per_kg: 800 }, { ingredient_id: "starch", name: "Starch", amount_per_kg: 200 }],
  };
  const egg = ing({ ingredient_id: "egg", name: "Egg white", category: "hybrid", hybrid_water: 0.85, amount: 200 });

  const totals = computeRecipeTotals({ hydration_percent: 70, servings: 4, ingredients: [egg], mixes: [mix], main_liquids: [{ ingredient_id: "water", name: "Water", percentage: 100 }] });

  assert.equal(totals.flour_weight_from_mixes, 800);
  assert.equal(totals.target_water, 560);
  assert.equal(totals.hybrid_water_content, 170); // 200 * 0.85
  assert.equal(totals.water_from_liquids, 170);
  // Additive model preserved from the current app: hybrids do NOT reduce the main liquid.
  assert.equal(totals.main_liquids[0]?.amount, 560);
  assert.equal(totals.total_liquid, 730);
  assert.equal(Number(totals.effective_hydration_percent.toFixed(1)), 91.3);
});

test("mix components scale by grams of mix used", () => {
  const mix: MixUse = { mix_id: "m", name: "Mix", amount: 250, components: [{ ingredient_id: "a", name: "A", amount_per_kg: 600, price: 20 }] };
  const totals = computeRecipeTotals({ hydration_percent: 100, servings: 1, ingredients: [], mixes: [mix], main_liquids: [] });
  assert.equal(totals.flour_weight_from_mixes, 150); // 600 * 250/1000
  assert.equal(totals.target_water, 150);
  assert.equal(totals.total_cost, 3); // 150 g * (€20 per 1000 g / 1000)
});

test("cost and nutrition aggregate direct ingredients and mix components", () => {
  const butter = ing({ ingredient_id: "butter", name: "Butter", category: "hybrid", hybrid_water: 0.16, price: 8000, calories: 717, amount: 200 });
  const sugar = ing({ ingredient_id: "sugar", name: "Sugar", price: 950, calories: 400, carbs: 100, amount: 50 });
  const totals = computeRecipeTotals({ hydration_percent: 65, servings: 2, ingredients: [butter, sugar], mixes: [], main_liquids: [] });
  assert.equal(totals.total_cost, Number(((200 * 8) + (50 * 0.95)).toFixed(2)));
  assert.equal(Number(totals.nutrition.calories.toFixed(1)), Number((200 * 7.17 + 50 * 4).toFixed(1)));
});

test("view scaling multiplies everything but changes nothing stored", () => {
  const input = { hydration_percent: 65, servings: 4, ingredients: [ing({ name: "Salt", amount: 10, price: 7960 })], mixes: [] as MixUse[], main_liquids: [] };
  const view = buildRecipeView(input, 8);
  assert.equal(view.scale, 2);
  assert.equal(view.dry_ingredients[0]?.amount, 20);
  assert.equal(Number(view.total_cost.toFixed(2)), 159.2); // 10 g * €7.96/g-per-kg... scaled x2
  assert.equal(Number(view.cost_per_serving.toFixed(2)), 19.9);
});

test("duplicate names follow the (N) scheme and never collide", () => {
  assert.equal(nextDuplicateName("Pizza", ["Pizza", "Pizza (1)", "Pizza (2)"]), "Pizza (3)");
  assert.equal(nextDuplicateName("Pizza (1)", ["Pizza", "Pizza (1)"]), "Pizza (2)");
  assert.equal(nextDuplicateName("Pão daily", ["Pão daily", "Pão daily old"]), "Pão daily (1)");
  assert.deepEqual(parseDuplicateName("Massa Sovada (12)"), { base: "Massa Sovada", n: 12 });
});

const rec = (table: string, pk: string, updated_at: number, origin: string, deleted = false): RowRecord =>
  ({ table: table as never, pk, cols: { id: pk }, updated_at, deleted, origin });

test("LWW merge converges regardless of which side is newer", () => {
  const local = [rec("ingredients", "a", 100, "dev-1"), rec("ingredients", "b", 50, "dev-1")];
  const remote = [rec("ingredients", "a", 90, "dev-2"), rec("ingredients", "c", 70, "dev-2")];

  const fromClient = mergeChangesets(local, remote);
  const fromHub = mergeChangesets(remote, local);

  assert.deepEqual(fromClient.toApply.map((r) => `${r.pk}@${r.updated_at}`), ["c@70"]);
  assert.deepEqual(fromClient.toPush.map((r) => r.pk).sort(), ["a", "b"]);
  const aMerged = fromClient.merged.get("ingredients::a");
  const aFromHub = fromHub.merged.get("ingredients::a");
  assert.equal(aMerged?.updated_at, 100);
  assert.equal(aFromHub?.updated_at, 100); // same winner both ways => convergence
});

test("tombstones beat older live rows so deletes replicate", () => {
  const local = [rec("recipes", "r1", 200, "dev-1", true)];
  const remote = [rec("recipes", "r1", 100, "dev-2", false)];
  const merged = mergeChangesets(local, remote);
  assert.equal(merged.merged.get("recipes::r1")?.deleted, true);
});

test("outbox selection uses the sync cursor", () => {
  const records = [rec("ingredients", "a", 10, "dev-1"), rec("ingredients", "b", 300, "dev-1")];
  assert.deepEqual(changesSince(records, 100).map((r) => r.pk), ["b"]);
});
