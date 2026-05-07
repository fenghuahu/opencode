import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"

export interface SpawnedServer {
  url: string
  close(): void
}

/** Ask the kernel for a free TCP port on the given hostname. */
async function findFreePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, hostname, () => {
      const addr = srv.address()
      if (typeof addr === "object" && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
        return
      }
      srv.close(() => reject(new Error("failed to obtain free port")))
    })
  })
}

/**
 * If cli.ts re-exec'd us with the proxy env stripped, the originals were
 * stashed in `OPENCODE_SWEBENCH_OUTBOUND_PROXY`. Decode them so we can hand
 * them back to the spawned opencode server (which still needs the proxy to
 * reach external model endpoints).
 */
function readStashedProxy(): Record<string, string> {
  const raw = process.env.OPENCODE_SWEBENCH_OUTBOUND_PROXY
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Spawn an opencode server using an arbitrary command. Mirrors the SDK's
 * `createOpencodeServer` but lets us point at the workspace dev entry instead
 * of whatever `opencode` is on PATH (the binary on PATH may be older than the
 * v2 HTTP API the SDK expects, producing
 * "Server responded with text/html" errors from the client interceptor).
 *
 * `command` should be one of:
 *   - "opencode"                                                (use PATH)
 *   - "/abs/path/to/opencode"                                   (absolute bin)
 *   - "bun run --conditions=browser /abs/path/to/src/index.ts"  (dev source)
 */
export async function spawnServer(opts: {
  command: string
  cwd?: string
  hostname?: string
  port?: number
  configJson: string
  timeoutMs?: number
  log?: (line: string) => void
}): Promise<SpawnedServer> {
  const hostname = opts.hostname ?? "127.0.0.1"
  const port = opts.port ?? (await findFreePort(hostname))
  const timeoutMs = opts.timeoutMs ?? 30_000

  const tokens = tokenize(opts.command)
  if (tokens.length === 0) throw new Error("empty --opencode-bin")
  const [bin, ...prefix] = tokens
  const args = [...prefix, "serve", `--hostname=${hostname}`, `--port=${port}`]

  const proc: ChildProcess = spawn(bin!, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      // Restore the original proxy env (stashed by cli.ts re-exec) so the
      // opencode server can still reach external model endpoints, even though
      // we stripped them from our own process to make local SDK calls work.
      ...readStashedProxy(),
      OPENCODE_CONFIG_CONTENT: opts.configJson,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return new Promise<SpawnedServer>((resolve, reject) => {
    let buffer = ""
    let stderr = ""
    let resolved = false

    const timer = setTimeout(() => {
      if (resolved) return
      proc.kill("SIGKILL")
      reject(
        new Error(
          `Timeout waiting for opencode server (cmd: ${opts.command}). ` +
            `stderr:\n${stderr}\nstdout:\n${buffer}`,
        ),
      )
    }, timeoutMs)

    proc.stdout!.on("data", (chunk) => {
      const s = chunk.toString()
      buffer += s
      if (resolved) return
      for (const line of buffer.split("\n")) {
        if (line.startsWith("opencode server listening")) {
          const m = line.match(/on\s+(https?:\/\/[^\s]+)/)
          if (!m) continue
          resolved = true
          clearTimeout(timer)
          resolve({
            url: m[1]!,
            close() {
              proc.kill("SIGTERM")
            },
          })
          return
        }
      }
    })
    proc.stderr!.on("data", (chunk) => {
      stderr += chunk.toString()
      if (opts.log) opts.log(`[opencode] ${chunk.toString().trimEnd()}`)
    })
    proc.on("exit", (code) => {
      if (resolved) return
      clearTimeout(timer)
      reject(
        new Error(
          `opencode server exited with code ${code} before listening (cmd: ${opts.command}).\n` +
            `stderr:\n${stderr}\nstdout:\n${buffer}`,
        ),
      )
    })
    proc.on("error", (err) => {
      if (resolved) return
      clearTimeout(timer)
      reject(new Error(`failed to spawn opencode (cmd: ${opts.command}): ${err.message}`))
    })
  })
}

/** Minimal POSIX-ish tokenizer; supports `"a b"` and `'a b'` and \\-escape. */
function tokenize(input: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < input.length) {
    const c = input[i]!
    if (quote) {
      if (c === "\\" && i + 1 < input.length) {
        cur += input[i + 1]
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'"
      i++
      continue
    }
    if (c === "\\" && i + 1 < input.length) {
      cur += input[i + 1]
      i += 2
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ""
      }
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur) out.push(cur)
  return out
}
