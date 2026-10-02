/** Recipe create/edit form with a live hydration · cost · nutrition breakdown. */

import { buildRecipeView, type IngredientUse, type MixUse, type RecipeMathInput } from "../../domain/calc.ts";
import { componentsOf, recipeMathInput } from "../../domain/state.ts";
import type { Recipe } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, pct, runAction, runUi, toast, waterSplit } from "../dom.ts";
import { recipeInputFromForm } from "../app.ts";
import { actionsRow, basicsPanel, figuresBlock, figuresPanel, groupSheet, numberField, pageHead, textField, type GroupSpec } from "./formKit.ts";
import { type ViewCtx } from "./context.ts";

/** Category picker. With no categories on this device the stored value is carried through untouched. */
function categoryField(ctx: ViewCtx, recipe?: Recipe): HTMLElement {
  const stored = recipe?.category_id ?? "";
  const options = [...ctx.state.categories.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (options.length === 0) return el("input", { type: "hidden", name: "category_id", value: stored });

  const select = el("select", { id: "category_id", name: "category_id" }) as HTMLSelectElement;
  select.append(el("option", { value: "" }, "— none —"));
  for (const category of options) select.append(el("option", { value: category.id }, category.name));
  select.value = options.some((c) => c.id === stored) ? stored : "";
  return el("div", { class: "field" }, el("label", { for: "category_id" }, "Category"), select);
}

export function renderRecipeForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const state = ctx.state;
  const recipe = editingId ? state.recipes.get(editingId) : undefined;
  if (editingId && !recipe) toast(`Recipe ${editingId} was not found on this device.`, "err");

  const ingredients = [...state.ingredients.values()].sort((a, b) => a.name.localeCompare(b.name));
  const dryIngredients = ingredients.filter((i) => i.category === "dry");
  const wetIngredients = ingredients.filter((i) => i.category !== "dry");
  const mixes = [...state.mixes.values()].sort((a, b) => a.name.localeCompare(b.name));

  const labelOf = (id: string): string => {
    const i = state.ingredients.get(id);
    return i ? `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)` : id;
  };

  const mixOptions: Array<[string, string]> = [["", "Select a mix…"], ...mixes.map((m) => [m.id, m.name] as [string, string])];
  const dryOptions: Array<[string, string]> = [["", "Select an ingredient…"], ...dryIngredients.map((i) => [i.id, labelOf(i.id)] as [string, string])];
  const wetOptions: Array<[string, string]> = [["", "Select an ingredient…"], ...wetIngredients.map((i) => [i.id, labelOf(i.id)] as [string, string])];

  const panel = figuresBlock();
  const gaugeSlot = el("div");   // the same water figures, drawn as two coloured blocks
  const previousInput = editingId ? recipeMathInput(state, editingId) : undefined;

  const form = el("form", { class: "max-w" });

  // ---- each family of rows gets the same box: a coloured sheet with its own add-row control ----
  const linkGroups: Array<GroupSpec> = [
    {
      title: "Flour mixes — the hydration base", nameKey: "mix_id", amountKey: "mix_amount", options: mixOptions,
      unit: "g", sheet: "sheet-butter",
      existing: (previousInput?.mixes ?? []).map((m) => ({ idOrMix: m.mix_id, amount: m.amount })),
    },
    {
      title: "Dry ingredients", nameKey: "dry_ingredient_id", amountKey: "dry_ingredient_amount", options: dryOptions,
      unit: "g", sheet: "sheet-sage",
      existing: (previousInput?.ingredients ?? []).filter((i) => i.category === "dry").map((i) => ({ idOrMix: i.ingredient_id, amount: i.amount })),
    },
    {
      title: "Liquids & hybrids", nameKey: "liquid_ingredient_id", amountKey: "liquid_ingredient_amount", options: wetOptions,
      unit: "g", sheet: "sheet-sky",
      existing: (previousInput?.ingredients ?? []).filter((i) => i.category !== "dry").map((i) => ({ idOrMix: i.ingredient_id, amount: i.amount })),
    },
    {
      title: "Main liquids — share of the target water", nameKey: "main_liquid_ingredient_id", amountKey: "main_liquid_percentage", options: wetOptions,
      unit: "%", sheet: "sheet-lilac",
      existing: (previousInput?.main_liquids ?? []).map((l) => ({ idOrMix: l.ingredient_id, amount: l.percentage })),
    },
  ];

  const deleteButton = recipe ? (() => {
    const button = el("button", { class: "danger-solid", type: "button" }, `Delete "${recipe.name}"`);
    button.addEventListener("click", () => {
      if (!askConfirm(`Delete recipe "${recipe.name}"? Its ingredient and mix links are removed as well.`)) return;
      runAction(ctx.app.repo.deleteRecipe(recipe.id)).then((done) => { if (!done) return; ctx.markChanged(); ctx.navigate("/recipes"); });
    });
    return button;
  })() : undefined;

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",

    basicsPanel(
      textField("name", "Name", recipe?.name ?? ""),
      el("div", { class: "row" }, numberField("servings", "Servings", recipe?.servings ?? 1), numberField("hydration_percent", "Hydration (%)", recipe?.hydration_percent ?? 65)),
      categoryField(ctx, recipe),
      el("div", { class: "field" }, el("label", { for: "instructions" }, "Instructions"), el("textarea", { id: "instructions", name: "instructions" }, recipe?.instructions ?? "")),
    ),

    ...linkGroups.map((group) => groupSheet({ ...group, onChange: recompute })),

    figuresPanel("While you edit", panel, gaugeSlot),
    actionsRow(deleteButton),
  );

  form.addEventListener("change", recompute);

  function collectForm(): RecipeMathInput | undefined {
    const data = new FormData(form);
    const servings = Math.max(1, Math.trunc(Number(data.get("servings") ?? 1)));
    const hydration = Number(data.get("hydration_percent") ?? 65);

    const readLinks = (idKey: string, amountKey: string): Array<{ id: string; amount: number }> => {
      const ids = data.getAll(idKey).map(String);
      const amounts = data.getAll(amountKey).map((v) => Number(v) || 0);
      return ids.map((id, i) => ({ id, amount: amounts[i] ?? 0 })).filter((row) => row.id && row.amount > 0);
    };

    const directIds = [...readLinks("dry_ingredient_id", "dry_ingredient_amount"), ...readLinks("liquid_ingredient_id", "liquid_ingredient_amount")];
    const seen = new Map<string, IngredientUse>();
    for (const link of directIds) {
      const ing = state.ingredients.get(link.id);
      if (!ing) continue;
      const already = seen.get(link.id);
      if (already) already.amount += link.amount;
      else seen.set(link.id, {
        ingredient_id: ing.id, name: ing.name, category: ing.category, price: ing.price, calories: ing.calories, protein: ing.protein,
        fats: ing.fats, carbs: ing.carbs, sugar: ing.sugar, fiber: ing.fiber, hybrid_water: ing.hybrid_water, amount: link.amount,
      });
    }

    const mixUses: MixUse[] = readLinks("mix_id", "mix_amount").flatMap((link) => {
      const mix = state.mixes.get(link.id);
      if (!mix) return [];
      return [{
        mix_id: mix.id, name: mix.name, amount: link.amount,
        components: componentsOf(state, mix.id).map((c) => {
          const ing = state.ingredients.get(c.ingredient_id);
          return { ingredient_id: c.ingredient_id, name: ing?.name ?? "(deleted)", amount_per_kg: c.amount, category: ing?.category ?? "dry", price: ing?.price ?? 0, calories: ing?.calories ?? 0, protein: ing?.protein ?? 0, fats: ing?.fats ?? 0, carbs: ing?.carbs ?? 0, sugar: ing?.sugar ?? 0, fiber: ing?.fiber ?? 0, hybrid_water: ing?.hybrid_water ?? 0 };
        }),
      } satisfies MixUse];
    });

    const mainLiquids = readLinks("main_liquid_ingredient_id", "main_liquid_percentage")
      .map((link) => ({ ingredient_id: link.id, name: state.ingredients.get(link.id)?.name ?? link.id, percentage: link.amount }));

    return { hydration_percent: Number.isFinite(hydration) ? hydration : 65, servings, ingredients: [...seen.values()], mixes: mixUses, main_liquids: mainLiquids };
  }

  function recompute(): void {
    const input = collectForm();
    if (!input) return;
    const view = buildRecipeView(input, input.servings);

    panel.textContent = [
      `Flour (from mixes): ${grams(view.flour_weight_from_mixes)}`,
      `Target water (${pct(input.hydration_percent)}): ${grams(view.target_water)}`,
      `Water in liquid/hybrid ingredients: ${grams(view.water_from_liquids)}`,
      ...view.liquid_ingredients.map((i) => `   — ${i.name}: ${grams(i.amount)}${i.category === "hybrid" ? ` → ${grams(i.amount * i.hybrid_water)} water` : ""}`),
      ...(view.main_liquids.length > 0 ? [`   Main liquids to weigh out:`] : []),
      ...view.main_liquids.map((m) => `   — ${m.name}: ${grams(m.amount)} (${pct(m.percentage)})`),
      view.main_liquid_percentage_total > 0 && Math.abs(view.main_liquid_percentage_total - 100) > 0.01 ? `   ! main liquids add up to ${pct(view.main_liquid_percentage_total)}, not 100%` : "",
      `Total liquid: ${grams(view.total_liquid)} · effective hydration ${view.effective_hydration_percent.toFixed(1)}%`,
      `Cost: ${euro(view.total_cost)} total · ${euro(view.cost_per_serving)} per serving`,
      `Per serving: ${num(view.nutrition_per_serving.calories, 0)} kcal · P ${num(view.nutrition_per_serving.protein)}/F ${num(view.nutrition_per_serving.fats)}/C ${num(view.nutrition_per_serving.carbs)} g`,
    ].join("\n");
    gaugeSlot.replaceChildren(waterSplit(view.target_water, view.water_from_liquids));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = await runUi(recipeInputFromForm(new FormData(form)));
    if (!input) return;
    const saved = await runUi(ctx.app.repo.saveRecipe(input));
    if (!saved) return;
    ctx.markChanged();
    toast(`Saved recipe "${String(saved[0]!.cols.name)}".`);
    ctx.navigate(`/recipes/${String(saved[0]!.cols.id)}`);
  });

  clear(mountPoint);
  mountPoint.append(pageHead(recipe ? "Edit recipe" : "New recipe", "/recipes"), form);
  recompute();
}
