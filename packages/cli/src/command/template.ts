import { $ } from "bun"
import { ConfigMarkdown } from "../config/markdown"

/** Render caller data once; only shell spans in the original command template execute. */
export async function renderCommandTemplate(template: string, text: string, argv: readonly string[]) {
  const placeholders = [...template.matchAll(/\$(\d+)/g)]
  const last = placeholders.reduce((maximum, match) => Math.max(maximum, Number(match[1])), 0)
  const numbered = (index: string) => {
    const position = Number(index)
    const offset = position - 1
    if (offset >= argv.length) return ""
    if (position === last) return argv.slice(offset).join(" ")
    return String(argv[offset])
  }
  const prose = (source: string) =>
    source.replaceAll(/\$(ARGUMENTS|\d+)/g, (_, index) => (index === "ARGUMENTS" ? text : numbered(index)))

  // Capture structure before inserting argv, stdin, fallback text or shell output.
  const spans = ConfigMarkdown.shell(template)
  const segments: string[] = []
  const scripts: { strings: TemplateStringsArray; values: (string | string[])[] }[] = []
  let cursor = 0
  for (const span of spans) {
    segments.push(prose(template.slice(cursor, span.index)))
    cursor = span.index + span[0].length
    const fragments: string[] = []
    const values: (string | string[])[] = []
    let start = 0
    for (const match of span[1].matchAll(/\$(ARGUMENTS|\d+)/g)) {
      fragments.push(span[1].slice(start, match.index))
      values.push(match[1] === "ARGUMENTS" ? [...argv] : numbered(match[1]))
      start = match.index + match[0].length
    }
    fragments.push(span[1].slice(start))
    const strings: TemplateStringsArray = Object.freeze(
      Object.assign(fragments, { raw: Object.freeze([...fragments]) }),
    )
    scripts.push({ strings, values })
  }
  segments.push(prose(template.slice(cursor)))

  const results = await Promise.all(
    scripts.map(async (script) => {
      try {
        return await $(script.strings, ...script.values)
          .quiet()
          .nothrow()
          .text()
      } catch (error) {
        return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
      }
    }),
  )
  const rendered = segments.map((segment, index) => segment + (index < results.length ? results[index] : "")).join("")
  const fallback = placeholders.length === 0 && !template.includes("$ARGUMENTS") && text.trim() ? "\n\n" + text : ""
  return (rendered + fallback).trim()
}
