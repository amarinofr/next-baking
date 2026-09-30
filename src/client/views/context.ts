/** Shared context passed to every view renderer. */

import type { AppHandle } from "../app.ts";
import type { AppState } from "../../domain/state.ts";

export interface ViewCtx {
  readonly app: AppHandle;
  readonly state: AppState;
  /** re-read IndexedDB and re-render the current page */
  readonly refresh: () => Promise<void>;
  readonly navigate: (path: string) => void;
}
