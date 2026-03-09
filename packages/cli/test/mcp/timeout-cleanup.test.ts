import { describe, test, expect, mock, beforeEach } from "bun:test"

// Track close() calls per transport type
const closeCalls: Array<{ type: "stdio" | "streamable" | "sse" }> = []

// Mock StdioClientTransport to track close() and expose a fake pid
// start() hangs forever to simulate an unreachable local server
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdio {
    stderr = null
    get pid() {
      return 99999 // fake PID (no real process)
    }
    async start() {
      // Hang forever -- simulates a local MCP server that never responds
      return new Promise<void>(() => {})
    }
    async close() {
      closeCalls.push({ type: "stdio" })
    }
  },
}))

// Mock StreamableHTTPClientTransport to track close()
// start() hangs forever to simulate an unreachable remote server
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(_url: URL, _options?: unknown) {}
    async start() {
      return new Promise<void>(() => {})
    }
    async close() {
      closeCalls.push({ type: "streamable" })
    }
  },
}))

// Mock SSEClientTransport to track close()
// start() hangs forever to simulate an unreachable remote server
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(_url: URL, _options?: unknown) {}
    async start() {
      return new Promise<void>(() => {})
    }
    async close() {
      closeCalls.push({ type: "sse" })
    }
  },
}))

// Mock Client to delegate connect() to transport.start()
// This matches the real Client behavior: connect() calls transport.start()
// The hang happens in the transport, not in Client -- so other test files
// that provide their own transport mocks (with start() that throws) work correctly.
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
    setNotificationHandler() {}
    async listTools() {
      return { tools: [] }
    }
  },
}))

// Mock UnauthorizedError so instanceof checks work
class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}
mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

beforeEach(() => {
  closeCalls.length = 0
})

// Import after mocking
const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

describe("MCP timeout transport cleanup", () => {
  test("timed-out local MCP connection closes transport", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Use MCP.add() with a very short timeout to trigger withTimeout rejection
        const result = await MCP.add("test-local-timeout", {
          type: "local",
          command: ["fake-mcp-server"],
          timeout: 100, // 100ms -- will trigger timeout since transport.start() hangs
        }).catch((e) => ({ status: { status: "failed" as const, error: String(e) } }))

        // Verify transport.close() was called during cleanup
        const stdioClosed = closeCalls.some((c) => c.type === "stdio")
        expect(stdioClosed).toBe(true)

        // Verify status is failed
        const statusRecord = result.status as Record<string, { status: string; error?: string }>
        const serverStatus = statusRecord["test-local-timeout"] ?? result.status
        expect(serverStatus.status).toBe("failed")
      },
    })
  })

  test("startAuth times out on unreachable server and closes transport", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/aictrl.json`,
          JSON.stringify({
            $schema: "https://aictrl.ai/config.json",
            mcp: {
              "test-remote-timeout": {
                type: "remote",
                url: "https://unreachable.example.com/mcp",
                timeout: 100, // 100ms -- will trigger timeout
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // startAuth should reject with a timeout error
        let threw = false
        try {
          await MCP.startAuth("test-remote-timeout")
        } catch (error) {
          threw = true
          expect(error).toBeInstanceOf(Error)
          // The error message should indicate a timeout (from withTimeout)
          expect((error as Error).message).toContain("Operation timed out")
        }
        expect(threw).toBe(true)

        // Verify transport.close() was called during cleanup
        const streamableClosed = closeCalls.some((c) => c.type === "streamable")
        expect(streamableClosed).toBe(true)
      },
    })
  })
})
