import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

async function provider() {
  const requests: { at: number; auth: string | null; body: unknown }[] = [],
    observations: { kind: string; at: number }[] = []
  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ at: Date.now(), auth: request.headers.get("authorization"), body: await request.json() })
      request.signal.addEventListener(
        "abort",
        () => {
          observations.push({ kind: "request-abort", at: Date.now() })
          if (heartbeat) clearInterval(heartbeat)
        },
        { once: true },
      )
      return new Response(
        new ReadableStream({
          start(controller) {
            observations.push({ kind: "stream-start", at: Date.now() })
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Owned in flight" }, finish_reason: null }] })}\n\n`,
              ),
            )
            heartbeat = setInterval(() => {
              controller.enqueue(encoder.encode(": owned keepalive\n\n"))
            }, 100)
          },
          cancel() {
            observations.push({ kind: "stream-cancel", at: Date.now() })
            if (heartbeat) clearInterval(heartbeat)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    server,
    requests,
    observations,
    stop() {
      if (heartbeat) clearInterval(heartbeat)
      server.stop(true)
    },
  }
}
async function waitClosed(observations: { kind: string; at: number }[]) {
  const until = Date.now() + 1000
  while (Date.now() < until) {
    if (observations.some((x) => x.kind === "request-abort" || x.kind === "stream-cancel")) return true
    await Bun.sleep(10)
  }
  return false
}
async function record(name: string, value: unknown) {
  if (process.env.BASH_ENV_PROVIDER_SIGNAL_EVIDENCE) {
    await fs.mkdir(process.env.BASH_ENV_PROVIDER_SIGNAL_EVIDENCE, { recursive: true })
    await fs.writeFile(
      path.join(process.env.BASH_ENV_PROVIDER_SIGNAL_EVIDENCE, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
    )
  }
}
test("owned streaming provider observer detects an actual client abort", async () => {
  const p = await provider(),
    controller = new AbortController()
  let closed = false
  try {
    const response = await fetch(p.server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    })
    await response.body!.getReader().read()
    controller.abort()
    closed = await waitClosed(p.observations)
    await record("observer-positive", {
      requests: p.requests,
      observations: p.observations,
      closedBeforeServerStop: closed,
    })
    expect(closed).toBe(true)
  } finally {
    p.stop()
  }
})
for (const entry of ["index", "headless"] as const)
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    test(`${entry} ${signal} cancels an actual in-flight provider request before grace`, async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-provider-signal-"))
      const network = path.join(cwd, "network.jsonl")
      await fs.writeFile(network, "")
      const p = await provider()
      await fs.writeFile(
        path.join(cwd, "aictrl.json"),
        JSON.stringify({
          enabled_providers: ["fixture"],
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "{env:AICTRL_PROVIDER_SIGNAL_KEY}", baseURL: p.server.url.origin + "/v1" },
              models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
            },
          },
          agent: { title: { disable: true } },
        }),
      )
      const env = {
        PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        HOME: path.join(cwd, "home"),
        AICTRL_TEST_HOME: path.join(cwd, "home"),
        AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(cwd, "managed"),
        XDG_DATA_HOME: path.join(cwd, "data"),
        XDG_CONFIG_HOME: path.join(cwd, "config"),
        XDG_CACHE_HOME: path.join(cwd, "cache"),
        XDG_STATE_HOME: path.join(cwd, "state"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(cwd, "bun-cache"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        SHELL: "/bin/bash",
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
        AICTRL_PROVIDER_SIGNAL_KEY: "fake-provider-signal",
        BASH_ENV_NETWORK_LEDGER: network,
        BASH_ENV_PROVIDER_ORIGIN: p.server.url.origin,
        TZ: "UTC",
      }
      const args = [
        "run",
        "--no-install",
        "--no-env-file",
        "--preload",
        path.join(import.meta.dir, "fixture/bash-env-forwarding-guard.ts"),
        "--conditions=browser",
        path.resolve(import.meta.dir, `../../src/${entry}.ts`),
        "run",
        "--bash-env-allowlist",
        "[]",
        "--format",
        "json",
        "--model",
        "fixture/fixture",
        "Respond using the owned provider.",
      ]
      const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = "",
        stderr = "",
        sentAt: number | undefined,
        deadline = false
      child.stdout!.on("data", (v) => (stdout += v))
      child.stderr!.on("data", (v) => (stderr += v))
      const exists = () => {
        try {
          process.kill(-child.pid!, 0)
          return true
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return false
          throw e
        }
      }
      const poll = setInterval(() => {
        const ready = p.observations.find((x) => x.kind === "stream-start")
        if (sentAt === undefined && p.requests.length === 1 && ready && Date.now() - ready.at >= 100) {
          sentAt = Date.now()
          child.kill(signal)
        }
      }, 10)
      const timer = setTimeout(() => {
          deadline = true
          if (exists()) process.kill(-child.pid!, "SIGTERM")
        }, 8500),
        kill = setTimeout(() => {
          if (exists()) process.kill(-child.pid!, "SIGKILL")
        }, 8800)
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      }).finally(() => {
        clearInterval(poll)
        clearTimeout(timer)
        clearTimeout(kill)
      })
      const exitAt = Date.now(),
        closedBeforeServerStop = await waitClosed(p.observations)
      const attempts = (await fs.readFile(network, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((v) => JSON.parse(v))
      const events = stdout
        .split("\n")
        .filter((v) => v.startsWith("{"))
        .map((v) => JSON.parse(v))
      const result = {
        entry,
        signal,
        launch: { executable: process.execPath, args, env, cwd },
        code,
        deadline,
        groupGone: !exists(),
        sentAt,
        exitAt,
        signalToExitMs: sentAt === undefined ? undefined : exitAt - sentAt,
        requests: p.requests,
        observations: [...p.observations],
        closedBeforeServerStop,
        stdout,
        stderr,
        attempts,
        events,
      }
      await record(entry + "-" + signal, result)
      p.stop()
      expect(deadline, JSON.stringify(result)).toBe(false)
      expect(result.groupGone).toBe(true)
      expect(p.requests).toHaveLength(1)
      expect(p.requests[0].auth).toBe("Bearer fake-provider-signal")
      expect(sentAt).toBeDefined()
      expect(code, stderr + stdout).toBe(signal === "SIGINT" ? 130 : 143)
      expect(result.signalToExitMs!, JSON.stringify(result)).toBeLessThan(3000)
      expect(closedBeforeServerStop, JSON.stringify(result)).toBe(true)
      expect(attempts.some((x) => !x.allowed)).toBe(false)
      expect(
        events.filter((x) => x.type === "session_complete" || x.type === "invocation_complete").map((x) => x.type),
      ).toEqual(["session_complete", "invocation_complete"])
      expect(events.at(-1)?.type).toBe("invocation_complete")
    })
