// Standalone child runtime: the parent installs its network guard before imports.
if (process.env.SELECTOR_RUNTIME_MODE === "deadline-hang") await Bun.sleep(10000)
const root = process.env.SELECTOR_RUNTIME_ROOT
if (!root) throw new Error("Missing isolated runtime root")
const { Instance } = (await import(root + "/project/instance.ts")) as typeof import("../../src/project/instance")
const { Session } = (await import(root + "/session/index.ts")) as typeof import("../../src/session")
const { SessionPrompt } = (await import(root + "/session/prompt.ts")) as typeof import("../../src/session/prompt")
const mode = process.env.SELECTOR_RUNTIME_MODE
try {
  await Instance.provide({
    directory: process.cwd(),
    async fn() {
      const session = process.env.SELECTOR_SAVED_SESSION
        ? await Session.get(process.env.SELECTOR_SAVED_SESSION)
        : await Session.create({ title: "Selection runtime fixture" })
      const prompt = (toolAllowlist: string[], text: string) =>
        SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "fixture" },
          toolAllowlist,
          parts: [{ type: "text", text }],
        })
      const users = async (sessionID: string) =>
        (await Session.messages({ sessionID })).filter((item) => item.info.role === "user").map((item) => item.info)
      const record = () =>
        SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          model: { providerID: "fixture", modelID: "fixture" },
          toolAllowlist: ["read"],
          parts: [{ type: "text", text: "Recorded read snapshot" }],
        })
      const omitted = (sessionID: string, text: string) =>
        SessionPrompt.prompt({
          sessionID,
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text }],
        })
      if (mode === "restart-replay") {
        await SessionPrompt.loop({ sessionID: session.id })
        await omitted(session.id, "Fresh process omitted selector resolves current config")
        await Bun.write("runtime-report.json", JSON.stringify({ users: await users(session.id) }))
        return
      }
      if (mode === "restart-snapshot") {
        await record()
        const keys = [
          "PATH",
          "SHELL",
          "HOME",
          "AICTRL_TEST_HOME",
          "AICTRL_TEST_MANAGED_CONFIG_DIR",
          "XDG_DATA_HOME",
          "XDG_CONFIG_HOME",
          "XDG_STATE_HOME",
          "XDG_CACHE_HOME",
          "AICTRL_CONFIG_CONTENT",
          "AICTRL_DISABLE_DEFAULT_PLUGINS",
          "AICTRL_DISABLE_AUTOCOMPACT",
          "AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS",
          "SELECTOR_FIXTURE_ORIGIN",
          "SELECTOR_FIXTURE_GUARD_LOG",
          "SELECTOR_RUNTIME_ROOT",
          "SELECTOR_RUNTIME_PRELOAD",
        ]
        const env = Object.fromEntries(
          keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        )
        const child = Bun.spawn(
          [
            process.execPath,
            "run",
            "--no-install",
            "--no-env-file",
            "--preload",
            process.env.SELECTOR_RUNTIME_PRELOAD!,
            "--conditions=browser",
            import.meta.path,
          ],
          {
            cwd: process.cwd(),
            env: { ...env, SELECTOR_RUNTIME_MODE: "restart-replay", SELECTOR_SAVED_SESSION: session.id },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (exit !== 0) throw new Error("Restart fixture failed: " + stderr + stdout)
        return
      }
      if (mode === "codex-reset") {
        const call = (toolAllowlist?: string[]) =>
          SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "openai", modelID: "gpt-5.2" },
            ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
            parts: [{ type: "text", text: "Codex selection fixture" }],
          })
        await call()
        await call(["read"])
        await call()
        await Bun.write("runtime-report.json", JSON.stringify({ users: await users(session.id) }))
        return
      }
      if (mode === "noop-history") {
        await Bun.write("read-fixture.txt", "Noop history harmless content")
        await prompt(["read"], "Read fixture first")
        await prompt([], "No work tools with historical tool call")
        await Bun.write("runtime-report.json", JSON.stringify({ users: await users(session.id) }))
        return
      }
      if (mode === "resolved-file-empty" || mode === "command-file-empty" || mode === "command-shell-empty") {
        if (mode === "resolved-file-empty") {
          const parts = await SessionPrompt.resolvePromptParts("Inspect @" + process.cwd() + "/caller-input.txt")
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: "fixture", modelID: "fixture" },
            toolAllowlist: [],
            parts,
          })
        } else {
          await SessionPrompt.command({
            sessionID: session.id,
            command: "prepare",
            arguments: "",
            model: "fixture/fixture",
            toolAllowlist: [],
          })
        }
        await Bun.write("runtime-report.json", JSON.stringify({ users: await users(session.id) }))
        return
      }
      if (mode === "snapshot-reset") {
        await record()
        await SessionPrompt.loop({ sessionID: session.id })
        await omitted(session.id, "Fresh omitted selector")
        await prompt([], "Explicit empty selector")
        await omitted(session.id, "Omitted selector after empty")
        await Bun.write("runtime-report.json", JSON.stringify({ users: await users(session.id) }))
        return
      }
      if (mode === "historical-missing") {
        const { Identifier } = (await import(root + "/id/id.ts")) as typeof import("../../src/id/id")
        const message = await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "fixture", modelID: "fixture" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: message.id,
          type: "text",
          text: "Historical wire User without selector metadata",
        })
        await SessionPrompt.loop({ sessionID: session.id })
        await omitted(session.id, "Fresh prompt resolves config")
        await Bun.write("runtime-report.json", JSON.stringify({ users: await users(session.id) }))
        return
      }
      if (mode === "fork-snapshot") {
        await record()
        const fork = await Session.fork({ sessionID: session.id })
        await SessionPrompt.loop({ sessionID: fork.id })
        await omitted(fork.id, "New fork prompt resolves config")
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({ original: await users(session.id), forked: await users(fork.id) }),
        )
        return
      }
      if (mode === "export-import" || mode === "export-import-reset") {
        await record()
        const keys = [
          "PATH",
          "SHELL",
          "HOME",
          "AICTRL_TEST_HOME",
          "AICTRL_TEST_MANAGED_CONFIG_DIR",
          "XDG_DATA_HOME",
          "XDG_CONFIG_HOME",
          "XDG_STATE_HOME",
          "XDG_CACHE_HOME",
          "AICTRL_CONFIG_CONTENT",
          "AICTRL_DISABLE_DEFAULT_PLUGINS",
          "AICTRL_DISABLE_AUTOCOMPACT",
          "AICTRL_MODEL_STREAM_IDLE_TIMEOUT_MS",
          "SELECTOR_FIXTURE_ORIGIN",
          "SELECTOR_FIXTURE_GUARD_LOG",
        ]
        const env = Object.fromEntries(
          keys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        )
        const cli = async (args: string[]) => {
          const child = Bun.spawn(
            [
              process.execPath,
              "run",
              "--no-install",
              "--no-env-file",
              "--preload",
              process.env.SELECTOR_RUNTIME_PRELOAD!,
              "--conditions=browser",
              root + "/index.ts",
              ...args,
            ],
            { cwd: process.cwd(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
          )
          const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          if (exit !== 0) throw new Error("Actual CLI " + args[0] + " failed: " + stderr)
          return { stdout, stderr, exit }
        }
        const exported = await cli(["export", session.id])
        const data = JSON.parse(exported.stdout)
        await Bun.write("session-export.json", exported.stdout)
        await Session.remove(session.id)
        const imported = await cli(["import", "session-export.json"])
        await SessionPrompt.loop({ sessionID: session.id })
        if (mode === "export-import-reset") await omitted(session.id, "Fresh imported prompt resolves config")
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({
            exported: data.messages
              .filter((item: { info: { role: string } }) => item.info.role === "user")
              .map((item: { info: unknown }) => item.info),
            users: await users(session.id),
            imported: imported.stdout,
          }),
        )
        return
      }
      if (mode === "compaction-snapshot") {
        await record()
        const { SessionCompaction } = (await import(
          root + "/session/compaction.ts"
        )) as typeof import("../../src/session/compaction")
        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "fixture", modelID: "fixture" },
          auto: true,
        })
        await SessionPrompt.loop({ sessionID: session.id })
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({
            users: await users(session.id),
            parts: (await Session.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "compaction"),
          }),
        )
        return
      }
      if (mode === "command-snapshot") {
        await SessionPrompt.command({
          sessionID: session.id,
          command: "inspect",
          arguments: "",
          model: "fixture/fixture",
          toolAllowlist: ["task", "read"],
        })
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({
            users: await users(session.id),
            parts: (await Session.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text" && part.synthetic),
          }),
        )
        return
      }
      if (mode === "cancel-record" || mode === "cancel-model") {
        const pending = prompt(["read"], "Owner cancellation snapshot").then(
          () => undefined,
          (error) => String(error),
        )
        const deadline = Date.now() + 5000
        while (!(await Bun.file("phase-ready.json").exists())) {
          if (Date.now() > deadline) throw new Error("Phase barrier never ready")
          await Bun.sleep(5)
        }
        const before = (await users(session.id)).length
        let busy: string | undefined
        try {
          await prompt(["bash"], "Must not replace busy owner")
        } catch (error) {
          busy = String(error)
        }
        SessionPrompt.cancel(session.id)
        await Bun.write("phase-release.json", "true")
        const ownerFailure = await pending
        await prompt(["bash"], "Fresh owner after cancellation")
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({ before, busy, ownerFailure, users: await users(session.id) }),
        )
        return
      }
      if (mode === "overlap-child-resume") {
        await prompt(["task", "read", "bash"], "Initial resume parent")
        const [child] = await Session.children(session.id)
        if (!child) throw new Error("Actual initial Task created no child")
        const pending = prompt(["task", "read"], "Resume held parent " + child.id)
        const deadline = Date.now() + 5000
        while (!(await Bun.file("phase-ready.json").exists())) {
          if (Date.now() > deadline) throw new Error("Resume child barrier never reached")
          await Bun.sleep(5)
        }
        const other = await Session.create({ title: "Overlapping Task caller" })
        await SessionPrompt.prompt({
          sessionID: other.id,
          model: { providerID: "fixture", modelID: "fixture" },
          toolAllowlist: ["task", "bash"],
          parts: [{ type: "text", text: "Overlap rejected parent " + child.id }],
        })
        const during = await users(child.id)
        await Bun.write("phase-release.json", "true")
        await pending
        await prompt(["task", "bash"], "Fresh resumed parent " + child.id)
        await Bun.write("runtime-report.json", JSON.stringify({ during, after: await users(child.id) }))
        return
      }
      if (mode === "sibling-children") {
        const second = await Session.create({ title: "Second sibling parent" })
        await Promise.all([
          prompt(["task", "read"], "Parent sibling read"),
          SessionPrompt.prompt({
            sessionID: second.id,
            model: { providerID: "fixture", modelID: "fixture" },
            toolAllowlist: ["task", "bash"],
            parts: [{ type: "text", text: "Parent sibling bash" }],
          }),
        ])
        const report = async (id: string) => ({
          users: await users(id),
          children: await Promise.all(
            (await Session.children(id)).map(async (child) => ({ id: child.id, users: await users(child.id) })),
          ),
        })
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({ first: await report(session.id), second: await report(second.id) }),
        )
        return
      }
      if (mode === "concurrent-sessions") {
        const second = await Session.create({ title: "Concurrent second" })
        await Promise.all([
          prompt(["read"], "Concurrent read invocation"),
          SessionPrompt.prompt({
            sessionID: second.id,
            model: { providerID: "fixture", modelID: "fixture" },
            toolAllowlist: ["bash"],
            parts: [{ type: "text", text: "Concurrent bash invocation" }],
          }),
        ])
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({
            first: { id: session.id, users: await users(session.id) },
            second: { id: second.id, users: await users(second.id) },
          }),
        )
        return
      }
      if (mode === "metadata-registration") {
        const { Bus } = (await import(root + "/bus/index.ts")) as typeof import("../../src/bus")
        const { MessageV2 } = (await import(
          root + "/session/message-v2.ts"
        )) as typeof import("../../src/session/message-v2")
        const metadata: unknown[] = []
        let immediate = false,
          ready = false
        const stop = Bus.subscribe(MessageV2.Event.PartUpdated, async (event) => {
          const part = event.properties.part
          if (part.type !== "tool" || part.tool !== "probe" || part.state.status !== "running") return
          await Bun.write("probe-running.json", "true")
          if (part.state.metadata?.immediateProbe) immediate = true
          if (part.state.metadata?.readyProbe) ready = true
          if (part.state.metadata?.immediateProbe || part.state.metadata?.readyProbe)
            metadata.push(JSON.parse(JSON.stringify(part)))
        })
        await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: "fixture", modelID: "fixture" },
          parts: [{ type: "text", text: "Probe existing metadata lifecycle" }],
        })
        stop()
        await Bun.write("runtime-report.json", JSON.stringify({ immediate, ready, metadata }))
        return
      }
      if (mode === "public-abort-busy") {
        const { Bus } = (await import(root + "/bus/index.ts")) as typeof import("../../src/bus")
        const { MessageV2 } = (await import(
          root + "/session/message-v2.ts"
        )) as typeof import("../../src/session/message-v2")
        const metadata: unknown[] = []
        const stop = Bus.subscribe(MessageV2.Event.PartUpdated, async (event) => {
          const part = event.properties.part
          if (part.type === "tool" && part.tool === "delegate" && part.state.status === "running")
            await Bun.write("delegate-running.json", "true")
          if (
            part.type === "tool" &&
            part.state.status === "running" &&
            (part.state.metadata?.facade || part.state.metadata?.abortLeaf)
          )
            metadata.push(JSON.parse(JSON.stringify(part)))
        })
        const pending = prompt(["delegate", "abortleaf"], "Wait for cancellation").catch((error) => ({
          failure: String(error),
        }))
        const deadline = Date.now() + 3000
        while (!(await Bun.file("abort-ready.json").exists())) {
          if (Date.now() > deadline) throw new Error("Nested public abort leaf never reached readiness barrier")
          await Bun.sleep(5)
        }
        let busy: string | undefined
        try {
          await prompt(["bash"], "Rejected concurrent prompt")
        } catch (error) {
          busy = String(error)
        }
        SessionPrompt.cancel(session.id)
        await pending
        stop()
        await prompt(["read"], "Fresh prompt after cancellation")
        await Bun.write("runtime-report.json", JSON.stringify({ busy, users: await users(session.id), metadata }))
        return
      }
      if (mode === "resume-child" || mode === "resume-child-config") {
        await prompt(["task", "read", "bash"], "First parent invocation")
        await prompt(["task", "read"], "Second narrower parent invocation")
        const children = await Session.children(session.id)
        await Bun.write(
          "runtime-report.json",
          JSON.stringify({
            users: await users(session.id),
            children: await Promise.all(
              children.map(async (child) => ({ id: child.id, users: await users(child.id) })),
            ),
          }),
        )
        return
      }
      if (mode === "child-widen") {
        const child = await Session.create({ parentID: session.id, title: "Widening child" })
        let failure: string | undefined
        try {
          await SessionPrompt.child(
            {
              sessionID: child.id,
              noReply: true,
              model: { providerID: "fixture", modelID: "fixture" },
              toolAllowlist: ["bash"],
              parts: [{ type: "text", text: "Do not widen" }],
            },
            ["read"],
          )
        } catch (error) {
          failure = String(error)
        }
        await Bun.write("runtime-report.json", JSON.stringify({ failure, users: await users(child.id) }))
        return
      }
      throw new Error("Unknown isolated runtime mode: " + mode)
    },
  })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await Instance.disposeAll()
}
