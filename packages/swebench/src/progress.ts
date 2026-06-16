/**
 * Live progress printer for opencode message parts. Mirrors the formatting in
 * `opencode run` (packages/opencode/src/cli/cmd/run.ts) so the swebench CLI
 * gives the same per-step visibility into what the agent is doing.
 *
 * Emits one short, human-readable line per significant event, plus optional
 * full text / reasoning blocks when --verbose is set.
 */

const ICONS = {
  text: "•",
  reasoning: "◇",
  bash: "⌘",
  read: "□",
  edit: "✎",
  write: "✎",
  glob: "✱",
  grep: "✱",
  webfetch: "↗",
  webfetch2: "↗",
  task: "≡",
  todo: "✓",
  generic: "⚙",
  error: "✗",
  step: "→",
  done: "✓",
  info: "i",
  cost: "$",
} as const

function trim(s: string, max = 140): string {
  const norm = s.replace(/\s+/g, " ").trim()
  return norm.length > max ? norm.slice(0, max - 1) + "…" : norm
}

function prettyInput(tool: string, input: any): string {
  if (!input || typeof input !== "object") return ""
  switch (tool) {
    case "bash":
      return trim(String(input.command ?? ""))
    case "read":
    case "write":
    case "edit":
      return trim(String(input.file ?? input.path ?? input.filePath ?? ""))
    case "glob":
      return trim(`"${input.pattern}"${input.path ? ` in ${input.path}` : ""}`)
    case "grep":
      return trim(`"${input.pattern}"${input.path ? ` in ${input.path}` : ""}`)
    case "webfetch":
      return trim(String(input.url ?? ""))
    case "task":
      return trim(String(input.description ?? input.prompt ?? ""))
    default: {
      try {
        return trim(JSON.stringify(input))
      } catch {
        return ""
      }
    }
  }
}

export interface ProgressOptions {
  tag: string
  verbose: boolean
  thinking: boolean
  /** Accumulator updated as we see step-finish parts. */
  log: (line: string) => void
  /**
   * Compact one-line status string for the live batch widget. Called frequently
   * with the current activity ("step 3  $0.0123"). Optional.
   */
  onStatus?: (status: string) => void
  /** Running total cost (USD) for this instance, reported as it accrues. */
  onCost?: (cost: number) => void
}

export class ProgressPrinter {
  private toolStarts = new Map<string, number>()
  private steps = 0
  private totalCost = 0
  private totalIn = 0
  private totalOut = 0
  private totalReasoning = 0

  constructor(private opts: ProgressOptions) {}

  /** Compact widget status: only step count + running total cost. */
  private statusLine(): string {
    return `step ${this.steps}  $${this.totalCost.toFixed(2)}`
  }

  /** Render a part. Called from the runner's event loop. */
  render(part: any) {
    const { tag, verbose, thinking } = this.opts
    // In quiet mode (verbose off) we still track totals + drive the live batch
    // widget via onStatus, but emit no per-step scroll-back lines. `log` is a
    // no-op so a single guard keeps the accounting paths intact.
    const log = verbose ? this.opts.log : (_: string) => {}

    if (part.type === "step-start") {
      this.steps++
      this.opts.onStatus?.(this.statusLine())
      log(`${tag} ${ICONS.step} step ${this.steps} start`)
      return
    }

    if (part.type === "step-finish") {
      const cost = Number(part.cost ?? 0)
      const tin = Number(part.tokens?.input ?? 0)
      const tout = Number(part.tokens?.output ?? 0)
      const treason = Number(part.tokens?.reasoning ?? 0)
      this.totalCost += cost
      this.totalIn += tin
      this.totalOut += tout
      this.totalReasoning += treason
      this.opts.onStatus?.(this.statusLine())
      this.opts.onCost?.(this.totalCost)
      log(
        `${tag} ${ICONS.done} step ${this.steps} finish reason=${part.reason} ` +
          `tokens=in:${tin} out:${tout} reason:${treason} cost=$${cost.toFixed(4)} ` +
          `(total $${this.totalCost.toFixed(4)})`,
      )
      return
    }

    if (part.type === "text" && typeof part.text === "string" && part.time?.end) {
      const text = part.text.trim()
      if (!text) return
      if (verbose) {
        log(`${tag} ${ICONS.text} assistant:`)
        for (const line of text.split("\n")) log(`${tag}   ${line}`)
      } else {
        log(`${tag} ${ICONS.text} ${trim(text, 200)}`)
      }
      return
    }

    if (part.type === "reasoning" && typeof part.text === "string" && part.time?.end) {
      const text = part.text.trim()
      if (!text || !thinking) return
      log(`${tag} ${ICONS.reasoning} thinking:`)
      for (const line of text.split("\n")) log(`${tag}   ${line}`)
      return
    }

    if (part.type === "tool" && part.state) {
      const s = part.state
      if (s.status === "running") {
        // Print one line when a tool starts; suppress duplicates.
        if (this.toolStarts.has(part.id)) return
        this.toolStarts.set(part.id, Date.now())
        const icon = (ICONS as any)[part.tool] ?? ICONS.generic
        const desc = prettyInput(part.tool, s.input)
        this.opts.onStatus?.(this.statusLine())
        log(`${tag} ${icon} ${part.tool} ${desc}`)
        return
      }
      if (s.status === "completed") {
        if (!this.toolStarts.has(part.id)) {
          // Tool completed without a separate "running" event — still announce.
          const icon = (ICONS as any)[part.tool] ?? ICONS.generic
          const desc = prettyInput(part.tool, s.input)
          log(`${tag} ${icon} ${part.tool} ${desc}`)
        }
        const took = Date.now() - (this.toolStarts.get(part.id) ?? Date.now())
        this.toolStarts.delete(part.id)
        const summary = s.title ? `: ${trim(s.title, 100)}` : ""
        log(`${tag}   ${ICONS.done} ${part.tool} done in ${took}ms${summary}`)
        if (verbose && s.output) {
          const out = String(s.output).trim()
          if (out) {
            const head = out.split("\n").slice(0, 20)
            for (const line of head) log(`${tag}     ${line}`)
            const lines = out.split("\n").length
            if (lines > 20) log(`${tag}     … (+${lines - 20} more lines)`)
          }
        }
        return
      }
      if (s.status === "error") {
        this.toolStarts.delete(part.id)
        log(`${tag}   ${ICONS.error} ${part.tool} error: ${trim(String(s.error ?? "unknown"))}`)
        return
      }
    }

    if (part.type === "patch" && Array.isArray(part.files) && part.files.length) {
      log(`${tag} ${ICONS.info} patch: ${part.files.length} file(s) [${part.files.slice(0, 5).join(", ")}${part.files.length > 5 ? ", …" : ""}]`)
      return
    }
  }

  /** Print a final summary line. Called once after the session goes idle. */
  summary() {
    const { tag } = this.opts
    if (!this.opts.verbose) return
    const log = this.opts.log
    log(
      `${tag} ${ICONS.cost} totals: steps=${this.steps} ` +
        `tokens=in:${this.totalIn} out:${this.totalOut} reason:${this.totalReasoning} ` +
        `cost=$${this.totalCost.toFixed(4)}`,
    )
  }
}
