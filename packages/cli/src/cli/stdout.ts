const state = {
  bound: false,
  closed: false,
  error: undefined as unknown,
  pending: new Set<Promise<void>>(),
}

function epipe(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EPIPE"
}

function fail(error: unknown) {
  if (epipe(error)) {
    state.closed = true
    return
  }
  state.error = error
}

function bind() {
  if (state.bound) return
  state.bound = true
  process.stdout.on("error", fail)
}

export namespace Stdout {
  export function write(chunk: string) {
    bind()
    if (state.closed || process.stdout.destroyed || process.stdout.writableEnded) return Promise.resolve()
    const pending = new Promise<void>((resolve) => {
      process.stdout.write(chunk, (error) => {
        if (error) fail(error)
        resolve()
      })
    })
    state.pending.add(pending)
    pending.then(() => state.pending.delete(pending))
    return pending
  }

  export async function flush() {
    while (state.pending.size) await Promise.all(state.pending)
    if (state.error) throw state.error
  }

  export function closed() {
    return state.closed
  }
}
