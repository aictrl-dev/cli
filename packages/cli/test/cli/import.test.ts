import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

test("importing from a share URL fails with a removed error and makes no request (#189)", async () => {
  await using home = await tmpdir()
  const requests: string[] = []
  const share = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      requests.push(new URL(req.url).pathname)
      return Response.json([])
    },
  })
  try {
    const proc = Bun.spawn(["bun", "run", entry, "import", `http://127.0.0.1:${share.port}/share/abc123`], {
      cwd: home.path,
      env: {
        ...process.env,
        HOME: home.path,
        XDG_CONFIG_HOME: path.join(home.path, ".config"),
        XDG_DATA_HOME: path.join(home.path, ".local/share"),
        XDG_CACHE_HOME: path.join(home.path, ".cache"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

    expect(exit).toBe(1)
    expect(stdout).toContain("Importing from a share URL was removed: session sharing is no longer supported")
    expect(requests).toEqual([])
  } finally {
    share.stop(true)
  }
}, 20000)
