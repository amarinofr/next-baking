# SAFETY — what was copied, what was protected, how to undo anything

Date of the copy operation: **2026-09-30 17:06 UTC**. Nothing outside `next-baking-app/` has been written.

---

## 1. Guarantee: your original app was never modified

Every database in the original project was opened **read-only** (`sqlite3 "file:…?mode=ro"`) and copied with SQLite's online **`.backup`** API, so a running server is not disturbed and `-wal` content is included.

Hashes taken *before* the copy and *after* everything in this project was built — identical:

| Original file | sha256 (before == after) | mtime (unchanged) |
|---|---|---|
| `../baking/data/app.db` (the DB your running app uses today) | `205f629be77ca91036d46cc1b47e0d4018c2cb4a9e83b3465202d1a55d1c1fbd` | 2026-07-13 12:12:22 |
| `../baking/backend/data/app.db` | `75eef7379cdd9e5161a6fd575077fa09452dacb0d1b4e60d9a844500a97e27c0` | 2026-07-13 12:35:57 |
| `../data/app.db` (seed DB from the old plan) | `f1c1d714b195aa1795c50ed2db1795613d868a07340cbf0b1a563384fdfebdcf` | 2026-07-13 12:13:13 |

Re-check it yourself at any time:

```bash
cd ~/projects/apps && sha256sum baking/data/app.db baking/backend/data/app.db data/app.db
```

Your running processes were left alone too: the old backend still listens on **:7901**, its Astro frontend on **:4321**. This app uses **:7902** (and **:4322** for `npm run dev`).

---

## 2. What was duplicated into `next-baking-app/`

### `legacy-baking/` — verbatim copy of your current app (28 MB)

Source (`backend/`, `frontend/src/`, configs), docs (`PLAN.md`, `PROGRESS.md`, `.pi/brief_*.md`), the launcher `serve.sh`, **its full git history** (`.git/`, so you can diff/blame inside the copy), its old build artifacts (`data.bak.*` folders), and its databases. Excluded only because they are regenerable: `node_modules/`, `dist/`, `.astro/`, and the compiled Go binaries `backend/backend{,.new,.old,.prev}`.

Two notes on that copy:

- SQLite sidecar files (`*-wal`, `*-shm`) were **not** copied — they are transient. Their content was captured properly instead by the online-backup API used for `snapshots/`, which folds the write-ahead log into a consistent `.db` file. So the databases inside `legacy-baking/` are point-in-time copies, and `snapshots/*.db` are the authoritative safe copies.
- Because `legacy-baking/.git` came along, git first saw it as a nested repository. This project now **does not track it at all**: it is listed in `.gitignore`, so the new repository contains only the new app, and your old app's history stays out of it. The copy remains on disk for diffing/blaming locally (`cd legacy-baking && git status`). Its working tree still shows *your own* pre-existing uncommitted changes (same as `../baking` has) — nothing here wrote to either tree.

Nothing in `legacy-baking/` is executed by this project. It exists so that a mistake here can never reach the real thing.

### `snapshots/` — hot backups of every database that existed

Taken with SQLite's online backup API (WAL folded in, integrity-checked):

| Snapshot | sha256 prefix |
|---|---|
| `baking-backend-data-app-db.2026-09-30-17-54.db` | `8d358237a30aae0d`…
| `baking-backend-data.20260930-170644.db` | `8d358237a30aae0d`…
| `baking-data-app-db.2026-09-30-17-54.db` | `57f882e8dbce54dc`…
| `baking-data.20260930-170644.db` | `57f882e8dbce54dc`…
| `data-app-db.2026-09-30-17-54.db` | `fb66e85af206b8d9`…
| `data.20260930-170644.db` | `fb66e85af206b8d9`…

Row-count and content equality is checked by a script, not by eye — it compares every row of
`data/app.db` against the newest snapshot and fails loudly if anything is missing or altered:

```bash
npm run verify:data
```

