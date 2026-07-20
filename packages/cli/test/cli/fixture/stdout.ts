import { Stdout } from "../../../src/cli/stdout"
import { Shutdown } from "../../../src/cli/shutdown"

if (process.argv.includes("--idle")) process.exit(process.stdout.listenerCount("error"))
if (process.argv.includes("--shutdown-error")) {
  Stdout.write("")
  await Stdout.flush()
  process.stdout.emit("error", Object.assign(new Error("broken stdout"), { code: "EIO" }))
  await Shutdown.flush()
  const status = process.argv.find((arg) => arg.startsWith("--status="))?.slice("--status=".length)
  if (status) await Bun.write(status, String(process.exitCode))
  process.exit()
}
if (process.argv.includes("--error")) {
  Stdout.write("")
  await Stdout.flush()
  process.stdout.emit("error", Object.assign(new Error("broken stdout"), { code: "EIO" }))
  const write = await Stdout.write("").then(
    () => false,
    (error) => error instanceof Error && error.message === "broken stdout",
  )
  const flush = await Stdout.flush().then(
    () => false,
    (error) => error instanceof Error && error.message === "broken stdout",
  )
  process.exit(write && flush ? 0 : 2)
}

const records = Array.from({ length: 1024 }, (_, index) =>
  JSON.stringify({
    type: "data",
    index,
    value: "x".repeat(2048),
  }),
)

Array.from({ length: process.argv.includes("--epipe") ? 8 : 1 }).forEach(() =>
  records.forEach((record) => Stdout.write(record + "\n")),
)
Stdout.write(JSON.stringify({ type: "complete" }) + "\n")
await Stdout.flush()
if (process.argv.includes("--epipe")) {
  const status = process.argv.find((arg) => arg.startsWith("--status="))?.slice("--status=".length)
  if (status) await Bun.write(status, Stdout.isClosed() ? "closed" : "open")
  process.exit(Stdout.isClosed() ? 0 : 2)
}
process.exit()
