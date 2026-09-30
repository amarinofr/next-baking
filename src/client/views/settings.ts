/** Sync + backup page: device identity, hub address, export/import of the whole store. */

import { Effect } from "effect";
import { mergeChangesets } from "../../domain/syncMerge.ts";
import type { RowRecord } from "../../domain/types.ts";
import { clear, el, runUi, setStatus, toast } from "../dom.ts";
import { exportSnapshot, hubUrlOf, pendingCount, setHubUrl, syncNow } from "../syncClient.ts";
import type { ViewCtx } from "./context.ts";

const download = (filename: string, content: string): void => {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

/** Kept outside the render so the result survives the view re-render after a refresh. */
let lastSyncSummary = "";

export function renderSettings(ctx: ViewCtx, mountPoint: HTMLElement): void {
  const state = ctx.state;
  const totalRows = state.ingredients.size + state.mixes.size + state.recipes.size + state.mixComponents.length + state.recipeIngredients.length + state.recipeMixes.length + state.mainLiquids.length;

  const hubInput = el("input", { type: "text", spellcheck: "false" }) as HTMLInputElement;
  const statusLine = el("p", { class: "small muted" }, lastSyncSummary);

  const deviceId = ctx.app.deviceId;

  const syncButton = el("button", { id: "sync-now", class: "primary", type: "button" }, "Sync now");
  syncButton.addEventListener("click", async () => {
    syncButton.disabled = true;
    const outcome = await runUi(syncNow(ctx.app.store, deviceId));
    syncButton.disabled = false;
    if (!outcome) return;
    lastSyncSummary = `pushed ${outcome.pushed} row(s), applied ${outcome.applied} row(s) from hub`;
    statusLine.textContent = lastSyncSummary;
    toast(`Synced with hub (${outcome.applied} incoming).`);
    void ctx.refresh();
  });

  const saveHubButton = el("button", { class: "small", type: "button" }, "Save address");
  saveHubButton.addEventListener("click", async () => {
    await runUi(setHubUrl(ctx.app.store, hubInput.value.trim() || "/api/sync"));
    toast("Hub address saved on this device.");
  });

  const exportButton = el("button", { class: "small", type: "button" }, "Export JSON snapshot");
  exportButton.addEventListener("click", async () => {
    const json = await runUi(exportSnapshot(ctx.app.store));
    if (!json) return;
    download(`next-baking-${new Date().toISOString().slice(0, 16)}.json`, json);
  });

  const fileInput = el("input", { type: "file", accept: "application/json" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const textContent = await file.text();
    const parsed = await runUi(Effect.try(() => JSON.parse(textContent) as { records?: RowRecord[] }).pipe(
      Effect.mapError((e) => ({ _tag: "ValidationError", reason: `not a valid snapshot: ${String(e.message ?? e)}` } as never)),
    ));
    if (!parsed?.records) { toast("That file has no `records` array.", "err"); return; }

    const local = await runUi(ctx.app.store.allRecords());
    if (!local) return;
    const { toApply } = mergeChangesets(local, parsed.records);
    await runUi(ctx.app.store.putRecords(toApply));
    toast(`Imported ${toApply.length} row(s) from the snapshot.`);
    void ctx.refresh();
  });

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" }, el("h2", {}, "Sync & backups")),

    el("section", { class: "panel" },
      el("h3", {}, "This device"),
      el("div", { class: "kv" },
        el("span", {}, "Device id"), el("b", {}, deviceId),
        el("span", {}, "Stored rows"), el("b", {}, String(totalRows)),
        el("span", {}, "Recipes / mixes / ingredients"), el("b", {}, `${state.recipes.size} / ${state.mixes.size} / ${state.ingredients.size}`),
        ...(state.invalidRows > 0 ? [el("span", {}, "Rows skipped (invalid)"), el("b", {}, String(state.invalidRows))] : []),
      ),
      statusLine,
    ),

    el("section", { class: "panel" },
      el("h3", {}, "Replication hub"),
      el("p", { class: "small muted" }, "Offline-first: every device keeps its own copy and edits work with no network. When a device can reach the hub it pushes what changed and pulls what it missed (last write wins per row)."),
      el("div", { class: "inline-fields" },
        el("div", { class: "field" }, el("label", { for: "hub" }, "Hub address"), hubInput),
        saveHubButton, syncButton,
      ),
      el("p", { class: "small muted" }, "Typical value on a phone: ", el("code", {}, "http://192.168.1.20:7902/api/sync"), " (the desktop running ", el("code", {}, "npm run serve"), ")."),
    ),

    el("section", { class: "panel" },
      el("h3", {}, "Backup & transfer"),
      el("p", { class: "small muted" }, "JSON snapshots include deleted-row tombstones, so importing onto another device converges instead of resurrecting old rows."),
      el("div", { class: "inline-fields" }, exportButton, fileInput),
      el("hr", { class: "sep" }),
      el("p", { class: "notice" }, "Your original app is untouched. Nothing in this project reads or writes outside this folder except the explicit read-only backup command: npm run snapshot"),
    ),
  );

  void Effect.runPromise(hubUrlOf(ctx.app.store)).then((url) => { hubInput.value = url; });
  void Effect.runPromise(pendingCount(ctx.app.store)).then((pending) => { setStatus(`${deviceId} · ${totalRows} rows`, pending > 0 ? `${pending} row(s) waiting to sync` : "in sync"); });
}
