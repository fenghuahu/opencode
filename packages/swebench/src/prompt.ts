import type { SweBenchInstance } from "./types.ts"

/**
 * Default prompt template — modelled after mini-swe-agent / SWE-agent so that
 * the agent has enough context to localise and patch the bug without us
 * orchestrating multi-turn dialog. The opencode `build` agent already provides
 * a strong system prompt with editing tools (`bash`, `read`, `edit`, `write`,
 * `grep`, `glob`), so the user prompt only needs the task framing.
 */
export function defaultPrompt(instance: SweBenchInstance, repoDir: string): string {
  const hints = instance.hints_text?.trim()
    ? `\n\n## Hints (from maintainers)\n${instance.hints_text.trim()}`
    : ""

  return `You are operating inside a git checkout of the \`${instance.repo}\` repository at commit \`${instance.base_commit}\`.

The repository is located at: ${repoDir}

Your task is to resolve the following GitHub issue by editing the source files in this repository. Do **not** modify any tests — the evaluation harness applies a hidden test patch on top of your changes.

## Issue
${instance.problem_statement.trim()}${hints}

## Instructions
1. Explore the repository structure (use \`grep\`, \`glob\`, \`read\` as needed).
2. Localise the bug to a small set of files.
3. Make a minimal, focused code change that fixes the issue.
4. Do not run the test suite, do not commit, do not push. Just edit the files.
5. When you are confident the fix is correct, stop.
`
}
