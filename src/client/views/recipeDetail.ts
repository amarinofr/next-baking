/** Recipe single page: read-only view with a servings scaler (never writes). */

import { buildRecipeView, type RecipeMathInput } from "../../domain/calc.ts";
import { recipeMathInput } from "../../domain/state.ts";
import { askConfirm, clear, el, euro, grams, num, pct, runUi, toast } from "../dom.ts";
import type { ViewCtx } from "./context.ts";

export function renderRecipeDetail(ctx: ViewCtx, mountPoint: HTMLElement, id: string): void {
  const recipe = ctx.state.recipes.get(id);
  if (!recipe) { mountPoint.append(el("p", { class: "notice err" }, "This recipe is not on this device yet (it may still be syncing).")); return; }

  const input: RecipeMathInput | undefined = recipeMathInput(ctx.state, id);
  if (!input) { mountPoint.append(el("p", { class: "notice err" }, "Recipe links are incomplete.")); return; }

  const scaleInput = el("input", { type: "number", min: "1", max: "99", value: String(recipe.servings) }) as HTMLInputElement;

  const body = el("div", { class: "stack" });

  const draw = (): void => {
    const target = Math.max(1, Math.trunc(Number(scaleInput.value) || recipe.servings));
    const view = buildRecipeView(input, target);

    clear(body);
    body.append(
      el("section", { class: "panel inline-fields" },
        el("div", { class: "field" }, el("label", { for: "scale" }, `Servings (recipe makes ${recipe.servings})`), scaleInput),
        el("p", { class: "small muted nowrap" }, `scaling ×${num(view.scale, 2)} · nothing is written to the database`),
      ),

      el("div", { class: "grid cols-2" },
        el("section", { class: "panel" },
          el("h3", {}, "Flour mixes"),
          ...(view.mixes.length === 0 ? [el("p", { class: "muted" }, "none")] : view.mixes.map((mix) => el("div", {},
            el("p", {}, `${mix.name}: `, el("b", {}, grams(mix.amount))),
            el("div", { class: "sub-list" }, ...mix.components.map((c) => el("span", {}, `${c.name}: ${grams(c.amount)}`))),
          ))),
          el("hr", { class: "sep" }),
          el("h3", {}, "Dry ingredients"),
          ...(view.dry_ingredients.length === 0 ? [el("p", { class: "muted" }, "none")] : view.dry_ingredients.map((i) => el("p", {}, `${i.name}: `, el("b", {}, grams(i.amount))))),
        ),

        el("section", { class: "panel" },
          el("h3", {}, `Hydration (${pct(input.hydration_percent)})`),
          kvRow("Flour weight (from mixes)", grams(view.flour_weight_from_mixes)),
          kvRow(`Target water (${pct(input.hydration_percent)})`, grams(view.target_water)),
          kvRow("Water from liquid/hybrid ingredients", grams(view.water_from_liquids)),
          ...view.liquid_ingredients.map((i) => el("div", { class: "sub-list" },
            el("span", {}, `${i.name}: ${grams(i.amount)}${i.category === "hybrid" ? ` (${pct(i.hybrid_water * 100)} water → ${grams(i.amount * i.hybrid_water)})` : ""}`),
          )),
          ...(view.main_liquids.length > 0 ? [el("hr", { class: "sep" }), el("h3", {}, "Main liquids to weigh out")] : []),
          ...view.main_liquids.map((m) => kvRow(`${m.name} (${pct(m.percentage)})`, grams(m.amount))),
          Math.abs(view.main_liquid_percentage_total - 100) > 0.01 && view.main_liquid_percentage_total > 0
            ? el("p", { class: "notice" }, `Main liquids total ${pct(view.main_liquid_percentage_total)} — should be 100%`) : null,
          el("hr", { class: "sep" }),
          kvRowTotal("Total liquid", grams(view.total_liquid)),
          kvRow("Effective hydration", pct(view.effective_hydration_percent)),
        ),
      ),

      el("div", { class: "grid cols-2" },
        el("section", { class: "panel" },
          el("h3", {}, "Nutrition per serving"),
          kvRow("Energy", `${num(view.nutrition_per_serving.calories, 0)} kcal`),
          kvRow("Protein", `${num(view.nutrition_per_serving.protein)} g`),
          kvRow("Fats", `${num(view.nutrition_per_serving.fats)} g`),
          kvRow("Carbs", `${num(view.nutrition_per_serving.carbs)} g`),
          kvRow("Sugar", `${num(view.nutrition_per_serving.sugar)} g`),
          kvRow("Fiber", `${num(view.nutrition_per_serving.fiber)} g`),
          el("hr", { class: "sep" }),
          kvRow("Per 100 g of dough — energy", `${num(view.nutrition_per_100g.calories, 0)} kcal`),
          kvRow("Per 100 g — P/F/C", `${num(view.nutrition_per_100g.protein)}/${num(view.nutrition_per_100g.fats)}/${num(view.nutrition_per_100g.carbs)} g`),
        ),
        el("section", { class: "panel" },
          el("h3", {}, "Price"),
          kvRowTotal(`Whole recipe (${target} servings)`, euro(view.total_cost)),
          kvRow("Per serving", euro(view.cost_per_serving)),
        ),
      ),

      ...(recipe.instructions.trim() ? [el("section", { class: "panel" }, el("h3", {}, "Instructions"), el("p", { style: "white-space: pre-wrap" }, recipe.instructions))] : []),
    );
  };

  function kvRow(label: string, value: string): HTMLElement {
    const wrap = el("div", { class: "kv" }, el("span", {}, label), el("b", {}, value));
    return wrap;
  }
  function kvRowTotal(label: string, value: string): HTMLElement {
    return el("div", { class: "kv total" }, el("span", {}, label), el("b", {}, value));
  }

  scaleInput.addEventListener("change", draw);

  const editLink = el("a", { class: "btn small", href: `/recipe-edit?id=${id}` }, "Edit");
  const duplicateButton = el("button", { class: "small" }, "Duplicate");
  duplicateButton.addEventListener("click", () => runUi(ctx.app.repo.duplicateRecipe(id)).then((rows) => { if (rows?.[0]) ctx.navigate(`/recipe-edit?id=${String(rows[0].cols.id)}`); }));
  const deleteButton = el("button", { class: "danger small" }, "Delete recipe");
  deleteButton.addEventListener("click", () => {
    if (!askConfirm(`Delete recipe "${recipe.name}"?`)) return;
    runUi(ctx.app.repo.deleteRecipe(id)).then((ok) => { if (ok !== undefined) ctx.navigate("/recipes"); });
  });

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" },
      el("h2", {}, recipe.name),
      el("div", { class: "row-actions" , style: "opacity:1" }, editLink, duplicateButton, deleteButton, el("a", { class: "btn ghost small", href: "/recipes" }, "all recipes")),
    ),
    body,
  );

  if (!ctx.state.recipes.get(id)) toast("missing recipe", "warn");
  draw();
}

