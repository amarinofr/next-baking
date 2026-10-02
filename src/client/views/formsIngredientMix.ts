/** Ingredient & flour-mix forms (create and edit share one implementation), built from the same boxes as the recipe editor. */

import { mixCostPerKg, mixNutritionPer100g } from "../../domain/calc.ts";
import { componentsOf, mixTotalGrams } from "../../domain/state.ts";
import type { Ingredient } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, runAction, runUi, toast } from "../dom.ts";
import { ingredientInputFromForm, mixInputFromForm } from "../app.ts";
import { actionsRow, basicsPanel, figuresBlock, figuresPanel, groupSheet, numberField, pageHead, selectField, textField } from "./formKit.ts";
import type { ViewCtx } from "./context.ts";

// ---------------- ingredient ----------------

export function renderIngredientForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const existing = editingId ? ctx.state.ingredients.get(editingId) : undefined;
  if (editingId && !existing) toast(`Ingredient ${editingId} was not found on this device.`, "err");

  const ing: Partial<Ingredient> = existing ?? { category: "dry", price: 0, calories: 0, protein: 0, fats: 0, carbs: 0, sugar: 0, fiber: 0, hybrid_water: 0 };

  const form = el("form", { class: "max-w" });

  const waterField = numberField("water_percent", "Water Percentage (%)", ing.category === "hybrid" ? (ing.hybrid_water ?? 0) * 100 : 0);
  waterField.classList.toggle("hidden", ing.category !== "hybrid");

  const nutritionInput = (name: string, value: number): HTMLElement =>
    el("input", { id: name, name, type: "number", step: "any", value: String(value) });

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",

    basicsPanel(
      textField("name", "Name", ing.name ?? ""),
      selectField("category", "Type", [["dry", "Dry"], ["hybrid", "Hybrid"], ["liquid", "Liquid"]], ing.category ?? "dry"),
      waterField,
      numberField("price", "Price (€/1000g)", ing.price ?? 0),

      // Nutrition lives behind a disclosure, exactly as in the original form.
      el("details", { class: "nutrition" },
        el("summary", {}, "Nutrition per 100g (optional)"),
        el("div", { class: "inner" },
          el("div", {}, el("label", {}, "Calories"), nutritionInput("calories", ing.calories ?? 0)),
          el("div", {}, el("label", {}, "Protein (g)"), nutritionInput("protein", ing.protein ?? 0)),
          el("div", {}, el("label", {}, "Fats (g)"), nutritionInput("fats", ing.fats ?? 0)),
          el("div", {}, el("label", {}, "Carbs (g)"), nutritionInput("carbs", ing.carbs ?? 0)),
          el("div", {}, el("label", {}, "Sugar (g)"), nutritionInput("sugar", ing.sugar ?? 0)),
          el("div", {}, el("label", {}, "Fiber (g)"), nutritionInput("fiber", ing.fiber ?? 0)),
        ),
      ),
    ),

    actionsRow(existing ? deleteControl(ctx, existing.id, existing.name, `Mixes and recipes using it will lose those rows.`, "/ingredients") : undefined),
    el("p", { class: "hint" }, "Prices are always €/1000 g · nutrition per 100 g · metric only."),
  );

  const categorySelect = form.querySelector<HTMLSelectElement>("select[name=category]")!;
  categorySelect.addEventListener("change", () => waterField.classList.toggle("hidden", categorySelect.value !== "hybrid"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = await runUi(ingredientInputFromForm(new FormData(form)));
    if (!input) return;
    const saved = await runUi(ctx.app.repo.saveIngredient(input));
    if (!saved) return;
    ctx.markChanged();
    toast(`Saved "${String(saved.cols.name)}".`);
    ctx.navigate("/ingredients");
  });

  clear(mountPoint);
  mountPoint.append(pageHead(existing ? "Edit ingredient" : "New ingredient", "/ingredients"), form);
}

