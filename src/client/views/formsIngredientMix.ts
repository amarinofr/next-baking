/** Ingredient & flour-mix forms (create + edit share one implementation). */

import { mixCostPerKg, mixNutritionPer100g } from "../../domain/calc.ts";
import { componentsOf } from "../../domain/state.ts";
import type { AppState } from "../../domain/state.ts";
import type { Ingredient } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, runAction, runUi, toast } from "../dom.ts";
import { ingredientInputFromForm, mixInputFromForm } from "../app.ts";
import type { ViewCtx } from "./context.ts";

const text = (name: string, label: string, value = "", placeholder = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "text", value, placeholder }));

const number = (name: string, label: string, value: number | string, opts: Record<string, string | number> = {}): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "number", step: "any", value: String(value), ...opts }));

const select = (name: string, label: string, options: Array<[value: string, label: string]>, selected?: string): HTMLElement =>
  el("div", { class: "field" },
    el("label", { for: name }, label),
    el("select", { id: name, name }, ...options.map(([value, text2]) => el("option", { value, selected: selected === value ? "selected" : undefined }, text2))),
  );

const submitRow = (caption: string): HTMLElement =>
  el("div", { class: "right" }, el("button", { class: "primary", type: "submit" }, caption));

// ---------------- ingredient ----------------

