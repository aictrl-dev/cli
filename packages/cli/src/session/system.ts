import { Instance } from "../project/instance"

import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_CODEX from "./prompt/codex_header.txt"
import type { Provider } from "@/provider/provider"
import { ToolGuidance } from "../tool/guidance"

export namespace SystemPrompt {
  export function instructions(tools?: ReadonlySet<string>) {
    const patch =
      "- Try to use apply_patch for single file edits, but it is fine to explore other options to make the edit if it does not work well. Do not use apply_patch for changes that are auto-generated (i.e. generating package.json or running a lint or format command like gofmt) or when scripting is more efficient (such as search and replacing a string across a codebase).\n"
    const files = "  - Use Read to view files, Edit to modify files, and Write only when needed.\n"
    const search = "  - Use Glob to find files by name and Grep to search file contents.\n"
    const bash = "- Use Bash for terminal operations (git, bun, builds, tests, running scripts).\n"
    const specialized = "- Prefer specialized tools over shell for file operations:\n"
    const available = (name: string) => tools?.has(name) ?? true
    const operations = [
      ...(available("read") ? ["Read to view files"] : []),
      ...(available("edit") ? ["Edit to modify files"] : []),
      ...(available("write") ? ["Write only when needed"] : []),
    ]
    const searches = [
      ...(available("glob") ? ["Glob to find files by name"] : []),
      ...(available("grep") ? ["Grep to search file contents"] : []),
    ]
    const prompt = ToolGuidance.replace(PROMPT_CODEX.trim(), patch, available("apply_patch") ? patch : "")
    const editing = ToolGuidance.replace(
      prompt,
      files,
      operations.length === 3 ? files : operations.length ? `  - Use ${operations.join("; ")}.\n` : "",
    )
    const searching = ToolGuidance.replace(
      editing,
      search,
      searches.length === 2 ? search : searches.length ? `  - Use ${searches[0]}.\n` : "",
    )
    return ToolGuidance.replace(
      ToolGuidance.replace(searching, bash, available("bash") ? bash : ""),
      specialized,
      operations.length || searches.length ? specialized : "",
    )
  }

  /** The base system prompt, shared by every provider and model family. */
  export function base(tools?: ReadonlySet<string>) {
    const task = "- Use the Task tool when a search is broad and open-ended, or when asked to delegate.\n"
    const bash =
      "- When you have finished, run the lint and typecheck commands (for example npm run lint, npm run typecheck, ruff) with bash if they were provided to you.\n"
    return ToolGuidance.replace(
      ToolGuidance.replace(PROMPT_DEFAULT.trim(), task, tools && !tools.has("task") ? "" : task),
      bash,
      tools && !tools.has("bash")
        ? "- When you have finished, verify your changes using the available capabilities. Report any provided lint or typecheck commands you could not run.\n"
        : bash,
    )
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
      ].join("\n"),
    ]
  }
}
