import z from "zod"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language } from "web-tree-sitter"

import { $ } from "bun"
import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"

export const MAX_OUTPUT_BUFFER = 2 * 1024 * 1024 // 2MB, matching PTY module precedent
const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.AICTRL_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const bashLanguage = await Language.load(bashPath)
  const p = new Parser()
  p.setLanguage(bashLanguage)
  return p
})

const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])

const TOKEN_TYPES = new Set(["command_name", "word", "string", "raw_string", "concatenation"])

/** Extract token text from a command node, filtering to known token types. */
function getCommandTokens(node: { childCount: number; child(i: number): { type: string; text: string } | null }): string[] {
  const tokens: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (TOKEN_TYPES.has(child.type)) tokens.push(child.text)
  }
  return tokens
}

function isShellInterpreter(commandName: string): boolean {
  // Handle both bare names and full paths (e.g., /bin/bash, /usr/bin/env bash)
  const base = commandName.split("/").pop() || ""
  return SHELL_INTERPRETERS.has(base)
}

async function extractEmbeddedCommands(
  shellContent: string,
  parserInstance: Awaited<ReturnType<typeof parser>>,
): Promise<string[]> {
  const embeddedTree = parserInstance.parse(shellContent)
  if (!embeddedTree) return []
  const commands: string[] = []
  for (const node of embeddedTree.rootNode.descendantsOfType("command")) {
    if (!node) continue
    const commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text
    commands.push(commandText)
  }
  return commands
}

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const p = await parser()
      const tree = p.parse(params.command)
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!(await Instance.containsPath(cwd))) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue

        // Get full command text including redirects if present
        let commandText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text

        const command = getCommandTokens(node)

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(command[0])) {
          for (const arg of command.slice(1)) {
            if (arg.startsWith("-") || (command[0] === "chmod" && arg.startsWith("+"))) continue
            const resolved = await $`realpath ${arg}`
              .cwd(cwd)
              .quiet()
              .nothrow()
              .text()
              .then((x) => x.trim())
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              const normalized =
                process.platform === "win32" ? Filesystem.windowsPath(resolved).replace(/\//g, "\\") : resolved
              if (!(await Instance.containsPath(normalized))) {
                const dir = (await Filesystem.isDir(normalized)) ? normalized : path.dirname(normalized)
                directories.add(dir)
              }
            }
          }
        }

        // cd covered by above check
        if (command.length && command[0] !== "cd") {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      // Detect shell interpreter bypass patterns:
      // Pattern 1: heredoc to interpreter (bash << EOF\nrm -rf /\nEOF)
      // Pattern 2: string arg to interpreter (bash -c 'rm -rf /', eval "rm -rf /")
      for (const node of tree.rootNode.descendantsOfType("command")) {
        if (!node) continue

        const tokens = getCommandTokens(node)
        if (tokens.length === 0) continue

        const commandName = tokens[0]
        const isInterpreter = isShellInterpreter(commandName) || commandName === "eval"

        if (!isInterpreter) continue

        // Pattern 1: Heredoc to interpreter
        if (node.parent?.type === "redirected_statement") {
          for (let i = 0; i < node.parent.childCount; i++) {
            const sibling = node.parent.child(i)
            if (sibling?.type === "heredoc_redirect") {
              // heredoc_body is a child of heredoc_redirect
              for (let j = 0; j < sibling.childCount; j++) {
                const bodyNode = sibling.child(j)
                if (bodyNode?.type === "heredoc_body") {
                  const heredocContent = bodyNode.text
                  // Remove trailing newline that precedes the delimiter
                  const lines = heredocContent.split("\n")
                  const content = lines.slice(0, -1).join("\n")
                  if (content.trim()) {
                    const embeddedCommands = await extractEmbeddedCommands(content, p)
                    for (const cmd of embeddedCommands) {
                      patterns.add(cmd)
                    }
                  }
                }
              }
            }
          }
        }

        // Pattern 2: String argument to interpreter (bash -c 'cmd', eval "cmd")
        // Handles: bash -c 'cmd', bash -c'cmd', bash -xc 'cmd', bash -c"cmd"
        for (let i = 1; i < tokens.length; i++) {
          const token = tokens[i]

          if (commandName === "eval") {
            if (token.startsWith("-")) continue
            const unquoted = token.replace(/^['"]|['"]$/g, "")
            if (unquoted.trim()) {
              const embeddedCommands = await extractEmbeddedCommands(unquoted, p)
              for (const cmd of embeddedCommands) {
                patterns.add(cmd)
              }
            }
          } else {
            // Determine if this token contains or is the -c flag
            // Case 1: exact "-c" — next token is the command
            // Case 2: "-c'cmd'" or '-c"cmd"' — command embedded after -c (concatenation token)
            // Case 3: "-xc" — combined short flags ending with c, next token is the command
            if (token === "-c") {
              if (i + 1 < tokens.length) {
                const cmdString = tokens[i + 1]
                const unquoted = cmdString.replace(/^['"]|['"]$/g, "")
                if (unquoted.trim()) {
                  const embeddedCommands = await extractEmbeddedCommands(unquoted, p)
                  for (const cmd of embeddedCommands) {
                    patterns.add(cmd)
                  }
                }
              }
              break
            } else if (token.startsWith("-c") && token.length > 2) {
              // -c'cmd', -c"cmd", -ccmd — extract command after the -c prefix
              const embedded = token.slice(2).replace(/^['"]|['"]$/g, "")
              if (embedded.trim()) {
                const embeddedCommands = await extractEmbeddedCommands(embedded, p)
                for (const cmd of embeddedCommands) {
                  patterns.add(cmd)
                }
              }
              break
            } else if (/^-[a-zA-Z]*c$/.test(token) && i + 1 < tokens.length) {
              // Combined flags like -xc, -exc — c is last, next token is the command
              const cmdString = tokens[i + 1]
              const unquoted = cmdString.replace(/^['"]|['"]$/g, "")
              if (unquoted.trim()) {
                const embeddedCommands = await extractEmbeddedCommands(unquoted, p)
                for (const cmd of embeddedCommands) {
                  patterns.add(cmd)
                }
              }
              break
            } else if (token.startsWith("-")) {
              // Other flags like -x, -e — skip
              continue
            }
          }
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          // Preserve POSIX-looking paths with /s, even on Windows
          if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const shellEnv = await Plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const proc = spawn(params.command, {
        shell,
        cwd,
        env: {
          ...process.env,
          ...shellEnv.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })

      let output = ""
      let truncatedBytes = 0

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()

        // Cap buffer to prevent OOM on unbounded output
        if (output.length > MAX_OUTPUT_BUFFER) {
          const excess = output.length - MAX_OUTPUT_BUFFER
          output = output.slice(excess)
          truncatedBytes += excess
        }

        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      if (truncatedBytes > 0) {
        output = `\n[...${truncatedBytes} bytes truncated from beginning — buffer capped at ${MAX_OUTPUT_BUFFER} bytes...]\n\n` + output
      }

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
