/**
 * SWE-bench instance shape (subset we care about).
 *
 * Matches the schema produced by `datasets.load_dataset("princeton-nlp/SWE-bench_Lite")`
 * after exporting to JSONL. Extra fields are preserved but ignored.
 */
export interface SweBenchInstance {
  instance_id: string
  repo: string // e.g. "django/django"
  base_commit: string
  problem_statement: string
  hints_text?: string
  version?: string
  // Present in the dataset; we deliberately do NOT apply this — the harness does.
  test_patch?: string
  // Anything else the user wants to keep.
  [key: string]: unknown
}

/**
 * One line of the predictions.jsonl file consumed by
 * `python -m swebench.harness.run_evaluation --predictions_path ...`.
 */
export interface SweBenchPrediction {
  instance_id: string
  model_name_or_path: string
  model_patch: string
}

/**
 * Configure an OpenAI-compatible provider on the fly. When set, the runner
 * registers a synthetic provider in the opencode server config and routes
 * `--model` to it. Useful for self-hosted endpoints, vLLM, Ollama, OpenRouter,
 * DeepSeek, Moonshot, etc.
 */
export interface CustomProvider {
  /** Provider id, e.g. "custom", "deepseek", "openrouter". Default: "custom". */
  id: string
  /** Display name; defaults to `id`. */
  name?: string
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1. */
  baseURL: string
  /** Total context window of the model in tokens. */
  contextLimit?: number
  /** Maximum tokens the model is willing to emit per response. */
  outputLimit?: number
  /** API key. Optional if the endpoint is unauthenticated. */
  apiKey?: string
  /** npm package implementing the provider. Default: @ai-sdk/openai-compatible. */
  npm?: string
  /** Optional extra headers passed on every request. */
  headers?: Record<string, string>
}

export interface RunOptions {
  instances: SweBenchInstance[]
  output: string
  workspaceRoot: string
  /**
   * Either "<providerID>/<modelID>" (uses an existing/built-in provider) or a
   * bare "<modelID>" — in the latter case `provider` MUST be set and the model
   * is implicitly scoped to it.
   */
  model: string
  /** Optional custom OpenAI-compatible provider. */
  provider?: CustomProvider
  /**
   * Command used to launch the opencode server. Defaults to "opencode"
   * resolved from PATH. Set this when the binary on PATH is older than the
   * SDK shipped in this workspace; e.g.
   *   `bun run --conditions=browser /abs/path/to/packages/opencode/src/index.ts`
   */
  opencodeBin?: string
  /**
   * Working directory for the spawned opencode process. Required when using a
   * dev-source command like `bun run dev` because Bun's `--conditions` resolution
   * is per-cwd. Typically `<repo>/packages/opencode`.
   */
  opencodeCwd?: string
  /**
   * Directory for per-instance trajectory files. Each instance writes
   * `<trajDir>/<instance_id>.traj.json` containing both a flat
   * mini-swe-agent-style `trajectory: [{role, content}, ...]` list and a
   * richer `parts: [...]` view (tools, reasoning, step boundaries, snapshots).
   * Files are rewritten incrementally so you can `tail -f` mid-run.
   * Default: undefined (no trajectory files written).
   */
  trajDir?: string
  /** Print every assistant message / tool call / step boundary as it happens. */
  verbose?: boolean
  /** Also print model reasoning blocks. Implies verbose. */
  thinking?: boolean
  /**
   * Show a live mini-style progress widget at the bottom of stderr while the
   * batch runs. Defaults to ON when stderr is a TTY and `verbose` is false.
   * Pass `false` to force off (useful for log-only environments / CI).
   */
  progress?: boolean
  agent?: string
  concurrency: number
  timeoutMs: number
  keepWorkspaces: boolean
  /** Override the system / instructions appended to the user prompt. */
  promptTemplate?: (instance: SweBenchInstance, repoDir: string) => string
  /** Logger; defaults to console. */
  log?: (line: string) => void
}

export interface RunResult {
  instance_id: string
  /**
   * mini-swe-agent compatible exit status. Common values:
   *  - `Submitted`                  agent produced a non-empty patch
   *  - `EmptyPatch`                 agent stopped without producing a diff
   *  - `TimeoutError`               wall-clock timeout fired
   *  - `LimitsExceeded`             cost/step/output limit hit by the agent
   *  - `ContextWindowExceededError` model's context window overflowed
   *  - `InternalServerError`        upstream provider returned 5xx
   *  - any other `<ExceptionName>`  passed through from `error.name`
   */
  status: string
  patch_bytes: number
  duration_ms: number
  error?: string
}
