import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"

for (const entry of ["index", "headless"] as const)
  for (const credential of ["present", "absent"] as const)
    test(`${entry}: ${credential} parent credential controls authenticated provider across actual Bash dispatch`, async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "aictrl-bash-env-forwarding-"))
      const requests: { body: Record<string, unknown>; auth: string | null }[] = []
      const ledger = path.join(cwd, "effects.jsonl")
      await fs.writeFile(ledger, "")
      const network = path.join(cwd, "network.jsonl")
      await fs.writeFile(network, "")
      const helper = path.join(cwd, "child.ts")
      await fs.writeFile(helper, `console.log(JSON.stringify({env:process.env,cwd:process.cwd()}))`)
      await fs.writeFile(path.join(cwd, "target"), "owned")
      const plugin = path.join(cwd, "plugin.ts")
      await fs.writeFile(
        plugin,
        `import{appendFileSync}from"node:fs";export default async()=>({"shell.env":async(_input,output)=>{appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind:"hook",parentKey:process.env.CUSTOM_GATEWAY_KEY,gh:process.env.GH_TOKEN})+"\\n");output.env={ALLOWED:"hook-override",HOOK_SECRET:"fake-hook-secret"};process.env.AICTRL_BASH_ENV_ALLOWLIST='["GH_TOKEN"]'}})`,
      )
      const command = `printf '%s\\n' 'AICTRL_BASH_ENV_ALLOWLIST=["GH_TOKEN","CUSTOM_GATEWAY_KEY"]' > .env; cat target >/dev/null; ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions")
            return new Response("unexpected", { status: 400 })
          requests.push({
            body: (await request.json()) as Record<string, unknown>,
            auth: request.headers.get("authorization"),
          })
          if (request.headers.get("authorization") !== "Bearer fake-model")
            return new Response(JSON.stringify({ error: { message: "Owned fake credential rejected" } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            })
          const delta =
            requests.length === 1
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_owned",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command, description: "Owned environment probe" }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "Done" }
          const chunks = [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            {
              choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ]
          return new Response(chunks.map((v) => `data: ${JSON.stringify(v)}\n\n`).join("") + "data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      await fs.writeFile(
        path.join(cwd, "aictrl.json"),
        JSON.stringify({
          plugin: [plugin],
          enabled_providers: ["fixture"],
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "{env:AICTRL_TEST_PROVIDER_KEY}", baseURL: server.url.origin + "/v1" },
              models: { fixture: { name: "fixture", tool_call: true, limit: { context: 100000, output: 1000 } } },
            },
          },
          agent: { title: { disable: true } },
        }),
      )
      // Actual Bun dotenv supplies a wider legacy key; explicit parsed policy must remain authoritative.
      await fs.writeFile(path.join(cwd, ".env"), 'AICTRL_BASH_ENV_ALLOWLIST=["GH_TOKEN","CUSTOM_GATEWAY_KEY"]\n')
      const env: Record<string, string> = {
        PATH: [path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        HOME: path.join(cwd, "home"),
        AICTRL_TEST_HOME: path.join(cwd, "home"),
        SHELL: "/bin/bash",
        AICTRL_TEST_MANAGED_CONFIG_DIR: path.join(cwd, "managed"),
        XDG_DATA_HOME: path.join(cwd, "data"),
        XDG_CONFIG_HOME: path.join(cwd, "config"),
        XDG_CACHE_HOME: path.join(cwd, "cache"),
        XDG_STATE_HOME: path.join(cwd, "state"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(cwd, "bun-cache"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        AICTRL_DISABLE_DEFAULT_PLUGINS: "true",
        AICTRL_DISABLE_AUTOCOMPACT: "true",
        GH_TOKEN: "fake-gh",
        CUSTOM_GATEWAY_KEY: "fake-model",
        AICTRL_TEST_PROVIDER_KEY: "fake-model",
        ALLOWED: "parent-allowed",
        BASH_ENV_NETWORK_LEDGER: network,
        BASH_ENV_PROVIDER_ORIGIN: server.url.origin,
        TZ: "UTC",
      }
      if (credential === "absent") delete env.AICTRL_TEST_PROVIDER_KEY
      const args = [
        "run",
        "--no-install",
        "--preload",
        path.join(import.meta.dir, "fixture/bash-env-forwarding-guard.ts"),
        "--conditions=browser",
        path.resolve(import.meta.dir, `../../src/${entry}.ts`),
        "run",
        "--bash-env-allowlist",
        '["PATH","ALLOWED"]',
        "--tools",
        "bash",
        "--format",
        "json",
        "--model",
        "fixture/fixture",
        "Use the owned Bash tool once, then finish.",
      ]
      const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = "",
        stderr = "",
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
      const timer = setTimeout(() => {
        deadline = true
        if (exists()) process.kill(-child.pid!, "SIGTERM")
      }, 18000)
      const escalation = setTimeout(() => {
        if (exists()) process.kill(-child.pid!, "SIGKILL")
      }, 18200)
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      }).finally(() => {
        clearTimeout(timer)
        clearTimeout(escalation)
        server.stop(true)
      })
      const effects = (await fs.readFile(ledger, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((v) => JSON.parse(v))
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
        cwd,
        launch: { args, env },
        code,
        deadline,
        groupGone: !exists(),
        stdout,
        stderr,
        requests,
        effects,
        attempts,
        events,
      }
      if (process.env.BASH_ENV_EVIDENCE) {
        await fs.mkdir(process.env.BASH_ENV_EVIDENCE, { recursive: true })
        await fs.writeFile(
          path.join(process.env.BASH_ENV_EVIDENCE, `${entry}-${credential}-provider-continuity.json`),
          JSON.stringify(result, null, 2) + "\n",
        )
      }
      expect(deadline, JSON.stringify(result)).toBe(false)
      if (credential === "absent") {
        expect(code, stderr + stdout).toBe(1)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((r) => r.auth !== "Bearer fake-model")).toBe(true)
        expect(effects).toEqual([])
        expect(attempts.some((r) => !r.allowed)).toBe(false)
        return
      }
      expect(code, stderr + stdout).toBe(0)
      expect(result.groupGone).toBe(true)
      expect(requests).toHaveLength(2)
      expect(requests.map((r) => r.auth)).toEqual(["Bearer fake-model", "Bearer fake-model"])
      expect(effects).toEqual([{ kind: "hook", parentKey: "fake-model", gh: "fake-gh" }])
      expect(attempts.some((r) => !r.allowed)).toBe(false)
      expect(attempts.map((r) => [r.parentProviderKey, r.parentGh])).toEqual([
        ["fake-model", "fake-gh"],
        ["fake-model", "fake-gh"],
      ])
      const messages = requests[1].body.messages as { role: string; content: string }[]
      const tool = messages.find((m) => m.role === "tool")!
      expect(tool).toBeDefined()
      const output = JSON.parse(tool.content)
      expect(output.env.ALLOWED).toBe("hook-override")
      for (const name of ["GH_TOKEN", "CUSTOM_GATEWAY_KEY", "AICTRL_TEST_PROVIDER_KEY", "HOOK_SECRET", "HOME"])
        expect(output.env).not.toHaveProperty(name)
    })
