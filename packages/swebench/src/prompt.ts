import type { SweBenchInstance } from "./types.ts"

/**
 * Sentinel emitted by the agent to signal "I am done, here is my final patch".
 *
 * This mirrors mini-swe-agent exactly: when the *first* line of a bash command's
 * stdout equals this marker, everything after it is treated as the submission
 * (the `model_patch`). See `extractSubmission` and the runner's event loop.
 */
export const SUBMISSION_MARKER = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"

/**
 * System prompt for the bash-only "swebench" agent.
 *
 * Kept verbatim from mini-swe-agent 2.2.7's `config/benchmarks/swebench.yaml`
 * `system_template`: a single line. All detailed task instructions live in the
 * instance prompt (see {@link miniInstancePrompt}), exactly as in mini-swe-agent.
 *
 * When an agent defines `prompt`, opencode uses it *in place of* the built-in
 * provider system prompt (see packages/opencode/src/session/llm.ts), so this is
 * the entire system prompt the model sees — matching mini-swe-agent, where the
 * agent has only a shell and no editing tools.
 */
export const MINI_SYSTEM_PROMPT =
  "You are a helpful assistant that can interact with a computer shell to solve programming tasks."
/**
 * Instance prompt for the bash-only agent. Reproduced from mini-swe-agent
 * 2.2.7's `config/benchmarks/swebench.yaml` `instance_template`, with two
 * adaptations for this harness:
 *   - `{{task}}` is the instance `problem_statement` only (no maintainer hints,
 *     matching mini-swe-agent, which never injects `hints_text`).
 *   - mini's hard-coded `/testbed` working directory is replaced by the
 *     per-instance checkout at `repoDir` (opencode runs every bash command in
 *     the session directory by default, so no `cd` prefix is needed).
 */
export function miniInstancePrompt(instance: SweBenchInstance, repoDir: string): string {
  return `<pr_description>
Consider the following PR description:
${instance.problem_statement.trim()}
</pr_description>

<instructions>
# Task Instructions

## Overview

You're a software engineer interacting continuously with a computer by submitting commands.
You'll be helping implement necessary changes to meet requirements in the PR description.
Your task is specifically to make changes to non-test files in the current directory in order to fix the issue described in the PR description in a way that is general and consistent with the codebase.
<IMPORTANT>This is an interactive process where you will think and issue AT LEAST ONE command, see the result, then think and issue your next command(s).</important>

For each response:

1. Include a THOUGHT section explaining your reasoning and what you're trying to accomplish
2. Provide one or more bash tool calls to execute

## Important Boundaries

- MODIFY: Regular source code files in ${repoDir} (this is the working directory for all your subsequent commands)
- DO NOT MODIFY: Tests, configuration files (pyproject.toml, setup.cfg, etc.)

## Recommended Workflow

1. Analyze the codebase by finding and reading relevant files
2. Create a script to reproduce the issue
3. Edit the source code to resolve the issue
4. Verify your fix works by running your script again
5. Test edge cases to ensure your fix is robust

## Command Execution Rules

You are operating in an environment where

1. You issue at least one command
2. The system executes the command(s) in a subshell
3. You see the result(s)
4. You write your next command(s)

Each response should include:

1. **Reasoning text** where you explain your analysis and plan
2. At least one tool call with your command

**CRITICAL REQUIREMENTS:**

- Your response SHOULD include reasoning text explaining what you're doing
- Your response MUST include AT LEAST ONE bash tool call. You can make MULTIPLE tool calls in a single response when the commands are independent (e.g., searching multiple files, reading different parts of the codebase).
- Directory or environment variable changes are not persistent. Every action is executed in a new subshell.
- However, you can prefix any action with \`MY_ENV_VAR=MY_VALUE cd /path/to/working/dir && ...\` or write/load environment variables from files

Example of a CORRECT response:
<example_response>
I need to understand the Builder-related code. Let me find relevant files and check the project structure.

[Makes multiple bash tool calls: {"command": "ls -la"}, {"command": "find src -name '*.java' | grep -i builder"}, {"command": "cat README.md | head -50"}]
</example_response>

## Environment Details

- You have a full Linux shell environment
- Always use non-interactive flags (-y, -f) for commands
- Avoid interactive tools like vi, nano, or any that require user input
- You can use bash commands or invoke any tool that is available in the environment
- You can also create new tools or scripts to help you with the task
- If a tool isn't available, you can also install it

## Submission

When you've completed your work, you MUST submit your changes as a git patch.
Follow these steps IN ORDER, with SEPARATE commands:

Step 1: Create the patch file
Run \`git diff -- path/to/file1 path/to/file2 > patch.txt\` listing only the source files you modified.
Do NOT commit your changes.

<IMPORTANT>
The patch must only contain changes to the specific source files you modified to fix the issue.
Do not submit file creations or changes to any of the following files:

- test and reproduction files
- helper scripts, tests, or tools that you created
- installation, build, packaging, configuration, or setup scripts unless they are directly part of the issue you were fixing (you can assume that the environment is already set up for your client)
- binary or compiled files
</IMPORTANT>

Step 2: Verify your patch
Inspect patch.txt to confirm it only contains your intended changes and headers show \`--- a/\` and \`+++ b/\` paths.

Step 3: Submit (EXACT command required)
You MUST use this EXACT command to submit:

\`\`\`bash
echo ${SUBMISSION_MARKER} && cat patch.txt
\`\`\`

If the command fails (nonzero exit status), it will not submit.

<CRITICAL>
- Creating/viewing the patch and submitting it MUST be separate commands (not combined with &&).
- If you modify patch.txt after verifying, you SHOULD verify again before submitting.
- You CANNOT continue working (reading, editing, testing) in any way on this task after submitting.
</CRITICAL>
</instructions>`
}

/**
 * If `output` is a bash command's stdout whose first non-blank line equals
 * {@link SUBMISSION_MARKER}, return everything after that line (the patch).
 * Otherwise return `undefined`. Mirrors mini-swe-agent's `_check_finished`.
 */
export function extractSubmission(output: string | undefined | null): string | undefined {
  if (!output) return undefined
  const trimmed = output.replace(/^\s+/, "")
  const nl = trimmed.indexOf("\n")
  const firstLine = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim()
  if (firstLine !== SUBMISSION_MARKER) return undefined
  return nl === -1 ? "" : trimmed.slice(nl + 1)
}

/**
 * Default prompt for opencode's native multi-tool `build` agent (used when
 * `--agent build` is passed). The built-in agent already provides a strong
 * system prompt plus `bash`/`read`/`edit`/`write`/`grep`/`glob` tools, so this
 * user prompt only needs the task framing and the "edit the files, then stop"
 * contract; the harness extracts the patch via `git diff` on the host worktree.
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
