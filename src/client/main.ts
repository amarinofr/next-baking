/** App bootstrap + in-app router: one boot, then views swap without ever reloading the page. */

import { Effect } from "effect";
import { boot, reloadState, type AppHandle } from "./app.ts";
import type { AppState } from "../domain/state.ts";
import { el, setStatus, toast } from "./dom.ts";
import { pendingCount } from "./syncClient.ts";
import { makeSyncScheduler } from "./syncScheduler.ts";
import type { ViewCtx } from "./views/context.ts";
import { renderIngredients, renderMixes, renderRecipeIndex } from "./views/lists.ts";
import { renderIngredientForm, renderMixForm } from "./views/formsIngredientMix.ts";
import { renderRecipeForm } from "./views/formsRecipe.ts";
import { renderRecipeDetail } from "./views/recipeDetail.ts";
import { renderSettings } from "./views/settings.ts";

type PageId =
  | "home" | "recipes" | "ingredients" | "ingredient-form" | "mixes" | "mix-form"
  | "recipe-form" | "recipe-detail" | "settings";

interface Route { readonly page: PageId; readonly id?: string; readonly path: string }

const query = (search: string, key: string): string | undefined => new URLSearchParams(search).get(key) ?? undefined;

/** Clean URLs like the original app (/recipes/<id>, /ingredients/<id>/edit), plus the older ?id= form. */
export function routeFor(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  const id = query(search, "id");

  if (path === "/" || path === "/index.html") return { page: "home", path };
  if (path === "/recipes") return { page: "recipes", path };
  if (path === "/ingredients") return { page: "ingredients", path };
  if (path === "/mixes") return { page: "mixes", path };
  if (path === "/settings") return { page: "settings", path };

  if (path === "/ingredients/new") return { page: "ingredient-form", path };
  if (path === "/ingredient-edit" && id) return { page: "ingredient-form", id, path };

  if (path === "/mixes/new") return { page: "mix-form", path };
  if (path === "/mix-edit" && id) return { page: "mix-form", id, path };

  if (path === "/recipes/new") return { page: "recipe-form", path };
  if (path === "/recipe-edit" && id) return { page: "recipe-form", id, path };
  if (path === "/recipe" && id) return { page: "recipe-detail", id, path };

  const ingredientEdit = /^\/ingredients\/([^/]+)\/edit$/.exec(path);
  if (ingredientEdit) return { page: "ingredient-form", id: decodeURIComponent(ingredientEdit[1]!), path };

  const mixEdit = /^\/mixes\/([^/]+)\/edit$/.exec(path);
  if (mixEdit) return { page: "mix-form", id: decodeURIComponent(mixEdit[1]!), path };

  const recipeEdit = /^\/recipes\/([^/]+)\/edit$/.exec(path);
  if (recipeEdit) return { page: "recipe-form", id: decodeURIComponent(recipeEdit[1]!), path };

  const recipeView = /^\/recipes\/([^/]+)$/.exec(path);
  if (recipeView && !["new"].includes(recipeView[1]!)) return { page: "recipe-detail", id: decodeURIComponent(recipeView[1]!), path };

  return { page: "home", path };
}

const TAB_FOR: Record<PageId, string> = {
  home: "recipes", recipes: "recipes", "recipe-detail": "recipes", "recipe-form": "recipes",
  ingredients: "ingredients", "ingredient-form": "ingredients", mixes: "mixes", "mix-form": "mixes", settings: "settings",
};

