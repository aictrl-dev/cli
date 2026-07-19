const state = {
  closed: false,
  queue: Promise.resolve(),
}

function pipe(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EPIPE"
}

function output(chunk: string, flush = false) {
  if (state.closed || process.stdout.destroyed || process.stdout.writableEnded) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const drain = () => resolve()
    const wait = { ready: true, done: false }
    wait.ready = process.stdout.write(chunk, (error) => {
      wait.done = true
      if (error) state.closed = true
      if (!wait.ready) process.stdout.off("drain", drain)
      resolve()
    })
    if (!wait.ready && !wait.done && !flush) process.stdout.once("drain", drain)
  })
}

process.stdout.on("error", (error) => {
  if (pipe(error)) {
    state.closed = true
    return
  }
  throw error
})

export namespace Stdout {
  export function write(chunk: string) {
    state.queue = state.queue.then(() => output(chunk))
    return state.queue
  }

  export async function flush() {
    await state.queue
    await output("", true)
  }
}
