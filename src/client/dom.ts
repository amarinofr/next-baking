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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Small ring in the corner of a recipe card: how hydrated this dough is. */
export function hydrationRing(percent: number): HTMLElement {
  // A CSS dial rather than an SVG one: no viewBox geometry to get wrong at small sizes,
  // and --p is a registered custom property, so the fill itself animates.
  const fill = Math.max(0, Math.min(100, percent));
  const dial = el("span", { class: "dial", "aria-hidden": "true" });
  dial.style.setProperty("--p", "0");
  dial.append(el("b", {}, `${Math.round(percent)}%`));
  if (reduceMotion()) dial.style.setProperty("--p", String(fill));
  else requestAnimationFrame(() => dial.style.setProperty("--p", String(fill)));
  return dial;
}

/** How a dough's water is built up: main liquids vs water carried by ingredients. */
export function waterGauge(mainWater: number, carriedWater: number): HTMLElement {
  const total = Math.max(mainWater + carriedWater, 0.0001);
  const seg = (kind: "main" | "hybrid", grams: number) =>
    el("div", { class: `gauge-seg ${kind}`, style: `width:${((grams / total) * 100).toFixed(2)}%` });

  return el(
    "div",
    { class: "gauge" },
    el("div", { class: "gauge-bar" }, ...(mainWater > 0 ? [seg("main", mainWater)] : []), ...(carriedWater > 0 ? [seg("hybrid", carriedWater)] : [])),
    el(
      "div",
      { class: "gauge-key" },
      el("span", {}, el("i", { class: "main" }), `from main liquids · ${grams(mainWater)}`),
      el("span", {}, el("i", { class: "hybrid" }), `carried by ingredients · ${grams(carriedWater)}`),
    ),
  );
}

/** Proportional bar of a flour mix's components, in the order given. */
export function mixBar(parts: Array<{ grams: number }>): HTMLElement {
  const total = parts.reduce((sum, part) => sum + part.grams, 0) || 1;
  const shades = ["#c1893b", "#5f7a4c", "#35708f", "#b0532c", "#9c6a25", "#7d8f69", "#8a6f52", "#265770"];
  return el(
    "div",
    { class: "mixbar", "aria-hidden": "true" },
    ...parts.map((part, index) => el("div", { style: `flex:${Math.max(part.grams, 0.001)}; background:${shades[index % shades.length]}` })),
  );
}

/** A figure that just changed gets a brief warm flash so you notice it. */
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
