/** Recipe create/edit form with a live hydration · cost · nutrition breakdown. */

import { buildRecipeView, type IngredientUse, type MixUse, type RecipeMathInput } from "../../domain/calc.ts";
import { componentsOf, recipeMathInput } from "../../domain/state.ts";
import type { Recipe } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, pct, runAction, runUi, toast } from "../dom.ts";
import { recipeInputFromForm } from "../app.ts";
import { type ViewCtx } from "./context.ts";

const text = (name: string, label: string, value = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "text", value }));

const number = (name: string, label: string, value: number | string): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "number", step: "any", value: String(value) }));

const picker = (name: string, options: Array<[string, string]>, selected?: string): HTMLElement =>
  el("select", { name }, ...options.map(([value, label]) => el("option", { value, selected: selected === value ? "selected" : undefined }, label)));

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

  const mixOptions: Array<[string, string]> = [["", "-- Select --"], ...mixes.map((m) => [m.id, m.name] as [string, string])];
  const dryOptions: Array<[string, string]> = [["", "-- Select --"], ...dryIngredients.map((i) => [i.id, labelOf(i.id)] as [string, string])];
  const wetOptions: Array<[string, string]> = [["", "-- Select --"], ...wetIngredients.map((i) => [i.id, labelOf(i.id)] as [string, string])];

  const panel = el("pre", { class: "preview" });
  const previousInput = editingId ? recipeMathInput(state, editingId) : undefined;

  const form = el("form", { class: "max-w" });

  // ---- the row editors (flour mixes / dry / liquid+hybrid / main liquids) ----
  const section = (
    title: string,
    nameKey: string,
    amountKey: string,
    options: Array<[string, string]>,
    existing: Array<{ idOrMix: string; amount: number }>,
    unit: "g" | "%",
  ): HTMLElement => {
    const rows = el("div", { class: "rows" });

    const addRow = (selectValue = "", amount: number | string = ""): HTMLElement => {
      const row = el("div", { class: "row component-row" },
        picker(nameKey, options, selectValue),
        el("input", { name: amountKey, type: "number", step: "any", placeholder: unit, value: String(amount) }),
      );
      const remove = el("button", { class: "remove", type: "button" }, "remove");
      remove.addEventListener("click", () => { row.remove(); recompute(); });
      row.append(remove);
      row.querySelectorAll("select, input").forEach((node) => node.addEventListener("change", recompute));
      rows.append(row);
      return row;
    };

    for (const item of existing) addRow(item.idOrMix, item.amount);
    if (existing.length === 0) addRow();

    const addButton = el("button", { class: "add-row", type: "button" }, "+ Add Row");
    addButton.addEventListener("click", () => { addRow(); recompute(); });

    return el("div", { class: "field" },
      el("div", { class: "form-head-row" }, el("span", {}, title), addButton),
      rows,
    );
  };

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",
    text("name", "Name", recipe?.name ?? ""),
    el("div", { class: "row" }, number("servings", "Servings", recipe?.servings ?? 1), number("hydration_percent", "Hydration (%)", recipe?.hydration_percent ?? 65)),
    categoryField(ctx, recipe),
    el("div", { class: "field" }, el("label", { for: "instructions" }, "Instructions"), el("textarea", { id: "instructions", name: "instructions" }, recipe?.instructions ?? "")),

    section("Flour Mixes (the hydration base)", "mix_id", "mix_amount", mixOptions,
      (previousInput?.mixes ?? []).map((m) => ({ idOrMix: m.mix_id, amount: m.amount })), "g"),

    section("Dry Ingredients", "dry_ingredient_id", "dry_ingredient_amount", dryOptions,
      (previousInput?.ingredients ?? []).filter((i) => i.category === "dry").map((i) => ({ idOrMix: i.ingredient_id, amount: i.amount })), "g"),

    section("Liquid & Hybrid Ingredients", "liquid_ingredient_id", "liquid_ingredient_amount", wetOptions,
      (previousInput?.ingredients ?? []).filter((i) => i.category !== "dry").map((i) => ({ idOrMix: i.ingredient_id, amount: i.amount })), "g"),

    section("Main Liquids (share of the target water)", "main_liquid_ingredient_id", "main_liquid_percentage", wetOptions,
      (previousInput?.main_liquids ?? []).map((l) => ({ idOrMix: l.ingredient_id, amount: l.percentage })), "%"),

    panel,
    el("div", { class: "right" }, el("button", { class: "primary save", type: "submit" }, recipe ? "Save" : "Save")),
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
  mountPoint.append(el("div", { class: "page-head" }, el("h2", {}, recipe ? "Edit Recipe" : "Create New Recipe"), el("a", { class: "plain", href: "/recipes" }, "Cancel")));

  if (recipe) {
    const deleteButton = el("button", { class: "danger-solid", type: "button" }, `Delete "${recipe.name}"`);
    deleteButton.addEventListener("click", () => {
      if (!askConfirm(`Delete recipe "${recipe.name}"?`)) return;
      runAction(ctx.app.repo.deleteRecipe(recipe.id)).then((done) => { if (!done) return; ctx.markChanged(); ctx.navigate("/recipes"); });
    });
    mountPoint.append(el("div", { class: "right" }, deleteButton));
  }

  mountPoint.append(form);
  recompute();
}