export async function startApp(): Promise<void> {
  const mountPoint = document.querySelector<HTMLElement>("[data-view]") ?? document.getElementById("app");
  if (!mountPoint) return;

  setStatus("opening local database…");

  // something on screen immediately, then quietly replaced once the local database answers
  mountPoint.append(
    el("div", { id: "boot" },
      el("div", { class: "skeleton head" }),
      el("div", { class: "cards" }, el("div", { class: "skeleton card" }), el("div", { class: "skeleton card" }), el("div", { class: "skeleton card" })),
    ),
  );

  let app: AppHandle;
  try {
    app = await Effect.runPromise(boot());
  } catch (error) {
    setStatus("local storage unavailable");
    toast(`Could not open the local database: ${String((error as Error)?.message ?? error)}. Private browsing blocks offline storage — so does any address the browser will not trust for storage.`, "err");
    return;
  }

  let state: AppState = app.state;
  let route: Route = routeFor(window.location.pathname, window.location.search);

  // Form content survives any re-render (background sync, coming back to a page, …).
  type DraftField = { readonly name: string; readonly value: string };
  const drafts = new Map<string, ReadonlyArray<DraftField>>();
  const fieldNodes = () => [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("#app form [name]")];

  const captureDraft = (): void => {
    const nodes = fieldNodes();
    if (nodes.length === 0) return;
    drafts.set(route.path, nodes.map((node) => ({ name: node.getAttribute("name") ?? "", value: node.value })));
  };

  /**
   * Component rows repeat their field names (every mix row has an "ingredient_id" and an "amount"), so a
   * draft keyed by name would pour one row's value into every row and quietly rewrite the whole mix.
   * Restore position by position, and only when the rebuilt form has exactly the same fields in the same
   * order — otherwise throw the draft away rather than guess.
   */
  const restoreDraft = (): void => {
    const saved = drafts.get(route.path);
    if (!saved) return;
    const nodes = fieldNodes();
    if (nodes.length !== saved.length) { drafts.delete(route.path); return; }
    for (let i = 0; i < nodes.length; i += 1) {
      if ((nodes[i]!.getAttribute("name") ?? "") !== saved[i]!.name) { drafts.delete(route.path); return; }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      const value = saved[i]!.value;
      if (node.value === value) continue;
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };


  const scheduler = makeSyncScheduler({
    store: app.store,
    deviceId: app.deviceId,
    isFormPage: () => route.page === "ingredient-form" || route.page === "mix-form" || route.page === "recipe-form",
    onApplied: () => { void refresh(); },
    onStatus: (report, error) => updateStatus(report, error),
  });

  const titleFor = (): string => {
    switch (route.page) {
      case "ingredients": return "Ingredients";
      case "ingredient-form": return route.id ? "Edit ingredient" : "New ingredient";
      case "mixes": return "Flour Mixes";
      case "mix-form": return route.id ? "Edit flour mix" : "New flour mix";
      case "recipes": return "Recipes";
      case "recipe-detail": return state.recipes.get(route.id ?? "")?.name ?? "Recipe";
      case "recipe-form": return route.id ? "Edit recipe" : "New recipe";
      case "settings": return "Sync & backups";
      default: return "Recipes";
    }
  };

  const paintChrome = (): void => {
    document.title = `${titleFor()} — Baking Recipes`;
    const tab = TAB_FOR[route.page];
    for (const link of document.querySelectorAll<HTMLAnchorElement>("nav.tabs a[data-tab]")) {
      if (link.dataset.tab === tab) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    moveTabGlider();
  };

  /** The pill behind the tabs slides to wherever you are now. */
  function moveTabGlider(): void {
    const glider = document.querySelector<HTMLElement>(".tab-glider");
    const active = document.querySelector<HTMLElement>('nav.tabs a[aria-current="page"]');
    if (!glider || !active) return;
    glider.style.width = `${active.offsetWidth}px`;
    glider.style.transform = `translateX(${active.offsetLeft}px)`;
    glider.classList.add("ready");
  }

  const renderView = (): void => {
    const ctx: ViewCtx = { app, state, refresh, navigate: (path: string) => void go(path), markChanged: () => scheduler.markChanged() };
    mountPoint!.replaceChildren();
    switch (route.page) {
      case "home":
      case "recipes": renderRecipeIndex(ctx, mountPoint!); break;
      case "ingredients": renderIngredients(ctx, mountPoint!); break;
      case "ingredient-form": renderIngredientForm(ctx, mountPoint!, route.id); break;
      case "mixes": renderMixes(ctx, mountPoint!); break;
      case "mix-form": renderMixForm(ctx, mountPoint!, route.id); break;
      case "recipe-form": renderRecipeForm(ctx, mountPoint!, route.id); break;
      case "recipe-detail": if (route.id) renderRecipeDetail(ctx, mountPoint!, route.id); break;
      case "settings": renderSettings(ctx, mountPoint!, scheduler); break;
    }
    restoreDraft();
    paintChrome();
  };

  /** Re-draw the current route from the in-memory state (used for the very first paint). */
  const draw = (): void => { captureDraft(); renderView(); };

  /**
   * Read the local database again, then draw. Every navigation goes through this, otherwise a
   * row you just saved would stay invisible until a full page reload.
   */
  async function loadStateAndRender(): Promise<void> {
    try {
      state = await Effect.runPromise(reloadState(app));
    } catch (error) {
      updateStatus(scheduler.lastSync, `could not read the local database: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    paint(renderView);
    updateStatus();
  }

  /**
   * Where the screen changes. Where the browser supports it, the swap goes through a real view
   * transition so old content fades up and new content rises in; elsewhere it simply renders.
   */
  function paint(render: () => void): void {
    const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (typeof doc.startViewTransition === "function" && !calm) doc.startViewTransition(render);
    else render();
  }

  async function refresh(): Promise<void> {
    captureDraft();          // keep whatever is being typed on a form right now
    await loadStateAndRender();
  }

  // ---- scroll memory: coming back to a list puts you where you were ----
  const scrollMemory = new Map<string, number>();

  const go = async (path: string): Promise<void> => {
    if (path.startsWith("http") || path.startsWith("//")) { window.location.assign(path); return; }
    const next = routeFor(path.split("?")[0] ?? "/", path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
    if (next.path === route.path) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }

    captureDraft();
    scrollMemory.set(route.path, window.scrollY);
    drafts.delete(route.path);            // leaving a form discards its draft only when saved/cancelled above
    history.pushState({ path }, "", path);
    route = next;
    await loadStateAndRender();
    const remembered = scrollMemory.get(next.path) ?? 0;
    requestAnimationFrame(() => window.scrollTo({ top: remembered }));
  };

  window.addEventListener("popstate", () => {
    captureDraft();
    scrollMemory.set(route.path, window.scrollY);
    route = routeFor(window.location.pathname, window.location.search);
    void loadStateAndRender();
    requestAnimationFrame(() => window.scrollTo({ top: scrollMemory.get(route.path) ?? 0 }));
  });

  // ---- every internal link is handled in-app: no reloads, no flicker ----
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;   // let "open in new tab" work
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;
    if (anchor.target && anchor.target !== "_self") return;
    if (anchor.hasAttribute("download") || anchor.hasAttribute("data-no-soft")) return;
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) return;                      // external links behave normally
    event.preventDefault();
    go(href);
  });

  const updateStatus = (report?: { pushed: number; applied: number; at: number }, error?: string): void => {
    const counts = `${state.recipes.size} recipes · ${state.mixes.size} mixes · ${state.ingredients.size} ingredients`;
    let right: string;
    let mood: string;
    if (!navigator.onLine) { right = "offline — changes stay queued"; mood = "offline"; }
    else if (error) { right = error; mood = "error"; }
    else if (report) { right = `synced ${new Date(report.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`; mood = "synced"; }
    else { right = "syncing…"; mood = "syncing"; }
    document.body.dataset.sync = mood;
    setStatus(counts, right);
  };

  draw();
  updateStatus();
  scheduler.start();
  window.addEventListener("resize", moveTabGlider, { passive: true });

  // First convergence happens quietly after the screen is already usable.
  void scheduler.trigger().catch(() => undefined);

  // Read-only diagnostics for when something looks odd on a device.
  (window as unknown as Record<string, unknown>).__baking = {
    deviceId: app.deviceId,
    debug: async () => {
      const rows = await Effect.runPromise(app.store.allRecords());
      return { totalRows: rows.length, deleted: rows.filter((r) => r.deleted).length, pendingSync: await Effect.runPromise(pendingCount(app.store)), tables: [...new Set(rows.map((r) => r.table))].sort() };
    },
    find: async (needle: string) => (await Effect.runPromise(app.store.allRecords()))
      .filter((row) => JSON.stringify(row.cols).includes(needle))
      .map((row) => ({ table: row.table, pk: row.pk, deleted: row.deleted, updated_at: row.updated_at })),
  };

  // Marks that this page kept running in place (used by the e2e test to prove there were no reloads).
  (window as unknown as Record<string, unknown>).__baking_boot_at = Date.now();
}
