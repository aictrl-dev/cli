import type { MigrationsJournal } from "drizzle-orm/migrator"
import { existsSync, readdirSync, readFileSync } from "fs"
import path from "path"

// Shared by Database.Client (dev) and script/build.ts (bundled AICTRL_MIGRATIONS),
// so both builds hand drizzle the same journal.

const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/

function folderMillis(name: string) {
  const match = TIMESTAMP.exec(name)!
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

/**
 * Reads `<dir>/<timestamp>_<slug>/migration.sql` into a drizzle journal, in
 * directory-name order.
 *
 * drizzle tracks applied migrations by `name`, so it must be the directory
 * name (as drizzle-kit uses). Databases written by older drizzle releases
 * only stored `created_at`; drizzle backfills their names by matching that
 * against `timestamp`, so both must stay stable for existing users.
 */
export function readMigrationJournal(dir: string): MigrationsJournal {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TIMESTAMP.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .filter((name) => existsSync(path.join(dir, name, "migration.sql")))
    .map((name) => ({
      sql: readFileSync(path.join(dir, name, "migration.sql"), "utf-8"),
      timestamp: folderMillis(name),
      name,
    }))
}
