/** List screens: ingredients table, flour-mix table, recipes grid + recipes table.
 *  Markup follows the original app's tables/cards; whole rows and cards are clickable. */

import { mixCostPerKg, summarizeRecipe } from "../../domain/calc.ts";
import { componentsOf, recipeMathInput, type AppState } from "../../domain/state.ts";
import type { Ingredient } from "../../domain/schema.ts";
import { askConfirm, clear, countUp, el, euro, hydrationSheet, pct, runAction, runUi, stagger, toast } from "../dom.ts";
import { categoryChip, type ViewCtx } from "./context.ts";

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** Ingredient categories always wear the same colour: dry butter paper, hybrid lilac, liquid sky. */
const ingredientSheet = (category?: string | null): string => {
  if (category === 'liquid') return 'sheet-sky';
  if (category === 'hybrid') return 'sheet-lilac';
  return 'sheet-butter';
};

/** Flour mixes rotate through the palette so neighbouring rows never look alike. */
const MIX_SHEETS = ['sheet-blush', 'sheet-clay', 'sheet-sage', 'sheet-lilac', 'sheet-butter', 'sheet-sky'];

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
      // the row's own paper colour says what this ingredient does to the water balance
      const categoryCell = el("td", { class: "dim capitalize" }, el("span", { class: "chip" }, categoryText));
      const tr = el(
        "tr",
        { class: `wash ${ingredientSheet(ing.category)}` },
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

  const rows = all.map((mix, index) => {
    const components = componentsOf(state, mix.id);
    const cost = mixCostPerKg(components.map((c) => ({ amount: c.amount, price: state.ingredients.get(c.ingredient_id)?.price ?? 0 })));

    // name · cost · controls. What a mix is made of is worth reading while editing it, not in a list.
    const sheet = MIX_SHEETS[index % MIX_SHEETS.length] ?? 'sheet-butter';
    const tr = el("tr", { class: `wash ${sheet}` },
      el("td", { class: "name" }, mix.name),
      cell(`${euro(cost)}/kg`, "dim num"),
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
      el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", { class: "num" }, "Cost"), el("th", {}))),
      el("tbody", {}, ...stagger(rows)),
    )),
    el("p", { class: "hint" }, "A mix is defined by its components — recipes scale it proportionally, so the total does not have to reach 1000 g."),
  );
}

// ---------------- recipes ----------------

interface RecipeRow { id: string; name: string; servings: number; hydration: number; cost: number; calories: number; flourWeight: number; category_id: string | null }

const recipeRows = (state: AppState): RecipeRow[] =>
  [...state.recipes.values()]
    .map((recipe) => {
      const input = recipeMathInput(state, recipe.id);
      const summary = input ? summarizeRecipe(input) : { total_cost: 0, calories: 0, flour_weight: 0, total_weight: 0 };
      return { id: recipe.id, name: recipe.name, servings: recipe.servings, hydration: recipe.hydration_percent, cost: summary.total_cost, calories: summary.calories, flourWeight: summary.flour_weight, category_id: recipe.category_id ?? null };
    })
    .sort(byName);

/** The recipe index — one list. Each row sits on the paper colour of its hydration band
 *  (dry butter · normal sage · wet sky · batter lilac); the percentage is a figure, not a dial.
 *  edit / duplicate / delete live in the last column, as before. */
export function renderRecipeIndex(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const rowsData = recipeRows(ctx.state);

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, "All Recipes"),
      el("div", { class: "links" }, el("a", { class: "create", href: "/recipes/new" }, "+ New Recipe")),
    ),
  );

  if (rowsData.length === 0) { mountPoint.append(emptyMessage("No recipes yet — write one down.")); return; }

  const rows = rowsData.map((row) => {
    const nameCell = el("td", { class: "name" }, row.name);
    const chip = categoryChip(ctx.state, row.category_id);
    if (chip) nameCell.append(" ", chip);

    const costCell = el("td", { class: "dim num" });
    countUp(costCell, row.cost, euro);

    const tr = el("tr", { class: `wash ${hydrationSheet(row.hydration)}` },
      nameCell,
      costCell,
      el("td", {}, actions([
        ["edit", "", () => ctx.navigate(`/recipes/${row.id}/edit`)],
        ["duplicate", "", () => runUi(ctx.app.repo.duplicateRecipe(row.id)).then((rows) => { if (rows?.[0]) ctx.navigate(`/recipes/${String(rows[0].cols.id)}`); })],
        ["delete", "danger", () => {
          if (!askConfirm(`Delete recipe "${row.name}"? Its ingredient and mix links are removed as well.`)) return;
          runAction(ctx.app.repo.deleteRecipe(row.id)).then((done) => { if (!done) return; toast(`Deleted ${row.name}.`); void ctx.refresh(); });
        }]]),
      ),
    );
    clickable(tr, () => ctx.navigate(`/recipes/${row.id}`), row.name);
    return tr;
  });

  mountPoint.append(el("div", { class: "table-wrap" }, el("table", { class: "data compact" },
    el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", { class: "num" }, "Cost"), el("th", {}))),
    el("tbody", {}, ...stagger(rows)),
  )));
}



/** Used by the recipe form's pickers. */
export const ingredientLabel = (state: AppState, id: string): string => {
  const i = state.ingredients.get(id);
  return i ? `${i.name} (${i.category}, €${i.price.toFixed(2)}/kg)` : id;
};
