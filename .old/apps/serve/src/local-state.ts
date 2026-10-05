import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite/driver";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

// ponytail: bundled dist/cli.js ships migrations as "./migrations" (sibling),
// unbundled src/local-state.ts finds them one level up as "../migrations".
// existsSync picks whichever layout is actually on disk.
const bundledMigrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url),
);
const sourceMigrationsFolder = existsSync(bundledMigrationsFolder)
  ? bundledMigrationsFolder
  : fileURLToPath(new URL("../migrations", import.meta.url));

export function openServeLocalState(
  databasePath: string,
  migrationsFolder = sourceMigrationsFolder,
) {
  const database = new Database(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  const state = drizzle(database);
  migrate(state, { migrationsFolder });

  return database;
}
