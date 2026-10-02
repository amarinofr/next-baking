/** Tiny DOM helpers + formatting (no framework on purpose: fewer moving parts). */

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value as unknown as Record<string, string>);
    else if (key.startsWith("on") && typeof value === "boolean") continue;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export const clear = (node: Element): void => { node.replaceChildren(); };

export const grams = (n: number): string => `${Number.isInteger(n) || Math.abs(n) >= 10 ? Math.round(n) : n.toFixed(1)} g`;

export const euro = (n: number): string => `€${n.toFixed(2)}`;

export const num = (n: number, digits = 1): string => n.toFixed(digits);

export const pct = (n: number): string => `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;

export const askConfirm = (message: string): boolean => window.confirm(message);

const reduceMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Staggered entrance: CSS reads `--i` and delays each item a little further. */
export function stagger<T extends HTMLElement>(nodes: T[]): T[] {
  nodes.forEach((node, index) => {
    node.classList.add("stagger");
    node.style.setProperty("--i", String(Math.min(index, 24)));
  });
  return nodes;
}

/** Which coloured sheet a hydration figure belongs to. Colour is the reading device:
 *  butter dry dough · sage a normal one · sky a wet one · lilac a batter-like one. */
export function hydrationSheet(percent: number): string {
  if (percent < 55) return "sheet-butter";
  if (percent < 80) return "sheet-sage";
  if (percent < 100) return "sheet-sky";
  return "sheet-lilac";
}

/** The two ways water reaches a dough, told as two coloured figures — no bar, no dial. */
export function waterSplit(mainWater: number, carriedWater: number): HTMLElement {
  const block = (sheet: string, label: string, value: number): HTMLElement =>
    el("div", { class: sheet }, el("span", {}, label), el("b", {}, grams(value)));

  return el(
    "div",
    { class: "split" },
    block("sheet-sky", "from main liquids", mainWater),
    block("sheet-clay", "carried by ingredients", carriedWater),
  );
}

/** A figure that just changed gets one warm stroke so you notice it. */
export const flash = (node: Element | null | undefined): void => {
  if (!node || reduceMotion()) return;
  node.classList.remove("flash");
  void (node as HTMLElement).offsetWidth;   // restart the animation
  node.classList.add("flash");
};

/** Count a number up to its value instead of dropping it on the screen. */
export function countUp(node: Element, value: number, format: (n: number) => string, ms = 480): void {
  if (reduceMotion() || ms <= 0 || !Number.isFinite(value)) { node.textContent = format(value); return; }

  const started = performance.now();
  const tick = (now: number): void => {
    const t = Math.min(1, (now - started) / ms);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = format(value * eased);
    if (t < 1) requestAnimationFrame(tick);
    else node.textContent = format(value);
  };
  requestAnimationFrame(tick);
}

/** Small messages in the corner — they never cover what you are looking at. */
export const toast = (message: string, kind: "ok" | "err" | "warn" = "ok"): void => {
  const box = document.getElementById("toasts");
  if (!box) return;
  const note = el("div", { class: kind === "ok" ? "toast" : `toast ${kind}` }, message);
  box.append(note);
  window.setTimeout(() => {
    note.style.opacity = "0";
    window.setTimeout(() => note.remove(), 250);
  }, kind === "err" ? 8000 : 3500);
};

export const setStatus = (left: string, right?: string): void => {
  const l = document.getElementById("status-left");
  const r = document.getElementById("status-right");
  if (l) l.textContent = left;
  if (r && right !== undefined) r.textContent = right;
};

/** Run an Effect program and surface failures as toasts instead of exceptions. */
/** Like runUi, but reports whether the action succeeded (a void success is still a success). */
export const runAction = async <A, E>(program: import("effect").Effect.Effect<A, E, never>): Promise<boolean> => {
  const { Effect } = await import("effect");
  const result = await Effect.runPromise(Effect.either(program));
  if (result._tag === "Left") {
    const error = result.left as { _tag?: string; field?: string; reason?: string; cause?: string; message?: string };
    toast([error.field, error.reason].filter(Boolean).join(": ") || error._tag || "something went wrong", "err");
    return false;
  }
  return true;
};

export const runUi = async <A, E>(program: import("effect").Effect.Effect<A, E, never>): Promise<A | undefined> => {
  const { Effect } = await import("effect");
  const result = await Effect.runPromise(Effect.either(program));
  if (result._tag === "Left") {
    const error = result.left as { _tag?: string; field?: string; reason?: string; cause?: string; message?: string };
    toast([error.field, error.reason].filter(Boolean).join(": ") || error._tag || "something went wrong", "err");
    return undefined;
  }
  return result.right;
};
