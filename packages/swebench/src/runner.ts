import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

import { diffSinceBase, ensureRepo } from "./git.ts"
import { defaultPrompt } from "./prompt.ts"
import { spawnServer } from "./spawnServer.ts"
import { ContainerManager, dockerAvailable } from "./container.ts"
import { TrajectoryWriter } from "./trajectory.ts"
import { ProgressPrinter } from "./progress.ts"
import { BatchProgressManager } from "./batchProgress.ts"
import type {
  CustomProvider,
  RunOptions,
  RunResult,
  SweBenchInstance,
  SweBenchPrediction,
} from "./types.ts"

/**
 * cli.ts re-execs us with `*_proxy` stripped from the env so that Bun's
 * cached fetch proxy resolution doesn't route SDK requests to localhost
 * through a corporate proxy. Nothing further needed here.
 */
function ensureLocalhostBypass(_hostname: string) {}

/**
 * Detect whether we are running from inside the opencode monorepo. If yes, use
 * the workspace dev source automatically — it is guaranteed to match this
 * package's SDK. Otherwise fall back to whatever `opencode` is on PATH.
 *
 * Heuristic: walk up from this file looking for `packages/opencode/package.json`
 * with `"name": "@opencode-ai/opencode"`.
 */
function defaultOpencodeBin(): { command: string; cwd?: string } {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "packages", "opencode", "package.json")
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }
        if (pkg.name === "opencode" || pkg.name === "@opencode-ai/opencode") {
          return {
            command: "bun run dev",
            cwd: path.join(dir, "packages", "opencode"),
          }
        }
      } catch {
        // ignore and keep walking
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { command: "opencode" }
}
/**
 * Permission ruleset that mirrors `opencode run`: deny anything that would
 * require human input, and rely on the per-request `permission.asked` event +
 * auto-approve for everything else.
 */
const DENY_INTERACTIVE = [
  { permission: "question", action: "deny", pattern: "*" } as const,
  { permission: "plan_enter", action: "deny", pattern: "*" } as const,
  { permission: "plan_exit", action: "deny", pattern: "*" } as const,
  // Prevent the agent from wandering outside the worktree.
  { permission: "external_directory", action: "deny", pattern: "*" } as const,
]

