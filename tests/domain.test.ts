import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";

import { buildRecipeView, computeRecipeTotals, type IngredientUse, type MixUse } from "../src/domain/calc.ts";
import { nextDuplicateName, parseDuplicateName } from "../src/domain/duplicate.ts";
import { changesSince, mergeChangesets, wins } from "../src/domain/syncMerge.ts";
import { makeMemoryStore } from "../src/client/store.ts";
import { makeRepository } from "../src/domain/repository.ts";
import { buildState } from "../src/domain/state.ts";
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

test("an identical version echoed back cannot resurrect a locally deleted row", () => {
  // The device created the row (ts 100), synced it, then deleted it locally (ts 200).
  // A pull that had read the pre-delete snapshot must not write the old copy back.
  const staleSnapshot = rec("ingredients", "x", 100, "dev-1", false);
  const tombstone = rec("ingredients", "x", 200, "dev-1", true);
  assert.equal(wins(staleSnapshot, tombstone), false, "same origin + older timestamp must lose");
  assert.equal(wins(tombstone, staleSnapshot), true, "the newer local edit wins");

  const store = makeMemoryStore([tombstone]);
  const applied = Effect.runSync(store.mergeRemote([staleSnapshot]));
  assert.equal(applied, 0, "nothing should be applied over a newer local row");
  assert.equal(store.snapshot()[0]?.deleted, true);

  // Genuine concurrent edits (different devices, same millisecond) resolve the same way on every device.
  const mine = rec("ingredients", "y", 300, "dev-b");
  const theirs = rec("ingredients", "y", 300, "dev-a");
  assert.equal(wins(theirs, mine), false);
  assert.equal(wins(mine, theirs), true);
  assert.equal(mergeChangesets([mine], [theirs]).merged.get("ingredients::y")?.origin, "dev-b");
});

test("editing a row never blanks the legacy columns this UI does not show", async () => {
  const store = makeMemoryStore([
    // A row exactly as your original database stores it (price_unit set, category assigned).
    { table: "ingredients", pk: "milk", cols: { id: "milk", name: "Milk", unit: "g", created_at: "2026-01-01T00:00:00Z", price: 1.2, price_unit: "per litre", category: "liquid", calories: 42, protein: 3.4, fats: 1, carbs: 4.8, sugar: 4.8, fiber: 0, hybrid_water: 0 }, updated_at: 10, deleted: false, origin: "legacy" },
    { table: "recipe_categories", pk: "bread-cat", cols: { id: "bread-cat", name: "Bread", color: "#4f46e5", created_at: "2026-01-01T00:00:00Z" }, updated_at: 10, deleted: false, origin: "legacy" },
    { table: "recipes", pk: "r1", cols: { id: "r1", name: "Loaf", instructions: "", category_id: "bread-cat", servings: 2, hydration_percent: 65, created_at: "2026-01-01T00:00:00Z" }, updated_at: 10, deleted: false, origin: "legacy" },
  ]);
  const repo = makeRepository({ store, deviceId: "dev-test" });

  await Effect.runPromise(repo.saveIngredient({ id: "milk", name: "Milk semi", price: 1.4, category: "liquid", hybrid_water: 0, calories: 42, protein: 3.4, fats: 1, carbs: 4.8, sugar: 4.8, fiber: 0 }));
  await Effect.runPromise(repo.saveRecipe({ id: "r1", name: "Loaf v2", instructions: "mix", servings: 4, hydration_percent: 70, ingredients: [], mixes: [], main_liquids: [] }));

  const rows = store.snapshot();
  const milk = rows.find((r) => r.table === "ingredients" && r.pk === "milk")!;
  const recipe = rows.find((r) => r.table === "recipes" && r.pk === "r1")!;

  assert.equal(milk.cols.price_unit, "per litre", "price_unit must survive an edit");
  assert.equal(milk.cols.created_at, "2026-01-01T00:00:00Z", "creation timestamp must not be rewritten");
  assert.equal(recipe.cols.category_id, "bread-cat", "category must survive an edit that does not mention it");
  assert.equal(recipe.cols.name, "Loaf v2");

  // An explicit null clears the category (that is a deliberate user choice).
  await Effect.runPromise(repo.saveRecipe({ id: "r1", name: "Loaf v3", instructions: "", category_id: null, servings: 1, hydration_percent: 65, ingredients: [], mixes: [], main_liquids: [] }));
  assert.equal(store.snapshot().find((r) => r.table === "recipes" && r.pk === "r1")!.cols.category_id, null);

  // Categories are part of the app state and reach the UI.
  const state = Effect.runSync(buildState(rows));
  assert.equal(state.categories.get("bread-cat")?.name, "Bread");
});

test("outbox selection uses the sync cursor", () => {
  const records = [rec("ingredients", "a", 10, "dev-1"), rec("ingredients", "b", 300, "dev-1")];
  assert.deepEqual(changesSince(records, 100).map((r) => r.pk), ["b"]);
});