Latest result: `ingredients 26 · flour_mixes 6 · flour_mix_components 26 · recipes 7 · recipe_ingredients 54 · recipe_mixes 7 · recipe_main_liquids 6 (+1 dangling row in the original, skipped on purpose) · recipe_categories 3`.

Make more at any time (read-only on sources):

```bash
cd ~/projects/apps/next-baking-app && npm run snapshot
```

---

## 3. Where the new app writes

Only these places, all inside `next-baking-app/`:

- `data/app.db` (+ `-wal`/`-shm`) — the hub's SQLite store; created from the read-only hot copy above. Migration is **additive only**: it adds `updated_at`, `deleted`, `origin` columns, a `sync_meta` table, and a `UNIQUE` index on each legacy link table (which had none). It never drops, renames or reparses existing columns or values — including `price_unit`, `category_id`, `recipe_categories` and timestamps exactly as written by the Go backend.
  The hub opens this replica with `PRAGMA foreign_keys = OFF`: row-level replication can deliver a link row before its parent recipe arrives from another device, and enforcing inherited FKs would either fail the write or force us to delete a real row. Nothing is ever deleted here because of a missing parent; integrity is kept by the app layer and rebuilt on export.
- `public/seed/state.json` — generated from `data/app.db` at build time.
- `exports/legacy-compat-*.db` — rollback file in the *original* schema.
- Each browser's IndexedDB (per device).

The new app has **no code path** that points at `../baking/**`. The only tool that even reads those files is `scripts/snapshot-db.ts`, which opens them as `file:…?mode=ro`.

---

## 4. Getting back / getting across

| Situation | Do this |
|---|---|
| You want today's edits from the old app inside the new one | `npm run snapshot` then `npm run refresh` (merges newest snapshot in, last-write-wins, deletes nothing) then `npm run build` |
| You want to be sure nothing was lost | `npm run verify:data` — compares every row against the newest snapshot of your original database |
| You want proof the rollback file is faithful | compare it yourself: `sqlite3 exports/legacy-compat-*.db "SELECT * FROM ingredients;"` vs the same query on `../baking/data/app.db` — they match row-for-row |
| You want the new app's data back in the Go app | `npm run export:legacy` → overwrite the old app's DB with `exports/legacy-compat-*.db` (after backing that file up yourself) |
| Something here went wrong | restore from a snapshot: `cp snapshots/<name>.<stamp>.db data/app.db` |
| You just cloned this repo onto another machine | `npm run doctor` → `npm run bootstrap` → `npm start`. The tracked `public/seed/state.json` carries the catalogue; nothing outside the clone is read |
| You want two machines' hub databases to hold the same content | on the machine that should receive rows: `npm run replicate -- http://<other-machine>:7902` (add `--push` for two-way). Row-level last-write-wins — no file copying, no whole-database overwrite |
| You want to see what changed vs your repo | `cd legacy-baking && git status` / `git diff` (the history is in the copy) |

---

## 5. One pre-existing oddity found in your original database (informational)

While validating copies, one dangling row was found — nothing was changed because of it:

```sql
-- in the ORIGINAL ../baking/data/app.db
SELECT ml.recipe_id FROM recipe_main_liquids ml
LEFT JOIN recipes r ON r.id = ml.recipe_id WHERE r.id IS NULL;
-- → 59d09c2f-0098-4590-8b73-36f6f66bb8eb   (a recipe that was deleted earlier)
```

Both apps ignore it (their queries join on existing recipes), and `npm run export:legacy` skips such rows explicitly instead of failing. If you ever want it gone, delete it from whichever database you decide is authoritative — deliberately not done here without you asking.

---

## 6. Fixes made while building — all of them local to this project

Nothing below touched `../baking/**`; each change was applied to this app's own copy (`data/app.db`) or its code.

