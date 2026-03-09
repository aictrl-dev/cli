import { describe, expect, test } from "bun:test"
import { Filesystem } from "../../src/util/filesystem"
import path from "path"
import fs from "fs/promises"
import os from "os"

describe("storage.migration-marker", () => {
  test("marker file is not created when migration would fail", async () => {
    // Verify the source code pattern: marker is written ONLY after successful migration
    const source = await Bun.file("src/index.ts").text()

    // The marker write (Filesystem.write(migrationMarker...)) must come AFTER
    // JsonMigration.run and BEFORE the catch block.
    // Verify ordering: JsonMigration.run -> Filesystem.write(migrationMarker) -> catch
    const runIndex = source.indexOf("JsonMigration.run(")
    const markerWriteIndex = source.indexOf("Filesystem.write(migrationMarker")
    const catchIndex = source.indexOf("catch (error)")
    expect(runIndex).toBeGreaterThan(-1)
    expect(markerWriteIndex).toBeGreaterThan(runIndex)
    expect(catchIndex).toBeGreaterThan(markerWriteIndex)

    // The catch block must NOT write the marker
    const catchStart = catchIndex
    const catchEnd = source.indexOf("} finally", catchStart)
    expect(catchEnd).toBeGreaterThan(catchStart)
    const catchBody = source.slice(catchStart, catchEnd)
    expect(catchBody).not.toContain("Filesystem.write(migrationMarker")
    expect(catchBody).not.toContain("json-migration-complete")
  })

  test("migration is only attempted when legacy storage directory exists", async () => {
    const source = await Bun.file("src/index.ts").text()

    // Must check for storageDir existence before running migration
    // The pattern: exists(storageDir) && !exists(migrationMarker)
    expect(source).toMatch(/Filesystem\.exists\(storageDir\)/)
    expect(source).toMatch(/Filesystem\.exists\(migrationMarker\)/)
  })

  test("old aictrl.db marker is not used for migration detection", async () => {
    const source = await Bun.file("src/index.ts").text()

    // Verify the migration marker variable uses "json-migration-complete"
    expect(source).toContain('"json-migration-complete"')

    // Verify the old pattern (const marker = ... "aictrl.db") is gone
    expect(source).not.toMatch(/const marker.*aictrl\.db/)
    // Verify aictrl.db is not used anywhere in the migration guard
    expect(source).not.toContain("Filesystem.exists(marker)")
  })

  test("migration failure is caught and logged", async () => {
    const source = await Bun.file("src/index.ts").text()

    // Error handling must exist around migration
    expect(source).toContain("json migration failed")
    expect(source).toContain("will be retried on next launch")
  })

  test("Filesystem.write works for marker file creation", async () => {
    // Verify the actual Filesystem.write mechanism works for marker files
    const tmpDir = path.join(os.tmpdir(), `marker-test-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })
    try {
      const markerPath = path.join(tmpDir, "json-migration-complete")
      await Filesystem.write(markerPath, String(Date.now()))
      expect(await Filesystem.exists(markerPath)).toBe(true)
      const content = await fs.readFile(markerPath, "utf-8")
      expect(Number(content)).toBeGreaterThan(0)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// Headless CLI entry point (headless.ts) - must match index.ts patterns
// ============================================================================

describe("storage.migration-marker headless", () => {
  test("headless.ts uses json-migration-complete marker (not aictrl.db)", async () => {
    const source = await Bun.file("src/headless.ts").text()

    // Must use json-migration-complete marker
    expect(source).toContain('"json-migration-complete"')

    // Must NOT use aictrl.db as migration marker
    expect(source).not.toMatch(/const marker.*aictrl\.db/)
    // aictrl.db should not be used for migration detection
    const markerPattern = source.match(/const\s+\w*[Mm]arker\w*\s*=\s*[^;]+/)
    if (markerPattern) {
      expect(markerPattern[0]).not.toContain("aictrl.db")
    }
  })

  test("headless.ts has storageDir existence guard", async () => {
    const source = await Bun.file("src/headless.ts").text()

    // Must check for storageDir existence before running migration
    expect(source).toMatch(/Filesystem\.exists\(storageDir\)/)
    expect(source).toMatch(/Filesystem\.exists\(migrationMarker\)/)
  })

  test("headless.ts has catch block with Log.Default.error", async () => {
    const source = await Bun.file("src/headless.ts").text()

    // Error handling must exist around migration
    expect(source).toContain("json migration failed")
    expect(source).toContain("will be retried on next launch")

    // Must have catch block with Log.Default.error
    expect(source).toMatch(/catch.*error.*Log\.Default\.error/s)
  })

  test("headless.ts success message is inside try block", async () => {
    const source = await Bun.file("src/headless.ts").text()

    // Find the JsonMigration.run call
    const runIndex = source.indexOf("JsonMigration.run(")
    expect(runIndex).toBeGreaterThan(-1)

    // Find the marker write
    const markerWriteIndex = source.indexOf("Filesystem.write(migrationMarker")
    expect(markerWriteIndex).toBeGreaterThan(runIndex)

    // Find the catch block
    const catchIndex = source.indexOf("catch (error)")
    expect(catchIndex).toBeGreaterThan(markerWriteIndex)

    // "Database migration complete" message must be inside try block
    // (before catch, after JsonMigration.run)
    const successMsgIndex = source.indexOf("Database migration complete")
    expect(successMsgIndex).toBeGreaterThan(runIndex)
    expect(successMsgIndex).toBeLessThan(catchIndex)

    // Catch block must NOT write the marker
    const catchEnd = source.indexOf("} finally", catchIndex)
    expect(catchEnd).toBeGreaterThan(catchIndex)
    const catchBody = source.slice(catchIndex, catchEnd)
    expect(catchBody).not.toContain("Filesystem.write(migrationMarker")
  })
})
