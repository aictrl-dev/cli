import { expect, test } from "bun:test"
import { Installation } from "../../src/installation"

test("standalone binary upgrade fails without running a remote installer", async () => {
  const error = await Installation.upgrade("curl", "9.9.9").catch((error) => error)
  expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
  expect(error.data.stderr).toContain("npm install -g @aictrl/cli@9.9.9")
})
