import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import path from "path"
import { Database } from "../../src/storage/db"
import { readMigrationJournal } from "../../src/storage/migration-journal"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

const journal = readMigrationJournal(path.join(import.meta.dirname, "../../migration"))

type MigrationRow = { hash: string; created_at: number; name: string | null }

// `created_at` values aictrl 0.5.1 (drizzle-orm 1.0.0-beta.12) wrote, read from
// a real database it created. drizzle matches these to `timestamp` to recognise
// already-applied migrations, so they must never change.
const LEGACY_CREATED_AT = [1769552633000, 1770830228000, 1770993676000, 1772056728000, 1772228279000]

// Recreates a database as aictrl <= 0.5.1 left it after applying the first
// `count` migrations: drizzle beta.12's bookkeeping table (no `name` column,
// `id` always NULL) with one row per migration holding an empty hash.
function writeLegacyDatabase(count: number) {
  const sqlite = new SQLite(Database.Path, { create: true })
  sqlite.run(`CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`)
  for (const [index, migration] of journal.slice(0, count).entries()) {
    sqlite.exec(migration.sql)
    sqlite.run(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('', ?)`, [LEGACY_CREATED_AT[index]])
  }
  sqlite.run(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('proj_legacy', '/legacy', 1, 2, '[]')`,
  )
  sqlite.close()
}

function migrationRows() {
  return Database.Client().$client.query<MigrationRow, []>(`SELECT hash, created_at, name FROM "__drizzle_migrations"`).all()
}

function tableNames() {
  return Database.Client()
    .$client.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name)
}

describe("Database migrations", () => {
  beforeEach(resetDatabase)
  afterEach(resetDatabase)

  test("journal names every migration by its directory, in timestamp order", () => {
    expect(journal.length).toBeGreaterThan(0)
    for (const migration of journal) {
      expect(migration.name).toMatch(/^\d{14}_\w+$/)
      expect(migration.timestamp).toBeGreaterThan(0)
    }
    expect(journal.map((m) => m.timestamp)).toEqual(journal.map((m) => m.timestamp).toSorted((a, b) => a - b))
    expect(journal.slice(0, LEGACY_CREATED_AT.length).map((m) => m.timestamp)).toEqual(LEGACY_CREATED_AT)
  })

  test("journal skips non-migration directories and orders same-second migrations by name", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        for (const name of ["20260101000000_b", "20260101000000_a", "20260101000000_B", "notes"]) {
          await Bun.write(path.join(dir, name, "migration.sql"), "SELECT 1;")
        }
      },
    })
    // Plain code-unit order, as `Array.prototype.sort()` gives (not locale collation).
    expect(readMigrationJournal(tmp.path).map((m) => m.name)).toEqual([
      "20260101000000_B",
      "20260101000000_a",
      "20260101000000_b",
    ])
  })

  test("fresh database applies every migration once", () => {
    expect(tableNames()).toEqual(expect.arrayContaining(["project", "session", "workspace", "__drizzle_migrations"]))
    expect(migrationRows().map((row) => row.name)).toEqual(journal.map((m) => m.name))

    // Reopening is a no-op.
    Database.close()
    expect(migrationRows()).toHaveLength(journal.length)
  })

  test("database migrated by aictrl <= 0.5.1 keeps its migrations and data", () => {
    writeLegacyDatabase(LEGACY_CREATED_AT.length)

    // Re-running any migration would throw (CREATE TABLE / ADD COLUMN on existing objects).
    const rows = migrationRows()
    expect(rows).toHaveLength(journal.length)
    expect(rows.map((row) => row.name)).toEqual(journal.map((m) => m.name))
    expect(rows.map((row) => Number(row.created_at))).toEqual(LEGACY_CREATED_AT)

    const project = Database.Client().$client.query(`SELECT id, worktree FROM project`).all()
    expect(project).toEqual([{ id: "proj_legacy", worktree: "/legacy" }])
  })

  test("partially migrated legacy database runs only the missing migrations", () => {
    writeLegacyDatabase(2)

    expect(migrationRows().map((row) => row.name)).toEqual(journal.map((m) => m.name))
    expect(tableNames()).toContain("workspace")
    expect(Database.Client().$client.query(`SELECT id FROM project`).all()).toEqual([{ id: "proj_legacy" }])
  })
})

describe("Database.transaction", () => {
  beforeEach(resetDatabase)
  afterEach(resetDatabase)

  test("returns the callback result and runs effects after commit", () => {
    const order: string[] = []
    const result = Database.transaction(() => {
      Database.effect(() => order.push("effect"))
      order.push("callback")
      return 42
    })
    expect(result).toBe(42)
    expect(order).toEqual(["callback", "effect"])
  })

  test("rejects async callbacks at compile time", () => {
    // Never called: this only has to typecheck.
    function asyncCallback() {
      // @ts-expect-error bun-sqlite transactions are synchronous
      Database.transaction(async () => 1)
      // @ts-expect-error a thenable is async too
      Database.transaction(() => ({ then() {} }) as PromiseLike<number>)
      // @ts-expect-error a callback that is only sometimes async
      Database.transaction(() => (Math.random() > 0.5 ? 1 : Promise.resolve(1)))
    }
    expect(asyncCallback).toBeFunction()
  })
})
