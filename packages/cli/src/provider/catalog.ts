import { mapValues } from "remeda"
import catalog from "./catalog.json"
import type { Provider } from "./provider"

/**
 * Built-in providers and their models. The data lives in catalog.json, one model per line,
 * and ships inside the binary: nothing is fetched or cached at runtime.
 *
 * Providers that are not built in are defined through `provider` in aictrl.json.
 */
export namespace ModelCatalog {
  type Entry = Provider.Info & SDKDefaults
  type SDKDefaults = {
    /** SDK package for models a config adds to this provider. */
    npm: string
    /** Base URL for models a config adds to this provider, when its SDK needs one. */
    api?: string
  }

  const entries = catalog as unknown as Record<string, Entry>

  /** Returns fresh copies, because provider state mutates the providers it loads. */
  export function providers(): Record<string, Provider.Info> {
    return mapValues(entries, ({ npm: _npm, api: _api, ...info }) => structuredClone(info))
  }

  export function sdkDefaults(providerID: string): Partial<SDKDefaults> {
    const entry = entries[providerID]
    if (!entry) return {}
    return { npm: entry.npm, api: entry.api }
  }
}
