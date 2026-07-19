import { Stdout } from "../../../src/cli/stdout"

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
process.exit()
