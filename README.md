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

### A machine you just cloned onto

`git clone`, `npm install`, then:

```bash
npm run doctor        # what exists here, and the one command to run next
npm run bootstrap     # builds data/app.db from the seed snapshot that ships in the repo
npm start             # UI + sync hub, printing the addresses your other devices should open
```

Your catalogue travels with the repository as `public/seed/state.json` (a JSON dump of every row, including deletes). A fresh browser on that machine seeds from it on first load, so even before any sync there are recipes on screen. If this machine should instead become a copy of a hub that is already running elsewhere:

```bash
npm run replicate -- http://192.168.1.20:7902          # take their rows
npm run replicate -- http://192.168.1.20:7902 --push   # two-way in one round-trip
```

That merge is per row, last-write-wins — pulling never rolls back unrelated work on either side, and never copies one whole database file over another.

---

## How it behaves (an app, not a stack of pages)

- Every item opens by clicking anywhere on it: a recipe card or table row opens the recipe, an ingredient or mix row opens its editor.
- Navigation happens inside the page (`/recipes/<id>`, `/ingredients/<id>/edit`, …): no reloads, no flicker, scroll position remembered when you come back, and a half-typed form survives any background update.
- Deep links and offline work because the hub serves the app shell for any route and the service worker caches it — refreshing `/recipes/<id>` or opening the app in a train tunnel lands on the right screen.
- Sync is automatic: a change is pushed ~1.2 s after you make it, each device pulls every 15 s while it is open and online, and returning to the tab triggers a catch-up immediately. There is a **Sync now** button and an auto-sync switch on the *Sync* screen for when you want control.
- Flour mixes are shown with their own batch total and cost per kg, and recipes scale them proportionally whatever that total is.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Astro dev server on `:4322` (hot reload while editing) |
| `npm run build` | regenerate the seed bundle + static build into `dist/` |
| `npm run serve` / `./run.sh` | serve `dist/` + SQLite sync hub on `:7902` |
| `npm run doctor` | what this machine has (seed snapshot, hub database, build, node version) and the next command to run |
| `npm run bootstrap` | create `data/app.db` from the tracked seed snapshot; refuses to overwrite a database that already has rows |
| `npm run replicate -- <hub-url> [--push]` | copy rows between two hubs of this app using the same last-write-wins merge the devices use |
| `npm test` | domain unit tests (hydration maths, cost/nutrition, duplicate naming, replication merge) |
| `npm run typecheck` | strict TypeScript check across client, server, scripts |
| `npm run e2e` | drives two real Chromium profiles as two devices: seed, clickable cards/rows, in-app navigation without reloads, scaler writes nothing, create → edit → auto-sync → other device, delete replication, phone width, offline |
| `npm run snapshot` | **read-only** hot backup of every SQLite file found in the original app into `snapshots/` |
| `npm run snapshot -- --refresh` | additionally refresh this app's working copy (`data/app.db`) from the old app's live DB |
| `npm run refresh` | merge the newest snapshot into `data/app.db` **additively** (last-write-wins, never deletes anything here) |
| `npm run verify:data` | compare `data/app.db` row-by-row against the newest snapshot of your original database (fails if anything is missing or changed) |
| `npm run export:legacy` | write this app's data back out as a plain SQLite file using the **original** schema (`exports/legacy-compat-*.db`) — the rollback path |
| `npm run shots` | drive the real UI and save screenshots (desktop + phone) so design changes can be reviewed visually |

---

## Where your data lives

| File / store | Role |
|---|---|
| `legacy-baking/` | verbatim copy of your current app (source, `.git` history, all its DB copies) — reference only, nothing runs from it |
| `snapshots/*.db` | timestamped online-backup copies (WAL included) of every database that existed in the original project |
| `data/app.db` | **this app's** SQLite database (hub store). Same tables as before plus three additive columns: `updated_at`, `deleted`, `origin` |
| `public/seed/state.json` | **tracked in git**: JSON dump of every row (with tombstones), generated by `npm run seed`. It is what seeds a brand-new device or browser, doubles as a readable backup, and is what a fresh clone builds its hub database from. The build refuses to shrink it (see SAFETY.md). |
| browser IndexedDB (`next-baking-app`) | each device's own working copy — this is what you actually edit offline |

### Schema compatibility

Table and column names match the legacy app exactly (`ingredients` incl. `price_unit`, `flour_mixes`, `flour_mix_components`, `recipes` incl. `category_id`, `recipe_categories`, `recipe_ingredients`, `recipe_mixes`, `recipe_main_liquids`). Only additive columns were introduced (`updated_at`, `deleted`, `origin`); the migration never drops, renames or reparses anything, and `npm run verify:data` proves row-for-row equality with the snapshot of your live database. `npm run export:legacy` produces a file with the *old* shape (replication columns stripped, tombstoned rows omitted) so you can hand the data back to the Go app if you ever want to.