function parseModel(
  model: string,
  custom?: CustomProvider,
): { providerID: string; modelID: string } {
  const i = model.indexOf("/")
  if (i > 0) return { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
  if (custom) return { providerID: custom.id, modelID: model }
  throw new Error(
    `--model must be "<provider>/<model>" unless --base-url is set, got "${model}"`,
  )
}

/**
 * Build the `provider` block of the opencode config so that a synthetic
 * OpenAI-compatible provider is available to every session spawned by the
 * shared server.
 */
function buildProviderConfig(custom: CustomProvider, modelID: string) {
  return {
    [custom.id]: {
      npm: custom.npm ?? "@ai-sdk/openai-compatible",
      name: custom.name ?? custom.id,
      options: {
        baseURL: custom.baseURL,
        ...(custom.apiKey ? { apiKey: custom.apiKey } : {}),
        ...(custom.headers ? { headers: custom.headers } : {}),
      },
      models: {
        [modelID]: {
          name: modelID,
          ...(custom.contextLimit || custom.outputLimit
            ? {
                limit: {
                  context: custom.contextLimit ?? 0,
                  output: custom.outputLimit ?? 0,
                },
              }
            : {}),
        },
      },
    },
  }
}

/**
 * Drive a single SWE-bench instance against a running opencode server.
 *
 * Returns `{ patch, ... }`; the caller is responsible for writing the
 * prediction line so that partial progress survives crashes.
 */
async function runOne(args: {
  client: OpencodeClient
  instance: SweBenchInstance
  repoDir: string
  model: string
  provider?: CustomProvider
  agent: string
  timeoutMs: number
  prompt: (instance: SweBenchInstance, repoDir: string) => string
  log: (line: string) => void
  traj?: TrajectoryWriter
  progress?: ProgressPrinter
}): Promise<{ patch: string; result: RunResult }> {
  const { client, instance, repoDir, model, provider, agent, timeoutMs, prompt, log, traj, progress } =
    args
  const t0 = Date.now()

  // 1) Create a session scoped to this worktree.
  const created = await client.session.create({
    directory: repoDir,
    title: `swebench:${instance.instance_id}`,
    permission: DENY_INTERACTIVE,
  })
  const sessionID = created.data?.id
  if (!sessionID) throw new Error("session.create returned no id")

  // 2) Subscribe to events BEFORE sending the prompt so we don't miss the
  //    initial status transitions.
  const events = await client.event.subscribe({ directory: repoDir })

  // 3) Race: idle event vs timeout. Auto-approve any permission ask.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    // Best-effort: aborting the session lets the server clean up and
    // pushes a terminal `session.status: idle` event so the loop exits.
    client.session.abort({ sessionID, directory: repoDir }).catch(() => {})
  }, timeoutMs)

  // Kick off the prompt — fire and forget; the SSE stream is the source of truth.
  const promptPromise = client.session
    .prompt({
      sessionID,
      directory: repoDir,
      agent,
      model: parseModel(model, provider),
      parts: [{ type: "text", text: prompt(instance, repoDir) }],
    })
    .catch((e: unknown) => {
      log(`[${instance.instance_id}] prompt error: ${(e as Error).message}`)
    })

  let lastError: string | undefined
  let lastErrorName: string | undefined
  try {
    for await (const ev of events.stream) {
      if (ev.type === "permission.asked") {
        const p = ev.properties
        if (p.sessionID !== sessionID) continue
        await client.permission
          .reply({ requestID: p.id, reply: "once", directory: repoDir })
          .catch(() => {})
        continue
      }

      if (ev.type === "message.part.updated") {
        const part = ev.properties.part
        if (part.sessionID !== sessionID) continue
        if (traj) traj.record(part)
        if (progress) progress.render(part)
      }

      if (ev.type === "session.error") {
        const p = ev.properties
        if (p.sessionID !== sessionID || !p.error) continue
        const err = p.error as { name?: string; data?: { message?: string } }
        lastErrorName = err?.name
        lastError = err?.data?.message ?? err?.name ?? "unknown error"
        log(`[${instance.instance_id}] session.error: ${lastErrorName ?? ""} ${lastError}`)
      }

      if (
        ev.type === "session.status" &&
        ev.properties.sessionID === sessionID &&
        ev.properties.status.type === "idle"
      ) {
        break
      }
    }
  } finally {
    clearTimeout(timer)
    await promptPromise
  }

  // 4) Extract the model patch directly from git — more reliable than the
  //    snapshot-based session.diff because it covers untracked files and
  //    matches exactly what the SWE-bench harness will apply.
  const patch = await diffSinceBase(repoDir, instance.base_commit)
  const duration = Date.now() - t0

  // Status uses mini-swe-agent's `info.exit_status` vocabulary so the
  // exit_statuses_*.yaml report and per-instance traj.json files match what
  // mini-extra inspector / sb-cli expect.
  const status = classifyExitStatus({ timedOut, patch, lastError, lastErrorName })

  return {
    patch,
    result: {
      instance_id: instance.instance_id,
      status,
      patch_bytes: patch.length,
      duration_ms: duration,
      ...(lastError ? { error: lastError } : {}),
    },
  }
}

/** Bounded-concurrency map over instances. */
async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let i = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.max(1, concurrency); w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = i++
          if (idx >= items.length) return
          await fn(items[idx]!, idx)
        }
      })(),
    )
  }
  await Promise.all(workers)
}

