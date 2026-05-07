import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { SweBenchInstance } from "./types.ts"

/**
 * Named subsets mirror mini-swe-agent's DATASET_MAPPING in
 * src/minisweagent/run/benchmarks/swebench.py.
 *
 * Pass any of these to --subset:
 *   lite          princeton-nlp/SWE-Bench_Lite          (300 instances, dev split)
 *   verified      princeton-nlp/SWE-Bench_Verified      (500 instances, test split)
 *   full          princeton-nlp/SWE-Bench               (2294 instances)
 *   multimodal    princeton-nlp/SWE-Bench_Multimodal
 *   multilingual  swe-bench/SWE-Bench_Multilingual
 *   smith         SWE-bench/SWE-smith
 *   _test         klieret/swe-bench-dummy-test-dataset  (tiny, for smoke tests)
 *   rebench       nebius/SWE-rebench
 */
export const DATASET_MAPPING: Record<string, string> = {
  full: "princeton-nlp/SWE-Bench",
  verified: "princeton-nlp/SWE-Bench_Verified",
  lite: "princeton-nlp/SWE-Bench_Lite",
  multimodal: "princeton-nlp/SWE-Bench_Multimodal",
  multilingual: "swe-bench/SWE-Bench_Multilingual",
  smith: "SWE-bench/SWE-smith",
  _test: "klieret/swe-bench-dummy-test-dataset",
  rebench: "nebius/SWE-rebench",
}

/**
 * Resolve --subset into a list of instances. Accepts:
 *   - A named subset (see DATASET_MAPPING).
 *   - A local path to a .jsonl / .json file.
 *   - A HuggingFace dataset id "<org>/<name>".
 *
 * For HuggingFace ids we try Python (`python3 -m`/`python -m` with the
 * `datasets` library) first because it leverages the user's local HF cache.
 * If Python is unavailable we fall back to the datasets-server REST API, which
 * works without any local dependencies but requires network access to
 * datasets-server.huggingface.co.
 */
export async function loadSubset(
  spec: string,
  split: string,
  log: (s: string) => void,
): Promise<SweBenchInstance[]> {
  const mapped = DATASET_MAPPING[spec] ?? spec
  if (await isFile(mapped)) {
    log(`> loading instances from local file: ${mapped}`)
    return loadFromFile(mapped)
  }
  if (mapped.includes("/") && !mapped.startsWith("/") && !mapped.startsWith(".")) {
    log(`> loading HuggingFace dataset ${mapped} (split=${split})`)
    try {
      return await loadViaPython(mapped, split, log)
    } catch (e) {
      log(`> python loader failed (${(e as Error).message}); falling back to datasets-server`)
      return await loadViaDatasetsServer(mapped, split, log)
    }
  }
  throw new Error(
    `--subset: cannot resolve "${spec}". Pass a named subset (${Object.keys(DATASET_MAPPING).join(", ")}), ` +
      `a HuggingFace id (org/name), or a local .jsonl / .json file.`,
  )
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(path.resolve(p))).isFile()
  } catch {
    return false
  }
}

export async function loadFromFile(file: string): Promise<SweBenchInstance[]> {
  const raw = await readFile(file, "utf8")
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) return JSON.parse(trimmed)
  // Try whole-file JSON parse first. If that succeeds and the result is an
  // object, decide between "single instance" and "dict-of-instances". If
  // whole-file parse fails (the common case for multi-line JSONL where each
  // line is a separate object), fall back to line-by-line parsing.
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj["instance_id"] === "string") {
        return [obj as unknown as SweBenchInstance]
      }
      const values = Object.values(obj)
      const looksLikeInstanceMap =
        values.length > 0 &&
        values.every(
          (v) =>
            v !== null &&
            typeof v === "object" &&
            typeof (v as Record<string, unknown>)["instance_id"] === "string",
        )
      if (looksLikeInstanceMap) return values as SweBenchInstance[]
      throw new Error(
        `${file}: top-level object is neither a single instance (missing "instance_id") nor a {id: instance} map.`,
      )
    } catch (e) {
      // If we already produced a meaningful error above, surface it.
      if (e instanceof Error && e.message.startsWith(file + ":")) throw e
      // Otherwise fall through to JSONL parsing.
    }
  }
  // JSONL
  return trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SweBenchInstance)
}

async function loadViaPython(
  dataset: string,
  split: string,
  log: (s: string) => void,
): Promise<SweBenchInstance[]> {
  const py = `
import json, sys
try:
    from datasets import load_dataset
except Exception as e:
    sys.stderr.write("datasets library not available: " + str(e))
    sys.exit(2)
ds = load_dataset(${JSON.stringify(dataset)}, split=${JSON.stringify(split)})
for row in ds:
    sys.stdout.write(json.dumps(dict(row), default=str) + "\\n")
`
  for (const bin of ["python3", "python"]) {
    try {
      const proc = Bun.spawn([bin, "-c", py], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      if (code === 0) {
        const rows = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l) as SweBenchInstance)
        log(`> loaded ${rows.length} instance(s) via ${bin}`)
        return rows
      }
      if (code !== 127) {
        // Surface full stderr so cache/split/version errors aren't truncated.
        for (const line of stderr.split("\n")) if (line.trim()) log(`  ${bin}: ${line}`)
        throw new Error(`${bin} exited ${code}`)
      }
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") continue
      throw e
    }
  }
  throw new Error("no python interpreter with `datasets` library found")
}

