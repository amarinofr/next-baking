/** Landing pages: ingredients table, flour mixes table, recipes grid/table. */

import { mixCostPerKg, summarizeRecipe } from "../../domain/calc.ts";
import { componentsOf, recipeMathInput, type AppState } from "../../domain/state.ts";
import type { Ingredient } from "../../domain/schema.ts";
import { askConfirm, clear, el, euro, grams, num, pct, runUi, toast } from "../dom.ts";
import type { ViewCtx } from "./context.ts";

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

const actions = (handlers: Array<[label: string, kind: string, handler: () => void]>): HTMLElement =>
  el("div", { class: "row-actions" }, ...handlers.map(([label, kind, handler]) => {
    const button = el("button", { class: `small ${kind}` }, label);
    button.addEventListener("click", (event) => { event.stopPropagation(); handler(); });
    return button;
  }));

const cell = (text: string, label?: string, className?: string): HTMLElement =>
  el("td", { "data-label": label ?? "", class: className }, text);

// ---------------- ingredients ----------------

export function renderIngredients(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const state = ctx.state;
  const all = [...state.ingredients.values()].sort(byName);

  const search = el("input", { type: "search", placeholder: "filter by name…" }) as HTMLInputElement;
  const term = { value: "" };
  search.value = term.value;

  const tableWrap = el("div");

  const draw = (): void => {
    clear(tableWrap);
    const filtered = all.filter((i) => i.name.toLowerCase().includes(term.value.toLowerCase()));

    if (filtered.length === 0) {
      tableWrap.append(el("p", { class: "muted" }, all.length === 0 ? "No ingredients yet — create the first one." : "Nothing matches that filter."));
      return;
    }

    const rows = filtered.map((ing) => {
      const tr = el(
        "tr",
        {},
        cell(ing.name),
        cell(ing.category, "type"),
        ing.category === "hybrid" ? cell(pct(ing.hybrid_water * 100), "water") : cell("—", "water"),
        cell(euro(ing.price), "€/kg", "num"),
        cell(num(ing.calories, 0), "kcal/100g", "num"),
        el("td", {}, actions([
          ["edit", "", () => ctx.navigate(`/ingredient-edit?id=${ing.id}`)],
          ["duplicate", "", () => runUi(ctx.app.repo.duplicateIngredient(ing.id)).then((r) => { if (r) ctx.navigate(`/ingredient-edit?id=${String(r.cols.id)}`); })],
          ["delete", "danger", () => {
            const usedIn = state.mixComponents.filter((c) => c.ingredient_id === ing.id).length + state.recipeIngredients.filter((r) => r.ingredient_id === ing.id).length;
            if (!askConfirm(`Delete "${ing.name}"? It is referenced by ${usedIn} mix/recipe row(s), which will be removed too.`)) return;
            runUi(ctx.app.repo.deleteIngredient(ing.id)).then((ok) => { if (ok !== undefined) ctx.refresh(); });
          }],
        ])),
      );
      return tr;
    });

    tableWrap.append(el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Type"), el("th", {}, "Water"), el("th", { class: "num" }, "Price"), el("th", { class: "num" }, "Energy"), el("th", {}, ""))),
      el("tbody", {}, ...rows),
    ));
  };

  search.addEventListener("input", () => { term.value = search.value; draw(); });

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, `Ingredients (${all.length})`),
      el("a", { class: "btn primary", href: "/ingredients/new" }, "+ New ingredient"),
    ),
    el("section", { class: "panel" }, el("div", { class: "field" }, search), tableWrap),
  );
  draw();
}

// ---------------- flour mixes ----------------

export function renderMixes(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const state = ctx.state;
  const all = [...state.mixes.values()].sort(byName);

  clear(mountPoint);

  if (all.length === 0) {
    mountPoint.append(
      el("div", { class: "page-head" }, el("h2", {}, "Flour Mixes"), el("a", { class: "btn primary", href: "/mixes/new" }, "+ New mix")),
      el("section", { class: "panel" }, el("p", { class: "muted" }, "No flour mixes yet.")),
    );
    return;
  }

  const rows = all.map((mix) => {
    const components = componentsOf(state, mix.id);
    const totalGrams = components.reduce((sum, c) => sum + c.amount, 0);

    const breakdown = el("div", { class: "sub-list" },
      ...components.map((c) => el("span", {}, `${state.ingredients.get(c.ingredient_id)?.name ?? "(deleted ingredient)"}: ${grams(c.amount)}`)),
    );

    return el("tr", {},
      cell(`${mix.name}${totalGrams !== 1000 ? ` (totals ${grams(totalGrams)})` : ""}`),
      cell(String(components.length), "components"),
      cell(euro(mixCostPerKg(components.map((c) => ({ amount: c.amount, price: state.ingredients.get(c.ingredient_id)?.price ?? 0 })))), "€/kg", "num"),
      el("td", {}, breakdown),
      el("td", {}, actions([
        ["edit", "", () => ctx.navigate(`/mix-edit?id=${mix.id}`)],
        ["duplicate", "", () => runUi(ctx.app.repo.duplicateMix(mix.id)).then((r) => { if (r?.[0]) ctx.navigate(`/mix-edit?id=${String(r[0].cols.id)}`); })],
        ["delete", "danger", () => {
          const usedIn = state.recipeMixes.filter((r) => r.mix_id === mix.id).length;
          if (!askConfirm(`Delete mix "${mix.name}"? ${usedIn} recipe(s) use it and will lose that mix.`)) return;
          runUi(ctx.app.repo.deleteMix(mix.id)).then((ok) => { if (ok !== undefined) ctx.refresh(); });
        }],
      ])),
    );
  });

  mountPoint.append(
    el("div", { class: "page-head" }, el("h2", {}, `Flour Mixes (${all.length})`), el("a", { class: "btn primary", href: "/mixes/new" }, "+ New mix")),
    el("section", { class: "panel" },
      el("table", { class: "data" },
        el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Components"), el("th", { class: "num" }, "Price"), el("th", {}, "Breakdown per kg"), el("th", {}, ""))),
        el("tbody", {}, ...rows),
      ),
    ),
  );
}

