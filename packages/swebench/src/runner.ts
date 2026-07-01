import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

import { diffSinceBase, ensureRepo } from "./git.ts"
import { defaultPrompt, miniInstancePrompt, extractSubmission, MINI_SYSTEM_PROMPT } from "./prompt.ts"
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

/**
 * How often to poll `session.messages` for live progress while a prompt is in
 * flight. The SSE event stream is unreliable in some environments, so this poll
 * drives the progress widget and early submission detection.
 */
const POLL_INTERVAL_MS = 3_000

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
          ...(custom.cost
            ? {
                cost: {
                  input: custom.cost.input,
                  output: custom.cost.output,
                  ...(custom.cost.cache_read != null ? { cache_read: custom.cost.cache_read } : {}),
                  ...(custom.cost.cache_write != null ? { cache_write: custom.cost.cache_write } : {}),
                },
              }
            : {}),
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
  mountPath?: string
  model: string
  provider?: CustomProvider
  agent: string
  miniMode: boolean
  timeoutMs: number
  prompt: (instance: SweBenchInstance, repoDir: string) => string
  log: (line: string) => void
  traj?: TrajectoryWriter
  progress?: ProgressPrinter
}): Promise<{ patch: string; result: RunResult }> {
  const { client, instance, repoDir, mountPath, model, provider, agent, miniMode, timeoutMs, prompt, log, traj, progress } =
    args
  const t0 = Date.now()

  // In container mode the agent's bash runs inside the container, so it may
  // freely access ANY path (e.g. /testbed, /tmp, /root, /usr). Replace the
  // blanket external_directory deny with a blanket allow; the container is fully
  // isolated so there is no host-filesystem risk.
  const DENY_INTERACTIVE_CONTAINER = [
    { permission: "question", action: "deny", pattern: "*" } as const,
    { permission: "plan_enter", action: "deny", pattern: "*" } as const,
    { permission: "plan_exit", action: "deny", pattern: "*" } as const,
    { permission: "external_directory", action: "allow", pattern: "*" } as const,
  ]
  const permission = mountPath ? DENY_INTERACTIVE_CONTAINER : DENY_INTERACTIVE
  const parsedModel = parseModel(model, provider)

  // 1) Create a session scoped to this worktree.
  const created = await client.session.create({
    directory: repoDir,
    title: `swebench:${instance.instance_id}`,
    agent,
    model: { id: parsedModel.modelID, providerID: parsedModel.providerID },
    permission,
  })
  const sessionID = created.data?.id
  if (!sessionID) throw new Error("session.create returned no id")

  let lastError: string | undefined
  let lastErrorName: string | undefined
  // mini-swe-agent parity: the agent signals completion by emitting a bash
  // command whose stdout starts with SUBMISSION_MARKER; everything after is the
  // patch.
  let submission: string | undefined

  // Render/record a single message part, and (in mini mode) watch for the
  // submission marker. Idempotent: a part delivered by BOTH the live SSE stream
  // and the final prompt response is processed only once.
  const seen = new Set<string>()
  const handlePart = (part: any) => {
    if (!part || (part.sessionID && part.sessionID !== sessionID)) return
    const key = part.type === "tool" ? `${part.id}:${part.state?.status}` : part.id
    if (key) {
      if (seen.has(key)) return
      seen.add(key)
    }
    if (traj) traj.record(part)
    if (progress) progress.render(part)

    if (
      miniMode &&
      submission === undefined &&
      part.type === "tool" &&
      part.tool === "bash" &&
      part.state?.status === "completed" &&
      // mini-swe-agent's _check_finished only submits when the command
      // succeeded (returncode == 0). opencode exposes the exit code in the
      // bash tool's completed metadata.
      part.state.metadata?.exit === 0
    ) {
      const found = extractSubmission(part.state.output as string | undefined)
      if (found !== undefined) {
        submission = found
        log(`[${instance.instance_id}] submission received (${found.length} bytes); stopping agent`)
        // Fast-path: stop the agent immediately. Harmless if the stream is dead
        // (we still detect the marker from the final prompt response below).
        client.session.abort({ sessionID, directory: repoDir }).catch(() => {})
      }
    }
  }

  // 2) Subscribe to events for best-effort LIVE progress only. In some
  //    environments the server's SSE stream does not deliver session events
  //    reliably (it may close right after `server.connected`), so it must NOT
  //    gate completion — the prompt response below is authoritative. The
  //    background consumer is cancelled via `streamAbort` once we are done.
  const streamAbort = new AbortController()
  const consume = (async () => {
    try {
      const events = await client.event.subscribe({ directory: repoDir }, { signal: streamAbort.signal })
      for await (const ev of events.stream) {
        if (ev.type === "permission.asked") {
          const p = ev.properties
          if (p.sessionID === sessionID)
            await client.permission.reply({ requestID: p.id, reply: "once", directory: repoDir }).catch(() => {})
          continue
        }
        if (ev.type === "message.part.updated") {
          if (ev.properties.part.sessionID === sessionID) handlePart(ev.properties.part)
          continue
        }
        if (ev.type === "session.error") {
          const p = ev.properties
          if (p.sessionID !== sessionID || !p.error || submission !== undefined) continue
          const err = p.error as { name?: string; data?: { message?: string } }
          lastErrorName = err?.name
          lastError = err?.data?.message ?? err?.name ?? "unknown error"
        }
      }
    } catch {
      // stream abort / transport errors are non-fatal; completion comes from the
      // prompt response.
    }
  })()

  // 3) Timeout: abort the session so the awaited prompt below settles.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    client.session.abort({ sessionID, directory: repoDir }).catch(() => {})
  }, timeoutMs)

  // 3b) Poll the message history for LIVE progress. The SSE stream is
  //     unreliable here (see above), so without this the progress widget would
  //     sit at "starting session" for the entire run. `handlePart` is
  //     idempotent, so replaying the growing history every few seconds is safe;
  //     it advances the step/cost widget and, in mini mode, lets us detect the
  //     submission marker (and abort) before the model's turn naturally ends.
  let polling = true
  const poll = (async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (!polling) break
      try {
        const msgs = await client.session.messages({ sessionID, directory: repoDir })
        for (const m of (msgs.data as Array<{ parts?: unknown[] }> | undefined) ?? [])
          for (const part of m.parts ?? []) handlePart(part)
      } catch {
        // transient; keep polling.
      }
    }
  })()

  // 4) Send the prompt and AWAIT it. The v2 prompt endpoint resolves with the
  //    full assistant message + parts once the model's turn ends; this is the
  //    authoritative completion signal and does not depend on the SSE stream.
  try {
    const res = await client.v2.session.prompt({
      sessionID,
      directory: repoDir,
      prompt: { text: prompt(instance, repoDir) },
    })
    if (res.error && submission === undefined && !timedOut) {
      const err = res.error as { name?: string; data?: { message?: string } }
      lastErrorName = err?.name ?? lastErrorName
      lastError = err?.data?.message ?? err?.name ?? JSON.stringify(res.error)
      log(`[${instance.instance_id}] prompt error: ${lastError}`)
    }
    const info = (res.data as { info?: { error?: { name?: string; data?: { message?: string } } } } | undefined)?.info
    if (info?.error && submission === undefined && !timedOut) {
      lastErrorName = info.error.name ?? lastErrorName
      lastError = info.error.data?.message ?? info.error.name ?? lastError
    }
  } catch (e: unknown) {
    // An abort we triggered (timeout or post-submission) surfaces here; only
    // treat it as a real error if it was neither.
    if (submission === undefined && !timedOut) {
      lastError = (e as Error).message
      log(`[${instance.instance_id}] prompt threw: ${lastError}`)
    }
  } finally {
    clearTimeout(timer)
    polling = false
    streamAbort.abort()
    await Promise.all([consume.catch(() => {}), poll.catch(() => {})])
  }

  // 5) Reconcile from the full message history. `v2.session.prompt` only
  //    returns
  //    the FINAL assistant message, but a single run spans many assistant
  //    messages (explore → edit → submit), and the SSE stream may have
  //    delivered none of them. Fetch every message and replay its parts through
  //    the idempotent `handlePart` so progress, trajectory, and (mini mode)
  //    submission detection are correct regardless of stream availability.
  await client.session
    .messages({ sessionID, directory: repoDir })
    .then((msgs) => {
      for (const m of (msgs.data as Array<{ info?: { sessionID?: string }; parts?: unknown[] }> | undefined) ?? [])
        for (const part of m.parts ?? []) handlePart(part)
    })
    .catch((e: unknown) => log(`[${instance.instance_id}] messages fetch failed: ${(e as Error).message}`))


  // 4) Resolve the model patch.
  //    - Primary: host-side `git diff` against base_commit. This is always
  //      authoritative for both container mode (bind-mounted worktree) and
  //      non-container mode. Captures the actual final state of the files.
  //    - Fallback: the explicit submission content (the model's `cat patch.txt`
  //      output). Used only when the host diff is empty — e.g. the model
  //      reverted its edits and the submission contained an older snapshot.
  //    This avoids the common failure where the model runs just
  //    `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` (no `cat patch.txt`),
  //    which sets `submission = ""` and previously produced an EmptyPatch even
  //    though the host worktree had real changes.
  const hostPatch = await diffSinceBase(repoDir, instance.base_commit)
  const patch = hostPatch.trim() ? hostPatch : (submission ?? "")
  const duration = Date.now() - t0

  // Status uses mini-swe-agent's `info.exit_status` vocabulary so the
  // exit_statuses_*.yaml report and per-instance traj.json files match what
  // mini-extra inspector / sb-cli expect.
  const status = classifyExitStatus({ submitted: submission !== undefined, timedOut, patch, lastError, lastErrorName })

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
  // Default to the bash-only "swebench" agent (mini-swe-agent style). Pass
  // `--agent build` to use opencode's native multi-tool agent instead.
  const agentName = options.agent ?? "swebench"
  const miniMode = agentName === "swebench"
  const prompt = options.promptTemplate ?? (miniMode ? miniInstancePrompt : defaultPrompt)

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
  log(
    miniMode
      ? `> agent: swebench (mini-swe-agent style: bash-only, explicit ${"COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"} submission)`
      : `> agent: ${agentName} (opencode native multi-tool; patch via host git diff)`,
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
    // Bash-only "swebench" agent (mini-swe-agent parity): replace opencode's
    // built-in system prompt with the mini-style shell prompt, and deny every
    // tool except `bash` so the model edits exclusively through the shell.
    ...(miniMode
      ? {
          agent: {
            swebench: {
              mode: "primary",
              prompt: MINI_SYSTEM_PROMPT,
              permission: { "*": "deny", bash: "allow" },
            },
          },
        }
      : {}),
  }

  // Container mode (mini-swe-agent parity): route every agent shell command
  // into the official SWE-bench eval image. We point opencode's `shell` config
  // at a wrapper that forwards commands into per-instance containers; file tools
  // and `git diff` keep operating on the bind-mounted host worktree.
  let containers: ContainerManager | undefined
  if (options.container) {
    if (!miniMode) {
      // Incompatible combination: a multi-tool agent's read/grep/glob/edit tools
      // emit HOST paths (`<workspaceRoot>/<instance>/...`), but bash runs INSIDE
      // the container where only the mount path (`/testbed`) exists. The model
      // copies host paths into bash → "No such file", and the correct `/testbed`
      // path is blocked by the external_directory deny rule → it thrashes and
      // edits via failing bash instead of the (host) edit tool → empty patches.
      // The bash-only `swebench` agent has a single consistent namespace.
      log(
        `> WARNING: --agent ${agentName} with --container mixes host-path tools and in-container bash, ` +
          `which confuses the model (host paths fail in the container; /testbed is permission-denied) ` +
          `and commonly yields empty patches. Use the default bash-only "swebench" agent WITH --container, ` +
          `or run --agent ${agentName} WITHOUT --container (host clone; the grader re-applies your patch in the image anyway).`,
      )
    }
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
        // In container mode the agent's bash runs INSIDE the container at the
        // mount path (e.g. /testbed), not at the host worktree path. The prompt
        // must therefore describe the CONTAINER path so the model's `cd`, paths
        // and submission `git diff` all target where its shell actually runs.
        // The host `repoDir` is still used for the session directory and the
        // host-side `git diff` fallback (same files via the bind mount).
        const promptDir = container ? container.mount : repoDir
        const promptText = prompt(instance, promptDir)
        const traj = options.trajDir
          ? new TrajectoryWriter({
              dir: options.trajDir,
              instance,
              model: options.model,
              providerId: options.provider?.id,
              agent: agentName,
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
          onCost: (cost) => bpm.onCost(instance.instance_id, cost),
        })

        const { patch, result } = await runOne({
          client,
          instance,
          repoDir,
          mountPath: container?.mount,
          model: options.model,
          provider: options.provider,
          agent: agentName,
          miniMode,
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
  log(
    `> summary: ${JSON.stringify(counts)} (total ${totalDur}s, ${results.length} instance(s), $${bpm.totalCost().toFixed(2)})`,
  )
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
  submitted: boolean
  timedOut: boolean
  patch: string
  lastError?: string
  lastErrorName?: string
}): string {
  // An explicit submission wins over everything: the agent declared itself done.
  if (args.submitted) return args.patch.trim() ? "Submitted" : "EmptyPatch"
  if (args.timedOut) return "TimeoutError"
  // A non-empty host-side patch means the agent made real edits — submit them
  // even if the session also emitted an error (context overflow, internal error,
  // etc.). The harness only cares about the patch content, and partial fixes can
  // still score points. Error classification is only used when there's nothing
  // to submit.
  if (args.patch.trim()) return "Submitted"
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
