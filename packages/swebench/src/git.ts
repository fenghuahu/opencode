import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"

/**
 * cli.ts strips `*_proxy` from this process so SDK calls to localhost don't
 * accidentally route through a corporate proxy (Bun's fetch caches proxy
 * resolution at startup and ignores literal 127.0.0.1 in NO_PROXY on some
 * versions). The originals are stashed in OPENCODE_SWEBENCH_OUTBOUND_PROXY so
 * git (and any other outbound-network child) can opt back in.
 */
function envWithProxy(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const raw = process.env.OPENCODE_SWEBENCH_OUTBOUND_PROXY
  if (raw) {
    try {
      const stash = JSON.parse(raw) as Record<string, string>
      for (const [k, v] of Object.entries(stash)) env[k] = v
    } catch {
      // ignore
    }
  }
  return env
}

/**
 * Run a command and capture stdout. Throws if the exit code is non-zero.
 */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? envWithProxy(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c.toString()))
    child.stderr.on("data", (c) => (stderr += c.toString()))
    const t = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error(`${cmd} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`))
        }, opts.timeoutMs)
      : undefined
    child.on("error", (e) => {
      if (t) clearTimeout(t)
      reject(e)
    })
    child.on("close", (code) => {
      if (t) clearTimeout(t)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

/**
 * Ensure `<workspaceRoot>/<instance_id>` is a clean git checkout of `repo`
 * at `base_commit`. If the directory already exists with the right HEAD it is
 * reused (cloning is the expensive step on SWE-bench).
 */
export async function ensureRepo(args: {
  workspaceRoot: string
  instanceId: string
  repo: string
  baseCommit: string
}): Promise<string> {
  const { workspaceRoot, instanceId, repo, baseCommit } = args
  await mkdir(workspaceRoot, { recursive: true })
  const dir = path.join(workspaceRoot, instanceId)

  if (!existsSync(path.join(dir, ".git"))) {
    const url = `https://github.com/${repo}.git`
    await exec("git", ["clone", "--quiet", "--no-tags", url, dir])
  }

  // Discard any stray changes from a previous run.
  await exec("git", ["reset", "--hard", "--quiet"], { cwd: dir }).catch(() => {})
  await exec("git", ["clean", "-fdx", "--quiet"], { cwd: dir }).catch(() => {})

  // Make sure we have the requested commit; fetch lazily if not.
  const has = await exec("git", ["cat-file", "-e", `${baseCommit}^{commit}`], { cwd: dir })
    .then(() => true)
    .catch(() => false)
  if (!has) {
    await exec("git", ["fetch", "--quiet", "origin", baseCommit], { cwd: dir })
  }
  await exec("git", ["checkout", "--quiet", "--detach", baseCommit], { cwd: dir })

  return dir
}

/**
 * Compute the unified diff between `base_commit` and the current worktree
 * (staged + unstaged + untracked). The output is the SWE-bench `model_patch`.
 */
export async function diffSinceBase(repoDir: string, baseCommit: string): Promise<string> {
  // Stage everything — including new files — so a single `git diff --cached`
  // against base_commit captures additions, modifications and deletions.
  await exec("git", ["add", "-A"], { cwd: repoDir })
  const { stdout } = await exec(
    "git",
    ["diff", "--no-color", "--binary", "--cached", baseCommit, "--"],
    { cwd: repoDir },
  )
  return stdout
}
