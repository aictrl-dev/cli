import z from "zod"

/** Work-tool selection is independent of permission rules and protocol tools. */
export namespace ToolSelection {
  export const Names = z
    .array(
      z
        .string()
        .min(1)
        .refine((name) => name.trim() === name, "Tool names must not contain surrounding whitespace"),
    )
    .transform((names) => [...new Set(names)])
  export const Snapshot = z.object({ version: z.literal(1), allowlist: Names.nullable() }).strict()
  export type Snapshot = z.infer<typeof Snapshot>

  export function parse(value: string) {
    return Names.parse(value === "" ? [] : value.split(","))
  }

  export function resolve(preference: string[] | undefined, ceiling?: readonly string[], explicit = true): Snapshot {
    const names = preference === undefined ? undefined : Names.parse(preference)
    if (explicit && ceiling && names?.some((name) => !ceiling.includes(name))) {
      throw new Error(
        `Tool selection cannot widen the parent invocation: ${names.filter((name) => !ceiling.includes(name)).join(", ")}`,
      )
    }
    return {
      version: 1,
      allowlist: ceiling ? [...ceiling].filter((name) => !names || names.includes(name)) : (names ?? null),
    }
  }

  export function restore(value?: Snapshot): Snapshot {
    return value === undefined ? { version: 1, allowlist: null } : Snapshot.parse(value)
  }

  export function validate(
    names: readonly string[] | null,
    eligible: readonly string[],
    known: readonly string[],
    controls: readonly string[] = [],
  ) {
    for (const name of names ?? []) {
      if (eligible.includes(name) && !controls.includes(name)) continue
      const reason = controls.includes(name)
        ? "is a protocol/control tool, not a selectable work tool"
        : known.includes(name)
          ? "is unavailable for the current model or enabled tools"
          : "is unknown or unavailable in the current tool catalog"
      throw new Error(
        `Tool '${name}' ${reason}. Available work tools: ${eligible.filter((id) => !controls.includes(id)).join(", ") || "(none)"}`,
      )
    }
  }
}