async function loadViaDatasetsServer(
  dataset: string,
  split: string,
  log: (s: string) => void,
): Promise<SweBenchInstance[]> {
  const out: SweBenchInstance[] = []
  let offset = 0
  const length = 100
  while (true) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
      `&config=default&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(
        `datasets-server ${res.status}: ${(await res.text()).slice(0, 300)} (url=${url})`,
      )
    }
    const data = (await res.json()) as {
      rows: Array<{ row: SweBenchInstance }>
      num_rows_total: number
    }
    for (const r of data.rows) out.push(r.row)
    if (data.rows.length === 0 || out.length >= (data.num_rows_total ?? out.length)) break
    offset += data.rows.length
    log(`> datasets-server: fetched ${out.length}/${data.num_rows_total}`)
  }
  return out
}

/**
 * Apply mini-swe-agent's filter/slice/shuffle pipeline.
 * `slice` is a Python-style "a:b" / "a:b:c" / ":n" / "n:" / "::-1" spec.
 * `filter` is a JS regex applied to instance_id (case-sensitive, matches anywhere).
 * `shuffle` sorts by instance_id first (for reproducibility) then shuffles with seed 42.
 */
export function filterInstances(
  instances: SweBenchInstance[],
  opts: { filter?: string; slice?: string; shuffle?: boolean; limit?: number },
): SweBenchInstance[] {
  let out = instances
  if (opts.shuffle) {
    out = [...out].sort((a, b) => a.instance_id.localeCompare(b.instance_id))
    seededShuffle(out, 42)
  }
  if (opts.filter) {
    const rx = new RegExp(opts.filter)
    out = out.filter((x) => rx.test(x.instance_id))
  }
  if (opts.slice) out = applySlice(out, opts.slice)
  if (opts.limit !== undefined) out = out.slice(0, opts.limit)
  return out
}

function applySlice<T>(arr: T[], spec: string): T[] {
  const parts = spec.split(":").map((p) => (p.trim() === "" ? undefined : Number(p)))
  if (parts.some((p) => p !== undefined && Number.isNaN(p))) {
    throw new Error(`--slice: bad spec "${spec}", expected Python-style "start:stop[:step]"`)
  }
  const [start, stop, step] = [parts[0], parts[1], parts[2] ?? 1]
  if (step === 0) throw new Error("--slice: step cannot be 0")
  const n = arr.length
  const norm = (v: number | undefined, def: number) => {
    if (v === undefined) return def
    return v < 0 ? Math.max(0, n + v) : Math.min(n, v)
  }
  if (step! > 0) {
    const s = norm(start, 0)
    const e = norm(stop, n)
    const out: T[] = []
    for (let i = s; i < e; i += step!) out.push(arr[i]!)
    return out
  }
  // Negative step
  const s = norm(start, n - 1)
  const e = stop === undefined ? -1 : norm(stop, -1)
  const out: T[] = []
  for (let i = s; i > e; i += step!) out.push(arr[i]!)
  return out
}

/** Mulberry32 PRNG, in-place Fisher–Yates shuffle. */
function seededShuffle<T>(arr: T[], seed: number) {
  let s = seed >>> 0
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
}

/**
 * Read existing predictions.jsonl (or .json dict) and return the set of
 * instance_ids already processed. Returns an empty set if the file is missing.
 */
export async function readExistingInstanceIds(file: string): Promise<Set<string>> {
  try {
    const raw = await readFile(file, "utf8")
    const t = raw.trim()
    if (!t) return new Set()
    // Try whole-file JSON parse first (mini-swe-agent's preds.json: a dict
    // keyed by instance_id). If that fails, fall back to JSONL.
    try {
      const parsed = JSON.parse(t)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const values = Object.values(parsed)
        const looksLikePredsDict =
          values.length > 0 &&
          values.every(
            (v) =>
              v !== null &&
              typeof v === "object" &&
              typeof (v as Record<string, unknown>)["instance_id"] === "string",
          )
        if (looksLikePredsDict) return new Set(Object.keys(parsed))
      }
      if (Array.isArray(parsed)) {
        const ids = new Set<string>()
        for (const r of parsed as Array<{ instance_id?: string }>) {
          if (r?.instance_id) ids.add(r.instance_id)
        }
        return ids
      }
    } catch {
      // fall through to JSONL
    }
    const ids = new Set<string>()
    for (const line of t.split("\n")) {
      const l = line.trim()
      if (!l) continue
      try {
        const obj = JSON.parse(l) as { instance_id?: string }
        if (obj.instance_id) ids.add(obj.instance_id)
      } catch {
        // skip malformed line
      }
    }
    return ids
  } catch {
    return new Set()
  }
}
