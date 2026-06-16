import { spawn } from "node:child_process"
import path from "node:path"
import { run } from "./runner.ts"
import {
  DATASET_MAPPING,
  filterInstances,
  loadFromFile,
  loadSubset,
  readExistingInstanceIds,
} from "./dataset.ts"
import type { SweBenchInstance } from "./types.ts"
import { loadPriceTable, lookupPrice, type ModelPrice } from "./pricing.ts"

/**
 * Bun 1.3 caches HTTP proxy configuration at process startup, so neither
 * `delete process.env.http_proxy` nor `fetch(url, { proxy: "" })` is enough
 * to bypass a corporate proxy when talking to localhost. The opencode SDK
 * client therefore receives the proxy's 403 HTML page and aborts with
 * "Server responded with text/html".
 *
 * Workaround: if any *_proxy env var is set when the CLI starts, re-exec the
 * same command in a fresh process with those vars stripped, but stash the
 * originals in OPENCODE_SWEBENCH_OUTBOUND_PROXY so the spawned opencode
 * server (which still needs to reach the model endpoint over the network)
 * can re-export them for its own outbound calls.
 *
 * Returns true if a re-exec was started (caller must NOT continue).
 */
function maybeReexecWithoutProxy(): boolean {
  if (process.env.OPENCODE_SWEBENCH_PROXY_STRIPPED === "1") return false
  const keys = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
  const stash: Record<string, string> = {}
  for (const k of keys) {
    if (process.env[k]) stash[k] = process.env[k]!
  }
  if (Object.keys(stash).length === 0) return false

  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of keys) delete env[k]
  env.OPENCODE_SWEBENCH_PROXY_STRIPPED = "1"
  env.OPENCODE_SWEBENCH_OUTBOUND_PROXY = JSON.stringify(stash)

  const child = spawn(process.execPath, process.argv.slice(1), { env, stdio: "inherit" })
  child.on("exit", (code, sig) => {
    if (sig) process.kill(process.pid, sig)
    else process.exit(code ?? 0)
  })
  return true
}

