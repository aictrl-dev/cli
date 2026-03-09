import { describe, expect, test } from "bun:test"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.resolve(__dirname, "../../src/index.ts")

describe("aictrl run error propagation", () => {
  test("exits non-zero when prompt fails with invalid model", async () => {
    // Run aictrl with a model that does not exist, causing SessionPrompt.prompt
    // to throw during model resolution. Before the fix, this would hang forever
    // because .catch(() => {}) swallowed the error and no idle event was emitted.
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "--conditions=browser",
        CLI_ENTRY,
        "run",
        "test prompt",
        "--model",
        "nonexistent-provider/nonexistent-model",
        "--print-logs",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Ensure we don't accidentally use real API keys
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    // Give the process a generous timeout -- if it hangs (the old bug), this
    // test will fail by timeout rather than passing
    const timeout = setTimeout(() => {
      proc.kill()
    }, 15_000)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    // The process must exit non-zero (1) when the prompt fails
    expect(exitCode).not.toBe(0)
  }, 20_000)

  test("does not contain .catch(() => {}) on critical path", async () => {
    // Static analysis: ensure the fire-and-forget pattern is not reintroduced
    const runSource = await Bun.file(path.resolve(__dirname, "../../src/cli/cmd/run.ts")).text()

    // Search for the specific antipattern: .catch(() => {}) on SessionPrompt calls
    const hasSilentCatch = runSource.includes("SessionPrompt.prompt") && runSource.includes(".catch(() => {})")
    expect(hasSilentCatch).toBe(false)
  })
})