export async function run(options: RunOptions): Promise<RunResult[]> {
  const rawLog = options.log ?? ((l) => console.log(l))
  const prompt = options.promptTemplate ?? defaultPrompt

  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true })

  // Live progress widget: ON by default whenever stderr is a TTY. Verbose log
  // lines still scroll above it via the wrapLog shim. Pass --no-progress to
  // disable in CI / piped logs.
  const wantsProgress = options.progress ?? Boolean(process.stderr.isTTY)
  const bpm = new BatchProgressManager({
    total: options.instances.length,
    log: rawLog,
    enabled: wantsProgress,
  })
  const log = bpm.wrapLog()
  // Verbose-only line: per-instance setup chatter. In quiet mode (default) only
  // the final `done` summary line survives.
  const vlog = options.verbose ? log : (_: string) => {}
  bpm.start()

  log(
    `> opencode-swebench: ${options.instances.length} instance(s), concurrency=${options.concurrency}, model=${options.model}`,
  )

  // Validate model up-front so we fail fast before spawning a server.
  const parsed = parseModel(options.model, options.provider)
  if (options.provider && options.provider.id !== parsed.providerID) {
    throw new Error(
      `model providerID "${parsed.providerID}" does not match --provider-id "${options.provider.id}"`,
    )
  }

  const config = {
    share: "manual",
    logLevel: "WARN",
    ...(options.provider
      ? { provider: buildProviderConfig(options.provider, parsed.modelID) }
      : {}),
  }

  // Container mode (mini-swe-agent parity): route every agent shell command
  // into the official SWE-bench eval image. We point opencode's `shell` config
  // at a wrapper that forwards commands into per-instance containers; file tools
  // and `git diff` keep operating on the bind-mounted host worktree.
  let containers: ContainerManager | undefined
  if (options.container) {
    if (!(await dockerAvailable())) {
      throw new Error(
        "--container requires a docker/podman-compatible CLI on PATH, but none was found.",
      )
    }
    containers = new ContainerManager({
      workspaceRoot: options.workspaceRoot,
      imageTemplate: options.containerImageTemplate,
      log,
    })
    const { shellPath } = await containers.init()
    ;(config as Record<string, unknown>).shell = shellPath
    log(`> container mode: agent shell commands run inside SWE-bench eval images`)
    log(`> container shell wrapper -> ${shellPath}`)
  }

  const command = options.opencodeBin ?? defaultOpencodeBin().command
  const cwd = options.opencodeCwd ?? defaultOpencodeBin().cwd
  log(`> spawning opencode server: ${command}${cwd ? ` (cwd=${cwd})` : ""}`)
  const server = await spawnServer({
    command,
    cwd,
    configJson: JSON.stringify(config),
    timeoutMs: 30_000,
    log,
  })
  if (options.provider) {
    log(
      `> using custom provider id=${options.provider.id} baseURL=${options.provider.baseURL} model=${parsed.modelID}`,
    )
  }
  log(`> opencode server listening on ${server.url}`)
  ensureLocalhostBypass(new URL(server.url).hostname)
  const client = createOpencodeClient({ baseUrl: server.url })

  const results: RunResult[] = []
  const total = options.instances.length
  const startedAt = Date.now()
  let completed = 0
  const counts: Record<string, number> = {}
  // mini-swe-agent-compatible exit-status report. Refreshed atomically after
  // every instance finishes so external watchers can `tail -F` it.
  const instancesByExitStatus: Record<string, string[]> = {}
  const exitStatusYamlPath = path.join(
    path.dirname(path.resolve(options.output)),
    `exit_statuses_${Math.floor(Date.now() / 1000)}.yaml`,
  )
  const writeLock: { p: Promise<void> } = { p: Promise.resolve() }
  // Auto-detect output format from extension. `.json` (mini-swe-agent /
  // SWE-bench harness convention) writes the entire dict atomically after each
  // instance; `.jsonl` appends one line per instance for crash-safe streaming.
  const outputAbs = path.resolve(options.output)
  const isDictFormat = /\.json$/i.test(outputAbs) && !/\.jsonl$/i.test(outputAbs)
  const predsByInstance: Record<string, SweBenchPrediction> = {}
  // Hydrate from existing file so resume runs preserve previously-completed
  // entries when we rewrite the dict.
  if (isDictFormat && existsSync(outputAbs)) {
    try {
      const existing = JSON.parse(readFileSync(outputAbs, "utf8")) as Record<string, SweBenchPrediction>
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        Object.assign(predsByInstance, existing)
      }
    } catch {
      // ignore malformed file; we'll overwrite it.
    }
  }
  const savePrediction = (prediction: SweBenchPrediction) => {
    if (isDictFormat) {
      predsByInstance[prediction.instance_id] = prediction
      const snapshot = JSON.stringify(predsByInstance, null, 2)
      writeLock.p = writeLock.p.then(() => writeFile(outputAbs, snapshot))
    } else {
      writeLock.p = writeLock.p.then(() =>
        appendFile(outputAbs, JSON.stringify(prediction) + "\n"),
      )
    }
    return writeLock.p
  }
  const writeExitStatusYaml = () => {
    writeLock.p = writeLock.p.then(() =>
      writeFile(exitStatusYamlPath, renderExitStatusYaml(instancesByExitStatus)),
    )
    return writeLock.p
  }
  const recordDone = (r: RunResult) => {
    completed++
    counts[r.status] = (counts[r.status] ?? 0) + 1
    ;(instancesByExitStatus[r.status] ??= []).push(r.instance_id)
    results.push(r)
    bpm.onEnd(r.instance_id, r.status)
    void writeExitStatusYaml()
    const elapsedSec = (Date.now() - startedAt) / 1000
    const etaSec = completed === total ? 0 : Math.round((elapsedSec / completed) * (total - completed))
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
    log(`> [${completed}/${total}] ${summary} eta=${formatDuration(etaSec)}`)
  }
  log(`> exit-status report -> ${exitStatusYamlPath}`)

  try {
    await pool(options.instances, options.concurrency, async (instance, idx) => {
      const tag = `[${instance.instance_id} ${idx + 1}/${total}]`
      bpm.onStart(instance.instance_id, idx + 1)
      const status = (s: string) => bpm.onUpdate(instance.instance_id, s)
      let container: Awaited<ReturnType<ContainerManager["prepare"]>> | undefined
      try {
        status("preparing repo")
        vlog(`${tag} preparing repo ${instance.repo}@${instance.base_commit.slice(0, 12)}`)
        let repoDir: string
        if (containers) {
          status("starting container")
          vlog(`${tag} starting container`)
          container = await containers.prepare(
            instance,
            path.join(options.workspaceRoot, instance.instance_id),
          )
          repoDir = container.repoDir
        } else {
          repoDir = await ensureRepo({
            workspaceRoot: options.workspaceRoot,
            instanceId: instance.instance_id,
            repo: instance.repo,
            baseCommit: instance.base_commit,
          })
        }

        vlog(`${tag} running agent (timeout=${options.timeoutMs}ms)`)
        status("starting session")
        const promptText = prompt(instance, repoDir)
        const traj = options.trajDir
          ? new TrajectoryWriter({
              dir: options.trajDir,
              instance,
              model: options.model,
              providerId: options.provider?.id,
              agent: options.agent ?? "build",
              prompt: promptText,
            })
          : undefined
        if (traj) vlog(`${tag} trajectory -> ${traj.path}`)

        const progress = new ProgressPrinter({
          tag,
          log,
          verbose: options.verbose ?? options.thinking ?? false,
          thinking: options.thinking ?? false,
          onStatus: status,
        })

        const { patch, result } = await runOne({
          client,
          instance,
          repoDir,
          model: options.model,
          provider: options.provider,
          agent: options.agent ?? "build",
          timeoutMs: options.timeoutMs,
          prompt: () => promptText,
          log,
          traj,
          progress,
        })
        progress.summary()

        const prediction: SweBenchPrediction = {
          instance_id: instance.instance_id,
          model_name_or_path: options.model,
          model_patch: patch,
        }
        await savePrediction(prediction)

        if (traj) {
          await traj.finish({
            exit_status: result.status,
            duration_ms: result.duration_ms,
            patch_bytes: result.patch_bytes,
            ...(result.error ? { error: result.error } : {}),
            submission: JSON.stringify(prediction),
          })
        }

        log(
          `${tag} done status=${result.status} bytes=${result.patch_bytes} took=${result.duration_ms}ms`,
        )
        recordDone(result)
      } catch (e) {
        const err = (e as Error).message
        log(`${tag} FAILED: ${err}`)
        const prediction: SweBenchPrediction = {
          instance_id: instance.instance_id,
          model_name_or_path: options.model,
          model_patch: "",
        }
        await savePrediction(prediction).catch(() => {})
        recordDone({
          instance_id: instance.instance_id,
          status: "AgentError",
          patch_bytes: 0,
          duration_ms: 0,
          error: err,
        })
      } finally {
        if (container) await container.stop().catch(() => {})
      }
    })
  } finally {
    server.close()
    if (containers) await containers.stopAll().catch(() => {})
    bpm.stop()
  }

  // Final summary
  const totalDur = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(`> summary: ${JSON.stringify(counts)} (total ${totalDur}s, ${results.length} instance(s))`)
  log(`> exit-status report: ${exitStatusYamlPath}`)

  if (!options.keepWorkspaces) {
    log(`> (kept workspaces under ${options.workspaceRoot}; pass --no-keep-workspaces to delete)`)
  }

  return results
}

