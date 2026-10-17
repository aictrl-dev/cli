// `--deadline` is an absolute instant (#138). ISO-8601 values must carry a time and an
// explicit offset, so the caller's and the runner's local time zones cannot disagree.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

export function parseDeadline(value: unknown, now = Date.now()) {
  if (value === undefined) return
  const instant = parse(value)
  if (instant === undefined)
    throw new Error(
      "--deadline must be an ISO-8601 date-time with an offset (e.g. 2026-10-17T12:00:00Z) or epoch milliseconds",
    )
  if (instant <= now) throw new Error("--deadline must be in the future")
  return instant
}

function parse(value: unknown) {
  if (typeof value !== "string") return
  if (/^\d+$/.test(value)) return Number.isSafeInteger(Number(value)) ? Number(value) : undefined
  if (!ISO.test(value)) return
  // Date.parse rolls an impossible day (2026-02-30) into the next month.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number)
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return
  const instant = Date.parse(value)
  return Number.isNaN(instant) ? undefined : instant
}
