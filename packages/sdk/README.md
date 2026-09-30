# @aictrl/sdk

Official SDK for the Aictrl Headless AI Engine.

## Installation

```bash
npm install @aictrl/sdk
```

## Quick Start

### Initialize Client

```typescript
import { createAictrlClient } from "@aictrl/sdk"

const client = createAictrlClient({
  baseUrl: "http://localhost:4096", // Port used by aictrl server
})
```

### Create a Session

```typescript
const session = await client.session.create({
  title: "My Task",
})
```

### Run a Prompt

```typescript
const response = await client.session.prompt({
  sessionID: session.data.id,
  parts: [{ type: "text", text: "Summarize this codebase" }],
})
```

### Subscribe to Events

```typescript
const events = await client.event.subscribe()

for await (const event of events.stream) {
  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.type === "text") {
      process.stdout.write(part.text)
    }
  }
}
```

## Features

- **Typed API:** Full TypeScript support for sessions, tools, and events.
- **Event Streaming:** Real-time feedback via an event stream.
- **MCP Integration:** Manage MCP servers programmatically.
- **V2 API:** Includes the new V2 API for more granular control.

## Documentation

### Regenerating event types

Run `bun run packages/sdk/script/build.ts` from the repository root. The build
runs the CLI `generate` command, which publishes the `StepFinishPart` and
`ProviderTermination` components from the runtime Zod schemas, then generates
`src/v2/gen/types.gen.ts`. Those types are exported from `@aictrl/sdk/v2`.

The legacy SDK still uses the historical files in `src/gen`. The build maintains
a `StepFinishPart` type alias there to the canonical generated v2 type, so its
event unions inherit the same additive termination fields. Edit the runtime
schemas and rebuild; do not hand-edit either generated declaration. The temporary
`openapi.json` is deleted after a successful build; the repository does not use
a checked-in `docs/architecture/openapi.yaml` contract.

For more information, visit [aictrl.ai](https://aictrl.ai).
