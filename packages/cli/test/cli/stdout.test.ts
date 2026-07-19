import { describe, expect, test } from "bun:test"
import path from "path"

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
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture", "stdout.ts"), "--epipe"],
      {
        cwd: path.join(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    await child.stdout.cancel()

    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
  })
})