if (maybeReexecWithoutProxy()) {
  // Re-exec in progress; the child process will do all the work.
} else {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

interface Args {
  instances?: string
  subset?: string
  split?: string
  slice?: string
  shuffle?: boolean
  redoExisting?: boolean
  output: string
  workspaceRoot: string
  model: string
  agent?: string
  concurrency: number
  timeoutMs: number
  keepWorkspaces: boolean
  limit?: number
  filter?: string
  baseUrl?: string
  modelContext?: number
  modelOutput?: number
  apiKey?: string
  providerId?: string
  providerNpm?: string
  priceTable?: string
  costInput?: number
  costOutput?: number
  costCacheRead?: number
  costCacheWrite?: number
  opencodeBin?: string
  opencodeCwd?: string
  trajDir?: string
  verbose?: boolean
  thinking?: boolean
  quiet?: boolean
  progress?: boolean
  container?: boolean
  containerImage?: string
}

function usage(): never {
  console.error(`opencode-swebench - run opencode against SWE-bench instances

Usage:
  opencode-swebench --subset lite --output <preds.json> --model <id> [options]
  opencode-swebench --instances <file.jsonl> --output <preds.json> --model <id> [options]

Data selection (mirrors mini-swe-agent's flags):
  --subset <name|path>       SWE-bench subset, HuggingFace dataset id, or path to a
                             local .jsonl/.json file. Named subsets:
                                 ${Object.keys(DATASET_MAPPING).join(", ")}
                             For HF ids we use python's \`datasets\` library when
                             available (uses the local cache), else fall back to
                             https://datasets-server.huggingface.co.
  --split <name>             Dataset split. Default: dev (matches SWE-bench Lite).
  --slice <spec>             Python-style slice, e.g. "0:5", ":10", "100:200:2",
                             "::-1".
  --filter <regex>           Keep only instance_ids matching this JS regex.
  --shuffle                  Sort by instance_id then shuffle with seed=42 before
                             slicing (so --slice 0:N selects a deterministic subset).
  --redo-existing            Re-run instances even if they already exist in the
                             output predictions file. Default: skip them (resume).
  --instances <path>         Legacy alias for --subset <local-file>.
  --limit <n>                Cap the final count (applied after filter+slice).

Required:
  --output <path>            Predictions file. Format is auto-detected from the
                             extension:
                               .json   → SWE-bench dict format (mini-swe-agent
                                         compatible). Atomically rewritten after
                                         each instance.
                               .jsonl  → one prediction per line, appended.
                                         Crash-safe streaming for huge runs.
                             Used for resume detection (existing instance ids
                             are skipped unless --redo-existing is set).
                             resume-detection unless --redo-existing.
  --model <id>               Model id. With --base-url: bare id (e.g. "deepseek-coder").
                             Without: "<provider>/<model>" using a built-in opencode
                             provider, e.g. "openai/gpt-4o".

Provider:
  --base-url <url>           OpenAI-compatible endpoint, e.g. https://api.deepseek.com/v1
                             or http://localhost:11434/v1. Enables custom provider mode.
  --api-key <key>            API key for --base-url. May also be passed via
                             OPENCODE_SWEBENCH_API_KEY env var.
  --provider-id <id>         Synthetic provider id. Default: "custom".
  --provider-npm <pkg>       Provider implementation. Default: @ai-sdk/openai-compatible.
  --model-context <int>      Total context window of the model (tokens). Tells
                             opencode how much room is available so it can size
                             prompts and request budgets. Required for vLLM /
                             local OpenAI-compatible endpoints whose context is
                             smaller than the SDK's default 128k assumption.
                             Example: --model-context 40960
  --model-output <int>       Maximum completion tokens to request. Should leave
                             enough room for the prompt: ctx >= prompt + output.
                             Default: min(8192, model-context/4) when only
                             --model-context is given. Example: --model-output 4096

Cost (litellm-style pricing):
  --price-table <path|url>   litellm price table to resolve the model's price
                             from. Accepts a local JSON file or URL. Default:
                             litellm's model_prices_and_context_window.json on
                             GitHub. The looked-up price is handed to opencode
                             so cost is computed natively (input*tokens/1e6 ...).
  --cost-input <usd/1M>      Override input price in USD per 1M tokens. Use this
                             for self-hosted models not in the litellm table
                             (e.g. vLLM). Example: --cost-input 0.5
  --cost-output <usd/1M>     Override output price in USD per 1M tokens.
                             Example: --cost-output 1.5
  --cost-cache-read <usd/1M> Override cached-input (read) price per 1M tokens.
  --cost-cache-write <usd/1M> Override cache-write price per 1M tokens.
  (env) LITELLM_LOCAL_MODEL_COST_MAP=True
                             Skip the network and read only the price table
                             bundled inside the installed litellm package
                             (same env var litellm / mini-swe-agent honour).

opencode server:
  --opencode-bin <cmd>       Command used to launch "opencode serve". Default: "opencode"
                             from PATH. Set this when your installed opencode is older
                             than this workspace's SDK, e.g.:
                                 --opencode-bin "bun run dev" \\
                                 --opencode-cwd "$PWD/packages/opencode"
                             May also be passed via OPENCODE_SWEBENCH_BIN env var.
  --opencode-cwd <dir>       Working directory for the spawned opencode process.
                             Required when using "bun run dev" (Bun resolves
                             --conditions per cwd). Env: OPENCODE_SWEBENCH_CWD.

Execution:
  --workers, -w <n>          Parallel instances. Default: 1. Alias: --concurrency.
  --timeout-ms <n>            Per-instance wall-clock timeout. Default: 600000
  --workspace-root <dir>     Where to clone per-instance worktrees. Default: ./.swebench-work
  --agent <name>             opencode primary agent. Default: build
  --no-keep-workspaces       Delete workspaces after completion (not yet implemented).

Container (mini-swe-agent parity):
  --container                Run every agent shell command inside the official
                             SWE-bench eval image for the instance, instead of on
                             the host. The host worktree is bind-mounted into the
                             container so opencode's file tools and the final
                             git diff still operate on local files. Requires a
                             docker- or podman-compatible CLI on PATH. Default: off.
  --container-image <tmpl>   Image name template. Supports {instance} (normalized
                             id, '__'->'_1776_', lowercased) and {instance_id}
                             (raw id). Default:
                                 swebench/sweb.eval.x86_64.{instance}:latest

Output:
  --traj-dir <dir>           Root directory for per-instance trajectory files.
                             Each instance is written to
                             <dir>/<instance_id>/<instance_id>.traj.json
                             (mini-swe-agent layout). Default: ./trajectories.
                             Pass --traj-dir "" to disable.
  --verbose, -v              Stream the agent <-> LLM interaction live to stdout
                             (default: OFF; quiet is the default).
  --thinking                 Also stream the model's reasoning blocks. Implies
                             --verbose.
  --quiet, -q                Only print the per-instance "done" summary line
                             (suppresses the live progress messages). This is
                             the default; pass --verbose to opt back in.
  --progress / --no-progress Enable / disable the live mini-style progress bar
                             at the bottom of stderr. Default: ON when stderr
                             is a TTY and --verbose is off.
  -h, --help                 Show this help.

Environment:
  Provider credentials for built-in providers (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
  OPENCODE_SWEBENCH_API_KEY  Fallback for --api-key when using --base-url.
  LITELLM_LOCAL_MODEL_COST_MAP=True
                             Force local-only pricing (use the litellm package's
                             bundled price table, never the network).

Examples:
  # SWE-bench Lite, first 10 instances, 4 workers, against a local vLLM
  opencode-swebench --subset lite --slice 0:10 --workers 4 \\
      --output ./preds.json \\
      --base-url http://10.0.0.1:30001/v1 --api-key xxx \\
      --provider-id qwen --model Qwen3-235B-A22B \\
      --model-context 40960 --model-output 4096

  # SWE-bench Verified, only Django instances
  opencode-swebench --subset verified --split test \\
      --filter '^django__' --workers 8 \\
      --output ./verified-django.json --model openai/gpt-4o

  # Resume an interrupted run (already-completed instances are skipped)
  opencode-swebench --subset lite --output ./preds.json --model openai/gpt-4o

  # Force re-run
  opencode-swebench --subset lite --output ./preds.json --model openai/gpt-4o \\
      --redo-existing

  # Run agent shell commands inside the official SWE-bench eval containers
  opencode-swebench --subset lite --slice 0:10 --workers 4 --container \\
      --output ./preds.json --model openai/gpt-4o
`)
  process.exit(1)
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    workspaceRoot: path.resolve(".swebench-work"),
    concurrency: 1,
    timeoutMs: 600_000,
    keepWorkspaces: true,
    agent: "build",
  }
  const need = (i: number, name: string) => {
    const v = argv[i + 1]
    if (v === undefined) {
      console.error(`Missing value for ${name}`)
      usage()
    }
    if (v.startsWith("--")) {
      console.error(
        `Missing value for ${name} (next token "${v}" looks like another flag).\n` +
          `Hint: an empty environment variable can cause this, e.g. --api-key $UNSET_VAR`,
      )
      usage()
    }
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case "-h":
      case "--help":
        usage()
      case "--instances":
        out.instances = need(i, a)
        i++
        break
      case "--subset":
        out.subset = need(i, a)
        i++
        break
      case "--split":
        out.split = need(i, a)
        i++
        break
      case "--slice":
        out.slice = need(i, a)
        i++
        break
      case "--shuffle":
        out.shuffle = true
        break
      case "--redo-existing":
        out.redoExisting = true
        break
      case "--output":
        out.output = path.resolve(need(i, a))
        i++
        break
      case "--workspace-root":
        out.workspaceRoot = path.resolve(need(i, a))
        i++
        break
      case "--model":
        out.model = need(i, a)
        i++
        break
      case "--agent":
        out.agent = need(i, a)
        i++
        break
      case "-w":
      case "--workers":
      case "--concurrency":
        out.concurrency = Number(need(i, a))
        i++
        break
      case "--timeout-ms":
        out.timeoutMs = Number(need(i, a))
        i++
        break
      case "--no-keep-workspaces":
        out.keepWorkspaces = false
        break
      case "--limit":
        out.limit = Number(need(i, a))
        i++
        break
      case "--filter":
        out.filter = need(i, a)
        i++
        break
      case "--base-url":
        out.baseUrl = need(i, a)
        i++
        break
      case "--model-context":
        out.modelContext = Number(need(i, a))
        i++
        break
      case "--model-output":
        out.modelOutput = Number(need(i, a))
        i++
        break
      case "--api-key":
        out.apiKey = need(i, a)
        i++
        break
      case "--provider-id":
        out.providerId = need(i, a)
        i++
        break
      case "--provider-npm":
        out.providerNpm = need(i, a)
        i++
        break
      case "--price-table":
        out.priceTable = need(i, a)
        i++
        break
      case "--cost-input":
        out.costInput = Number(need(i, a))
        i++
        break
      case "--cost-output":
        out.costOutput = Number(need(i, a))
        i++
        break
      case "--cost-cache-read":
        out.costCacheRead = Number(need(i, a))
        i++
        break
      case "--cost-cache-write":
        out.costCacheWrite = Number(need(i, a))
        i++
        break
      case "--opencode-bin":
        out.opencodeBin = need(i, a)
        i++
        break
      case "--opencode-cwd":
        out.opencodeCwd = need(i, a)
        i++
        break
      case "--traj-dir":
        out.trajDir = need(i, a)
        i++
        break
      case "-v":
      case "--verbose":
        out.verbose = true
        break
      case "--thinking":
        out.thinking = true
        out.verbose = true
        break
      case "-q":
      case "--quiet":
        out.quiet = true
        break
      case "--progress":
        out.progress = true
        break
      case "--no-progress":
        out.progress = false
        break
      case "--container":
        out.container = true
        break
      case "--container-image":
        out.containerImage = need(i, a)
        i++
        break
      default:
        console.error(`Unknown argument: ${a}`)
        usage()
    }
  }
  if (!out.output || !out.model) usage()
  if (!out.instances && !out.subset) {
    console.error("Need either --subset or --instances.")
    usage()
  }
  return out as Args
}

