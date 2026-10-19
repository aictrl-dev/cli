import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type MigrationsJournal } from "drizzle-orm/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@aictrl/util/error"
import z from "zod"
import path from "path"
import * as schema from "./schema"
import { readMigrationJournal } from "./migration-journal"

declare const AICTRL_MIGRATIONS: MigrationsJournal | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export const Path = path.join(Global.Path.data, "aictrl.db")
  type Schema = typeof schema
  export type Transaction = SQLiteTransaction<"sync", void, Schema>

  type Client = SQLiteBunDatabase<Schema>

  const state = {
    sqlite: undefined as BunDatabase | undefined,
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: path.join(Global.Path.data, "aictrl.db") })

    const sqlite = new BunDatabase(path.join(Global.Path.data, "aictrl.db"), { create: true })
    state.sqlite = sqlite

    sqlite.run("PRAGMA journal_mode = WAL")
    sqlite.run("PRAGMA synchronous = NORMAL")
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA cache_size = -64000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")

    const db = drizzle({ client: sqlite, schema })

    // Apply schema migrations
    const entries =
      typeof AICTRL_MIGRATIONS !== "undefined"
        ? AICTRL_MIGRATIONS
        : readMigrationJournal(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof AICTRL_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      migrate(db, entries)
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Client.reset()
  }

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  // bun-sqlite transactions are synchronous: an async callback would commit
  // before its awaits run, so the type rejects callbacks that can return a
  // Promise or any other thenable.
  type SyncResult<T> = [Extract<T, PromiseLike<unknown>>] extends [never] ? T : never

  export function transaction<T>(callback: (tx: TxOrDb) => SyncResult<T>): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        // drizzle's own sync guard cannot evaluate a generic T, so the result
        // travels in a box; SyncResult has already rejected async callbacks.
        const { result } = Client().transaction((tx) => {
          return { result: ctx.provide({ tx, effects }, () => callback(tx)) }
        })
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
