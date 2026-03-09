import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, symlinkSync, rmSync } from "fs"
import { join } from "path"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { Filesystem } from "../../src/util/filesystem"

describe("containsSafe symlink escape", () => {
  let projectDir: string
  let outsideDir: string

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "test-project-"))
    outsideDir = await mkdtemp(join(tmpdir(), "test-outside-"))
    // Create a symlink inside the project that points outside
    symlinkSync(outsideDir, join(projectDir, "escape-link"))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  test("detects symlink escape even when target file does not exist", async () => {
    // The symlink exists: projectDir/escape-link -> outsideDir
    // The target does NOT exist: projectDir/escape-link/nonexistent
    // containsSafe should return false because the path escapes via symlink
    const escapePath = join(projectDir, "escape-link", "nonexistent")
    const result = await Filesystem.containsSafe(projectDir, escapePath)
    expect(result).toBe(false) // BUG: currently returns true
  })

  test("allows non-existent path with no symlinks", async () => {
    // No symlinks involved — just a path that doesn't exist yet
    const safePath = join(projectDir, "subdir", "nonexistent-file.txt")
    const result = await Filesystem.containsSafe(projectDir, safePath)
    expect(result).toBe(true)
  })

  test("allows symlink pointing inside project with non-existent child", async () => {
    // Create an internal symlink: projectDir/internal-link -> projectDir/real-dir
    mkdirSync(join(projectDir, "real-dir"))
    symlinkSync(join(projectDir, "real-dir"), join(projectDir, "internal-link"))

    const safePath = join(projectDir, "internal-link", "nonexistent")
    const result = await Filesystem.containsSafe(projectDir, safePath)
    expect(result).toBe(true)
  })

  test("detects deeply nested symlink escape with non-existent target", async () => {
    // projectDir/escape-link -> outsideDir
    // Target: projectDir/escape-link/a/b/c (none of a/b/c exist)
    const deepPath = join(projectDir, "escape-link", "a", "b", "c")
    const result = await Filesystem.containsSafe(projectDir, deepPath)
    expect(result).toBe(false)
  })
})
