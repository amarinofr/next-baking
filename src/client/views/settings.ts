/** Sync & backups: auto-sync switch, manual sync, hub address, JSON snapshot import/export. */

import { Effect } from "effect";
import { mergeChangesets } from "../../domain/syncMerge.ts";
import type { RowRecord } from "../../domain/types.ts";
import { clear, el, runUi, toast } from "../dom.ts";
import type { SyncScheduler } from "../syncScheduler.ts";
import { exportSnapshot, hubUrlOf, pendingCount, setHubUrl } from "../syncClient.ts";
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

export function renderSettings(ctx: ViewCtx, mountPoint: HTMLElement, scheduler?: SyncScheduler): void {
  const state = ctx.state;
  const deviceId = ctx.app.deviceId;
  const totalRows = state.ingredients.size + state.mixes.size + state.recipes.size + state.mixComponents.length + state.recipeIngredients.length + state.recipeMixes.length + state.mainLiquids.length;

  const last = scheduler?.lastSync;
  const statusLine = el("p", { class: "hint" }, last
    ? `last sync ${new Date(last.at).toLocaleString()} — pushed ${last.pushed}, applied ${last.applied}`
    : "no sync yet on this device");

  // ---- auto-sync switch ----
  const autoToggle = el("input", { id: "auto-sync", type: "checkbox" }) as HTMLInputElement;
  autoToggle.checked = scheduler?.autoSync ?? true;
  autoToggle.addEventListener("change", () => {
    scheduler?.setAutoSync(autoToggle.checked);
    toast(autoToggle.checked ? "Auto-sync on: changes are pushed a moment after you make them." : "Auto-sync off: use “Sync now” when you want to send changes.");
  });

  const syncButton = el("button", { id: "sync-now", class: "primary", type: "button" }, "Sync now");
  syncButton.addEventListener("click", async () => {
    syncButton.disabled = true;
    syncButton.textContent = "syncing…";
    const outcome = scheduler ? await scheduler.trigger() : undefined;
    syncButton.disabled = false;
    syncButton.textContent = "Sync now";
    if (!outcome) return;
    statusLine.textContent = `last sync ${new Date(outcome.at).toLocaleString()} — pushed ${outcome.pushed}, applied ${outcome.applied}`;
    void Effect.runPromise(pendingCount(ctx.app.store)).then((pending: number) => { if (pending > 0) statusLine.textContent += ` · ${pending} still queued`; }).catch(() => undefined);
  });

  const hubInput = el("input", { id: "hub", name: "hub_url", type: "text", spellcheck: "false" }) as HTMLInputElement;
  const saveHubButton = el("button", { class: "primary", type: "submit" }, "Save address");

  const hubForm = el("form", { class: "panel" });
  hubForm.append(
    el("h3", {}, "Replication hub"),
    el("p", { class: "hint" }, "Every device keeps its own copy and works with no network at all. When a device can reach the hub it pushes what changed and pulls what it missed — last write wins per row."),
    el("div", { class: "field" }, el("label", { for: "hub" }, "Hub address"), hubInput),
    el("div", { class: "right" }, saveHubButton),
    el("p", { class: "hint" }, "On a phone, point this at the machine running ", el("code", {}, "npm run serve"), ", e.g. ", el("code", {}, "http://192.168.1.20:7902/api/sync"), "."),
  );
  hubForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runUi(setHubUrl(ctx.app.store, hubInput.value.trim() || "/api/sync"));
    toast("Hub address saved on this device.");
  });

  const exportButton = el("button", { class: "remove", type: "button" }, "export JSON snapshot");
  exportButton.addEventListener("click", async () => {
    const json = await runUi(exportSnapshot(ctx.app.store));
    if (!json) return;
    download(`next-baking-${new Date().toISOString().slice(0, 16)}.json`, json);
  });

  const fileInput = el("input", { id: "import-file", type: "file", accept: "application/json" }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const content = await file.text();
    const parsed = await runUi(Effect.try(() => JSON.parse(content) as { records?: RowRecord[] }).pipe(
      Effect.mapError((error) => ({ _tag: "ValidationError", reason: `not a valid snapshot: ${String(error.message ?? error)}` } as never)),
    ));
    if (!parsed?.records) { toast("That file has no `records` array.", "err"); return; }

    const local = await runUi(ctx.app.store.allRecords());
    if (!local) return;
    const { toApply } = mergeChangesets(local, parsed.records);
    await runUi(ctx.app.store.mergeRemote(toApply));
    ctx.markChanged();
    toast(`Imported ${toApply.length} row(s) from the snapshot.`);
    void ctx.refresh();
  });

  clear(mountPoint);
  mountPoint.append(
    el("div", { class: "page-head" }, el("h2", {}, "Sync & backups")),

    el("section", { class: "panel" },
      el("h3", {}, "Syncing"),
      el("div", { class: "row" }, autoToggle, el("label", { for: "auto-sync" }, "Sync automatically while online")),
      el("div", { class: "row" }, syncButton),
      statusLine,
      el("hr", { class: "sep" }),
      el("div", { class: "kv" },
        el("span", {}, "This device"), el("b", {}, deviceId),
        el("span", {}, "Recipes · mixes · ingredients"), el("b", {}, `${state.recipes.size} · ${state.mixes.size} · ${state.ingredients.size}`),
        el("span", {}, "Stored rows"), el("b", {}, String(totalRows)),
        ...(state.invalidRows > 0 ? [el("span", {}, "Rows skipped (unreadable)"), el("b", {}, String(state.invalidRows))] : []),
      ),
    ),

    hubForm,

    el("section", { class: "panel" },
      el("h3", {}, "Backup & transfer"),
      el("p", { class: "hint" }, "JSON snapshots include delete tombstones, so importing onto another device converges instead of resurrecting old rows."),
      el("div", { class: "row" }, exportButton),
      el("div", { class: "field" }, el("label", { for: "import-file" }, "Import a snapshot"), fileInput),
      el("hr", { class: "sep" }),
      el("p", { class: "notice" }, "Your original app is untouched. Nothing here reads or writes outside this folder except the explicit read-only backup command: npm run snapshot"),
    ),
  );

  void Effect.runPromise(hubUrlOf(ctx.app.store)).then((url) => { hubInput.value = url; }).catch(() => undefined);
  void Effect.runPromise(pendingCount(ctx.app.store)).then((pending: number) => { if (pending > 0) statusLine.textContent += ` · ${pending} row(s) waiting to sync`; }).catch(() => undefined);
}
