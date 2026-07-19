import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("stdout", () => {
  test("flushes NDJSON beyond pipe capacity before forced exit", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture", "stdout.ts")], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new Response(child.stdout).text()
    const error = new Response(child.stderr).text()

    expect(await child.exited).toBe(0)
    expect(await error).toBe("")

    const lines = (await output)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1025)
    expect(lines.at(-1)).toEqual({ type: "complete" })
  })

  test("treats a closed output pipe as controlled", async () => {
    await using tmp = await tmpdir()
    const status = path.join(tmp.path, "status")
    const child = await $`${process.execPath} ${path.join(
      import.meta.dir,
      "fixture",
      "stdout.ts",
    )} --epipe --status=${status} | ${process.execPath} -e ${"await Bun.stdin.stream().getReader().read(); process.exit()"}`
      .cwd(path.join(import.meta.dir, "../.."))
      .quiet()
      .nothrow()

    expect(child.exitCode).toBe(0)
    expect(child.stderr.toString()).toBe("")
    expect(await Bun.file(status).text()).toBe("closed")
  })

  test("does not bind an error handler until output is written", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture", "stdout.ts"), "--idle"], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  })

  test("surfaces unexpected output errors from write and flush", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture", "stdout.ts"), "--error"], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  })

  test("entrypoints handle flush failures before forced exit", async () => {
    for (const entry of ["index.ts", "headless.ts"]) {
      const source = await Bun.file(path.join(import.meta.dir, "../../src", entry)).text()
      const flush = source.lastIndexOf("await Stdout.flush().catch")
      expect(flush).toBeGreaterThan(-1)
      expect(source.indexOf("process.exit()", flush)).toBeGreaterThan(flush)
    }
  })
})
