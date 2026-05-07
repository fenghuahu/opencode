import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SweBenchInstance } from "./types.ts"

/**
 * Trajectory writer that emits the **mini-swe-agent v1.1** schema, so files
 * produced by this harness can be browsed with `mini-extra inspector` and
 * graded by tooling that expects mini's `info` / `messages` shape.
 *
 * Reference: https://mini-swe-agent.com/latest/usage/output_files/
 *
 * Layout:
 * ```
 * {
 *   "info": {
 *     "instance_id": "...",
 *     "exit_status": "Submitted" | "TimeoutError" | ...,
 *     "submission":  "<unified diff>",
 *     "model_stats": { "instance_cost", "api_calls", ... },
 *     "config":      { "agent_type", "model_type", "environment_type", "model": {...} },
 *     "mini_version": "1.1.0",
 *     "opencode":    { "version": "v2", "parts": [...] }   // opencode-specific telemetry
 *   },
 *   "messages": [
 *     { "role": "system",    "content": "..." },
 *     { "role": "user",      "content": "<task prompt>" },
 *     { "role": "assistant", "content": "...", "tool_calls": [...], "extra": { cost, tokens, ... } },
 *     { "role": "tool",      "tool_call_id": "...", "content": "<output>", "extra": {...} },
 *     ...
 *     { "role": "user",      "content": "", "extra": { "exit_status", "submission", "timestamp" } }
 *   ],
 *   "trajectory_format": "mini-swe-agent-1.1"
 * }
 * ```
 *
 * Per-step buffering: opencode emits `step-start` / parts.../ `step-finish`
 * boundaries. We buffer text + tool calls inside one step then flush them as
 * a single assistant message followed by tool observations on `step-finish`,
 * which matches how mini groups one LLM call worth of activity.
 */
interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  extra?: Record<string, unknown>
}

interface Trajectory {
  instance_id: string
  info: {
    instance_id: string
    exit_status?: string
    submission?: string
    exception_str?: string
    traceback?: string
    model_stats: {
      instance_cost: number
      api_calls: number
      total_input_tokens: number
      total_output_tokens: number
      total_reasoning_tokens: number
    }
    config: {
      agent: Record<string, unknown>
      agent_type: string
      model: { model_name: string; provider_id?: string }
      model_type: string
      environment: Record<string, unknown>
      environment_type: string
    }
    mini_version: string
    opencode: {
      version: string
      repo: string
      base_commit: string
      started_at: number
      ended_at?: number
      duration_ms?: number
      patch_bytes?: number
      parts: any[]
    }
  }
  messages: Message[]
  trajectory_format: "mini-swe-agent-1.1"
}

const SYSTEM_MESSAGE =
  "opencode SWE-bench harness. Agent has access to bash, read, edit, write, glob, grep, webfetch and task tools. " +
  "Edits are persisted to the repository working tree; the harness collects the resulting diff against the base commit as the submission."

export class TrajectoryWriter {
  readonly path: string
  private data: Trajectory
  private writePromise: Promise<void> = Promise.resolve()
  private dirty = false
  private flushing = false

  // Per-step buffers (reset on every `step-start`).
  private currentText: string[] = []
  private currentReasoning: string[] = []
  private currentToolCalls: ToolCall[] = []
  private currentObservations: Message[] = []
  private inStep = false

  constructor(args: {
    dir: string
    instance: SweBenchInstance
    model: string
    providerId?: string
    agent: string
    prompt: string
  }) {
    const id = args.instance.instance_id
    // mini-swe-agent layout: <output_dir>/<instance_id>/<instance_id>.traj.json
    this.path = path.join(args.dir, id, `${id}.traj.json`)
    this.data = {
      instance_id: id,
      info: {
        instance_id: id,
        model_stats: {
          instance_cost: 0,
          api_calls: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_reasoning_tokens: 0,
        },
        config: {
          agent: { name: args.agent },
          agent_type: `opencode.${args.agent}`,
          model: {
            model_name: args.model,
            ...(args.providerId ? { provider_id: args.providerId } : {}),
          },
          model_type: "opencode.openai-compatible",
          environment: { environment_class: "opencode.local" },
          environment_type: "opencode.local",
        },
        mini_version: "2.0.0",
        opencode: {
          version: "v2",
          repo: args.instance.repo,
          base_commit: args.instance.base_commit,
          started_at: Date.now(),
          parts: [],
        },
      },
      messages: [
        { role: "system", content: SYSTEM_MESSAGE },
        { role: "user", content: args.prompt, extra: { timestamp: nowSec() } },
      ],
      trajectory_format: "mini-swe-agent-1.1",
    }
  }

  /** Record one opencode part. Mirrors the runner's event loop. */
  record(part: any) {
    this.data.info.opencode.parts.push({ ...part, _recorded_at: Date.now() })