async function loadInstances(args: Args, log: (s: string) => void): Promise<SweBenchInstance[]> {
  if (args.subset) {
    return loadSubset(args.subset, args.split ?? "dev", log)
  }
  log(`> loading instances from ${args.instances}`)
  return loadFromFile(args.instances!)
}

function resolveTrajDir(value: string | undefined): string | undefined {
  if (value === "") return undefined
  if (value !== undefined) return path.resolve(value)
  return path.resolve("trajectories")
}

/**
 * Resolve the model price (USD per 1M tokens) litellm-style: explicit
 * --cost-* overrides win; otherwise look the model up in the litellm price
 * table. Returns undefined (cost stays 0) when nothing matches.
 */
async function resolveCost(args: Args, log: (s: string) => void): Promise<ModelPrice | undefined> {
  if (args.costInput != null || args.costOutput != null) {
    log(`> pricing: manual override input=$${args.costInput ?? 0}/1M output=$${args.costOutput ?? 0}/1M`)
    return {
      input: args.costInput ?? 0,
      output: args.costOutput ?? 0,
      ...(args.costCacheRead != null ? { cache_read: args.costCacheRead } : {}),
      ...(args.costCacheWrite != null ? { cache_write: args.costCacheWrite } : {}),
    }
  }
  try {
    const table = await loadPriceTable(args.priceTable)
    // litellm keys are often "<provider>/<model>" (e.g. "openai/Qwen3-235B-A22B-FP8").
    // Try the provider-id-prefixed id first so it can match those keys, then
    // fall back to the bare model id. lookupPrice strips prefixes from most to
    // least specific, so the combined form covers both cases.
    const combined = args.providerId ? `${args.providerId}/${args.model}` : args.model
    const price = lookupPrice(table, combined) ?? lookupPrice(table, args.model)
    if (price) {
      log(`> pricing: ${combined} -> input=$${price.input}/1M output=$${price.output}/1M (litellm)`)
      return price
    }
    log(`> WARNING: pricing: "${combined}" not found in price table; cost will be $0 (pass --cost-input/--cost-output)`)
  } catch (e) {
    log(`> WARNING: pricing: could not load price table: ${(e as Error).message}; cost will be $0 (pass --cost-input/--cost-output or set LITELLM_LOCAL_MODEL_COST_MAP=True)`)
  }
  return undefined
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const log = (s: string) => console.log(s)

  let instances = await loadInstances(args, log)
  const total = instances.length
  log(`> dataset: ${total} instance(s)`)

  instances = filterInstances(instances, {
    filter: args.filter,
    slice: args.slice,
    shuffle: args.shuffle,
    limit: args.limit,
  })
  if (instances.length !== total) {
    log(
      `> filter/slice/shuffle: ${total} -> ${instances.length} instance(s)` +
        (args.filter ? ` filter=/${args.filter}/` : "") +
        (args.slice ? ` slice=${args.slice}` : "") +
        (args.shuffle ? " shuffle" : "") +
        (args.limit !== undefined ? ` limit=${args.limit}` : ""),
    )
  }

  if (!args.redoExisting) {
    const done = await readExistingInstanceIds(args.output)
    if (done.size > 0) {
      const before = instances.length
      instances = instances.filter((x) => !done.has(x.instance_id))
      log(
        `> resume: ${done.size} existing prediction(s) in ${args.output}; ` +
          `${before} -> ${instances.length} instance(s) to run ` +
          `(pass --redo-existing to override)`,
      )
    }
  }

  if (instances.length === 0) {
    console.error("No instances to run after filtering.")
    process.exit(0)
  }

  const provider = await (async () => {
    if (!args.baseUrl) return undefined
    const apiKey = args.apiKey ?? process.env.OPENCODE_SWEBENCH_API_KEY
    const ctx = args.modelContext
    const out = args.modelOutput ?? (ctx ? Math.min(8192, Math.floor(ctx / 4)) : undefined)
    const cost = await resolveCost(args, log)
    return {
      id: args.providerId ?? "custom",
      baseURL: args.baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(args.providerNpm ? { npm: args.providerNpm } : {}),
      ...(ctx ? { contextLimit: ctx } : {}),
      ...(out ? { outputLimit: out } : {}),
      ...(cost ? { cost } : {}),
    }
  })()

  const results = await run({
    instances,
    output: args.output,
    workspaceRoot: args.workspaceRoot,
    model: args.model,
    provider,
    opencodeBin: args.opencodeBin ?? process.env.OPENCODE_SWEBENCH_BIN,
    opencodeCwd: args.opencodeCwd ?? process.env.OPENCODE_SWEBENCH_CWD,
    trajDir: resolveTrajDir(args.trajDir),
    verbose: args.verbose ?? false,
    thinking: args.thinking ?? false,
    progress: args.progress,
    agent: args.agent,
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    keepWorkspaces: args.keepWorkspaces,
    container: args.container,
    containerImageTemplate: args.containerImage,
  })

  const failed = results.filter((r) => r.status === "error" || r.status === "timeout").length
  process.exit(failed === results.length ? 2 : 0)
}
