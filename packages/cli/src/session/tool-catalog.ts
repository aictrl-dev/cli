import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { ToolSelection } from "../tool/selection"
import { PermissionNext } from "../permission/next"
import type { Agent } from "../agent/agent"
import type { Provider } from "../provider/provider"

/** A resolved invocation catalog preserves actual registry/MCP collision identity. */
export namespace ToolCatalog {
  type Registered = Awaited<ReturnType<typeof ToolRegistry.tools>>[number]
  type External = Awaited<ReturnType<typeof MCP.tools>>[string]
  export type Entry = { kind: "registry"; item: Registered } | { kind: "mcp"; item: External }
  export type Info = { entries: Map<string, Entry>; known: string[] }

  export async function load(agent: Agent.Info, model: Provider.Model, sessionID: string): Promise<Info> {
    const entries = new Map<string, Entry>()
    for (const item of await ToolRegistry.tools(
      { modelID: model.api.id, providerID: model.providerID },
      agent,
      sessionID,
    ))
      entries.set(item.id, { kind: "registry", item })
    for (const [name, item] of Object.entries(await MCP.tools())) {
      if (item.execute) entries.set(name, { kind: "mcp", item })
    }
    return { entries, known: [...new Set([...(await ToolRegistry.ids()), ...entries.keys()])] }
  }

  export function work(entry: Entry) {
    return entry.kind !== "registry" || entry.item.builtin !== "invalid"
  }

  export function controls(catalog: Info) {
    return [...catalog.entries].flatMap(([name, entry]) => (work(entry) ? [] : [name]))
  }

  export function names(
    catalog: Info,
    snapshot: ToolSelection.Snapshot,
    permission: PermissionNext.Ruleset,
    legacy?: Record<string, boolean>,
    controls: readonly string[] = [],
  ) {
    const disabled = PermissionNext.disabled([...catalog.entries.keys()], permission)
    return Object.freeze(
      [...catalog.entries.keys()].filter(
        (name) =>
          work(catalog.entries.get(name)!) &&
          !controls.includes(name) &&
          !disabled.has(name) &&
          legacy?.[name] !== false &&
          (snapshot.allowlist === null || snapshot.allowlist.includes(name)),
      ),
    )
  }
}