export function renderIngredientForm(ctx: ViewCtx, mountPoint: HTMLElement, editingId?: string): void {
  const existing = editingId ? ctx.state.ingredients.get(editingId) : undefined;
  if (editingId && !existing) { toast(`Ingredient ${editingId} was not found on this device.`, "err"); }

  const ing: Partial<Ingredient> = existing ?? { category: "dry", price: 0, calories: 0, protein: 0, fats: 0, carbs: 0, sugar: 0, fiber: 0, hybrid_water: 0 };

  const form = el("form", { class: "panel stack" });

  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",
    el("div", { class: "inline-fields" },
      text("name", "Name", ing.name ?? ""),
      select("category", "Type", [["dry", "dry"], ["hybrid", "hybrid (contains water)"], ["liquid", "liquid"]], ing.category ?? "dry"),
      number("price", "Price (€ per 1000 g)", ing.price ?? 0),
    ),
  );

  const waterField = number("water_percent", "Water content (%)", ing.category === "hybrid" ? (ing.hybrid_water ?? 0) * 100 : 0);
  waterField.style.display = ing.category === "hybrid" ? "" : "none";
  form.append(waterField);

  form.append(
    el("h3", {}, "Nutrition per 100 g"),
    el("div", { class: "inline-fields" },
      number("calories", "kcal", ing.calories ?? 0), number("protein", "protein", ing.protein ?? 0), number("fats", "fats", ing.fats ?? 0),
      number("carbs", "carbs", ing.carbs ?? 0), number("sugar", "sugar", ing.sugar ?? 0), number("fiber", "fiber", ing.fiber ?? 0),
    ),
    submitRow(existing ? "Save changes" : "Create ingredient"),
    el("p", { class: "small muted" }, "Prices are always €/1000 g · nutrition per 100 g · metric only."),
  );

  const categorySelect = form.querySelector<HTMLSelectElement>("select[name=category]")!;
  categorySelect.addEventListener("change", () => { waterField.style.display = categorySelect.value === "hybrid" ? "" : "none"; });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = await runUi(ingredientInputFromForm(new FormData(form)));
    if (!input) return;
    const saved = await runUi(ctx.app.repo.saveIngredient(input));
    if (!saved) return;
    toast(`Saved "${String(saved.cols.name)}".`);
    ctx.navigate("/ingredients");
  });

  clear(mountPoint);
  mountPoint.append(el("div", { class: "page-head" }, el("h2", {}, existing ? `Edit ingredient` : "New ingredient"), el("a", { class: "btn ghost small", href: "/ingredients" }, "cancel")));

  if (existing) {
    const deleteButton = el("button", { class: "danger", type: "button" }, `Delete "${existing.name}"`);
    deleteButton.addEventListener("click", () => {
      if (!askConfirm(`Delete "${existing.name}"? Mixes and recipes using it will lose those rows.`)) return;
      runAction(ctx.app.repo.deleteIngredient(existing.id)).then((done) => { if (done) ctx.navigate("/ingredients"); });
    });
    mountPoint.append(el("section", { class: "panel" }, deleteButton));
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
    ["", "-- select ingredient --"],
    ...ingredients.map((i) => [i.id, `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)`] as [string, string]),
  ];

  const rowsWrap = el("div", { class: "rows" });
  const preview = el("div", { class: "kv" });

  const makeRow = (ingredientId = "", amount: number | string = ""): HTMLElement => {
    const row = el("div", { class: "row" },
      select2("ingredient_id", options, ingredientId),
      el("input", { name: "amount", type: "number", step: "any", placeholder: "g", value: String(amount) }),
      el("span", { class: "row-preview muted" }, ""),
    );
    const remove = el("button", { class: "ghost small", type: "button" }, "remove");
    remove.addEventListener("click", () => { row.remove(); updatePreview(); });
    row.append(remove);
    row.querySelectorAll("select, input").forEach((node) => node.addEventListener("change", updatePreview));
    return row;
  };

  function select2(name: string, opts: Array<[string, string]>, selected?: string): HTMLElement {
    return el("select", { name }, ...opts.map(([value, label]) => el("option", { value, selected: selected === value ? "selected" : undefined }, label)));
  }

  function updatePreview(): void {
    clear(preview);
    const ids = [...rowsWrap.querySelectorAll<HTMLSelectElement>("select[name=ingredient_id]")].map((s) => s.value);
    const amounts = [...rowsWrap.querySelectorAll<HTMLInputElement>("input[name=amount]")].map((i) => Number(i.value) || 0);

    let totalGrams = 0; let cost = 0;
    const comps: Array<{ amount: number; price: number; calories: number; protein: number; fats: number; carbs: number; sugar: number; fiber: number }> = [];

    ids.forEach((id, i) => {
      const ingredient = state.ingredients.get(id);
      if (!ingredient || !amounts[i]) return;
      totalGrams += amounts[i];
      cost += (amounts[i] * ingredient.price) / 1000;
      comps.push({ amount: amounts[i], price: ingredient.price, calories: ingredient.calories, protein: ingredient.protein, fats: ingredient.fats, carbs: ingredient.carbs, sugar: ingredient.sugar, fiber: ingredient.fiber });
    });

    const nutrition = mixNutritionPer100g(comps);
    preview.append(
      el("span", {}, "Total weight"), el("b", {}, grams(totalGrams)),
      el("span", {}, "Cost per kg of mix"), el("b", {}, euro(cost)),
      el("span", {}, "Energy per 100 g"), el("b", {}, `${num(nutrition.calories, 0)} kcal`),
      el("span", {}, "Protein / fats / carbs per 100 g"), el("b", {}, `${num(nutrition.protein)}/${num(nutrition.fats)}/${num(nutrition.carbs)} g`),
      totalGrams !== 1000 && totalGrams > 0 ? el("span", { class: "muted" }, "note: totals are scaled by grams used in recipes, so any total works") : "",
    );

    // per-row inline price preview
    [...rowsWrap.querySelectorAll<HTMLElement>(".row")].forEach((rowNode, i) => {
      const id = ids[i] ?? ""; const amount = amounts[i] ?? 0;
      const ingredient = state.ingredients.get(id);
      const label = rowNode.querySelector(".row-preview");
      if (label) label.textContent = ingredient && amount > 0 ? `${grams(amount)} → ${euro((amount * ingredient.price) / 1000)}` : "";
    });
  }

  const form = el("form", { class: "panel stack" });
  form.append(
    editingId ? el("input", { type: "hidden", name: "id", value: editingId }) : "",
    text("name", "Mix name", mix?.name ?? ""),
    el("h3", {}, "Components (grams per 1 kg of mix)"),
    rowsWrap,
    el("div", {}, el("button", { class: "small", type: "button" }, "+ Add component")),
    el("hr", { class: "sep" }),
    preview,
    submitRow(mix ? "Save changes" : "Create mix"),
  );

  // keep the live preview node in sync after the initial children copy
  form.querySelector("button[type=button]")!.addEventListener("click", () => { rowsWrap.append(makeRow()); updatePreview(); });

  const existingComponents = editingId ? componentsOf(state, editingId) : [];
  if (existingComponents.length > 0) for (const comp of existingComponents) rowsWrap.append(makeRow(comp.ingredient_id, comp.amount));
  else rowsWrap.append(makeRow());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = await runUi(mixInputFromForm(new FormData(form)));
    if (!input) return;
    const saved = await runUi(ctx.app.repo.saveMix(input));
    if (!saved) return;
    toast(`Saved mix "${String(saved[0]!.cols.name)}".`);
    ctx.navigate("/mixes");
  });

  clear(mountPoint);
  mountPoint.append(el("div", { class: "page-head" }, el("h2", {}, mix ? "Edit flour mix" : "New flour mix"), el("a", { class: "btn ghost small", href: "/mixes" }, "cancel")));

  if (mix) {
    const deleteButton = el("button", { class: "danger", type: "button" }, `Delete "${mix.name}"`);
    deleteButton.addEventListener("click", () => {
      if (!askConfirm(`Delete mix "${mix.name}"? Recipes using it will lose that mix.`)) return;
      runAction(ctx.app.repo.deleteMix(mix.id)).then((done) => { if (done) ctx.navigate("/mixes"); });
    });
    mountPoint.append(el("section", { class: "panel" }, deleteButton));
  }

  mountPoint.append(form);
  updatePreview();
}
