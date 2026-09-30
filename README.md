# next-baking-app

An **offline-first** rewrite of your baking app (ingredients · flour mixes · recipes with baker's-hydration maths).
Your original app in `../baking` is untouched — this folder contains its full copy plus a new app built on top of the same database content.

Read [`SAFETY.md`](./SAFETY.md) first if you care about the data (you said you do).

---

## Stack (and why)

| Layer | Choice | Why |
|---|---|---|
| UI | **Astro 5 → plain static HTML/JS** | Static files run anywhere: desktop, laptop, phone browser, installed as a PWA. No server required to *use* the app, so "offline" is not a nice idea but the default. |
| Domain logic | **Effect-TS** (`Schema` + `Effect` + typed errors) | Every value crossing a boundary (form input, hub payload, imported row, seed file) is validated before use. Untyped JSON never reaches the maths. Errors are values in a typed channel instead of runtime surprises. |
| Local storage | **IndexedDB** (per device) | Works offline on iOS & Android too, no WASM tricks, no COOP/COEP headers needed. |
| Hub / shared store | **SQLite via Node's built-in `node:sqlite`** | Same schema family as your original `app.db`, so the data stays portable both ways. Zero native deps, zero ORM. |
| Replication | last-write-wins per row + tombstones | Devices converge regardless of sync order; deletes stay deleted instead of resurrecting. |

Odin/gpui were dropped on purpose: they'd give a fast desktop binary but no clean path to a phone. This stack gives one codebase that runs unchanged on all three devices.

---

## Run it

### Desktop / laptop

```bash
cd ~/projects/apps/next-baking-app
npm install          # once
./run.sh             # builds if needed, then serves UI + sync hub on :7902
```

Open **http://localhost:7902**. Your old app keeps its own ports (`7901` API, `4321` Astro) — nothing here collides with it.

### Phone (Android or iPhone)

1. Make sure the hub is running on the desktop and both devices are on the same Wi-Fi.
2. On the phone open `http://<desktop-lan-ip>:7902` (the launcher prints those URLs).
3. **Add to home screen / Install app** → it becomes an installable PWA.
4. From then on it works **with no network**: the recipe data lives in the phone's IndexedDB, and the pages are cached by the service worker. When the phone can reach the hub again it pushes what changed and pulls what it missed.

If you set a custom hub address (Sync page), it looks like `http://192.168.1.20:7902/api/sync`.

### Laptop + desktop + phone together

Run `./run.sh` on whichever machine you want as the hub; every other device just syncs to it. Any device can also be used fully standalone — changes stay queued until it can sync.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Astro dev server on `:4322` (hot reload while editing) |
| `npm run build` | regenerate the seed bundle + static build into `dist/` |
| `npm run serve` / `./run.sh` | serve `dist/` + SQLite sync hub on `:7902` |
| `npm test` | domain unit tests (hydration maths, cost/nutrition, duplicate naming, replication merge) |
| `npm run typecheck` | strict TypeScript check across client, server, scripts |
| `npm run e2e` | drives real Chromium: seeded data loads, recipe maths renders, scaler works, create/edit survives reload, second device receives it via the hub, offline render still works |
| `npm run snapshot` | **read-only** hot backup of every SQLite file found in the original app into `snapshots/` |
| `npm run snapshot -- --refresh` | additionally refresh this app's working copy (`data/app.db`) from the old app's live DB |
| `npm run verify:data` | compare `data/app.db` row-by-row against the newest snapshot of your original database (fails if anything is missing or changed) |
| `npm run export:legacy` | write this app's data back out as a plain SQLite file using the **original** schema (`exports/legacy-compat-*.db`) — the rollback path |

---

## Where your data lives

| File / store | Role |
|---|---|
| `legacy-baking/` | verbatim copy of your current app (source, `.git` history, all its DB copies) — reference only, nothing runs from it |
| `snapshots/*.db` | timestamped online-backup copies (WAL included) of every database that existed in the original project |
| `data/app.db` | **this app's** SQLite database (hub store). Same tables as before plus three additive columns: `updated_at`, `deleted`, `origin` |
| `public/seed/state.json` | generated at build time from `data/app.db`; seeds a brand-new device (fresh browser/phone) with your existing catalogue |
| browser IndexedDB (`next-baking-app`) | each device's own working copy — this is what you actually edit offline |

### Schema compatibility

Table and column names match the legacy app exactly (`ingredients` incl. `price_unit`, `flour_mixes`, `flour_mix_components`, `recipes` incl. `category_id`, `recipe_categories`, `recipe_ingredients`, `recipe_mixes`, `recipe_main_liquids`). Only additive columns were introduced (`updated_at`, `deleted`, `origin`); the migration never drops, renames or reparses anything, and `npm run verify:data` proves row-for-row equality with the snapshot of your live database. `npm run export:legacy` produces a file with the *old* shape (replication columns stripped, tombstoned rows omitted) so you can hand the data back to the Go app if you ever want to.

---

## The maths (deliberately unchanged)

Ported 1:1 from your current Go backend + hydration box, including the "hybrids are additive" fix:

```
flour_weight      = Σ mix components scaled by grams of mix used   (component_g × mix_g / 1000)
target_water      = flour_weight × hydration% / 100                  # hydration base = mixes only
main_liquid_i     = target_water × percentage_i / 100                # split across your main liquids
water_from_ings   = Σ liquid amounts + Σ hybrid amount × hybrid_water
total_liquid      = target_water + water_from_ings                   # hybrids do NOT reduce the main liquid
effective_hydration = total_liquid / flour_weight × 100
cost              = Σ grams × price_per_1000g / 1000                 # prices are always €/1000 g
nutrition         = Σ per_100g_value × grams / 100                   # shown per serving and per 100 g dough
```

Scaling servings on a recipe page is a pure view transform: it multiplies displayed amounts and never writes to any database.

Verified against your own acceptance case in `tests/domain.test.ts`: 800 g flour mix + 200 g egg white (85 % water) at 70 % hydration → flour 800 g · target water 560 g · hybrid water 170 g · main liquid 560 g · total liquid 730 g · effective hydration 91.3 %.

Duplicate naming keeps the `(N)` scheme but is collision-safe and no longer stacks suffixes (`Pizza (1)` duplicates to `Pizza (2)`, not `Pizza (1) (2)`).

---

## Sync model, in one paragraph

Each device stores every row as `{table, pk, cols, updated_at, deleted, origin}`. A sync round-trip pushes local rows newer than the device's cursor and pulls everything the hub changed since that cursor; both sides keep the row with the greater `(updated_at, origin)` — and an *identical* version is never re-applied, so a slow pull can never resurrect something you just edited or deleted. Merges happen inside one storage transaction, so they are deterministic and converge no matter which device talks first. Deletes are tombstones (`deleted = true`) and replicate like any other write. Offline edits are simply rows whose `updated_at` is beyond the cursor — they wait in the outbox until a hub is reachable.

---

## Known limits (so nothing surprises you)

- Cross-device convergence needs at least one reachable hub at some point; two devices that never see each other (or a shared hub) will not merge.
- Last-write-wins is per **row**, not per field: if you edit the same recipe on two phones before either syncs, one version wins whole-row.
- Recipe categories are read from your original data and shown as coloured labels; you can assign or clear one per recipe, but there is no screen to create or rename categories yet (edit them in the database or in the old app for now).
- The original database contains one dangling row in `recipe_main_liquids` (its recipe was deleted earlier). It is preserved in copies and skipped by exports — details in `SAFETY.md`.
- The hub binds `0.0.0.0` so your phone can reach it: it is LAN-facing, unauthenticated by design. Don't port-forward it to the internet.

---

## What has to stay green

```bash
npm run typecheck     # strict TS over client + hub + scripts
npm test              # hydration maths, cost/nutrition scaling, duplicate naming, replication rules, legacy-column preservation
npm run build         # static build + seed bundle
npm run e2e           # two real Chromium profiles as two devices: seed → view → create → edit → hub → second device → delete → offline
npm run verify:data   # this app's rows == your original database's rows
```

`npm run e2e` needs `npm run serve` running in another terminal.