// ---------------- recipes ----------------

interface RecipeCard { id: string; name: string; servings: number; hydration: number; cost: number; calories: number; flourWeight: number }

const recipeCards = (state: AppState): RecipeCard[] =>
  [...state.recipes.values()]
    .map((recipe) => {
      const input = recipeMathInput(state, recipe.id);
      const summary = input ? summarizeRecipe(input) : { total_cost: 0, calories: 0, flour_weight: 0, total_weight: 0 };
      return { id: recipe.id, name: recipe.name, servings: recipe.servings, hydration: recipe.hydration_percent, cost: summary.total_cost, calories: summary.calories, flourWeight: summary.flour_weight };
    })
    .sort(byName);

const deleteRecipe = (ctx: ViewCtx, id: string, name: string): void => {
  if (!askConfirm(`Delete recipe "${name}"? Its ingredient and mix links are removed as well.`)) return;
  runUi(ctx.app.repo.deleteRecipe(id)).then((ok) => { if (ok !== undefined) ctx.refresh(); });
};

const duplicateRecipe = (ctx: ViewCtx, id: string): void => {
  runUi(ctx.app.repo.duplicateRecipe(id)).then((rows) => { if (rows?.[0]) ctx.navigate(`/recipe-edit?id=${String(rows[0].cols.id)}`); });
};

export function renderRecipesGrid(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const cards = recipeCards(ctx.state);

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, `Recipes (${cards.length})`),
      el("div", {}, el("a", { class: "btn ghost small", href: "/recipes" }, "table view →"), " ", el("a", { class: "btn primary", href: "/recipes/new" }, "+ New recipe")),
    ),
  );

  if (cards.length === 0) {
    mountPoint.append(el("section", { class: "panel" }, el("p", { class: "muted" }, "No recipes stored on this device yet.")));
    return;
  }

  mountPoint.append(el("section", { class: "cards" }, ...cards.map((card) =>
    el("article", { class: "card" },
      el("a", { class: "name", href: `/recipe?id=${card.id}` }, card.name),
      el("div", { class: "meta" },
        el("span", {}, `${card.servings} serving${card.servings === 1 ? "" : "s"}`),
        el("span", {}, pct(card.hydration)),
        el("span", {}, `${Math.round(card.flourWeight)} g flour`),
      ),
      el("div", { class: "meta" }, el("span", {}, euro(card.cost)), el("span", {}, `${Math.round(card.calories)} kcal`)),
      el("div", { class: "actions" },
        el("a", { class: "btn small", href: `/recipe-edit?id=${card.id}` }, "edit"),
        el("button", { class: "small" }, "duplicate"),
        el("button", { class: "small danger" }, "delete"),
      ),
    ),
  )));

  // wire the two buttons per card (kept out of `el` so handlers stay typed)
  const nodes = mountPoint.querySelectorAll(".card");
  cards.forEach((card, index) => {
    const cardNode = nodes[index];
    if (!cardNode) return;
    const [dupButton, delButton] = [...cardNode.querySelectorAll("button")];
    dupButton?.addEventListener("click", () => duplicateRecipe(ctx, card.id));
    delButton?.addEventListener("click", () => deleteRecipe(ctx, card.id, card.name));
  });
}

export function renderRecipesTable(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const cards = recipeCards(ctx.state);

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, `Recipes (${cards.length})`),
      el("div", {}, el("a", { class: "btn ghost small", href: "/" }, "grid view →"), " ", el("a", { class: "btn primary", href: "/recipes/new" }, "+ New recipe")),
    ),
    el("section", { class: "panel" },
      cards.length === 0
        ? el("p", { class: "muted" }, "No recipes stored on this device yet.")
        : el("table", { class: "data" },
          el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Servings"), el("th", {}, "Hydration"), el("th", { class: "num" }, "Flour"), el("th", { class: "num" }, "Cost"), el("th", {}, ""))),
          ...cards.map((card) => el("tr", {},
            cell(card.name), cell(String(card.servings), "servings"), cell(pct(card.hydration), "hydration"),
            cell(`${Math.round(card.flourWeight)} g`, "flour", "num"), cell(euro(card.cost), "cost", "num"),
            el("td", {}, actions([
              ["edit", "", () => ctx.navigate(`/recipe-edit?id=${card.id}`)],
              ["duplicate", "", () => duplicateRecipe(ctx, card.id)],
              ["delete", "danger", () => deleteRecipe(ctx, card.id, card.name)],
            ])),
          )),
        ),
    ),
  );
}

/** Used by the detail page header. */
export const ingredientBadge = (ing: Ingredient): HTMLElement =>
  el("span", { class: `badge ${ing.category}` }, ing.category);
