import { expect, test } from "bun:test"
import path from "path"

test("model catalog refresh handles a timeout while reading the response body", async () => {
  using server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    },
  })
  const proc = Bun.spawn(
    [
      "bun",
      "--conditions=browser",
      "-e",
      `const { Log } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/util/log.ts"))}); await Log.init({ print: true }); const { ModelsDev } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/provider/models.ts"))}); await ModelsDev.refresh(); console.log("refresh completed")`,
    ],
    {
      env: { ...process.env, AICTRL_DISABLE_MODELS_FETCH: "true", AICTRL_MODELS_URL: server.url.origin },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  using cleanup = { [Symbol.dispose]: () => proc.kill() }
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exit, stderr).toBe(0)
  expect(stdout).toContain("refresh completed")
  expect(stderr).toContain("Failed to read models.dev response")
  expect(stderr).not.toContain("Failed to fetch models.dev")
}, 25000)
