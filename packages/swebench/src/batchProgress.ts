/**
 * Live batch progress widget — mini-swe-agent's `RunBatchProgressManager`
 * ported to a zero-dep ANSI renderer.
 *
 * Layout (rendered at the bottom of stderr, redrawn ~4 Hz):
 *
 *   ⠋ Overall: 7/10 ████████████░░░░  70% • elapsed 0:42 • eta 0:18 • Submitted=3 TimeoutError=2
 *     Submitted: 3   astropy__astropy-12907, marshmallow-code__marshmallow-1359, ...
 *     TimeoutError: 2   sqlfluff__sqlfluff-1517, sqlfluff__sqlfluff-1625
 *   ─ Active workers ───────────────────────────────────────────────────────────
 *     ⠙ django__django-10914  step 5  $0.0123  0:42
 *     ⠹ pvlib__pvlib-python-1072  step 2  $0.0056  0:21
 *
 * Usage:
 *
 *   const bpm = new BatchProgressManager({ total, log: realLog })
 *   bpm.start()
 *   const log = bpm.wrapLog()      // log lines now scroll *above* the widget
 *   bpm.onStart(id, idx); bpm.onUpdate(id, "step 1"); bpm.onEnd(id, "Submitted")
 *   bpm.stop()
 *
 * The widget is suppressed automatically when stderr is not a TTY.
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

interface ActiveEntry {
  idx: number
  status: string
  startedAt: number
}

export interface BatchProgressOptions {
  total: number
  log: (line: string) => void
  out?: NodeJS.WriteStream
  /** Force enable/disable instead of TTY-autodetect. */
  enabled?: boolean
  /** Refresh interval in ms. */
  refreshMs?: number
}

export class BatchProgressManager {
  readonly total: number
  readonly counts: Record<string, number> = {}
  completed = 0
  startedAt = Date.now()

  private active = new Map<string, ActiveEntry>()
  private order: string[] = []
  private finished: { id: string; exitStatus: string }[] = []
  private lastFinished: Record<string, string[]> = {}
  private out: NodeJS.WriteStream
  private interval?: ReturnType<typeof setInterval>
  private lastLines = 0
  private spinnerFrame = 0
  private enabled: boolean
  private refreshMs: number
  private originalLog: (line: string) => void
  private writing = false

  constructor(opts: BatchProgressOptions) {
    this.total = opts.total
    this.originalLog = opts.log
    this.out = opts.out ?? process.stderr
    this.refreshMs = opts.refreshMs ?? 250
    this.enabled = opts.enabled ?? Boolean(this.out.isTTY)
  }

  /** Begin redrawing the bar; idempotent. */
  start() {
    if (!this.enabled || this.interval) return
    this.interval = setInterval(() => this.draw(), this.refreshMs)
    this.draw()
  }

  /** Stop redraw and erase the live region. */
  stop() {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
    this.clear()
  }

  /**
   * Returns a `log` shim that erases the widget, prints the line, then
   * redraws it — so log output scrolls naturally above the live region.
   */
  wrapLog(): (line: string) => void {
    if (!this.enabled) return this.originalLog
    return (line) => {
      this.clear()
      this.originalLog(line)
      this.draw()
    }
  }

  onStart(id: string, idx: number) {
    this.active.set(id, { idx, status: "preparing", startedAt: Date.now() })
    this.order.push(id)
  }

  onUpdate(id: string, status: string) {
    const e = this.active.get(id)
    if (e) e.status = status
  }

  onEnd(id: string, exitStatus: string) {
    this.active.delete(id)
    this.completed++
    this.counts[exitStatus] = (this.counts[exitStatus] ?? 0) + 1
    this.finished.push({ id, exitStatus })
    ;(this.lastFinished[exitStatus] ??= []).push(id)
  }

  // --- rendering ---

  private clear() {
    if (!this.enabled || this.lastLines === 0 || this.writing) return
    this.writing = true
    try {
      this.out.write(`\x1b[${this.lastLines}A\x1b[J`)
    } finally {
      this.writing = false
    }
    this.lastLines = 0
  }

  private draw() {
    if (!this.enabled || this.writing) return
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
    const cols = Math.max(40, this.out.columns ?? 100)
    const lines = this.buildLines(cols)
    this.writing = true
    try {
      // Clear previous region first.
      if (this.lastLines > 0) this.out.write(`\x1b[${this.lastLines}A\x1b[J`)
      this.out.write(lines.join("\n") + "\n")
    } finally {
      this.writing = false
    }
    this.lastLines = lines.length
  }

  private buildLines(cols: number): string[] {
    const spin = SPINNER[this.spinnerFrame]!
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000)
    const etaSec =
      this.completed > 0 && this.completed < this.total
        ? Math.round((elapsed / this.completed) * (this.total - this.completed))
        : 0
    const pct = this.total > 0 ? this.completed / this.total : 0
    const barWidth = Math.max(10, Math.min(40, Math.floor(cols / 4)))
    const filled = Math.round(pct * barWidth)
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled)
    const countsStr = Object.entries(this.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")

    const lines: string[] = []
    lines.push(
      truncate(
        `${spin} Overall: ${this.completed}/${this.total} ${bar} ${(pct * 100).toFixed(0).padStart(3)}% ` +
          `• elapsed ${fmt(elapsed)} • eta ${this.completed === this.total ? "0:00" : fmt(etaSec)}` +
          (countsStr ? ` • ${countsStr}` : ""),
        cols,
      ),
    )

    // Exit-status breakdown (top 4 buckets)
    const sortedStatuses = Object.entries(this.counts).sort((a, b) => b[1] - a[1])
    for (const [status, n] of sortedStatuses.slice(0, 4)) {
      const recents = (this.lastFinished[status] ?? []).slice(-3).join(", ")
      lines.push(truncate(`    ${status}: ${n}   ${recents}`, cols))
    }

    if (this.active.size > 0) {
      lines.push(truncate("─ Active workers " + "─".repeat(Math.max(0, cols - 17)), cols))
      const activeArr = [...this.active.entries()].sort((a, b) => a[1].idx - b[1].idx)
      for (const [id, e] of activeArr) {
        const dur = Math.floor((Date.now() - e.startedAt) / 1000)
        const frame = SPINNER[(this.spinnerFrame + e.idx) % SPINNER.length]
        lines.push(
          truncate(
            `    ${frame} ${id}  ${e.status}  ${fmt(dur)}`,
            cols,
          ),
        )
      }
    }

    return lines
  }
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

function truncate(s: string, max: number): string {
  // strip ANSI for length calc; widget output has none, so naive .length is OK.
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}
