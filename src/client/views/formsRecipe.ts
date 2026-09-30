/** Recipe create/edit form with a live hydration · cost · nutrition panel. */

import { buildRecipeView, type IngredientUse, type MixUse, type RecipeMathInput } from "../../domain/calc.ts";
import { componentsOf, recipeMathInput } from "../../domain/state.ts";
import type { Recipe } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, pct, runAction, runUi, toast } from "../dom.ts";
import { recipeInputFromForm } from "../app.ts";
import { type ViewCtx } from "./context.ts";

const text = (name: string, label: string, value = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "text", value }));

const number = (name: string, label: string, value: number | string, opts: Record<string, string> = {}): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "number", step: "any", value: String(value), ...opts }));

const picker = (name: string, options: Array<[string, string]>, selected?: string): HTMLElement =>
  el("select", { name }, ...options.map(([value, label]) => el("option", { value, selected: selected === value ? "selected" : undefined }, label)));

/** Category picker. If this device has no categories yet we keep the stored value untouched. */
function categoryField(ctx: ViewCtx, recipe?: Recipe): HTMLElement {
  const stored = recipe?.category_id ?? "";
  const options = [...ctx.state.categories.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (options.length === 0) return el("input", { type: "hidden", name: "category_id", value: stored });

  const select = el("select", { name: "category_id" }) as HTMLSelectElement;
  select.append(el("option", { value: "" }, "— no category —"));
  for (const category of options) select.append(el("option", { value: category.id }, category.name));
  select.value = options.some((c) => c.id === stored) ? stored : "";
  return el("div", { class: "field" }, el("label", {}, "Category"), select);
}

export function renderRecipeForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const state = ctx.state;
  const recipe = editingId ? state.recipes.get(editingId) : undefined;
  if (editingId && !recipe) toast(`Recipe ${editingId} was not found on this device.`, "err");

  const ingredients = [...state.ingredients.values()].sort((a, b) => a.name.localeCompare(b.name));
  const dryIngredients = ingredients.filter((i) => i.category === "dry");
  const wetIngredients = ingredients.filter((i) => i.category !== "dry");
  const mixes = [...state.mixes.values()].sort((a, b) => a.name.localeCompare(b.name));

  const ingredientLabel = (id: string): string => {
    const i = state.ingredients.get(id);
    return i ? `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)` : id;
  };

  const mixOptions: Array<[string, string]> = [["", "-- select flour mix --"], ...mixes.map((m) => [m.id, m.name] as [string, string])];
  const dryOptions: Array<[string, string]> = [["", "-- select ingredient --"], ...dryIngredients.map((i) => [i.id, ingredientLabel(i.id)] as [string, string])];
  const wetOptions: Array<[string, string]> = [["", "-- select ingredient --"], ...wetIngredients.map((i) => [i.id, ingredientLabel(i.id)] as [string, string])];

  const rowsOf = (nameKey: string, amountKey: string, options: Array<[string, string]>, existing: Array<{ idOrMix: string; amount: number }> = []): HTMLElement => {
    const wrap = el("div", { class: "rows" });
    const addRow = (selectValue = "", amount: number | string = ""): HTMLElement => {
      const row = el("div", { class: "row" }, picker(nameKey, options, selectValue), el("input", { name: amountKey, type: "number", step: "any", placeholder: "g", value: String(amount) }));
      const remove = el("button", { class: "ghost small", type: "button" }, "remove");
      remove.addEventListener("click", () => { row.remove(); recompute(); });
      row.append(remove);
      row.querySelectorAll("select, input").forEach((node) => node.addEventListener("change", recompute));
      wrap.append(row);
      return row;
    };
    for (const item of existing) addRow(item.idOrMix, item.amount);
    if (existing.length === 0) addRow();
    return wrap;
  };

  const form = el("form", { class: "panel stack" });
  const panel = el("div", { class: "kv" });

  const previousInput = editingId ? recipeMathInput(state, editingId) : undefined;

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",
    el("div", { class: "inline-fields" },
      text("name", "Recipe name", recipe?.name ?? ""),
      number("servings", "Servings", recipe?.servings ?? 1),
      number("hydration_percent", "Hydration %", recipe?.hydration_percent ?? 65),
      categoryField(ctx, recipe),
    ),
    el("div", { class: "field" }, el("label", { for: "instructions" }, "Instructions"), el("textarea", { id: "instructions", name: "instructions" }, recipe?.instructions ?? "")),
  );

  const section = (title: string, nameKey: string, amountKey: string, options: Array<[string, string]>, existing: Array<{ idOrMix: string; amount: number }>): HTMLElement => {
    const rows = rowsOf(nameKey, amountKey, options, existing);
    const addButton = el("button", { class: "small", type: "button" }, "+ Add");
    addButton.addEventListener("click", () => { addInto(rows, nameKey, amountKey, options); recompute(); });
    return el("section", {}, el("h3", {}, title), rows, addButton);
  };

  function addInto(rows: HTMLElement, nameKey: string, amountKey: string, options: Array<[string, string]>): void {
    const row = el("div", { class: "row" }, picker(nameKey, options), el("input", { name: amountKey, type: "number", step: "any", placeholder: "g" }));
    const remove = el("button", { class: "ghost small", type: "button" }, "remove");
    remove.addEventListener("click", () => { row.remove(); recompute(); });
    row.append(remove);
    row.querySelectorAll("select, input").forEach((node) => node.addEventListener("change", recompute));
    rows.append(row);
  }

  const mixSection = section("Flour mixes (the hydration base)", "mix_id", "mix_amount", mixOptions,
    (previousInput?.mixes ?? []).map((m) => ({ idOrMix: m.mix_id, amount: m.amount })));
  const drySection = section("Dry ingredients", "dry_ingredient_id", "dry_ingredient_amount", dryOptions,
    (previousInput?.ingredients ?? []).filter((i) => i.category === "dry").map((i) => ({ idOrMix: i.ingredient_id, amount: i.amount })));
  const wetSection = section("Liquid & hybrid ingredients", "liquid_ingredient_id", "liquid_ingredient_amount", wetOptions,
    (previousInput?.ingredients ?? []).filter((i) => i.category !== "dry").map((i) => ({ idOrMix: i.ingredient_id, amount: i.amount })));
  const mainLiquidSection = section("Main liquids (share of the target water)", "main_liquid_ingredient_id", "main_liquid_percentage", wetOptions,
    (previousInput?.main_liquids ?? []).map((l) => ({ idOrMix: l.ingredient_id, amount: l.percentage })));

  form.append(mixSection, drySection, wetSection, mainLiquidSection);

  // percentages belong to the "percentage" column, not grams — relabel those inputs
  mainLiquidSection.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.placeholder = "%"; });

  form.append(el("hr", { class: "sep" }), el("h3", {}, "Live breakdown"), panel,
    el("div", { class: "right" }, el("button", { class: "primary", type: "submit" }, recipe ? "Save changes" : "Create recipe")));

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
    const seenIngredients = new Map<string, IngredientUse>();
    for (const link of directIds) {
      const ing = state.ingredients.get(link.id);
      if (!ing) continue;
      const existingRow = seenIngredients.get(link.id);
      if (existingRow) existingRow.amount += link.amount;
      else seenIngredients.set(link.id, {
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

    return { hydration_percent: Number.isFinite(hydration) ? hydration : 65, servings, ingredients: [...seenIngredients.values()], mixes: mixUses, main_liquids: mainLiquids };
  }

  function recompute(): void {
    const input = collectForm();
    if (!input) return;
    const view = buildRecipeView(input, input.servings);

    clear(panel);
    panel.append(
      el("span", {}, "Flour weight (from mixes)"), el("b", {}, grams(view.flour_weight_from_mixes)),
      el("span", {}, `Target water (${pct(input.hydration_percent)})`), el("b", {}, grams(view.target_water)),
      el("span", {}, "Water from liquid/hybrid ingredients"), el("b", {}, grams(view.water_from_liquids)),
      ...view.liquid_ingredients.map((i) => el("span", { class: "sub-list" }, `${i.name}: ${grams(i.amount)}${i.category === "hybrid" ? ` → ${grams(i.amount * i.hybrid_water)} water` : ""}`)),
      ...(view.main_liquids.length > 0 ? [el("span", { class: "muted" }, "Main liquids to weigh out")] : []),
      ...view.main_liquids.map((m) => el("span", { class: "sub-list" }, `${m.name}: ${grams(m.amount)} (${pct(m.percentage)})`)),
      view.main_liquid_percentage_total > 0 && Math.abs(view.main_liquid_percentage_total - 100) > 0.01
        ? el("span", { class: "notice" }, `Main liquids total ${pct(view.main_liquid_percentage_total)} — should be 100%`) : "",
      el("hr", { class: "sep" }),
      el("span", {}, "Total liquid"), el("b", { class: "total" }, grams(view.total_liquid)),
      el("span", {}, "Effective hydration"), el("b", {}, pct(view.effective_hydration_percent)),
      el("span", {}, "Cost (whole recipe / per serving)"), el("b", {}, `${euro(view.total_cost)} / ${euro(view.cost_per_serving)}`),
      el("span", {}, "Per serving (kcal · P/F/C)"), el("b", {}, `${num(view.nutrition_per_serving.calories, 0)} · ${num(view.nutrition_per_serving.protein)}/${num(view.nutrition_per_serving.fats)}/${num(view.nutrition_per_serving.carbs)} g`),
      el("span", {}, "Per 100 g (kcal · P/F/C)"), el("b", {}, `${num(view.nutrition_per_100g.calories, 0)} · ${num(view.nutrition_per_100g.protein)}/${num(view.nutrition_per_100g.fats)}/${num(view.nutrition_per_100g.carbs)} g`),
    );
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = await runUi(recipeInputFromForm(new FormData(form)));
    if (!input) return;
    const saved = await runUi(ctx.app.repo.saveRecipe(input));
    if (!saved) return;
    const id = String(saved[0]!.cols.id);
    toast(`Saved recipe "${String(saved[0]!.cols.name)}".`);
    ctx.navigate(`/recipe?id=${id}`);
  });

  clear(mountPoint);
  mountPoint.append(el("div", { class: "page-head" }, el("h2", {}, recipe ? "Edit recipe" : "New recipe"), el("a", { class: "btn ghost small", href: "/recipes" }, "cancel")));

  if (recipe) {
    const deleteButton = el("button", { class: "danger", type: "button" }, `Delete "${recipe.name}"`);
    deleteButton.addEventListener("click", () => {
      if (!askConfirm(`Delete recipe "${recipe.name}"?`)) return;
      runAction(ctx.app.repo.deleteRecipe(recipe.id)).then((done) => { if (done) ctx.navigate("/recipes"); });
    });
    mountPoint.append(el("section", { class: "panel" }, deleteButton));
  }

  mountPoint.append(form);
  recompute();
}
