import type { Tool } from "ai"

export namespace ToolGuidance {
  const builtin = Symbol("builtin")
  const renderer = Symbol("description.renderer")

  export type Renderer = (description: string, tools: ReadonlySet<string>) => string
  type Owned = Tool & { [builtin]?: string; [renderer]?: Renderer }

  export function bind(tool: Tool, id?: string, render?: Renderer): Tool {
    if (!id) return tool
    return { ...tool, [builtin]: id, [renderer]: render } as Owned
  }

  export function capabilities(tools: Record<string, Tool>) {
    return new Set(
      Object.entries(tools).flatMap(([id, tool]) => (id !== "invalid" && (tool as Owned)[builtin] === id ? [id] : [])),
    )
  }

  export function render(tools: Record<string, Tool>, names: ReadonlySet<string>): Record<string, Tool> {
    return Object.fromEntries(
      Object.entries(tools).map(([id, tool]) => {
        const render = (tool as Owned)[renderer]
        if (!render) return [id, tool]
        if (tool.description === undefined) throw new Error(`Built-in tool ${id} has no description`)
        return [id, { ...tool, description: render(tool.description, names) }]
      }),
    )
  }

  export function replace(description: string, fragment: string, replacement: string) {
    const index = description.indexOf(fragment)
    if (index === -1 || index !== description.lastIndexOf(fragment)) {
      throw new Error("Harness guidance fragment is missing or duplicated")
    }
    return description.replace(fragment, () => replacement)
  }

  export function bash(description: string, tools: ReadonlySet<string>) {
    const files = [
      ["glob", "Glob (not find/ls)"],
      ["grep", "Grep (not grep/rg)"],
      ["read", "Read (not cat/head/tail)"],
      ["edit", "Edit (not sed/awk/perl)"],
      ["write", "Write (not echo/heredoc redirection)"],
    ]
    const selected = files.filter(([id]) => tools.has(id)).map(([, text]) => text)
    const dedicated = `Do not use it for file operations; use the dedicated tools instead: ${files.map(([, text]) => text).join(", ")}.\n\n`
    const output =
      "; read it with Read (offset/limit) or search it with Grep. So do not limit output with `head`, `tail` or other truncation commands; run the command directly."
    const readers = [
      ...(tools.has("read") ? ["read it with Read (offset/limit)"] : []),
      ...(tools.has("grep") ? ["search it with Grep"] : []),
    ]
    return replace(
      replace(
        description,
        dedicated,
        selected.length === files.length
          ? dedicated
          : selected.length
            ? `Use the available dedicated tools for their supported file operations: ${selected.join(", ")}.\n\n`
            : "",
      ),
      output,
      readers.length === 2
        ? output
        : readers.length
          ? `; ${readers.join(" or ")}. So do not limit output with \`head\`, \`tail\` or other truncation commands; run the command directly.`
          : ".",
    )
  }

  export function read(description: string, tools: ReadonlySet<string>) {
    const grep = "- Use the grep tool to find specific content in large files or files with long lines.\n"
    const glob =
      "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n"
    return replace(replace(description, grep, tools.has("grep") ? grep : ""), glob, tools.has("glob") ? glob : "")
  }

  export function glob(description: string, tools: ReadonlySet<string>) {
    const task =
      "- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n"
    return replace(description, task, tools.has("task") ? task : "")
  }

  export function grep(description: string, tools: ReadonlySet<string>) {
    const bash =
      "- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.\n"
    return glob(replace(description, bash, tools.has("bash") ? bash : ""), tools)
  }

  export function edit(description: string, tools: ReadonlySet<string>) {
    const read =
      "- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n"
    const output = "When editing text from Read tool output"
    return replace(
      replace(
        description,
        read,
        tools.has("read")
          ? read
          : "- For a nonempty `oldString`, the file's current contents must already be recorded as read in this session. This tool fails if that record is missing or stale. An empty `oldString` uses the direct-write path without this prerequisite.\n",
      ),
      output,
      tools.has("read") ? output : "When editing text from numbered file output",
    )
  }

  export function write(description: string, tools: ReadonlySet<string>) {
    const read =
      "- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n"
    return replace(
      description,
      read,
      tools.has("read")
        ? read
        : "- Replacing an existing file requires its current contents to already be recorded as read in this session. This tool fails if that record is missing or stale; creating a new file does not need that record.\n",
    )
  }

  export function explore(description: string, tools: ReadonlySet<string>) {
    const lines = [
      ["glob", "- Use Glob for broad file pattern matching\n"],
      ["grep", "- Use Grep for searching file contents with regex\n"],
      ["read", "- Use Read when you know the specific file path you need to read\n"],
      ["bash", "- Use Bash for file operations like copying, moving, or listing directory contents\n"],
    ] as const
    return lines.reduce((text, [id, line]) => replace(text, line, tools.has(id) ? line : ""), description)
  }

  export function batch(description: string, tools: ReadonlySet<string>) {
    const example =
      'Payload Format (JSON array):\n[{"tool": "read", "parameters": {"filePath": "src/index.ts", "limit": 350}},{"tool": "grep", "parameters": {"pattern": "Session\\\\.updatePart", "include": "src/**/*.ts"}},{"tool": "bash", "parameters": {"command": "git status", "description": "Shows working tree status"}}]'
    const search = ["grep", "glob", "read"].filter((id) => tools.has(id))
    const cases = [
      ["- Read many files\n", tools.has("read") ? "- Read many files\n" : ""],
      ["- grep + glob + read combos\n", search.length >= 2 ? `- ${search.join(" + ")} combos\n` : ""],
      ["- Multiple bash commands\n", tools.has("bash") ? "- Multiple bash commands\n" : ""],
      [
        "- Multi-part edits; on the same, or different files\n",
        ["edit", "write"].some((id) => tools.has(id)) ? "- Multi-part edits; on the same, or different files\n" : "",
      ],
    ] as const
    const rendered = cases.reduce((text, [line, replacement]) => replace(text, line, replacement), description)
    return replace(
      replace(rendered, "Good Use Cases:\n", cases.some(([, replacement]) => replacement) ? "Good Use Cases:\n" : ""),
      example,
      ["read", "grep", "bash"].every((id) => tools.has(id))
        ? example
        : "Supply independent calls to tools available in this request through the `tool_calls` array. Each item has `tool` and `parameters` fields.",
    )
  }
}