/** Format a number of seconds as h:mm:ss / m:ss / N s. */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "?"
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

/**
 * Translate (timeout, patch, error) into a mini-swe-agent exit_status string.
 *
 * The opencode server emits errors with `name` set to one of
 *   - `MessageAbortedError`        — we cancelled the session (timeout path)
 *   - `MessageOutputLengthError`   — model exceeded its `--model-output` budget
 *   - `ContextOverflowError`       — prompt+history exceeded `--model-context`
 *   - `ProviderAuthError` etc.     — upstream auth issues
 * Plus arbitrary upstream errors surfaced through `error.data.message` (e.g.
 * `InternalServerError`, `RateLimitError` from the AI SDK provider).
 *
 * We normalise these to the names mini emits via `type(e).__name__` so a single
 * downstream tooling stack can read both harnesses' reports.
 */
function classifyExitStatus(args: {
  timedOut: boolean
  patch: string
  lastError?: string
  lastErrorName?: string
}): string {
  if (args.timedOut) return "TimeoutError"
  if (args.lastErrorName) {
    if (args.lastErrorName === "ContextOverflowError") return "ContextWindowExceededError"
    if (args.lastErrorName === "MessageOutputLengthError") return "LimitsExceeded"
    if (args.lastErrorName === "MessageAbortedError") return "TimeoutError"
    return args.lastErrorName
  }
  if (args.lastError) {
    const m = args.lastError.toLowerCase()
    if (m.includes("context length") || m.includes("context window") || m.includes("maximum context")) {
      return "ContextWindowExceededError"
    }
    if (m.includes("internal server error") || /\b5\d\d\b/.test(args.lastError)) {
      return "InternalServerError"
    }
    if (m.includes("rate limit")) return "RateLimitError"
    return "AgentError"
  }
  if (!args.patch.trim()) return "EmptyPatch"
  return "Submitted"
}

/**
 * Emit the same shape as mini-swe-agent's `RunBatchProgressManager`:
 *
 *     instances_by_exit_status:
 *         <status>:
 *             - <instance_id>
 *             ...
 *
 * Status keys are sorted by descending count then alphabetically; instance ids
 * are sorted alphabetically inside each bucket so diffs across runs are stable.
 * Hand-rolled to avoid pulling in a yaml dep — the schema is intentionally tiny.
 */
function renderExitStatusYaml(instancesByExitStatus: Record<string, string[]>): string {
  const escape = (s: string) => {
    if (s === "" || /[:#&*!|>'"%@`{}\[\],?\-]/.test(s) || /^\s|\s$/.test(s) || /^(true|false|null|yes|no|on|off)$/i.test(s)) {
      return JSON.stringify(s)
    }
    return s
  }
  const statuses = Object.entries(instancesByExitStatus).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )
  const lines = ["instances_by_exit_status:"]
  if (statuses.length === 0) {
    lines[0] = "instances_by_exit_status: {}"
  } else {
    for (const [status, ids] of statuses) {
      lines.push(`    ${escape(status)}:`)
      for (const id of [...ids].sort()) lines.push(`        - ${escape(id)}`)
    }
  }
  return lines.join("\n") + "\n"
}