| Problem found | What was done here |
|---|---|
| The legacy link tables have no primary key or unique index, so replication inserted the same link over and over | one row per composite key (last write wins) + `UNIQUE` index added when the hub starts (`enforceLinkTableKeys`) |
| One pre-existing dangling `recipe_main_liquids` row made sync fail with `FOREIGN KEY constraint failed` on every device | the hub replica now runs with foreign keys off (see §3), so out-of-order replication cannot fail or lose a row. An earlier version of this project *pruned* such rows — that pruning was removed, because pruning a child whose parent has simply not arrived yet deletes genuine data. `/api/info` now reports dangling links as a diagnostic without touching them |
| A background pull could resurrect a row that had just been edited or deleted locally (equal timestamp + same device counted as "win") | last-write-wins is now strict: an identical version is never re-applied, and remote rows are merged inside a single IndexedDB transaction (`store.mergeRemote`) — covered by a unit test |
| `price_unit` (ingredients) and `category_id` / `recipe_categories` existed in your database but not in the new model, so saving a row blanked them | both columns are modelled, replicated, preserved on edit, and shown/edited in the UI — covered by a unit test |
| Deletes removed the row from storage but the list kept showing it (a `void` success looked like a failure) | view actions now use a success-aware runner and refresh + confirm with a message |
| A background sync could re-render a page under a half-filled form and lose what you typed | form values are captured before every re-render and restored after it; on form pages an incoming update is announced instead of applied to the DOM |
| Saving something appeared to do nothing: the list still showed the old state until a full page reload | every navigation re-reads the local database before drawing (`loadStateAndRender`), so saved rows show up immediately while still never reloading the page |
| Legacy timestamps were being prettified on import (`2026-04-11 21:19:58 +0000 +00` → ISO with `T`/`Z`) | `normalizeRow` keeps `created_at` byte-for-byte as your database stores it |
| A device could advance its cursor past a row written on the hub mid-request | the cursor now only advances over changes the device actually received (`max(local updated_at, previous cursor)`, never the hub's clock) |
| The legacy export omitted `price_unit`, `category_id` and `recipe_categories` | `scripts/export-legacy-db.ts` mirrors your live schema exactly, writes categories before recipes so FK checks pass, and turns empty `category_id` into NULL like the Go app does |

| Leaving a mix/recipe editor and coming back showed every component row as the same ingredient, and saving would have collapsed them | form drafts were keyed by field name while component rows repeat their names (`ingredient_id`, `amount`), so one row's value was written into all of them. Drafts are now positional and are discarded if the rebuilt form's structure differs; `distinctRows()` additionally refuses a submission that repeats an ingredient or mix, because those link tables are keyed by what they point at |
| On a machine whose hub database had been created but not filled, `npm run build` replaced the tracked seed snapshot with an empty one | `scripts/build-seed.ts` probes the database first and keeps the existing seed when the local store holds nothing; `seedWriteDecision()` refuses to shrink the seed by more than max(5, 10 %) of its rows unless you pass `--force`. Covered by a unit test |

---

## 7. What is safe to copy around — and what is not

Safe to hand to Syncthing, Dropbox, a USB stick, or git, because each is a self-contained snapshot that no running process writes to:

| Artifact | How it is made |
|---|---|
| `snapshots/*.db` | `npm run snapshot` — SQLite online backup of every database found in the original app (WAL included), read-only source |
| `exports/legacy-compat-*.db` | `npm run export:legacy` — this app's data written out in your **original** schema |
| `public/seed/state.json` | `npm run seed` — every row as JSON, including tombstones; tracked in this repo so a clone starts with your data |

Never file-sync these, because merging two copies of them is not possible per row, and a partial copy can corrupt them outright:

- `data/app.db` plus its `-wal` / `-shm` side files — the live hub store.
- browser IndexedDB (`next-baking-app`) — where your daily edits actually live on each device. It is not a file, so no file-sync tool can see it at all.

Data moves between devices through `/api/sync` instead: row by row, last-write-wins on `(updated_at, origin)`, deletes as tombstones, any order tolerated.

Re-verify originals at any time:

```bash
cd ~/projects/apps && sha256sum baking/data/app.db baking/backend/data/app.db data/app.db
# 205f629be77ca910…  75eef7379cdd9e51…  f1c1d714b195aa17…   (unchanged since the first snapshot)
```
