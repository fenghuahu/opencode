/**
 * litellm-style model pricing.
 *
 * litellm computes cost by looking the model up in a price table
 * (`model_prices_and_context_window.json`) and multiplying the per-token
 * input/output cost by the token counts. We mirror that: resolve a model's
 * price from the table, then hand it to opencode as the provider model `cost`
 * (input/output/cache_read/cache_write in USD per 1M tokens) so opencode does
 * the actual cost accounting natively — see
 * packages/opencode/src/session/session.ts (`.div(1_000_000)`).
 */

/** Default source: litellm's canonical price table on GitHub. */
export const LITELLM_PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

/**
 * Backup table filename shipped inside the installed litellm package. Its
 * absolute path depends on where pip installed litellm, so we locate the
 * package at runtime via python rather than hardcoding a path.
 */
export const LITELLM_BACKUP_FILENAME = "model_prices_and_context_window_backup.json"

/** A single litellm price-table entry (only the fields we need). */
interface LiteLLMEntry {
  /** USD per input token. */
  input_cost_per_token?: number
  /** USD per output token. */
  output_cost_per_token?: number
  /** USD per cached (read) input token. */
  cache_read_input_token_cost?: number
  /** USD per cache-creation (write) input token. */
  cache_creation_input_token_cost?: number
}

export type PriceTable = Record<string, LiteLLMEntry>

/** Resolved price in opencode's units: USD per 1M tokens. */
export interface ModelPrice {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

/**
 * Load a litellm price table from a local path or URL. Defaults to litellm's
 * canonical table, and—when the default source fails (e.g. offline)—falls back
 * to the backup table bundled inside the pip-installed litellm package (located
 * at runtime via python, since its path depends on the install location).
 * Throws with an actionable message when every source can't be read so the
 * caller can fall back to manual --cost-* flags.
 *
 * Set `LITELLM_LOCAL_MODEL_COST_MAP=True` (same env var litellm/mini-swe-agent
 * use) to skip the network entirely and read only the bundled backup table.
 */
export async function loadPriceTable(source?: string): Promise<PriceTable> {
  // Explicit source: no implicit fallback, the caller asked for this one.
  if (source) return readPriceTable(source)
  // Force local-only mode, matching litellm's LITELLM_LOCAL_MODEL_COST_MAP.
  if (useLocalCostMap()) return readPriceTable(await locateLitellmBackup())
  try {
    return await readPriceTable(LITELLM_PRICE_URL)
  } catch (primary) {
    try {
      const backup = await locateLitellmBackup()
      return await readPriceTable(backup)
    } catch (backup) {
      throw new Error(
        `failed to load litellm price table from ${LITELLM_PRICE_URL} ` +
          `(${(primary as Error).message}) and from the installed litellm package ` +
          `(${(backup as Error).message})`,
      )
    }
  }
}

/** Whether LITELLM_LOCAL_MODEL_COST_MAP forces local-only pricing. */
function useLocalCostMap(): boolean {
  const v = (process.env.LITELLM_LOCAL_MODEL_COST_MAP ?? "").trim().toLowerCase()
  return v === "true" || v === "1" || v === "yes"
}

/**
 * Resolve the absolute path to litellm's bundled backup price table by asking
 * the installed litellm package where it lives. Tries python3 then python.
 */
async function locateLitellmBackup(): Promise<string> {
  const py = `
import os, sys
try:
    import litellm
except Exception as e:
    sys.stderr.write("litellm not importable: " + str(e))
    sys.exit(2)
p = os.path.join(os.path.dirname(litellm.__file__), ${JSON.stringify(LITELLM_BACKUP_FILENAME)})
if not os.path.isfile(p):
    sys.stderr.write("backup table not found at " + p)
    sys.exit(3)
sys.stdout.write(p)
`
  for (const bin of ["python3", "python"]) {
    try {
      const proc = Bun.spawn([bin, "-c", py], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      if (code === 0 && stdout.trim()) return stdout.trim()
      if (code !== 127) throw new Error(stderr.trim() || `${bin} exited ${code}`)
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") continue
      throw e
    }
  }
  throw new Error("could not locate the installed litellm package via python")
}

async function readPriceTable(src: string): Promise<PriceTable> {
  const isUrl = /^https?:\/\//.test(src)
  if (isUrl) {
    const res = await fetch(src).catch((e) => {
      throw new Error(`failed to fetch price table ${src}: ${(e as Error).message}`)
    })
    if (!res.ok) throw new Error(`failed to fetch price table ${src}: HTTP ${res.status}`)
    return (await res.json()) as PriceTable
  }
  const file = Bun.file(src)
  if (!(await file.exists())) throw new Error(`price table not found: ${src}`)
  return (await file.json()) as PriceTable
}

/**
 * Look a model up in the table the way litellm does. litellm keys are a mix of
 * bare model ids (`gpt-4o`) and `provider/model` ids (`azure/eu/gpt-4o-...`),
 * so we try every `/`-delimited suffix of the requested id from most specific
 * to least specific: `openrouter/anthropic/claude-sonnet-4-5` is tried as
 * `openrouter/anthropic/claude-sonnet-4-5`, then `anthropic/claude-sonnet-4-5`,
 * then `claude-sonnet-4-5`. Each candidate is matched case-insensitively.
 * The most specific match wins (so provider-specific pricing is preferred over
 * the bare-model fallback). Returns USD per 1M tokens, or undefined when unknown.
 */
export function lookupPrice(table: PriceTable, model: string): ModelPrice | undefined {
  // Case-insensitive index: lowercased key -> original key.
  const index = new Map<string, string>()
  for (const k of Object.keys(table)) index.set(k.toLowerCase(), k)

  const parts = model.split("/")
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join("/")
    const key = table[candidate] ? candidate : index.get(candidate.toLowerCase())
    const hit = key ? table[key] : undefined
    if (hit && (hit.input_cost_per_token != null || hit.output_cost_per_token != null)) return toPer1M(hit)
  }
  return undefined
}

function toPer1M(e: LiteLLMEntry): ModelPrice {
  const M = 1_000_000
  return {
    input: (e.input_cost_per_token ?? 0) * M,
    output: (e.output_cost_per_token ?? 0) * M,
    ...(e.cache_read_input_token_cost != null ? { cache_read: e.cache_read_input_token_cost * M } : {}),
    ...(e.cache_creation_input_token_cost != null ? { cache_write: e.cache_creation_input_token_cost * M } : {}),
  }
}
