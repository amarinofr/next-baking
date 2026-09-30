/** Ingredient & flour-mix forms (create and edit share one implementation), styled like the old app. */

import { mixCostPerKg, mixNutritionPer100g } from "../../domain/calc.ts";
import { componentsOf, mixTotalGrams } from "../../domain/state.ts";
import type { Ingredient } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, runAction, runUi, toast } from "../dom.ts";
import { ingredientInputFromForm, mixInputFromForm } from "../app.ts";
import type { ViewCtx } from "./context.ts";

const text = (name: string, label: string, value = "", placeholder = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "text", value, placeholder }));

const number = (name: string, label: string, value: number | string, placeholder = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "number", step: "any", value: String(value), placeholder }));

const select = (name: string, label: string, options: Array<[value: string, label: string]>, selected?: string): HTMLElement =>
  el("div", { class: "field" },
    el("label", { for: name }, label),
    el("select", { id: name, name }, ...options.map(([value, text2]) => el("option", { value, selected: selected === value ? "selected" : undefined }, text2))),
  );

const pageHead = (title: string, cancelHref: string): HTMLElement =>
  el("div", { class: "page-head" }, el("h2", {}, title), el("a", { class: "plain", href: cancelHref }, "Cancel"));

const saveRow = (caption: string): HTMLElement => el("div", { class: "right" }, el("button", { class: "primary save", type: "submit" }, caption));

// ---------------- ingredient ----------------

export function renderIngredientForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const existing = editingId ? ctx.state.ingredients.get(editingId) : undefined;
  if (editingId && !existing) toast(`Ingredient ${editingId} was not found on this device.`, "err");

  const ing: Partial<Ingredient> = existing ?? { category: "dry", price: 0, calories: 0, protein: 0, fats: 0, carbs: 0, sugar: 0, fiber: 0, hybrid_water: 0 };

  const form = el("form", { class: "max-w" });

  const waterField = number("water_percent", "Water Percentage (%)", ing.category === "hybrid" ? (ing.hybrid_water ?? 0) * 100 : 0);
  waterField.classList.toggle("hidden", ing.category !== "hybrid");

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",
    text("name", "Name", ing.name ?? ""),
    select("category", "Type", [["dry", "Dry"], ["hybrid", "Hybrid"], ["liquid", "Liquid"]], ing.category ?? "dry"),
    waterField,
    number("price", "Price (€/1000g)", ing.price ?? 0),

    // Nutrition lives behind a disclosure, exactly as in the original form.
    el("details", { class: "nutrition" },
      el("summary", {}, "Nutrition per 100g (optional)"),
      el("div", { class: "inner" },
        el("div", {}, el("label", {}, "Calories"), number2("calories", ing.calories ?? 0)),
        el("div", {}, el("label", {}, "Protein (g)"), number2("protein", ing.protein ?? 0)),
        el("div", {}, el("label", {}, "Fats (g)"), number2("fats", ing.fats ?? 0)),
        el("div", {}, el("label", {}, "Carbs (g)"), number2("carbs", ing.carbs ?? 0)),
        el("div", {}, el("label", {}, "Sugar (g)"), number2("sugar", ing.sugar ?? 0)),
        el("div", {}, el("label", {}, "Fiber (g)"), number2("fiber", ing.fiber ?? 0)),
      ),
    ),

    saveRow(existing ? "Save" : "Save"),
    el("p", { class: "hint" }, "Prices are always €/1000 g · nutrition per 100 g · metric only."),
  );

  function number2(name: string, value: number): HTMLElement {
    return el("input", { id: name, name, type: "number", step: "any", value: String(value) });
  }

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
  mountPoint.append(pageHead(existing ? "Edit Ingredient" : "Create New Ingredient", "/ingredients"));

  if (existing) {
    const deleteButton = el("button", { class: "danger-solid", type: "button" }, `Delete "${existing.name}"`);
    deleteButton.addEventListener("click", () => {
      if (!askConfirm(`Delete "${existing.name}"? Mixes and recipes using it will lose those rows.`)) return;
      runAction(ctx.app.repo.deleteIngredient(existing.id)).then((done) => { if (!done) return; ctx.markChanged(); ctx.navigate("/ingredients"); });
    });
    mountPoint.append(el("div", { class: "right" }, deleteButton));
  }

  mountPoint.append(form);
}