/** The destructive control every editor puts beside Save. */
function deleteControl(ctx: ViewCtx, id: string, name: string, consequence: string, backTo: string): HTMLElement {
  const button = el("button", { class: "danger-solid", type: "button" }, `Delete "${name}"`);
  button.addEventListener("click", () => {
    if (!askConfirm(`Delete "${name}"? ${consequence}`)) return;
    const removal = backTo === "/ingredients" ? ctx.app.repo.deleteIngredient(id) : ctx.app.repo.deleteMix(id);
    runAction(removal).then((done) => { if (!done) return; ctx.markChanged(); ctx.navigate(backTo); });
  });
  return button;
}

// ---------------- flour mix ----------------

export function renderMixForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const state = ctx.state;
  const mix = editingId ? state.mixes.get(editingId) : undefined;
  const ingredients = [...state.ingredients.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (editingId && !mix) toast(`Flour mix ${editingId} was not found on this device.`, "err");

  const options: Array<[string, string]> = [
    ["", "Select an ingredient…"],
    ...ingredients.map((i) => [i.id, `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)`] as [string, string]),
  ];

  const preview = figuresBlock();

  const components = editingId ? componentsOf(state, editingId) : [];

  const form = el("form", { class: "max-w" });
  const componentSheet = groupSheet({
    title: "Ingredients",
    nameKey: "ingredient_id",
    amountKey: "amount",
    options,
    unit: "g",
    sheet: "sheet-butter",   // a mix is flour, so it wears the same paper as a recipe's flour mixes
    existing: components.map((c) => ({ idOrMix: c.ingredient_id, amount: c.amount })),
    onChange: () => updatePreview(),
  });

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",

    basicsPanel(textField("name", "Name", mix?.name ?? "")),
    componentSheet,
    figuresPanel("While you edit", preview),
    actionsRow(mix ? deleteControl(ctx, mix.id, mix.name, `Recipes using it will lose that mix.`, "/mixes") : undefined),
  );

  function updatePreview(): void {
    const selects = [...componentSheet.querySelectorAll<HTMLSelectElement>("select[name=ingredient_id]")];
    const amounts = [...componentSheet.querySelectorAll<HTMLInputElement>("input[name=amount]")].map((input) => Number(input.value) || 0);

    let total = 0;
    const comps: Array<{ amount: number; price: number; calories: number; protein: number; fats: number; carbs: number; sugar: number; fiber: number }> = [];

    selects.forEach((select, i) => {
      const ingredient = state.ingredients.get(select.value);
      const amount = amounts[i] ?? 0;
      if (!ingredient || amount <= 0) return;
      total += amount;
      comps.push({ amount, price: ingredient.price, calories: ingredient.calories, protein: ingredient.protein, fats: ingredient.fats, carbs: ingredient.carbs, sugar: ingredient.sugar, fiber: ingredient.fiber });
    });

    const nutrition = mixNutritionPer100g(comps);
    const perKg = mixCostPerKg(comps);

    preview.textContent = [
      `Mix total:   ${grams(total)}`,
      `Cost of mix: ${euro(perKg)} per kg`,
      `Per 100 g:   ${num(nutrition.calories, 0)} kcal · protein ${num(nutrition.protein)}/${num(nutrition.fats)}/${num(nutrition.carbs)} g`,
      total > 0 ? `Recipes scale this mix proportionally (${grams(total)} = the whole mix).` : "",
    ].filter(Boolean).join("\n");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = await runUi(mixInputFromForm(new FormData(form)));
    if (!input) return;
    const saved = await runUi(ctx.app.repo.saveMix(input));
    if (!saved) return;
    ctx.markChanged();
    toast(`Saved mix "${String(saved[0]!.cols.name)}".`);
    ctx.navigate("/mixes");
  });

  clear(mountPoint);
  mountPoint.append(pageHead(mix ? "Edit flour mix" : "New flour mix", "/mixes"), form);
  updatePreview();
}

/** Grams a mix's components add up to (shown in the list too). */
export const mixBatchLabel = (components: ReadonlyArray<{ amount: number }>): string => grams(mixTotalGrams(components));
