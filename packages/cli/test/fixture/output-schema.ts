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
