import { bootstrap } from "../../../src/cli/bootstrap"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { Shutdown } from "../../../src/cli/shutdown"

const data = await Bun.file(process.env.COMMAND_ARGUMENTS_DATA!).json()
if (typeof data.arguments !== "string") throw new Error("Explicit legacy string arguments required")
await bootstrap(process.cwd(), async () => {
  const session = await Session.createNext({ directory: process.cwd(), title: "Legacy string control" })
  await SessionPrompt.command({
    sessionID: session.id,
    command: "argumentprobe",
    arguments: data.arguments,
    model: "fixture/fixture",
  })
  console.log(JSON.stringify({ completed: true, sessionID: session.id }))
})
await Shutdown.flush()
