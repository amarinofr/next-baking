/** Shared context passed to every view renderer. */

import type { RecipeCategory } from "../../domain/schema.ts";
import { el } from "../dom.ts";
import type { AppHandle } from "../app.ts";
import type { AppState } from "../../domain/state.ts";

export interface ViewCtx {
  readonly app: AppHandle;
  readonly state: AppState;
  /** re-read IndexedDB and re-render the current page */
  readonly refresh: () => Promise<void>;
  /** soft navigation: no page reload, state is kept */
  readonly navigate: (path: string) => void;
  /** tell the scheduler something changed locally so it pushes shortly after */
  readonly markChanged: () => void;
}

/** Recipe categories come straight from your original database. */
export const categoryOf = (state: AppState, categoryId?: string | null): RecipeCategory | undefined =>
  categoryId ? state.categories.get(categoryId) : undefined;

/** Small colored label, e.g. "Bread" in the category's own colour. */
export function categoryChip(state: AppState, categoryId?: string | null): HTMLElement | undefined {
  const category = categoryOf(state, categoryId);
  if (!category) return undefined;
  const dot = el("span", { class: "chip-dot" });
  dot.style.background = category.color;
  return el("span", { class: "chip" }, dot, category.name);
}
