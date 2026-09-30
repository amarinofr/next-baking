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

- `data/app.db` (+ `-wal`/`-shm`) — the hub's SQLite store; created from the read-only hot copy above. Migration is **additive only**: it adds `updated_at`, `deleted`, `origin` columns and a `sync_meta` table. It never drops, renames or reparses existing columns, and it leaves tables it does not model (`recipe_categories`, the legacy `price_unit` column) exactly as they were.
- `public/seed/state.json` — generated from `data/app.db` at build time.
- `exports/legacy-compat-*.db` — rollback file in the *original* schema.
- Each browser's IndexedDB (per device).

The new app has **no code path** that points at `../baking/**`. The only tool that even reads those files is `scripts/snapshot-db.ts`, which opens them as `file:…?mode=ro`.

---

## 4. Getting back / getting across

| Situation | Do this |
|---|---|
| You want today's edits from the old app inside the new one | `npm run snapshot -- --refresh` then `npm run build` |
| You want the new app's data back in the Go app | `npm run export:legacy` → overwrite the old app's DB with `exports/legacy-compat-*.db` (after backing that file up yourself) |
| Something here went wrong | restore from a snapshot: `cp snapshots/<name>.<stamp>.db data/app.db` |
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
| One pre-existing dangling `recipe_main_liquids` row made sync fail with `FOREIGN KEY constraint failed` on every device | the orphan row was pruned **from this project's copy only**, and the hub now skips any incoming child row whose parent does not exist instead of erroring |
| A background pull could resurrect a row that had just been edited or deleted locally (equal timestamp + same device counted as "win") | last-write-wins is now strict: an identical version is never re-applied, and remote rows are merged inside a single IndexedDB transaction (`store.mergeRemote`) — covered by a unit test |
| `price_unit` (ingredients) and `category_id` / `recipe_categories` existed in your database but not in the new model, so saving a row blanked them | both columns are modelled, replicated, preserved on edit, and shown/edited in the UI — covered by a unit test |
| Deletes removed the row from storage but the list kept showing it (a `void` success looked like a failure) | view actions now use a success-aware runner and refresh + confirm with a message |
| A background sync could re-render a page under a half-filled form and lose what you typed | form values are captured before every re-render and restored after it; on form pages an incoming update is announced instead of applied to the DOM |

Re-verify originals at any time:

```bash
cd ~/projects/apps && sha256sum baking/data/app.db baking/backend/data/app.db data/app.db
# 205f629be77ca910…  75eef7379cdd9e51…  f1c1d714b195aa17…   (unchanged since the first snapshot)
```
