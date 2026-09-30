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

export const toast = (message: string, kind: "ok" | "err" | "warn" = "ok"): void => {
  const app = document.getElementById("app");
  if (!app) return;
  const note = el("div", { class: `notice ${kind === "ok" ? "ok" : kind}` }, message);
  app.prepend(note);
  window.setTimeout(() => note.remove(), kind === "err" ? 8000 : 4000);
};

export const setStatus = (left: string, right?: string): void => {
  const l = document.getElementById("status-left");
  const r = document.getElementById("status-right");
  if (l) l.textContent = left;
  if (r && right !== undefined) r.textContent = right;
};

/** Run an Effect program and surface failures as toasts instead of exceptions. */
export const runUi = async <A, E>(program: import("effect").Effect.Effect<A, E, never>): Promise<A | undefined> => {
  const { Effect } = await import("effect");
  const result = await Effect.runPromise(Effect.either(program));
  if (result._tag === "Left") {
    const error = result.left as { _tag?: string; reason?: string; cause?: string; message?: string };
    toast(error.reason ?? error.cause ?? error.message ?? error._tag ?? "something went wrong", "err");
    return undefined;
  }
  return result.right;
};
