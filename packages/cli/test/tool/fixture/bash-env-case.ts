import fs from "node:fs/promises"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { BashTool } from "../../../src/tool/bash"
import { BashEnvPolicy } from "../../../src/util/bash-env-policy"
import { Instance } from "../../../src/project/instance"
import { PermissionNext } from "../../../src/permission/next"
import { Log } from "../../../src/util/log"

const input = JSON.parse(await fs.readFile(process.env.BASH_ENV_INPUT!, "utf8"))
const record = (value: unknown) => appendFileSync(process.env.BASH_ENV_LEDGER!, JSON.stringify(value) + "\n")
if (input.guardNegative) {
  let guardBlocked = false
  try {
    if (input.guardNegative === "fetch") await fetch("https://owned-denied.invalid/fixture")
    else Bun.spawn([process.execPath, "install"])
  } catch {
    guardBlocked = true
  }
  console.log(JSON.stringify({ guardBlocked }))
  process.exit(0)
}
if (input.policy !== null) BashEnvPolicy.initialize({ "bash-env-allowlist": JSON.stringify(input.policy) })
await Log.init({ print: false, dev: true, level: "DEBUG" })
const controller = new AbortController()
if (input.preAbort) controller.abort()
const ctx = {
  sessionID: "ses_owned",
  messageID: "",
  callID: "owned",
  agent: "build",
  abort: controller.signal,
  messages: [],
  metadata: (data: { metadata?: { output?: string } }) => {
    if (input.cancel && data.metadata?.output?.includes("LIFECYCLE_READY")) controller.abort()
  },
  ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
    record({ kind: "permission", permission: request.permission })
    await PermissionNext.ask({
      ...request,
      sessionID: "ses_owned",
      ruleset: [{ permission: "*", pattern: "*", action: input.deny ? "deny" : "allow" }],
    })
  },
}
const before = { gh: process.env.GH_TOKEN, provider: process.env.CUSTOM_GATEWAY_KEY, allowed: process.env.ALLOWED }
const outcome = await Instance.provide({
  directory: process.cwd(),
  fn: async () => {
    const tool = await BashTool.init()

    let command = input.command
    if (input.residual) {
      const file = path.join(process.cwd(), "parent-credential")
      await fs.writeFile(file, "fake-owned-file-credential")
      const residual = path.join(process.cwd(), "residual.ts")
      await fs.writeFile(
        residual,
        `import fs from "node:fs"; const rows=fs.readFileSync("/proc/${process.pid}/environ","utf8").split("\\0");console.log(JSON.stringify({childGh:process.env.GH_TOKEN??null,parentGh:rows.find(v=>v.startsWith("GH_TOKEN=")),credential:fs.readFileSync(${JSON.stringify(file)},"utf8")}))`,
      )
      command = `${JSON.stringify(process.execPath)} ${JSON.stringify(residual)}`
    }
    if (input.cancel || input.timeout !== undefined) {
      const lifecycle = path.join(process.cwd(), "lifecycle.ts")
      await fs.writeFile(
        lifecycle,
        `import{appendFileSync}from"node:fs";const record=v=>appendFileSync(${JSON.stringify(process.env.BASH_ENV_LEDGER)},JSON.stringify(v)+"\\n");const child=Bun.spawn([process.execPath,"--no-env-file","-e","setInterval(()=>{},1000)"],{env:{PATH:"/usr/bin:/bin"},stdin:"ignore",stdout:"ignore",stderr:"ignore"});record({kind:"lifecycle-start",pid:process.pid,grandchild:child.pid});process.on("SIGTERM",async()=>{child.kill("SIGTERM");await child.exited;record({kind:"lifecycle-reaped"});process.exit(0)});console.log("LIFECYCLE_READY");setInterval(()=>{},1000)`,
      )
      command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(lifecycle)}`
    }
    try {
      if (input.repeat) {
        const results = []
        for (let i = 0; i < input.repeat; i++)
          results.push(await tool.execute({ command, description: "Owned rapid exit probe" }, ctx))
        return { results }
      }
      const result = await tool.execute(
        {
          command,
          description: "Owned environment probe",
          ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        },
        ctx,
      )
      return { result }
    } catch (error) {
      return {
        error: {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          cause: error instanceof Error ? String(error.cause) : undefined,
          code: (error as { code?: string }).code,
        },
      }
    }
  },
})
const after = { gh: process.env.GH_TOKEN, provider: process.env.CUSTOM_GATEWAY_KEY, allowed: process.env.ALLOWED }
await new Promise((resolve) => setTimeout(resolve, 80))
console.log(JSON.stringify({ outcome, before, after, policy: BashEnvPolicy.current() }))
await Instance.disposeAll()
process.exit(0)
