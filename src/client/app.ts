/**
 * Browser application facade: opens IndexedDB, seeds the very first run from the
 * bundled snapshot of the original database, validates form input through Effect
 * schemas, and exposes typed operations to the UI layer.
 */

import { Effect } from "effect";
import {
  decode, IngredientInputSchema, MixInputSchema, RecipeInputSchema, StorageError, ValidationError, numField,
} from "../domain/schema.ts";
import { loadSeedRecords } from "../domain/seed.ts";
import { makeRepository } from "../domain/repository.ts";
import { buildState, type AppState } from "../domain/state.ts";
import { TABLE_NAMES, type RowRecord, type TableName } from "../domain/types.ts";
import { deviceIdOf, makeIdbStore, type Store } from "./store.ts";

const SEED_URL = "/seed/state.json";

export interface SeedFile {
  generated_at?: string;
  source?: string;
  snapshot_ms?: number;
  origin?: string;
  tables?: Partial<Record<TableName, Record<string, unknown>[]>>;
}

export interface AppHandle {
  readonly store: Store;
  readonly deviceId: string;
  readonly repo: ReturnType<typeof makeRepository>;
  readonly state: AppState;
}

const fetchSeed = (): Effect.Effect<SeedFile | undefined, never> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(SEED_URL, { cache: "no-store" });
      if (!res.ok) return undefined;
      return (await res.json()) as SeedFile;
    },
    catch: () => undefined as never,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

const seedFromBundle = (store: Store): Effect.Effect<number, ValidationError | StorageError> =>
  Effect.gen(function* () {
    const existing = yield* store.allRecords();
    if (existing.length > 0) return 0;

    const seed = yield* fetchSeed();
    if (!seed?.tables) return 0;

    const snapshotMs = Number(seed.snapshot_ms ?? Date.now());
    const origin = String(seed.origin ?? "seed");

    const all: RowRecord[] = [];
    for (const table of TABLE_NAMES) {
      const rows = seed.tables[table] ?? [];
      all.push(...(yield* loadSeedRecords(table, rows, snapshotMs, origin)));
    }

    yield* store.putRecords(all);
    yield* store.setMeta("seeded_at", new Date().toISOString());
    return all.length;
  });

export const boot = (): Effect.Effect<AppHandle, StorageError | ValidationError> =>
  Effect.gen(function* () {
    const store = yield* makeIdbStore();
    const deviceId = yield* deviceIdOf(store);
    yield* seedFromBundle(store);
    const records = yield* store.allRecords();
    const state = yield* buildState(records);
    return { store, deviceId, repo: makeRepository({ store, deviceId }), state };
  });

export const reloadState = (app: AppHandle): Effect.Effect<AppState, ValidationError | StorageError> =>
  Effect.flatMap(app.store.allRecords(), (records) => buildState(records));

// ---------- form parsing (the only place raw DOM values become typed data) ----------

const formValue = (form: FormData, key: string): unknown => form.get(key);

/**
 * Water content is entered as a percentage ("85"), but a bare fraction ("0.85") is also
 * accepted and converted, then clamped into the legal 0..1 range instead of letting the
 * browser silently refuse to submit the form.
 */
const hybridWaterFraction = (raw: unknown): number => {
  const value = numField(raw, 0);
  const percent = value > 1 ? value : value * 100;
  return Math.min(1, Math.max(0, percent / 100));
};

export const ingredientInputFromForm = (form: FormData): Effect.Effect<typeof IngredientInputSchema.Type, ValidationError> => {
  const categoryRaw = String(formValue(form, "category") ?? "dry");
  const category = categoryRaw === "hybrid" || categoryRaw === "liquid" ? categoryRaw : "dry";
  return decode(IngredientInputSchema, "ingredient")({
    id: String(formValue(form, "id") ?? "") || undefined,
    name: String(formValue(form, "name") ?? "").trim(),
    category,
    price: numField(formValue(form, "price"), 0),
    hybrid_water: category === "hybrid" ? hybridWaterFraction(formValue(form, "water_percent")) : 0,
    calories: numField(formValue(form, "calories"), 0),
    protein: numField(formValue(form, "protein"), 0),
    fats: numField(formValue(form, "fats"), 0),
    carbs: numField(formValue(form, "carbs"), 0),
    sugar: numField(formValue(form, "sugar"), 0),
    fiber: numField(formValue(form, "fiber"), 0),
  });
};

const pairs = (form: FormData, idKey: string, amountKey: string): Array<Record<string, number | string>> => {
  const ids = form.getAll(idKey).map(String);
  const amounts = form.getAll(amountKey).map((v) => numField(v, 0));
  const out: Array<Record<string, number | string>> = [];
  ids.forEach((id, i) => { if (id && (amounts[i] ?? 0) > 0) out.push({ [idKey]: id, amount: amounts[i] ?? 0 }); });
  return out;
};

export const mixInputFromForm = (form: FormData): Effect.Effect<typeof MixInputSchema.Type, ValidationError> => {
  const components = form.getAll("ingredient_id").map(String)
    .map((id, i) => ({ ingredient_id: id, amount: numField(form.getAll("amount")[i], 0) }))
    .filter((c) => c.ingredient_id && c.amount > 0);
  return decode(MixInputSchema, "mix")({
    id: String(formValue(form, "id") ?? "") || undefined,
    name: String(formValue(form, "name") ?? "").trim(),
    components,
  });
};

export const recipeInputFromForm = (form: FormData): Effect.Effect<typeof RecipeInputSchema.Type, ValidationError> => {
  const ingredients = [
    ...form.getAll("dry_ingredient_id").map(String).map((id, i) => ({ ingredient_id: id, amount: numField(form.getAll("dry_ingredient_amount")[i], 0) })),
    ...form.getAll("liquid_ingredient_id").map(String).map((id, i) => ({ ingredient_id: id, amount: numField(form.getAll("liquid_ingredient_amount")[i], 0) })),
  ].filter((row) => row.ingredient_id && row.amount > 0);

  const mixes = form.getAll("mix_id").map(String).map((id, i) => ({ mix_id: id, amount: numField(form.getAll("mix_amount")[i], 0) }))
    .filter((row) => row.mix_id && row.amount > 0);

  const mainLiquids = form.getAll("main_liquid_ingredient_id").map(String).map((id, i) => ({ ingredient_id: id, percentage: numField(form.getAll("main_liquid_percentage")[i], 0) }))
    .filter((row) => row.ingredient_id && row.percentage > 0);

  return decode(RecipeInputSchema, "recipe")({
    id: String(formValue(form, "id") ?? "") || undefined,
    name: String(formValue(form, "name") ?? "").trim(),
    instructions: String(formValue(form, "instructions") ?? ""),
    servings: Math.max(1, Math.trunc(numField(formValue(form, "servings"), 1))),
    hydration_percent: numField(formValue(form, "hydration_percent"), 65),
    // An empty selection means "no category"; a hidden field carries the stored one through.
    category_id: form.has("category_id") ? (String(formValue(form, "category_id") ?? "") || null) : undefined,
    ingredients, mixes, main_liquids: mainLiquids,
  });
};
