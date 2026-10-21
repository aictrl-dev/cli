/** Explicit release binary comparison. No paid provider or image build; capture only. */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { gzipSync } from "node:zlib"
import { MARKER, PROTOCOL_VERSION, Stub } from "./release-fixtures/token-stub"

type Binary = { path: string; sha256: string; version: string; provenance: { path: string; sha256: string } }
type Inputs = { fixtureImage: string; current: Binary; previous: Binary; repeats: number }
const SHA = /^[a-f0-9]{64}$/
const digest = (b: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex")
const [inputArg, outputArg] = process.argv.slice(2)
if (!inputArg || !outputArg || process.argv.length !== 4)
  throw new Error("Usage: bun script/token-budget/release.ts INPUT.json NEW-OUTPUT-DIRECTORY")
const inputPath = path.resolve(inputArg)
const inputBytes = fs.readFileSync(inputPath)
const input = JSON.parse(inputBytes.toString()) as Inputs
if (!/^sha256:[a-f0-9]{64}$/.test(input.fixtureImage) || !Number.isInteger(input.repeats) || input.repeats < 2)
  throw new Error("Pinned fixture image and repeats >=2 required")
for (const name of ["current", "previous"] as const) {
  const bin = input[name]
  if (
    !bin ||
    !SHA.test(bin.sha256) ||
    typeof bin.version !== "string" ||
    !bin.version ||
    !bin.provenance ||
    !SHA.test(bin.provenance.sha256)
  )
    throw new Error(`Explicit ${name} binary/version/hash/provenance required`)
  bin.path = path.resolve(path.dirname(inputPath), bin.path)
  if (
    fs.lstatSync(bin.path).isSymbolicLink() ||
    !fs.statSync(bin.path).isFile() ||
    digest(fs.readFileSync(bin.path)) !== bin.sha256
  )
    throw new Error(`${name} binary hash/file mismatch`)
  const bytes = fs.readFileSync(path.resolve(path.dirname(inputPath), bin.provenance.path))
  if (digest(bytes) !== bin.provenance.sha256) throw new Error(`${name} provenance hash mismatch`)
  const provenance = JSON.parse(bytes.toString())
  const published = provenance.installedPackages?.platformPackages?.find(
    (item: any) => item.binarySha256 === bin.sha256 && item.version === bin.version,
  )
  if (
    name === "current" &&
    (provenance.complete !== true || provenance.binarySha256 !== bin.sha256 || provenance.version !== bin.version)
  )
    throw new Error("Current build provenance must bind complete reviewed build/version/binary")
  if (
    name === "previous" &&
    (!published || provenance.publishedPackage?.version !== bin.version || provenance.npmWrapperVersion !== bin.version)
  )
    throw new Error("Previous provenance must bind actual published npm wrapper/platform binary/version")
}
if (input.current.sha256 === input.previous.sha256)
  throw new Error(
    "Current and previous binaries must have distinct SHA256 hashes; self-comparison is not a release comparison",
  )
const output = path.resolve(outputArg)
fs.mkdirSync(output, { recursive: false }) // refuse existing campaign, including failed runs
const logs = path.join(output, "campaign-logs")
fs.mkdirSync(logs, { mode: 0o700 })
fs.writeFileSync(path.join(output, "original-inputs.json"), inputBytes, { mode: 0o600 })
for (const name of ["current", "previous"] as const) {
  const bytes = fs.readFileSync(path.resolve(path.dirname(inputPath), input[name].provenance.path))
  fs.writeFileSync(path.join(output, `${name}-provenance.json`), bytes, { mode: 0o600 })
  input[name].provenance.path = path.join(output, `${name}-provenance.json`)
}
fs.writeFileSync(path.join(output, "effective-inputs.json"), JSON.stringify(input, null, 2) + "\n", { mode: 0o600 })
const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "release248-docker-"))
const hostEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: hostHome }
const TIMEOUT = 180_000
let ownedContainer: string | undefined
let proc: ReturnType<typeof Bun.spawn> | undefined
const campaignId = `release248-${process.pid}-${Date.now()}`
const failures: unknown[] = []
const cleanupChecks: unknown[] = []
const arms: string[] = ["current-default", "previous-default"]
const support: Record<string, boolean> = {}
const raw: Record<string, Record<string, unknown[]>> = { short: Object.fromEntries(arms.map((x) => [x, []])) }
const protocolSources = Object.fromEntries(
  ["release-fixtures/token-stub.ts", "release.ts", "release-count.py", "reference.py"].map((name) => [
    name,
    digest(fs.readFileSync(path.join(import.meta.dir, name))),
  ]),
)
const metadata = {
  purpose: "explicit current versus previous release reference-token capture; no performance comparison",
  network: "host network; loopback scripted stub only is intended, but OS egress is not restricted",
  model: "fixture/fixture (non-GPT), no real inference",
  prompt: `${MARKER} short: read notes-0.txt, notes-1.txt and notes-2.txt once each in order, then reply Done.`,
  permission: { "*": "allow" },
  selector: "--tools read,bash,edit,write, only if actual run help supports it",
  inputManifestSha256: digest(inputBytes),
  protocolSources,
  limitations: [
    "Not provider billing/cache/quality evidence",
    "Raw inert requests include repeated history and auxiliary calls",
    "Timing is diagnostic only; never compare against historical campaigns",
  ],
}
let stub: Stub | undefined
function checkpoint() {
  fs.writeFileSync(
    path.join(output, "campaign.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        protocolVersion: PROTOCOL_VERSION,
        HARNESSES: arms,
        REPS: input.repeats,
        LONG_REPS: 0,
        WARMUP: 0,
        LATENCY: 50,
        CPUS: "2",
        MEMORY: "2g",
        TIMEOUT_MS: TIMEOUT,
        binaries: input,
        support,
        campaignMetadata: metadata,
        raw,
        failures,
        cleanupChecks,
      },
      null,
      2,
    ) + "\n",
  )
}
async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { env: hostEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timeout = false
  const timer = setTimeout(() => {
    timeout = true
    child.kill("SIGKILL")
  }, TIMEOUT)
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code || timeout) {
      await cleanup()
      throw new Error(`Docker preflight failed (${code}, timeout=${timeout}): ${err}`)
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}
async function cleanupCommand(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { env: hostEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 15_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exit, timedOut }
  } finally {
    clearTimeout(timer)
  }
}
async function cleanup() {
  try {
    if (ownedContainer) {
      const name = ownedContainer
      const removed = await cleanupCommand(["rm", "-f", name])
      const remaining = await cleanupCommand(["ps", "-aq", "--filter", `name=^/${name}$`])
      cleanupChecks.push({ name, removed, remaining })
      if (
        removed.timedOut ||
        remaining.timedOut ||
        remaining.exit !== 0 ||
        remaining.stdout.trim() ||
        (removed.exit !== 0 && !removed.stderr.includes("No such container"))
      )
        throw new Error(`Unverified container cleanup: ${name}`)
    }
  } finally {
    if (proc && proc.exitCode === null) proc.kill("SIGKILL")
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)))
  })