    switch (part.type) {
      case "step-start":
        this.beginStep()
        break

      case "text":
        if (part.time?.end && typeof part.text === "string" && part.text.trim()) {
          this.currentText.push(part.text)
        }
        break

      case "reasoning":
        if (part.time?.end && typeof part.text === "string" && part.text.trim()) {
          this.currentReasoning.push(part.text)
        }
        break

      case "tool": {
        const s = part.state
        if (!s) break
        if (s.status === "completed") {
          const id = String(part.id ?? `call_${this.currentToolCalls.length}`)
          this.currentToolCalls.push({
            id,
            type: "function",
            function: {
              name: String(part.tool ?? "unknown"),
              arguments: safeJson(s.input ?? {}),
            },
          })
          this.currentObservations.push({
            role: "tool",
            tool_call_id: id,
            content: stringifyOutput(s.output),
            extra: {
              tool_name: String(part.tool ?? "unknown"),
              ...(typeof s.title === "string" ? { title: s.title } : {}),
              ...(s.metadata && typeof s.metadata === "object" ? { metadata: s.metadata } : {}),
              timestamp: nowSec(),
            },
          })
        } else if (s.status === "error") {
          const id = String(part.id ?? `call_${this.currentToolCalls.length}`)
          this.currentToolCalls.push({
            id,
            type: "function",
            function: {
              name: String(part.tool ?? "unknown"),
              arguments: safeJson(s.input ?? {}),
            },
          })
          this.currentObservations.push({
            role: "tool",
            tool_call_id: id,
            content: `ERROR: ${String(s.error ?? "unknown")}`,
            extra: {
              tool_name: String(part.tool ?? "unknown"),
              error: true,
              timestamp: nowSec(),
            },
          })
        }
        break
      }

      case "step-finish":
        this.flushStep(part)
        break
    }

    this.scheduleFlush()
  }

  /** Update the per-instance result fields, append the final user message, and flush. */
  finish(result: {
    exit_status: string
    duration_ms: number
    patch_bytes: number
    error?: string
    submission?: string
  }) {
    // Drain a step that never finished (e.g. timeout / mid-stream abort).
    if (this.inStep) this.flushStep(null)

    this.data.info.exit_status = result.exit_status
    this.data.info.submission = result.submission ?? ""
    if (result.error) this.data.info.exception_str = result.error
    Object.assign(this.data.info.opencode, {
      ended_at: Date.now(),
      duration_ms: result.duration_ms,
      patch_bytes: result.patch_bytes,
    })

    // mini convention: the trajectory ends with a synthetic user message whose
    // `extra` carries `exit_status` and `submission`; tooling reads this as the
    // final submitted payload.
    this.data.messages.push({
      role: "user",
      content: "",
      extra: {
        exit_status: result.exit_status,
        submission: result.submission ?? "",
        timestamp: nowSec(),
        ...(result.error ? { error: result.error } : {}),
      },
    })

    this.dirty = true
    return this.flushNow()
  }

  // ---- internals ----

  private beginStep() {
    this.inStep = true
    this.currentText = []
    this.currentReasoning = []
    this.currentToolCalls = []
    this.currentObservations = []
  }

  private flushStep(stepFinish: any) {
    this.inStep = false
    const text = this.currentText.join("").trim()
    const reasoning = this.currentReasoning.join("").trim()

    const extra: Record<string, unknown> = { timestamp: nowSec() }
    if (reasoning) extra.reasoning_content = reasoning

    if (stepFinish) {
      const cost = Number(stepFinish.cost ?? 0)
      const tin = Number(stepFinish.tokens?.input ?? 0)
      const tout = Number(stepFinish.tokens?.output ?? 0)
      const treason = Number(stepFinish.tokens?.reasoning ?? 0)
      this.data.info.model_stats.api_calls += 1
      this.data.info.model_stats.instance_cost += cost
      this.data.info.model_stats.total_input_tokens += tin
      this.data.info.model_stats.total_output_tokens += tout
      this.data.info.model_stats.total_reasoning_tokens += treason
      extra.cost = cost
      extra.tokens = { input: tin, output: tout, reasoning: treason }
      if (stepFinish.reason) extra.finish_reason = stepFinish.reason
    }

    if (text || this.currentToolCalls.length > 0 || reasoning) {
      const msg: Message = {
        role: "assistant",
        content: text,
        ...(this.currentToolCalls.length > 0 ? { tool_calls: this.currentToolCalls } : {}),
        extra,
      }
      this.data.messages.push(msg)
      for (const obs of this.currentObservations) this.data.messages.push(obs)
    }

    this.currentText = []
    this.currentReasoning = []
    this.currentToolCalls = []
    this.currentObservations = []
  }

  private scheduleFlush() {
    this.dirty = true
    if (this.flushing) return
    this.flushing = true
    // Coalesce rapid updates into ~1 write per 100ms so consumers can `tail -f`.
    setTimeout(() => {
      this.flushing = false
      this.flushNow().catch(() => {})
    }, 100)
  }

  private flushNow(): Promise<void> {
    if (!this.dirty) return this.writePromise
    this.dirty = false
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writePromise = this.writePromise.then(async () => {
      await mkdir(path.dirname(this.path), { recursive: true })
      await writeFile(this.path, snapshot)
    })
    return this.writePromise
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (output == null) return ""
  return safeJson(output)
}

function nowSec(): number {
  return Date.now() / 1000
}
