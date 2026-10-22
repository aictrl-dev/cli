import { expect, test } from "bun:test"
import { MARKER, Stub } from "./token-stub"

for (const api of ["chat", "responses"] as const) {
  const body = (main: boolean) => ({
    model: "fixture",
    ...(api === "chat"
      ? {
          messages: [
            { role: "user", content: main ? `${MARKER} short` : "Generate a title" },
            { role: "tool", tool_call_id: "foreign_history_id", content: "Earlier unrelated result" },
          ],
          tools: main
            ? [
                {
                  type: "function",
                  function: {
                    name: "read",
                    parameters: {
                      type: "object",
                      properties: { filePath: { type: "string" } },
                      required: ["filePath"],
                    },
                  },
                },
              ]
            : [],
        }
      : {
          input: [
            { role: "user", content: main ? `${MARKER} short` : "Generate a title" },
            { type: "function_call_output", call_id: "foreign_history_id", output: "Earlier unrelated result" },
          ],
          tools: main
            ? [
                {
                  type: "function",
                  name: "read",
                  parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
                },
              ]
            : [],
        }),
  })

  test(`${api}: auxiliary foreign history does not advance or reject the main script`, async () => {
    const stub = new Stub(0)
    stub.reset("short")
    try {
      const response = await fetch(
        new URL(api === "chat" ? "/v1/chat/completions" : "/v1/responses", stub.server.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body(false)),
        },
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Bench title")
      expect(stub.log).toHaveLength(1)
      expect(stub.log[0]).toMatchObject({ kind: "aux", step: 0 })
      expect(stub.log[0].toolResults?.[0]?.callId).toBe("foreign_history_id")
      expect(stub.log.some((row) => row.error)).toBe(false)
    } finally {
      await stub.server.stop(true)
    }
  })

  test(`${api}: main foreign history still fails explicit scripted-ID validation`, async () => {
    const stub = new Stub(0)
    stub.reset("short")
    try {
      const response = await fetch(
        new URL(api === "chat" ? "/v1/chat/completions" : "/v1/responses", stub.server.url),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body(true)),
        },
      )
      expect(response.status).toBe(400)
      expect(await response.text()).toContain("Tool results lost all scripted call IDs")
      expect(stub.log.some((row) => row.error?.includes("Tool results lost all scripted call IDs"))).toBe(true)
      expect(stub.log.some((row) => row.kind === "main")).toBe(false)
    } finally {
      await stub.server.stop(true)
    }
  })
}
