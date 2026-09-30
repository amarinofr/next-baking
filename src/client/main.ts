/** Page bootstrap: boots the local store once, then renders the requested view. */

import { Effect } from "effect";
import { boot, reloadState, type AppHandle } from "./app.ts";
import type { AppState } from "../domain/state.ts";
import { setStatus, toast } from "./dom.ts";
import { syncNow } from "./syncClient.ts";
import type { ViewCtx } from "./views/context.ts";
import { renderIngredients, renderMixes, renderRecipesGrid, renderRecipesTable } from "./views/lists.ts";
import { renderIngredientForm, renderMixForm } from "./views/formsIngredientMix.ts";
import { renderRecipeForm } from "./views/formsRecipe.ts";
import { renderRecipeDetail } from "./views/recipeDetail.ts";
import { renderSettings } from "./views/settings.ts";

type PageId =
  | "home" | "recipes" | "ingredients" | "ingredient-form" | "mixes" | "mix-form"
  | "recipe-form" | "recipe-detail" | "settings";

const renderPage = (ctx: ViewCtx, mountPoint: HTMLElement, page: PageId, id?: string): void => {
  switch (page) {
    case "home": renderRecipesGrid(ctx, mountPoint); break;
    case "recipes": renderRecipesTable(ctx, mountPoint); break;
    case "ingredients": renderIngredients(ctx, mountPoint); break;
    case "ingredient-form": renderIngredientForm(ctx, mountPoint, id); break;
    case "mixes": renderMixes(ctx, mountPoint); break;
    case "mix-form": renderMixForm(ctx, mountPoint, id); break;
    case "recipe-form": renderRecipeForm(ctx, mountPoint, id); break;
    case "recipe-detail": if (id) renderRecipeDetail(ctx, mountPoint, id); break;
    case "settings": renderSettings(ctx, mountPoint); break;
    default: renderRecipesGrid(ctx, mountPoint);
  }
};

export async function startApp(): Promise<void> {
  const body = document.body;
  const page = (body.dataset.page ?? "home") as PageId;
  const id = new URLSearchParams(window.location.search).get("id") ?? body.dataset.id ?? undefined;
  const mountPoint = document.querySelector<HTMLElement>("[data-view]") ?? document.getElementById("app");

  if (!mountPoint) return;

  setStatus("opening local database…");

  let app: AppHandle;
  try {
    app = await Effect.runPromise(boot());
  } catch (error) {
    setStatus("local storage unavailable");
    toast(`Could not open the local database: ${String((error as Error)?.message ?? error)}. Private browsing mode blocks offline storage.`, "err");
    return;
  }

  let state: AppState = app.state;

  const draw = (): void => {
    const ctx: ViewCtx = { app, state, refresh, navigate: (path: string) => window.location.assign(path) };
    renderPage(ctx, mountPoint!, page, id);
  };

  async function refresh(): Promise<void> {
    try {
      state = await Effect.runPromise(reloadState(app));
    } catch (error) {
      toast(`Could not read the local database: ${String((error as Error)?.message ?? error)}`, "err");
      return;
    }
    draw();
    updateStatus();
  }

  const updateStatus = (): void => {
    const counts = `${state.recipes.size} recipes · ${state.mixes.size} mixes · ${state.ingredients.size} ingredients`;
    const connection = navigator.onLine ? "online" : "offline — local copy in use";
    setStatus(`${app.deviceId} · ${counts}`, connection);
  };

  draw();
  updateStatus();

  // Quiet best-effort sync so devices converge when they can reach each other.
  if (navigator.onLine) {
    try {
      const outcome = await Effect.runPromise(syncNow(app.store, app.deviceId));
      if (outcome.applied > 0 || outcome.pushed > 0) await refresh();
      if (outcome.applied > 0) toast(`Updated from hub: ${outcome.applied} row(s).`);
    } catch {
      setStatus(`${app.deviceId} · working locally`, "hub not reachable — changes stay queued");
    }
  }

  window.addEventListener("online", () => { void refresh(); });
  window.addEventListener("offline", () => { updateStatus(); });
}
