/**
 * Repository: all writes go through here.
 *
 * Deletes are tombstones (`deleted = true`) so they replicate correctly between
 * devices instead of silently resurrecting on the next pull. Cascades match the
 * legacy app's behaviour (removing an ingredient also removes the recipe/mix rows
 * that referenced it).
 */

import { Effect } from "effect";
import { nextDuplicateName } from "./duplicate.ts";
import { NotFoundError, StorageError, ValidationError, type IngredientInput, type MixInput, type RecipeInput } from "./schema.ts";
import { TABLES, pkOf, type RowRecord, type TableName } from "./types.ts";
import type { Store } from "../client/store.ts";

export interface RepoDeps { readonly store: Store; readonly deviceId: string; readonly now?: () => number }

const nowIso = () => new Date().toISOString();
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);

const colsOf = (record: RowRecord): Record<string, unknown> => record.cols;

export function makeRepository(deps: RepoDeps) {
  const now = deps.now ?? (() => Date.now());

  const readAll = deps.store.allRecords;

  const buildRecord = (table: TableName, values: Record<string, unknown>): RowRecord => {
    const stamped: Record<string, unknown> = { ...values, updated_at: now(), deleted: false, origin: deps.deviceId };
    const pk = pkOf(table, stamped);
    const cols: Record<string, unknown> = {};
    for (const column of TABLES[table].columns) {
      if (column === "updated_at" || column === "deleted" || column === "origin") continue;
      cols[column] = stamped[column];
    }
    return { table, pk, cols, updated_at: stamped.updated_at as number, deleted: false, origin: deps.deviceId };
  };

  const findRecord = (records: readonly RowRecord[], table: TableName, pk: string) =>
    records.find((r) => r.table === table && r.pk === pk);

  const namesIn = (records: readonly RowRecord[], table: TableName): string[] =>
    records.filter((r) => r.table === table && !r.deleted).map((r) => String(colsOf(r).name ?? ""));

  // ---------- ingredients ----------

  const saveIngredient = (input: IngredientInput): Effect.Effect<RowRecord, ValidationError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const id = input.id ?? newId();
      const existing = findRecord(records, "ingredients", id);
      const row = buildRecord("ingredients", {
        id,
        name: input.name,
        unit: "g",
        created_at: existing ? colsOf(existing).created_at : nowIso(),
        price: input.price,
        category: input.category,
        calories: input.calories, protein: input.protein, fats: input.fats, carbs: input.carbs, sugar: input.sugar, fiber: input.fiber,
        hybrid_water: input.category === "hybrid" ? input.hybrid_water : 0,
      });
      yield* deps.store.putRecords([row]);
      return row;
    });

  const deleteIngredient = (id: string): Effect.Effect<void, NotFoundError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const target = findRecord(records, "ingredients", id);
      if (!target || target.deleted) return yield* Effect.fail(new NotFoundError({ table: "ingredients", id }));

      const cascade = records.filter((r) =>
        !r.deleted &&
        (r.table === "flour_mix_components" || r.table === "recipe_ingredients" || r.table === "recipe_main_liquids") &&
        colsOf(r).ingredient_id === id,
      ).map((r) => ({ ...r, deleted: true, updated_at: now(), origin: deps.deviceId }));

      yield* deps.store.putRecords([{ ...target, deleted: true, updated_at: now(), origin: deps.deviceId }, ...cascade]);
    });

  const duplicateIngredient = (id: string): Effect.Effect<RowRecord, NotFoundError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const source = findRecord(records, "ingredients", id);
      if (!source || source.deleted) return yield* Effect.fail(new NotFoundError({ table: "ingredients", id }));
      const name = nextDuplicateName(String(colsOf(source).name ?? ""), namesIn(records, "ingredients"));
      const copy = buildRecord("ingredients", { ...colsOf(source), id: newId(), name, created_at: nowIso() });
      yield* deps.store.putRecords([copy]);
      return copy;
    });

  // ---------- flour mixes ----------

  const saveMix = (input: MixInput): Effect.Effect<RowRecord[], ValidationError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const id = input.id ?? newId();
      const existing = findRecord(records, "flour_mixes", id);
      const mix = buildRecord("flour_mixes", {
        id, name: input.name, created_at: existing ? colsOf(existing).created_at : nowIso(),
      });

      const wantedKeys = new Set(input.components.map((c) => pkOf("flour_mix_components", { mix_id: id, ingredient_id: c.ingredient_id })));
      const componentRows = input.components.map((c) =>
        buildRecord("flour_mix_components", { mix_id: id, ingredient_id: c.ingredient_id, amount: c.amount }),
      );
      const removed = records.filter((r) => r.table === "flour_mix_components" && colsOf(r).mix_id === id && !r.deleted && !wantedKeys.has(r.pk))
        .map((r) => ({ ...r, deleted: true, updated_at: now(), origin: deps.deviceId }));

      yield* deps.store.putRecords([mix, ...componentRows, ...removed]);
      return [mix, ...componentRows];
    });

  const deleteMix = (id: string): Effect.Effect<void, NotFoundError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const target = findRecord(records, "flour_mixes", id);
      if (!target || target.deleted) return yield* Effect.fail(new NotFoundError({ table: "flour_mixes", id }));

      const cascade = records.filter((r) =>
        !r.deleted && (r.table === "flour_mix_components" || r.table === "recipe_mixes") && colsOf(r).mix_id === id,
      ).map((r) => ({ ...r, deleted: true, updated_at: now(), origin: deps.deviceId }));

      yield* deps.store.putRecords([{ ...target, deleted: true, updated_at: now(), origin: deps.deviceId }, ...cascade]);
    });

  const duplicateMix = (id: string): Effect.Effect<RowRecord[], NotFoundError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const source = findRecord(records, "flour_mixes", id);
      if (!source || source.deleted) return yield* Effect.fail(new NotFoundError({ table: "flour_mixes", id }));

      const newMixId = newId();
      const name = nextDuplicateName(String(colsOf(source).name ?? ""), namesIn(records, "flour_mixes"));
      const components = records.filter((r) => r.table === "flour_mix_components" && colsOf(r).mix_id === id && !r.deleted)
        .map((r) => buildRecord("flour_mix_components", { mix_id: newMixId, ingredient_id: String(colsOf(r).ingredient_id), amount: Number(colsOf(r).amount) }));

      const mix = buildRecord("flour_mixes", { id: newMixId, name, created_at: nowIso() });
      yield* deps.store.putRecords([mix, ...components]);
      return [mix, ...components];
    });

  // ---------- recipes ----------

  const saveRecipe = (input: RecipeInput): Effect.Effect<RowRecord[], ValidationError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const id = input.id ?? newId();
      const existing = findRecord(records, "recipes", id);
      const recipe = buildRecord("recipes", {
        id, name: input.name, instructions: input.instructions ?? "", servings: Math.trunc(input.servings),
        hydration_percent: input.hydration_percent, created_at: existing ? colsOf(existing).created_at : nowIso(),
      });

      const writeLinks = (table: TableName, rows: Array<Record<string, unknown>>, keyField: string) => {
        const wanted = new Set(rows.map((r) => pkOf(table, r)));
        const created = rows.map((r) => buildRecord(table, r));
        const removed = records.filter((r) => r.table === table && colsOf(r)[keyField] === id && !r.deleted && !wanted.has(r.pk))
          .map((r) => ({ ...r, deleted: true, updated_at: now(), origin: deps.deviceId }));
        return [...created, ...removed];
      };

      const rows = [
        recipe,
        ...writeLinks("recipe_ingredients", input.ingredients.map((i) => ({ recipe_id: id, ingredient_id: i.ingredient_id, amount: i.amount })), "recipe_id"),
        ...writeLinks("recipe_mixes", input.mixes.map((m) => ({ recipe_id: id, mix_id: m.mix_id, amount: m.amount })), "recipe_id"),
        ...writeLinks("recipe_main_liquids", input.main_liquids.filter((l) => l.percentage > 0).map((l) => ({ recipe_id: id, ingredient_id: l.ingredient_id, percentage: l.percentage })), "recipe_id"),
      ];

      yield* deps.store.putRecords(rows);
      return rows;
    });

  const deleteRecipe = (id: string): Effect.Effect<void, NotFoundError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const target = findRecord(records, "recipes", id);
      if (!target || target.deleted) return yield* Effect.fail(new NotFoundError({ table: "recipes", id }));

      const cascade = records.filter((r) =>
        !r.deleted && (r.table === "recipe_ingredients" || r.table === "recipe_mixes" || r.table === "recipe_main_liquids") && colsOf(r).recipe_id === id,
      ).map((r) => ({ ...r, deleted: true, updated_at: now(), origin: deps.deviceId }));

      yield* deps.store.putRecords([{ ...target, deleted: true, updated_at: now(), origin: deps.deviceId }, ...cascade]);
    });

  const duplicateRecipe = (id: string): Effect.Effect<RowRecord[], NotFoundError | StorageError> =>
    Effect.gen(function* () {
      const records = yield* readAll();
      const source = findRecord(records, "recipes", id);
      if (!source || source.deleted) return yield* Effect.fail(new NotFoundError({ table: "recipes", id }));

      const newIdValue = newId();
      const name = nextDuplicateName(String(colsOf(source).name ?? ""), namesIn(records, "recipes"));
      const copy = buildRecord("recipes", {
        id: newIdValue, name, instructions: String(colsOf(source).instructions ?? ""), servings: Number(colsOf(source).servings),
        hydration_percent: Number(colsOf(source).hydration_percent), created_at: nowIso(),
      });

      const linkCopies = records
        .filter((r) => !r.deleted && (r.table === "recipe_ingredients" || r.table === "recipe_mixes" || r.table === "recipe_main_liquids") && colsOf(r).recipe_id === id)
        .map((r) => buildRecord(r.table, { ...colsOf(r), recipe_id: newIdValue }));

      yield* deps.store.putRecords([copy, ...linkCopies]);
      return [copy, ...linkCopies];
    });

  // ---------- maintenance ----------

  /** Rows this device wrote since the last sync cursor (the replication outbox). */
  const outboxSince = (cursorMs: number): Effect.Effect<RowRecord[], ValidationError | StorageError> =>
    Effect.map(readAll(), (records) => records.filter((r) => r.updated_at > cursorMs && r.origin === deps.deviceId));

  return { saveIngredient, deleteIngredient, duplicateIngredient, saveMix, deleteMix, duplicateMix, saveRecipe, deleteRecipe, duplicateRecipe, outboxSince };
}