try {
  const image = JSON.parse(await docker(["image", "inspect", input.fixtureImage]))[0]
  if (
    image.Id !== input.fixtureImage ||
    image.Architecture !== "amd64" ||
    image.Os !== "linux" ||
    image.Config.Env.some((entry: string) => !/^(PATH|NODE_VERSION|YARN_VERSION|HOME)=/.test(entry))
  )
    throw new Error("Fixture image identity/platform mismatch")
  for (const name of ["current", "previous"] as const) {
    const binary = input[name]
    const script = `const fs=require('fs'),cp=require('child_process'),crypto=require('crypto'); const binary='/release/aictrl'; console.log(JSON.stringify({uid:process.getuid(),home:fs.readdirSync(process.env.HOME),binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),version:cp.execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),help:cp.execFileSync(binary,['run','--help'],{encoding:'utf8'}),fixtures:Object.fromEntries(['notes.txt','big.txt',...Array.from({length:3},(_,i)=>'notes-'+i+'.txt'),...Array.from({length:50},(_,i)=>'big-'+i+'.txt')].map(name=>{const b=fs.readFileSync('/workspace/'+name);return[name,{bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}]}))}));`
    ownedContainer = `${campaignId}-preflight-${name}`
    const preflight = JSON.parse(
      await docker([
        "run",
        "--rm",
        "--pull=never",
        "--name",
        ownedContainer,
        "--label",
        `aictrl.harness-benchmark=${campaignId}`,
        "--network",
        "none",
        "--user",
        "10001:10001",
        "--mount",
        `type=bind,src=${binary.path},dst=/release/aictrl,readonly`,
        "--entrypoint",
        "node",
        input.fixtureImage,
        "-e",
        script,
      ]),
    )
    await cleanup()
    ownedContainer = undefined
    fs.writeFileSync(path.join(output, `${name}-preflight.json`), JSON.stringify(preflight, null, 2) + "\n")
    if (
      preflight.uid !== 10001 ||
      preflight.home.length ||
      preflight.binarySha256 !== binary.sha256 ||
      preflight.version !== binary.version
    )
      throw new Error(`${name} binary/UID/HOME/version mismatch`)
    for (const [filename, item] of Object.entries(preflight.fixtures) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      const short = filename.startsWith("notes")
      if (
        item.bytes !== (short ? 340 : 48000) ||
        item.sha256 !==
          (short
            ? "268a0ba51362b6181510ff8e8cea2804328d526cb07a97ce8fe56d995f5c64a0"
            : "1c756a4da138e2789f27bccbd48c08dcf99bcbf51bd27f7a4442b13b28b912db")
      )
        throw new Error(`Fixture mismatch:${filename}`)
    }
    support[name] = /^\s*--tools\s/m.test(preflight.help)
    if (support[name]) {
      arms.push(`${name}-selected`)
      raw.short[`${name}-selected`] = []
    }
  }
  stub = new Stub(50)
  stub.keepBodies = true
  for (let rep = 0; rep < input.repeats; rep++) {
    for (const arm of rep % 2 ? [...arms].reverse() : arms) {
      stub.reset("short")
      const runId = `${String(rep + 1).padStart(2, "0")}-${arm}-short`
      ownedContainer = `${campaignId}-${runId}`
      const config = {
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${stub.port}/v1` },
            models: { fixture: { name: "fixture", tool_call: true, limit: { context: 200_000, output: 1000 } } },
          },
        },
        permission: metadata.permission,
      }
      const binary = input[arm.startsWith("current-") ? "current" : "previous"]
      const cliArgv = [
        "/release/aictrl",
        "run",
        "--format",
        "json",
        "--model",
        "fixture/fixture",
        ...(arm.endsWith("-selected") ? ["--tools", "read,bash,edit,write"] : []),
        metadata.prompt,
      ]
      const argv = [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--name",
        ownedContainer,
        "--label",
        `aictrl.harness-benchmark=${campaignId}`,
        "--network",
        "host",
        "--user",
        "10001:10001",
        "--cpus",
        "2",
        "--memory",
        "2g",
        "--memory-swap",
        "2g",
        "-e",
        `AICTRL_CONFIG_CONTENT=${JSON.stringify(config)}`,
        "--mount",
        `type=bind,src=${binary.path},dst=/release/aictrl,readonly`,
        "--entrypoint",
        "/release/aictrl",
        input.fixtureImage,
        ...cliArgv.slice(1),
      ]
      fs.writeFileSync(
        path.join(logs, `${runId}.argv.json`),
        JSON.stringify({ argv, cliArgv, config, inputManifestSha256: digest(inputBytes) }, null, 2) + "\n",
      )
      let timeout = false
      let cleanupFailure: string | undefined
      const child = Bun.spawn(argv, { env: hostEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      proc = child
      const timer = setTimeout(() => {
        timeout = true
        void cleanup().catch((error) => {
          cleanupFailure = String(error)
        })
      }, TIMEOUT)
      let stdout = "",
        stderr = "",
        code: number | null = null
      try {
        ;[stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
      } finally {
        clearTimeout(timer)
        try {
          await cleanup()
        } catch (error) {
          cleanupFailure = String(error)
        }
        if (!cleanupFailure) ownedContainer = undefined
        proc = undefined
      }
      const requests = [...stub.log]
      fs.writeFileSync(path.join(logs, `${runId}.stdout.jsonl`), stdout)
      fs.writeFileSync(path.join(logs, `${runId}.stderr.log`), stderr)
      fs.writeFileSync(
        path.join(logs, `${runId}.requests-with-bodies.jsonl.gz`),
        gzipSync(
          requests
            .map((q) => JSON.stringify({ ...q, bodySha256: q.body === undefined ? null : digest(q.body) }))
            .join("\n") + "\n",
        ),
        { mode: 0o600 },
      )
      fs.writeFileSync(
        path.join(logs, `${runId}.requests.jsonl`),
        requests
          .map(({ body, ...q }) => JSON.stringify({ ...q, bodySha256: body === undefined ? null : digest(body) }))
          .join("\n") + "\n",
      )
      const errors: string[] = []
      if (cleanupFailure) errors.push(cleanupFailure)
      const events: any[] = []
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          events.push(JSON.parse(line))
        } catch {
          errors.push("Invalid native NDJSON")
        }
      }
      const main = requests.filter((q) => q.kind === "main")
      const tools = main.map((q) => JSON.parse(q.body!).tools.map((t: any) => t.function?.name ?? t.name)) as string[][]
      for (const names of tools) {
        if (names.some((n) => typeof n !== "string") || new Set(names).size !== names.length)
          errors.push("Malformed/duplicate schema names")
        if (arm.endsWith("-selected") && [...names].sort().join(",") !== "bash,edit,read,write")
          errors.push("Selected schema does not contain exactly four work tools")
        if (arm.endsWith("-default") && !names.includes("read")) errors.push("Default catalog lacks scripted Read tool")
      }
      if (main.length !== 4 || main.map((q) => q.step).join(",") !== "0,1,2,3")
        errors.push("Expected four main requests / scripted steps0..3")
      for (let i = 0; i < 3; i++) {
        const call = main[i]?.response
        const evidence = main[i + 1]?.toolResults?.find((q) => q.callId === `call_${i}`)
        if (
          call?.kind !== "tool" ||
          call.name !== "read" ||
          call.arguments?.filePath !== `/workspace/notes-${i}.txt` ||
          !evidence?.complete ||
          evidence.matchedLines !== 20 ||
          evidence.errorNotice ||
          evidence.truncationNotice ||
          evidence.nativeSuppressed ||
          evidence.nativeGuardrailRefusal
        )
          errors.push(`Read${i} not exactly validated`)
      }
      if (
        main.at(-1)?.toolResults?.length !== 3 ||
        main.at(-1)?.response?.text !== "Done." ||
        !events.some((e) => e.type === "text" && /^Done\.?$/.test((e.text ?? e.part?.text ?? "").trim()))
      )
        errors.push("Missing final three reads / native Done")
      if (requests.some((q) => q.kind === "other")) errors.push("Unexpected provider endpoint request")
      if (
        events.some((e) => e.type === "error" || e.is_error || e.type === "invocation_failed") ||
        requests.some((q) => q.error)
      )
        errors.push("Native/stub error")
      if (code !== 0 || timeout) errors.push(`Exit${code}, timeout=${timeout}`)
      const sample = {
        runId,
        valid: errors.length === 0,
        mainRequests: main.length,
        auxRequests: requests.filter((q) => q.kind === "aux").length,
        discoveryRequests: requests.filter((q) => q.kind === "discovery").length,
        otherRequests: requests.filter((q) => q.kind === "other").map((q) => q.path),
        toolNames: tools,
        exit: code,
        timedOut: timeout,
        errors,
      }
      raw.short[arm].push(sample)
      if (errors.length) failures.push({ arm, rep, ...sample })
      checkpoint()
      if (errors.length) throw new Error(`Capture ${runId} failed: ${errors.join("; ")}`)
    }
  }
} catch (error) {
  failures.push({ campaignError: error instanceof Error ? error.message : String(error) })
  checkpoint()
  throw error
} finally {
  try {
    await cleanup()
    const remaining = await cleanupCommand(["ps", "-aq", "--filter", `label=aictrl.harness-benchmark=${campaignId}`])
    cleanupChecks.push({ finalCampaignCheck: remaining })
    if (remaining.timedOut || remaining.exit !== 0 || remaining.stdout.trim())
      throw new Error("Campaign-owned containers remain or cleanup state could not be inspected")
    checkpoint()
  } catch (error) {
    failures.push({ cleanupError: String(error) })
    checkpoint()
    throw error
  } finally {
    stub?.server.stop(true)
    fs.rmSync(hostHome, { recursive: true, force: true })
  }
}
console.log(
  `Captured ${input.repeats} sessions per supported arm; containers verified absent in ${output}; run release-count.py next`,
)
