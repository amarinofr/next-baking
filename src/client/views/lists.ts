/** List screens: ingredients table, flour-mix table, recipes grid + recipes table.
 *  Markup follows the original app's tables/cards; whole rows and cards are clickable. */

import { mixCostPerKg, summarizeRecipe } from "../../domain/calc.ts";
import { componentsOf, mixTotalGrams, recipeMathInput, type AppState } from "../../domain/state.ts";
import type { Ingredient } from "../../domain/schema.ts";
import { askConfirm, clear, countUp, el, euro, grams, hydrationRing, mixBar, pct, runAction, runUi, stagger, toast } from "../dom.ts";
import { categoryChip, type ViewCtx } from "./context.ts";

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

const cell = (text: string, className?: string): HTMLElement => el("td", { class: className }, text);

/** edit · duplicate · delete, exactly like the old app's action column. */
const actions = (handlers: Array<[label: string, kind: string, handler: () => void]>): HTMLElement =>
  el("div", { class: "row-actions" }, ...handlers.map(([label, kind, handler]) => {
    const button = el("button", { class: kind === "danger" ? "danger" : "small", type: "button", title: label }, label);
    button.addEventListener("click", (event) => { event.stopPropagation(); handler(); });
    return button;
  }));

/** Make a row / card open something when clicked anywhere on it. */
function clickable(node: HTMLElement, open: () => void, label: string): void {
  node.classList.add("clickable");
  node.setAttribute("role", "link");
  node.setAttribute("tabindex", "0");
  node.setAttribute("aria-label", `${label} (open)`);
  node.addEventListener("click", open);
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
}

const emptyMessage = (message: string): HTMLElement => el("p", { class: "empty" }, message);

// ---------------- ingredients ----------------

export function renderIngredients(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const state = ctx.state;
  const all = [...state.ingredients.values()].sort(byName);

  const search = el("input", { type: "search", placeholder: "filter by name…" }) as HTMLInputElement;
  const tableWrap = el("div", { class: "table-wrap" });
  let term = "";

  const draw = (): void => {
    clear(tableWrap);
    const filtered = all.filter((i) => i.name.toLowerCase().includes(term.toLowerCase()));

    if (filtered.length === 0) {
      tableWrap.replaceChildren();
      tableWrap.append(emptyMessage(all.length === 0 ? "No ingredients yet." : "Nothing matches that filter."));
      return;
    }

    const rows = filtered.map((ing) => {
      const categoryText = ing.category === "hybrid" ? `hybrid · ${pct((ing.hybrid_water ?? 0) * 100)} water` : ing.category;
      // colour-coded so you can see at a glance what this thing does to the water balance
      const categoryCell = el("td", { class: "dim capitalize" },
        el("span", { class: "chip" }, el("i", { class: `dot ${ing.category ?? "dry"}`, "aria-hidden": "true" }), categoryText),
      );
      const tr = el(
        "tr",
        {},
        cell(ing.name, "name"),
        categoryCell,
        cell(euro(ing.price), "dim"),
        el("td", {}, actions([
          ["edit", "", () => ctx.navigate(`/ingredients/${ing.id}/edit`)],
          ["duplicate", "", () => runUi(ctx.app.repo.duplicateIngredient(ing.id)).then((row) => { if (row) ctx.navigate(`/ingredients/${String(row.cols.id)}/edit`); })],
          ["delete", "danger", () => deleteIngredient(ctx, state, ing)],
        ])),
      );
      clickable(tr, () => ctx.navigate(`/ingredients/${ing.id}/edit`), ing.name);
      return tr;
    });

    tableWrap.append(el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Category"), el("th", {}, "Price (€/kg)"), el("th", {}))),
      el("tbody", {}, ...stagger(rows)),
    ));
  };

  search.addEventListener("input", () => { term = search.value.trim(); draw(); });
  draw();   // first paint — without this the list mounted empty

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" }, el("h2", {}, "All Ingredients"), el("a", { class: "create", href: "/ingredients/new" }, "+ Create New")),
    el("div", { class: "search-row" }, search),
    tableWrap,
  );
}

