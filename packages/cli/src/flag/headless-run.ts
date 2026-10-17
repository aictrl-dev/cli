/**
 * Whether this process is serving a headless `aictrl run`. The run command marks it
 * at runtime, whichever entry point or build started it. The mark lives in memory
 * rather than in the environment, so it is not inherited by processes a run
 * spawns and cannot be switched on by a stray exported variable (#155).
 */
export namespace HeadlessRun {
  let active = false

  export function enable() {
    active = true
  }

  export function disable() {
    active = false
  }

  export function enabled() {
    return active
  }
}
