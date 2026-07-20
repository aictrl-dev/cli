import { Log } from "../util/log"
import { Stdout } from "./stdout"

export namespace Shutdown {
  export async function flush() {
    await Stdout.flush().catch((error) => {
      Log.Default.error("stdout flush failed", {
        error: error instanceof Error ? error.message : error,
      })
      process.exitCode = 1
    })
  }
}