---

## The maths (deliberately unchanged)

Ported 1:1 from your current Go backend + hydration box, including the "hybrids are additive" fix:

```
batch_g           = Σ a mix's own component grams                    # a mix does NOT have to total 1000 g
flour_weight      = Σ mix component_g × mix_g_used / batch_g         # mixes scale proportionally
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

A device only ever advances its cursor past changes it has actually seen (never past the hub's wall-clock stamp), so a row written on the hub while a request was in flight cannot be skipped. Sync requests are single-flight: a slow round-trip delays the next one instead of stacking them.

### Which machine is the hub

Any machine running `npm start` is a hub. Pick one that is usually on — normally the desktop — and open `http://<that-machine>:7902` from the laptop and the phone (the launcher prints those addresses now). Each of those browsers keeps its own IndexedDB copy and syncs to that hub automatically. Nothing about being a hub is permanent: point a device at a different address on the *Sync* screen and it converges with the new one instead.

If two machines both have their own hub databases and you want them to hold the same content, use `npm run replicate`. It speaks the same `/api/sync` protocol a browser does, so it merges rows rather than files.

### Why not Syncthing / Dropbox / rsync over the SQLite file

Because copying `app.db` between machines is how data gets lost, not how it gets shared:

- A SQLite file is not a set of rows you can merge: whichever file lands last wins entirely, silently throwing away every edit made on the other machine since the copy was made. Its `-wal` / `-shm` side files make partial copies actively dangerous (a half-copied database can be unreadable).
- File sync has no idea which *row* is newer, so it cannot answer the only question that matters when you edited dough on the phone and flour mixes on the desktop at the same time.
- Syncthing cannot see inside IndexedDB at all: your day-to-day edits live there, not in any file, so there is nothing for it to sync.

What this app does instead is sync **rows** (`{table, pk, cols, updated_at, deleted, origin}`) through `/api/sync`, which works offline, tolerates any order, and preserves deletes as tombstones.

Where Syncthing or git *is* useful: **backups**. `snapshots/*.db` (hot online backups), `exports/legacy-compat-*.db` (your data in the original schema) and `public/seed/state.json` are all plain files that survive being copied anywhere you like. Restore by pointing a device at a hub holding that data, or by importing a snapshot on the *Sync* screen.

---

## Known limits (so nothing surprises you)

- Cross-device convergence needs at least one reachable hub at some point; two devices that never see each other (or a shared hub) will not merge.
- The tracked seed snapshot means your recipes are in this repository's history. That is deliberate (it is what makes a clone usable and doubles as a backup) — if you would rather keep them out of git, put `public/seed/state.json` back into `.gitignore` and move data with `npm run replicate` instead.
- Auto-sync is deliberately unhurried: expect another device's change to appear within ~15 s (**Sync now** does it instantly).
- Deleted rows stay in storage as tombstones (a few bytes each) — they are never shown, and exports omit them. There is no garbage collection of old tombstones yet.
- Last-write-wins is per **row**, not per field: if you edit the same recipe on two phones before either syncs, one version wins whole-row.
- Recipe categories are read from your original data and shown as coloured labels; you can assign or clear one per recipe, but there is no screen to create or rename categories yet (edit them in the database or in the old app for now).
- The original database contains one dangling row in `recipe_main_liquids` (its recipe was deleted earlier). It is preserved in copies and skipped by exports — details in `SAFETY.md`.
- The hub binds `0.0.0.0` so your phone can reach it: it is LAN-facing, unauthenticated by design. Don't port-forward it to the internet.

---

## Look & motion (`ui-polish` branch)

Same zinc-and-monospace identity as the old app, but alive:

- warm ambient light behind everything (static on purpose — an always-animating background eats battery on a phone), wheat mark in the header, sticky blurred header/status bar;
- a pill that slides under the current tab; cards lift with a light sweeping across them; table rows grow an accent edge when they are clickable;
- staggered reveals for lists and panels, buttons that press, toasts that slide in with a timer bar, a sync dot that pulses while it works and turns green when it is done;
- **hydration rings** on recipe cards and on the hydration panel (how wet this dough is, at a glance);
- a **water gauge** on recipe pages and in the recipe form showing how the liquid splits between your main liquids and what the ingredients carry;
- proportional **component bars** next to each flour mix, colour-coded category dots in the ingredient list (grey dry · amber hybrid · blue liquid);
- figures count up when a page opens and flash when the servings scaler moves them;
- native view transitions where the browser supports them, everything disabled cleanly under `prefers-reduced-motion`.

Look at it without squinting at CSS: `npm run shots` drives the real UI and writes PNGs to `/tmp/ui-shots` (desktop + phone widths).

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
