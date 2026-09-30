/**
 * Auto-sync scheduling.
 *
 * You never press "sync": a change is pushed a moment later, the app pulls when it wakes
 * up, and everything stays queued while offline. One request at a time, no thundering herd.
 */

import { Effect } from "effect";
import { syncNow } from "./syncClient.ts";
import type { Store } from "./store.ts";

export interface SyncOutcomeReport { pushed: number; applied: number; at: number }

export interface SchedulerOptions {
  readonly store: Store;
  readonly deviceId: string;
  /** what to do when rows arrived from elsewhere (usually: re-render lists) */
  readonly onApplied: (applied: number) => void;
  /** are we on a form page? then incoming changes must not touch the screen */
  readonly isFormPage: () => boolean;
  readonly onStatus?: (report: SyncOutcomeReport | undefined, error: string | undefined) => void;
}

/** Public shape of the scheduler, as views see it. */
export interface SyncScheduler {
  readonly markChanged: () => void;
  readonly trigger: () => Promise<SyncOutcomeReport | undefined>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly autoSync: boolean;
  readonly setAutoSync: (on: boolean) => void;
  readonly lastSync: SyncOutcomeReport | undefined;
  readonly isBusy: () => boolean;
}

const DEBOUNCE_MS = 1200;      // after a local change
const HEARTBEAT_MS = 15_000;   // while online and visible
const AUTO_SYNC_KEY = "auto_sync";

export function makeSyncScheduler(options: SchedulerOptions) {
  let running = false;
  let againWhenDone = false;
  let debounceTimer: number | undefined;
  let heartbeat: number | undefined;
  let lastReport: SyncOutcomeReport | undefined;
  let stopped = false;
  let autoSync = true;

  const publish = (error?: string): void => options.onStatus?.(lastReport, error);

  const once = async (): Promise<void> => {
    if (running || stopped) { againWhenDone = true; return; }
    running = true;
    try {
      const outcome = await Effect.runPromise(syncNow(options.store, options.deviceId));
      lastReport = { pushed: outcome.pushed, applied: outcome.applied, at: Date.now() };
      publish();
      if (outcome.applied > 0) {
        if (options.isFormPage()) options.onStatus?.(lastReport, `${outcome.applied} row(s) changed elsewhere — your form is untouched`);
        else options.onApplied(outcome.applied);
      }
    } catch (error) {
      publish(`hub not reachable — changes stay queued (${String((error as Error)?.message ?? error).slice(0, 60)})`);
    } finally {
      running = false;
      if (againWhenDone && !stopped) { againWhenDone = false; void once(); }
    }
  };

  /** Call right after anything was written locally. */
  const markChanged = (): void => {
    if (stopped || !autoSync) return;
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => { debounceTimer = undefined; void once(); }, DEBOUNCE_MS);
  };

  /** Force one round-trip now (the "Sync now" button, coming back online, …). */
  const trigger = async (): Promise<SyncOutcomeReport | undefined> => { await once(); return lastReport; };

  const start = (): void => {
    void Effect.runPromise(options.store.getMeta(AUTO_SYNC_KEY)).then((value) => { autoSync = value !== "0"; }).catch(() => undefined);

    // A quiet heartbeat. It runs whether or not this device has its own changes waiting,
    // because that is how deletions and other devices' edits arrive. Single-flight (`once`)
    // means a slow round-trip simply delays the next one instead of stacking requests.
    heartbeat = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;   // do not hammer the hub from a background tab
      if (!navigator.onLine) { publish("offline — changes stay queued"); return; }
      if (!autoSync) return;
      void once();
    }, HEARTBEAT_MS);

    window.addEventListener("online", () => void once());
    window.addEventListener("focus", () => { if (autoSync && navigator.onLine) void once(); });   // back to the app -> catch up
    window.addEventListener("offline", () => publish("offline — local copy in use"));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && navigator.onLine) void once(); });
  };

  const stop = (): void => {
    stopped = true;
    if (heartbeat !== undefined) window.clearInterval(heartbeat);
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  };

  const setAutoSync = (on: boolean): void => {
    autoSync = on;
    void Effect.runPromise(options.store.setMeta(AUTO_SYNC_KEY, on ? "1" : "0")).catch(() => undefined);
    if (on) void once();
  };

  const scheduler = { markChanged, trigger, start, stop, get autoSync(): boolean { return autoSync; }, setAutoSync, get lastSync(): SyncOutcomeReport | undefined { return lastReport; }, isBusy: () => running };
  return scheduler satisfies SyncScheduler & { isBusy: () => boolean };
}
