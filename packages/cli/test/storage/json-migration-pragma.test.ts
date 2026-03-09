import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import path from "path"
import fs from "fs/promises"
import { readFileSync, readdirSync } from "fs"
import { JsonMigration } from "../../src/storage/json-migration"
import { Global } from "../../src/global"

// Helper to create in-memory test database with schema
function createTestDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")

  const dir = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
  migrate(drizzle({ client: sqlite }), migrations)

  return sqlite
}

describe("JsonMigration PRAGMA restoration", () => {
  let storageDir: string
  let sqlite: Database

  beforeEach(async () => {
    storageDir = path.join(Global.Path.data, "storage")
    await fs.rm(storageDir, { recursive: true, force: true })
    sqlite = createTestDb()

    // Set production PRAGMAs (as db.ts does)
    sqlite.exec("PRAGMA journal_mode = WAL")
    sqlite.exec("PRAGMA synchronous = NORMAL")
    sqlite.exec("PRAGMA cache_size = -64000")
  })

  afterEach(async () => {
    sqlite.close()
    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {})
  })

  test("restores production PRAGMA values after successful migration (no storage dir)", async () => {
    // No storage dir means migration returns early, but PRAGMAs should still be
    // at production values (the early-return path skips PRAGMA changes entirely)
    const stats = await JsonMigration.run(sqlite)
    expect(stats.projects).toBe(0)

    // Verify PRAGMAs are at production values
    const syncValue = sqlite.query("PRAGMA synchronous").get() as any
    expect(syncValue.synchronous).toBe(1) // NORMAL = 1

    const cacheValue = sqlite.query("PRAGMA cache_size").get() as any
    expect(cacheValue.cache_size).toBe(-64000)
  })

  test("restores production PRAGMA values after successful migration (with storage dir)", async () => {
    // Create storage dir with minimal data so migration actually runs the PRAGMA path
    await fs.mkdir(path.join(storageDir, "project"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "session"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "message"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "part"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "todo"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "permission"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "session_share"), { recursive: true })

    await JsonMigration.run(sqlite)

    // After migration, PRAGMAs must be restored to production values
    const syncValue = sqlite.query("PRAGMA synchronous").get() as any
    expect(syncValue.synchronous).toBe(1) // NORMAL = 1 (not OFF = 0)

    const cacheValue = sqlite.query("PRAGMA cache_size").get() as any
    expect(cacheValue.cache_size).toBe(-64000) // not 10000

    const tempValue = sqlite.query("PRAGMA temp_store").get() as any
    expect(tempValue.temp_store).toBe(0) // DEFAULT = 0 (not MEMORY = 2)
  })

  test("restores production PRAGMA values even when migration throws", async () => {
    // Create storage dir so migration enters the PRAGMA-changing code path
    await fs.mkdir(path.join(storageDir, "project"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "session"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "message"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "part"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "todo"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "permission"), { recursive: true })
    await fs.mkdir(path.join(storageDir, "session_share"), { recursive: true })

    // Monkey-patch sqlite.exec to throw on COMMIT, simulating a mid-flight error
    const origExec = sqlite.exec.bind(sqlite)
    let commitCalled = false
    sqlite.exec = (sql: string) => {
      if (sql === "COMMIT" && !commitCalled) {
        commitCalled = true
        throw new Error("simulated mid-flight error")
      }
      return origExec(sql)
    }

    try {
      await JsonMigration.run(sqlite)
      // Should not reach here
      expect(true).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe("simulated mid-flight error")
    }

    // Restore original exec for PRAGMA queries
    sqlite.exec = origExec

    // Even after an error, PRAGMAs must be restored
    const syncValue = sqlite.query("PRAGMA synchronous").get() as any
    expect(syncValue.synchronous).toBe(1) // NORMAL = 1 (not OFF = 0)

    const cacheValue = sqlite.query("PRAGMA cache_size").get() as any
    expect(cacheValue.cache_size).toBe(-64000) // not 10000

    const tempValue = sqlite.query("PRAGMA temp_store").get() as any
    expect(tempValue.temp_store).toBe(0) // DEFAULT = 0 (not MEMORY = 2)
  })
})
