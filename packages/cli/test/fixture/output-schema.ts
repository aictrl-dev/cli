import fs from "fs"
import path from "path"

export const schema = {
  type: "object",
  properties: {
    result: { type: "string" },
    nested: {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    },
  },
  required: ["result"],
  additionalProperties: false,
}

export const corpus = [
  {},
  { result: 42 },
  { result: "valid", nested: { count: "42" } },
  { result: "valid", extra: "must remain" },
  { result: "valid", nested: { count: 3, extra: true } },
  { result: "valid", nested: null },
  { result: "valid", nested: { count: 1.5 } },
  { result: "valid" },
  { result: "valid", nested: { count: 42 } },
  null,
  [],
  "value",
]

// StructuredOutput takes the path of a result file (#140): fixture providers write the
// result text to a file in the run directory and call the tool with its path.
export function pathArgs(directory: string, args: string, name: string) {
  fs.writeFileSync(path.join(directory, name), args)
  return JSON.stringify({ path: name })
}
