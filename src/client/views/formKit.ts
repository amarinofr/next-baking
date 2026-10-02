/**
 * The boxes every editor is built from.
 *
 * Recipe, flour mix and ingredient ask for different things, but they must read as one app — so all three are assembled
 * here from the same five parts: a page head, a plain sheet for the basics, coloured sheets for repeating groups of rows
 * (the colour says which family those rows belong to: butter flour mixes, sage dry goods, sky liquids and hybrids, lilac
 * shares of the target water), a figures block for live totals, and one action row at the end with the optional delete
 * beside the Save pill. Nothing in here knows what a recipe is; it only builds boxes.
 */

import { el } from "../dom.ts";

export interface GroupSpec {
  readonly title: string;
  readonly nameKey: string;                       // field name of the picker in each row
  readonly amountKey: string;                     // field name of the amount in each row
  readonly options: Array<[value: string, label: string]>;
  readonly unit: "g" | "%";                       // placeholder inside the amount box
  readonly sheet: string;                         // which coloured paper this family wears
  readonly existing?: Array<{ idOrMix: string; amount: number }>;
  readonly onChange?: () => void;                 // live totals redraw whenever a row changes
}

export const pageHead = (title: string, cancelHref: string): HTMLElement =>
  el("div", { class: "page-head" }, el("h2", {}, title), el("a", { class: "plain", href: cancelHref }, "Cancel"));

export const textField = (name: string, label: string, value = "", placeholder = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "text", value, placeholder }));

export const numberField = (name: string, label: string, value: number | string, placeholder = ""): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), el("input", { id: name, name, type: "number", step: "any", value: String(value), placeholder }));

/** A bare select, for fields that need their own label or hidden fallback (categories). */
export const selectOf = (name: string, options: Array<[value: string, label: string]>, selected?: string): HTMLElement =>
  el("select", { id: name, name }, ...options.map(([value, label]) => el("option", { value, selected: selected === value ? "selected" : undefined }, label)));

export const selectField = (name: string, label: string, options: Array<[value: string, label: string]>, selected?: string): HTMLElement =>
  el("div", { class: "field" }, el("label", { for: name }, label), selectOf(name, options, selected));

/** The identity fields — name and the handful of plain values — always on one uncoloured sheet. */
export const basicsPanel = (...fields: Array<HTMLElement>): HTMLElement => el("section", { class: "panel" }, ...fields);

/** Live totals while editing, boxed exactly like a panel on a detail page so both screens rhyme. */
export const figuresPanel = (title: string, ...content: Array<HTMLElement>): HTMLElement =>
  el("section", { class: "panel tinted sheet-sky" }, el("h3", {}, title), ...content);

/** A repeating group of rows on its own coloured sheet, with its own add-row control. */
export function groupSheet(spec: GroupSpec): HTMLElement {
  const rows = el("div", { class: "rows" });

  const addRow = (selectValue = "", amount: number | string = ""): HTMLElement => {
    const row = el("div", { class: "row component-row" },
      selectOf(spec.nameKey, spec.options, selectValue),
      el("input", { name: spec.amountKey, type: "number", step: "any", placeholder: spec.unit, value: String(amount) }),
    );

    const remove = el("button", { class: "remove", type: "button" }, "remove");
    remove.addEventListener("click", () => { row.remove(); spec.onChange?.(); });
    row.append(remove);
    row.querySelectorAll("select, input").forEach((node) => node.addEventListener("change", () => spec.onChange?.()));

    rows.append(row);
    return row;
  };

  for (const item of spec.existing ?? []) addRow(item.idOrMix, item.amount);
  if ((spec.existing?.length ?? 0) === 0) addRow();   // a form always offers one empty row to fill in

  const addButton = el("button", { class: "add-row", type: "button" }, "+ Add row");
  addButton.addEventListener("click", () => { addRow(); spec.onChange?.(); });

  return el("div", { class: `field washed ${spec.sheet}` },
    el("div", { class: "form-head-row" }, el("span", {}, spec.title), addButton),
    rows,
  );
}

/** Live totals while editing: text on coloured paper, never a chart. */
export const figuresBlock = (): HTMLElement => el("pre", { class: "preview" });

/** Every editor ends the same way: optional delete, then the ink Save pill. */
export const actionsRow = (deleteButton?: HTMLElement): HTMLElement =>
  el("div", { class: "form-actions" }, ...(deleteButton ? [deleteButton] : []), el("button", { class: "primary save", type: "submit" }, "Save"));
