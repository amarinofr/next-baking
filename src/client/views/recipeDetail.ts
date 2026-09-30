/** One recipe: the same breakdown as the original app, with a servings scaler that never writes. */

import { buildRecipeView, type RecipeMathInput } from "../../domain/calc.ts";
import { recipeMathInput } from "../../domain/state.ts";
import { askConfirm, clear, countUp, el, euro, flash, grams, hydrationRing, num, pct, runAction, stagger, toast, waterGauge } from "../dom.ts";
import { categoryChip, type ViewCtx } from "./context.ts";

export function renderRecipeDetail(ctx: ViewCtx, mountPoint: HTMLElement, id: string): void {
  const recipe = ctx.state.recipes.get(id);
  if (!recipe) { mountPoint.append(el("p", { class: "notice err" }, "This recipe is not on this device yet (it may still be syncing).")); return; }

  const input: RecipeMathInput | undefined = recipeMathInput(ctx.state, id);
  if (!input) { mountPoint.append(el("p", { class: "notice err" }, "Recipe links are incomplete.")); return; }

  const scaleInput = el("input", { id: "scale-input", class: "tiny", type: "number", min: "1", max: "100", value: String(recipe.servings) }) as HTMLInputElement;
  const body = el("div");
  let firstDraw = true;
  const shown = { total: "", effective: "", cost: "", perServing: "", calories: "" };

  const draw = (): void => {
    const target = Math.max(1, Math.trunc(Number(scaleInput.value) || recipe.servings));
    const view = buildRecipeView(input, target);
    clear(body);

    // the figures that react to the scaler get their own nodes so they can be highlighted when they change
    const totalLiquidValue = el("b", {}, grams(view.total_liquid));
    const effectiveValue = el("b", {}, `${view.effective_hydration_percent.toFixed(1)}%`);
    const costTotalValue = el("b", {});
    const costPerServingValue = el("b", {}, euro(view.cost_per_serving));
    const caloriesValue = el("b", {}, num(view.nutrition_per_serving.calories, 0));

    body.append(
      // Servings
      el("div", { class: "search-row" },
        el("label", { for: "scale-input", class: "plain" }, "Servings:"),
        scaleInput,
        el("span", { class: "hint" }, `(recipe makes ${recipe.servings}) · scaling ×${num(view.scale, 2)}, nothing is saved`),
      ),

      el("div", { class: "grid-side" },
        // Ingredients (the wide panel)
        el("section", { class: "panel" },
          el("h3", {}, "Ingredients"),

          ...(view.mixes.length > 0 ? [
            el("p", { class: "label-upper" }, "Flour Mixes"),
            ...view.mixes.flatMap((mix) => [
              el("p", { class: "line" }, `${mix.name} — `, el("b", {}, grams(mix.amount))),
              ...(mix.components.length === 0 ? [] : [el("ul", { class: "sub" }, ...mix.components.map((c) => el("li", {}, `— ${c.name}: `, el("b", {}, grams(c.amount)))))]),
            ]),
          ] : []),

          ...(view.dry_ingredients.length > 0 ? [
            el("p", { class: "label-upper" }, "Dry Ingredients"),
            ...view.dry_ingredients.map((ing) => el("p", { class: "line" }, el("span", {}, `${ing.name}: `), el("b", {}, grams(ing.amount)))),
          ] : []),

          ...(view.mixes.length === 0 && view.dry_ingredients.length === 0 ? [el("p", { class: "hint" }, "None")] : []),
        ),

        // Hydration breakdown (the narrow panel)
        el("section", { class: "panel" },
          el("div", { class: "panel-head", style: "display:flex; justify-content:space-between; align-items:center; gap:.75rem; padding-right:3.4rem" },
            el("h3", { style: "margin:0" }, `Hydration (${recipe.hydration_percent.toFixed(0)}%)`),
            hydrationRing(view.effective_hydration_percent),
          ),
          el("p", { class: "line" }, "Flour weight: ", el("b", {}, grams(view.flour_weight_from_mixes))),
          el("p", { class: "line" }, `Target water (${recipe.hydration_percent.toFixed(0)}%): `, el("b", {}, grams(view.target_water))),
          el("p", { class: "line" }, "Water from liquids: ", el("b", {}, grams(view.water_from_liquids))),

          ...(view.liquid_ingredients.length > 0 ? [
            el("p", { class: "label-upper" }, "─ Liquids ─"),
            el("ul", { class: "sub" }, ...view.liquid_ingredients.map((ing) => ing.category === "hybrid"
              ? el("li", {}, `— ${ing.name}: `, el("b", {}, grams(ing.amount)), el("span", { class: "note" }, ` (${pct(ing.hybrid_water * 100)} water → ${grams(ing.amount * ing.hybrid_water)})`))
              : el("li", {}, `— ${ing.name}: `, el("b", {}, grams(ing.amount))))),
          ] : []),

          ...(view.main_liquids.length > 0 ? [
            el("p", { class: "label-upper" }, "─ Main liquids ─"),
            el("ul", { class: "sub" }, ...view.main_liquids.map((m) => el("li", {}, `— ${m.name}: `, el("b", {}, grams(m.amount)), ` (${pct(m.percentage)})`))),
          ] : []),

          ...(view.main_liquid_percentage_total > 0 && Math.abs(view.main_liquid_percentage_total - 100) > 0.01
            ? [el("p", { class: "notice" }, `Main liquids total ${pct(view.main_liquid_percentage_total)} — should add up to 100%.`)]
            : []),

          el("hr", { class: "sep" }),
          // where the water in this dough actually comes from
          waterGauge(view.target_water, view.water_from_liquids),
          el("p", { class: "total-line" }, "Total liquid: ", totalLiquidValue),
          el("p", { class: "line" }, "Effective hydration: ", effectiveValue),
        ),
      ),

      // Per serving + price
      el("div", { class: "grid-two" },
        el("section", { class: "panel" },
          el("h3", {}, "Per Serving"),
          el("div", { class: "kv" },
            el("span", {}, "Calories"), caloriesValue,
            el("span", {}, "Protein"), el("b", {}, `${num(view.nutrition_per_serving.protein)} g`),
            el("span", {}, "Fats"), el("b", {}, `${num(view.nutrition_per_serving.fats)} g`),
            el("span", {}, "Carbs"), el("b", {}, `${num(view.nutrition_per_serving.carbs)} g`),
            el("span", {}, "Sugar"), el("b", {}, `${num(view.nutrition_per_serving.sugar)} g`),
            el("span", {}, "Fiber"), el("b", {}, `${num(view.nutrition_per_serving.fiber)} g`),
            el("span", { class: "sub full" }, `per 100 g of dough: ${num(view.nutrition_per_100g.calories, 0)} kcal · ${num(view.nutrition_per_100g.protein)}/${num(view.nutrition_per_100g.fats)}/${num(view.nutrition_per_100g.carbs)} g`),
          ),
        ),
        el("section", { class: "panel" },
          el("h3", {}, "Price"),
          el("p", { class: "line" }, "Total: ", costTotalValue),
          el("p", { class: "line" }, "Per serving: ", costPerServingValue),
        ),
      ),

      el("div", { class: "right" }, deleteButton()),
    );

    stagger([...body.querySelectorAll<HTMLElement>("section.panel")]);

    const current = {
      total: grams(view.total_liquid),
      effective: `${view.effective_hydration_percent.toFixed(1)}%`,
      cost: euro(view.total_cost),
      perServing: euro(view.cost_per_serving),
      calories: num(view.nutrition_per_serving.calories, 0),
    };

    if (firstDraw) {
      firstDraw = false;
      countUp(costTotalValue, view.total_cost, euro);
      countUp(caloriesValue, view.nutrition_per_serving.calories, (n) => num(n, 0));
    } else {
      // scaling servings: highlight only the figures that really moved
      if (current.total !== shown.total) flash(totalLiquidValue);
      if (current.effective !== shown.effective) flash(effectiveValue);
      if (current.cost !== shown.cost) flash(costTotalValue);
      if (current.perServing !== shown.perServing) flash(costPerServingValue);
      if (current.calories !== shown.calories) flash(caloriesValue);
    }

    Object.assign(shown, current);
  };

  const deleteButton = (): HTMLElement => {
    const button = el("button", { class: "danger-solid", type: "button" }, "Delete Recipe");
    button.addEventListener("click", () => {
      if (!askConfirm(`Delete recipe "${recipe.name}"? Its ingredient and mix links are removed as well.`)) return;
      runAction(ctx.app.repo.deleteRecipe(recipe.id)).then((done) => { if (!done) return; toast(`Deleted ${recipe.name}.`); ctx.navigate("/recipes"); });
    });
    return button;
  };

  scaleInput.addEventListener("input", draw);
  scaleInput.addEventListener("change", draw);

  clear(mountPoint);

  const heading = el("h2", {}, recipe.name);
  const chip = categoryChip(ctx.state, recipe.category_id);
  if (chip) heading.append(" ", chip);

  mountPoint.append(
    el("div", { class: "page-head" },
      heading,
      el("div", { class: "links" },
        el("button", { class: "primary", type: "button" }, "Edit"),
        el("a", { class: "plain", href: "/recipes" }, "All Recipes"),
      ),
    ),
    body,
  );

  mountPoint.querySelector<HTMLButtonElement>(".page-head button")?.addEventListener("click", () => ctx.navigate(`/recipes/${recipe.id}/edit`));

  draw();
}
