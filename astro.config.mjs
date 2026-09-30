import { defineConfig } from "astro/config";

// Static output on purpose: the UI is plain HTML/JS that any device can cache and
// run offline. All data lives client-side (IndexedDB) or in the hub's SQLite file.
export default defineConfig({
  output: "static",
  build: { concurrency: 4 },
  vite: {
    build: { assetsDir: "assets" },
  },
});