// ---------------- flour mix ----------------

export function renderMixForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const state = ctx.state;
  const mix = editingId ? state.mixes.get(editingId) : undefined;
  const ingredients = [...state.ingredients.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (editingId && !mix) toast(`Flour mix ${editingId} was not found on this device.`, "err");

  const options: Array<[string, string]> = [
    ["", "-- Select --"],
    ...ingredients.map((i) => [i.id, `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)`] as [string, string]),
  ];

  const rowsWrap = el("div", { class: "rows" });
  const preview = el("pre", { class: "preview" });

  const makeRow = (ingredientId = "", amount: number | string = ""): HTMLElement => {
    const row = el("div", { class: "row component-row" },
      el("select", { name: "ingredient_id" }, ...options.map(([value, label]) => el("option", { value, selected: ingredientId === value ? "selected" : undefined }, label))),
      el("input", { name: "amount", type: "number", step: "any", placeholder: "g", value: String(amount) }),
    );
    const remove = el("button", { class: "remove", type: "button" }, "remove");
    remove.addEventListener("click", () => { row.remove(); updatePreview(); });
    row.append(remove);
    row.querySelectorAll("select, input").forEach((node) => node.addEventListener("change", updatePreview));
    rowsWrap.append(row);
    return row;
  };

  function updatePreview(): void {
    const selects = [...rowsWrap.querySelectorAll<HTMLSelectElement>("select[name=ingredient_id]")];
    const amounts = [...rowsWrap.querySelectorAll<HTMLInputElement>("input[name=amount]")].map((input) => Number(input.value) || 0);

    let total = 0;
    const comps: Array<{ amount: number; price: number; calories: number; protein: number; fats: number; carbs: number; sugar: number; fiber: number }> = [];

    selects.forEach((sel, i) => {
      const ingredient = state.ingredients.get(sel.value);
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

  const addButton = el("button", { class: "add-row", type: "button" }, "+ Add Row");
  addButton.addEventListener("click", () => { makeRow(); updatePreview(); });

  const form = el("form", { class: "max-w" });
  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",
    text("name", "Name", mix?.name ?? ""),
    el("div", { class: "field" },
      el("div", { class: "form-head-row" }, el("span", {}, "Ingredients"), addButton),
      rowsWrap,
    ),
    preview,
    saveRow("Save"),
  );

  for (const comp of editingId ? componentsOf(state, editingId) : []) makeRow(comp.ingredient_id, comp.amount);
  if (editingId && componentsOf(state, editingId).length === 0) makeRow();
  if (!editingId) makeRow();

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
  mountPoint.append(pageHead(mix ? "Edit Flour Mix" : "Create New Flour Mix", "/mixes"));

  if (mix) {
    const deleteButton = el("button", { class: "danger-solid", type: "button" }, `Delete "${mix.name}"`);
    deleteButton.addEventListener("click", () => {
      if (!askConfirm(`Delete mix "${mix.name}"? Recipes using it will lose that mix.`)) return;
      runAction(ctx.app.repo.deleteMix(mix.id)).then((done) => { if (!done) return; ctx.markChanged(); ctx.navigate("/mixes"); });
    });
    mountPoint.append(el("div", { class: "right" }, deleteButton));
  }

  mountPoint.append(form);
  updatePreview();
}

/** Grams a mix's components add up to (shown in the list too). */
export const mixBatchLabel = (components: ReadonlyArray<{ amount: number }>): string => grams(mixTotalGrams(components));