function deleteIngredient(ctx: ViewCtx, state: AppState, ing: Ingredient): void {
  const usedIn = state.mixComponents.filter((c) => c.ingredient_id === ing.id).length + state.recipeIngredients.filter((r) => r.ingredient_id === ing.id).length;
  if (!askConfirm(`Delete "${ing.name}"? It is referenced by ${usedIn} mix/recipe row(s), which will be removed too.`)) return;
  runAction(ctx.app.repo.deleteIngredient(ing.id)).then((done) => { if (!done) return; toast(`Deleted ${ing.name}.`); void ctx.refresh(); });
}

// ---------------- flour mixes ----------------

export function renderMixes(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const state = ctx.state;
  const all = [...state.mixes.values()].sort(byName);

  clear(mountPoint);

  if (all.length === 0) {
    mountPoint.append(
      el("div", { class: "page-head" }, el("h2", {}, "All Flour Mixes"), el("a", { class: "create", href: "/mixes/new" }, "+ Create New")),
      emptyMessage("No flour mixes yet."),
    );
    return;
  }

  const rows = all.map((mix) => {
    const components = componentsOf(state, mix.id);
    const total = mixTotalGrams(components);
    const cost = mixCostPerKg(components.map((c) => ({ amount: c.amount, price: state.ingredients.get(c.ingredient_id)?.price ?? 0 })));

    // the name cell carries a little proportional bar: what this mix is made of, at a glance
    const nameCell = el("td", { class: "name" }, mix.name);
    if (components.length > 0) {
      const bar = mixBar(components.map((c) => ({ grams: c.amount })));
      bar.setAttribute("title", components.map((c) => `${state.ingredients.get(c.ingredient_id)?.name ?? c.ingredient_id} · ${grams(c.amount)}`).join("\n"));
      nameCell.append(bar);
    }

    const tr = el("tr", {},
      nameCell,
      cell(`${components.length} ingredient${components.length === 1 ? "" : "s"} · ${grams(total)} · ${euro(cost)}/kg`, "dim"),
      el("td", {}, actions([
        ["edit", "", () => ctx.navigate(`/mixes/${mix.id}/edit`)],
        ["duplicate", "", () => runUi(ctx.app.repo.duplicateMix(mix.id)).then((rows) => { if (rows?.[0]) ctx.navigate(`/mixes/${String(rows[0].cols.id)}/edit`); })],
        ["delete", "danger", () => {
          const usedIn = state.recipeMixes.filter((r) => r.mix_id === mix.id).length;
          if (!askConfirm(`Delete mix "${mix.name}"? ${usedIn} recipe link(s) using it will be removed too.`)) return;
          runAction(ctx.app.repo.deleteMix(mix.id)).then((done) => { if (!done) return; toast(`Deleted ${mix.name}.`); void ctx.refresh(); });
        }]]),
      ),
    );
    clickable(tr, () => ctx.navigate(`/mixes/${mix.id}/edit`), mix.name);
    return tr;
  });

  mountPoint.append(
    el("div", { class: "page-head" }, el("h2", {}, "All Flour Mixes"), el("a", { class: "create", href: "/mixes/new" }, "+ Create New")),
    el("div", { class: "table-wrap" }, el("table", { class: "data" },
      el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Ingredients"), el("th", {}))),
      el("tbody", {}, ...stagger(rows)),
    )),
    el("p", { class: "hint" }, "A mix is defined by its components — recipes scale it proportionally, so the total does not have to reach 1000 g."),
  );
}

// ---------------- recipes ----------------

interface RecipeCard { id: string; name: string; servings: number; hydration: number; cost: number; calories: number; flourWeight: number; category_id: string | null }

