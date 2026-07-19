import { Stdout } from "../../../src/cli/stdout"

if (process.argv.includes("--idle")) process.exit(process.stdout.listenerCount("error"))
if (process.argv.includes("--error")) {
  Stdout.write("")
  await Stdout.flush()
  process.stdout.emit("error", Object.assign(new Error("broken stdout"), { code: "EIO" }))
  await Stdout.flush().then(
    () => process.exit(2),
    (error) => process.exit(error instanceof Error && error.message === "broken stdout" ? 0 : 3),
  )
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
if (process.argv.includes("--epipe")) process.exit(Stdout.closed() ? 0 : 2)
process.exit()
