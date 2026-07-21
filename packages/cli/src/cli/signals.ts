export namespace Signals {
  export type Info = {
    name: "SIGINT" | "SIGTERM"
    reason: "interrupted" | "terminated"
    code: 130 | 143
    message: string
  }
}

const info = {
  SIGINT: {
    name: "SIGINT",
    reason: "interrupted",
    code: 130,
    message: "Session interrupted by SIGINT",
  },
  SIGTERM: {
    name: "SIGTERM",
    reason: "terminated",
    code: 143,
    message: "Session terminated by SIGTERM",
  },
} as const satisfies Record<Signals.Info["name"], Signals.Info>

export function attempt(run: () => unknown, fail: () => void) {
  Promise.resolve().then(run).catch(fail)
}

export function signals(stop: (info: Signals.Info) => void, grace = 5_000, expire?: (info: Signals.Info) => unknown) {
  const state: {
    current?: Signals.Info
    timer?: ReturnType<typeof setTimeout>
    hard?: ReturnType<typeof setTimeout>
    resolve?: (info: Signals.Info) => void
  } = {}
  const received = new Promise<Signals.Info>((resolve) => {
    state.resolve = resolve
  })

  function handle(name: Signals.Info["name"]) {
    const signal = info[name]
    if (state.current) {
      process.exit(state.current.code)
    }
    state.current = signal
    process.exitCode = signal.code
    state.timer = setTimeout(() => {
      state.hard = setTimeout(() => process.exit(signal.code), 250)
      Promise.resolve()
        .then(() => expire?.(signal))
        .then(
          () => {
            if (state.hard) clearTimeout(state.hard)
            process.exit(signal.code)
          },
          () => process.exit(signal.code),
        )
    }, grace)
    stop(signal)
    state.resolve?.(signal)
  }

  const sigint = () => handle("SIGINT")
  const sigterm = () => handle("SIGTERM")
  process.on("SIGINT", sigint)
  process.on("SIGTERM", sigterm)

  const dispose = () => {
    if (state.timer) clearTimeout(state.timer)
    if (state.hard) clearTimeout(state.hard)
    process.off("SIGINT", sigint)
    process.off("SIGTERM", sigterm)
  }

  return {
    received,
    get current() {
      return state.current
    },
    dispose,
    [Symbol.dispose]: dispose,
  }
}
