/** Page bootstrap: boots the local store once, then renders the requested view. */

import { Effect } from "effect";
import { boot, reloadState, type AppHandle } from "./app.ts";
import type { AppState } from "../domain/state.ts";
import { setStatus, toast } from "./dom.ts";
import { pendingCount, syncNow } from "./syncClient.ts";
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

  // A background sync (or a save) can re-render the page while you are still typing.
  // Form values are therefore captured before every re-render and restored afterwards,
  // so nothing you typed is ever thrown away.
  const drafts = new Map<string, Record<string, string>>();
  const draftKey = (which: PageId, whichId?: string): string => `${which}${whichId ? `::${whichId}` : ""}`;
  const fieldNodes = () => [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#app form [name]")];

  const captureDraft = (): void => {
    if (fieldNodes().length === 0) return;
    const values: Record<string, string> = {};
    for (const node of fieldNodes()) { const name = node.getAttribute("name"); if (name) values[name] = node.value; }
    drafts.set(draftKey(page, id), values);
  };

  const restoreDraft = (): void => {
    const values = drafts.get(draftKey(page, id));
    if (!values) return;
    for (const node of fieldNodes()) {
      const name = node.getAttribute("name");
      if (!name || !(name in values)) continue;
      if (node.value === values[name]) continue;
      node.value = values[name]!;
      node.dispatchEvent(new Event("input", { bubbles: true })); // lets conditional fields (water %, …) catch up
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const draw = (): void => {
    captureDraft();
    const ctx: ViewCtx = {
      app,
      state,
      refresh,
      navigate: (path: string) => { drafts.delete(draftKey(page, id)); window.location.assign(path); },
    };
    renderPage(ctx, mountPoint!, page, id);
    restoreDraft();
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
      const fillingInForm = page === "ingredient-form" || page === "mix-form" || page === "recipe-form";
      if (outcome.applied > 0 && fillingInForm) {
        // Never re-render under someone's half-filled form: tell them instead.
        toast(`${outcome.applied} row(s) changed elsewhere — reload to see them.`, "warn");
      } else if (outcome.applied > 0 || outcome.pushed > 0) {
        await refresh();
        if (outcome.applied > 0) toast(`Updated from hub: ${outcome.applied} row(s).`);
      }
    } catch {
      setStatus(`${app.deviceId} · working locally`, "hub not reachable — changes stay queued");
    }
  }

  window.addEventListener("online", () => { void refresh(); });
  window.addEventListener("offline", () => { updateStatus(); });

  // Small read-only diagnostic handle: handy when something looks wrong on a device.
  // Open the browser console and try __baking.debug() or __baking.find("Butter").
  (window as unknown as Record<string, unknown>).__baking = {
    deviceId: app.deviceId,
    debug: async () => {
      const rows = await Effect.runPromise(app.store.allRecords());
      return {
        totalRows: rows.length,
        deleted: rows.filter((row) => row.deleted).length,
        pendingSync: await Effect.runPromise(pendingCount(app.store)),
        tables: [...new Set(rows.map((row) => row.table))].sort(),
      };
    },
    find: async (needle: string) => {
      const rows = await Effect.runPromise(app.store.allRecords());
      return rows
        .filter((row) => JSON.stringify(row.cols).includes(needle))
        .map((row) => ({ table: row.table, pk: row.pk, deleted: row.deleted, updated_at: row.updated_at }));
    },
  };
}