const recipeCards = (state: AppState): RecipeCard[] =>
  [...state.recipes.values()]
    .map((recipe) => {
      const input = recipeMathInput(state, recipe.id);
      const summary = input ? summarizeRecipe(input) : { total_cost: 0, calories: 0, flour_weight: 0, total_weight: 0 };
      return { id: recipe.id, name: recipe.name, servings: recipe.servings, hydration: recipe.hydration_percent, cost: summary.total_cost, calories: summary.calories, flourWeight: summary.flour_weight, category_id: recipe.category_id ?? null };
    })
    .sort(byName);

/** Landing grid — same cards as the old app's home page, now clickable anywhere. */
export function renderRecipesGrid(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const cards = recipeCards(ctx.state);

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, "All Recipes"),
      el("div", { class: "links" }, el("a", { class: "plain", href: "/recipes" }, "table view →"), " ", el("a", { class: "create", href: "/recipes/new" }, "+ New Recipe")),
    ),
  );

  if (cards.length === 0) { mountPoint.append(emptyMessage("No recipes yet.")); return; }

  const nodes = cards.map((card) => {
    const costNode = el("span", { class: "cost" });
    const article = el("article", { class: "card has-ring" },
      hydrationRing(card.hydration),
      el("h3", {}, card.name),
      el("div", { class: "meta" },
        el("span", {}, `Servings: ${card.servings}`),
        costNode,
      ),
      el("div", { class: "meta sub" },
        el("span", {}, `${Math.round(card.flourWeight)} g flour · ${Math.round(card.calories)} kcal`),
        categoryChip(ctx.state, card.category_id) ?? el("span", {}, ""),
      ),
    );
    clickable(article, () => ctx.navigate(`/recipes/${card.id}`), card.name);
    countUp(costNode, card.cost, euro);
    return article;
  });

  mountPoint.append(el("section", { class: "cards" }, ...stagger(nodes)));
}

/** Table view of the same recipes (this is where edit / duplicate / delete live, as before). */
export function renderRecipesTable(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const cards = recipeCards(ctx.state);

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, "All Recipes"),
      el("div", { class: "links" }, el("a", { class: "plain", href: "/" }, "grid view →"), " ", el("a", { class: "create", href: "/recipes/new" }, "+ New Recipe")),
    ),
  );

  if (cards.length === 0) { mountPoint.append(emptyMessage("No recipes yet.")); return; }

  const rows = cards.map((card) => {
    const nameCell = el("td", { class: "name" }, card.name);
    const chip = categoryChip(ctx.state, card.category_id);
    if (chip) nameCell.append(" ", chip);

    const tr = el("tr", {},
      nameCell,
      cell(String(card.servings), "dim"),
      cell(`${card.hydration.toFixed(0)}%`, "dim"),
      el("td", {}, actions([
        ["edit", "", () => ctx.navigate(`/recipes/${card.id}/edit`)],
        ["duplicate", "", () => runUi(ctx.app.repo.duplicateRecipe(card.id)).then((rows) => { if (rows?.[0]) ctx.navigate(`/recipes/${String(rows[0].cols.id)}`); })],
        ["delete", "danger", () => {
          if (!askConfirm(`Delete recipe "${card.name}"? Its ingredient and mix links are removed as well.`)) return;
          runAction(ctx.app.repo.deleteRecipe(card.id)).then((done) => { if (!done) return; toast(`Deleted ${card.name}.`); void ctx.refresh(); });
        }]]),
      ),
    );
    clickable(tr, () => ctx.navigate(`/recipes/${card.id}`), card.name);
    return tr;
  });

  mountPoint.append(el("div", { class: "table-wrap" }, el("table", { class: "data" },
    el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Servings"), el("th", {}, "Hydration"), el("th", {}))),
    el("tbody", {}, ...stagger(rows)),
  )));
}

/** Used by the recipe form's pickers. */
export const ingredientLabel = (state: AppState, id: string): string => {
  const i = state.ingredients.get(id);
  return i ? `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)` : id;
};
