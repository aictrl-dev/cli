/** Normalize parser-owned message operands before titling or reading stdin. */
export function runInput(operands: readonly string[], tty: boolean | undefined) {
  const words = operands.filter((word) => word !== "-")
  return {
    argv: words,
    prompt: words.join(" "),
    message: words.join(" "),
    // An explicit empty operand is still a supplied message; do not wait for stdin.
    stdin: operands.includes("-") || (operands.length === 0 && !tty),
  }
}
