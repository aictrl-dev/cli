import { EOL } from "os"

const state = {
  bound: false,
  closed: false,
  pending: new Set<Promise<void>>(),
}
let failure: unknown

function epipe(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EPIPE"
}

function fail(error: unknown) {
  if (epipe(error)) {
    state.closed = true
    return false
  }
  failure = error
  return true
}

function bind() {
  if (state.bound) return
  state.bound = true
  process.stdout.on("error", fail)
}

export namespace Stdout {
  export function write(chunk: string) {
    bind()
    if (failure !== undefined) {
      const pending = Promise.reject(failure)
      pending.catch(() => {})
      return pending
    }
    if (state.closed || process.stdout.destroyed || process.stdout.writableEnded) return Promise.resolve()
    const pending = new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (error) => {
        if (error && fail(error)) {
          reject(error)
          return
        }
        resolve()
      })
    })
    state.pending.add(pending)
    pending.catch(() => {})
    pending.then(
      () => state.pending.delete(pending),
      () => state.pending.delete(pending),
    )
    return pending
  }

  export async function flush() {
    while (state.pending.size) await Promise.allSettled(state.pending)
    if (failure !== undefined) throw failure
  }

  export function json(data: Record<string, unknown>) {
    return write(JSON.stringify(data) + EOL)
  }

  export function isClosed() {
    return state.closed
  }
}
