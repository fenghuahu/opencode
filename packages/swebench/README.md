# @opencode-ai/swebench

Run [opencode](https://opencode.ai) against [SWE-bench](https://www.swebench.com/) instances
and emit a `predictions.jsonl` file compatible with the official harness
(`python -m swebench.harness.run_evaluation`).

## Quick start

```bash
# 1) install workspace deps from repo root
bun install

# 2) prepare an instances file (JSONL, one SWE-bench instance per line)
#    each line must include at least: instance_id, repo, base_commit, problem_statement
#    optional: hints_text, version

# 3) pick a model
#    a) built-in provider (provider known to opencode):
export ANTHROPIC_API_KEY=sk-...
#    b) any OpenAI-compatible endpoint (DeepSeek, Moonshot, OpenRouter,
#       vLLM, Ollama, LM Studio, llama.cpp, ...): see "Custom provider" below.

# 4) run
bun packages/swebench/bin/opencode-swebench \
  --instances ./swebench_lite.jsonl \
  --output ./predictions.jsonl \
  --model anthropic/claude-sonnet-4-5 \
  --workspace-root /tmp/swebench-workspaces \
  --concurrency 2 \
  --timeout-ms 600000
```

## Custom provider (any OpenAI-compatible endpoint)

Pass `--base-url` and (optionally) `--api-key` to register a synthetic provider
on the fly. The `--model` value is then the **bare** model id served by that
endpoint.

```bash
# DeepSeek
bun packages/swebench/bin/opencode-swebench \
  --instances ./swebench_lite.jsonl --output ./predictions.jsonl \
  --base-url https://api.deepseek.com/v1 \
  --api-key   $DEEPSEEK_API_KEY \
  --provider-id deepseek \
  --model deepseek-coder

# Local vLLM / Ollama / LM Studio
bun packages/swebench/bin/opencode-swebench \
  --instances ./swebench_lite.jsonl --output ./predictions.jsonl \
  --base-url http://localhost:11434/v1 \
  --provider-id ollama \
  --model qwen2.5-coder:32b

# OpenRouter
bun packages/swebench/bin/opencode-swebench \
  --instances ./swebench_lite.jsonl --output ./predictions.jsonl \
  --base-url https://openrouter.ai/api/v1 \
  --api-key  $OPENROUTER_API_KEY \
  --provider-id openrouter \
  --model qwen/qwen3-coder
```

Internally this injects an opencode `provider` config block:

```jsonc
{
  "provider": {
    "<provider-id>": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "...", "apiKey": "..." },
      "models": { "<model>": { "name": "<model>" } }
    }
  }
}
```

so the same workflow works with anything that speaks the OpenAI Chat
Completions API. Override the implementation package with `--provider-npm`
if you need a different ai-sdk adapter.

## Cost (litellm-style pricing)

Cost is computed the way litellm does it: the model's per-token input/output
price is looked up in litellm's price table
(`model_prices_and_context_window.json`) and multiplied by the token counts.
The resolved price is handed to opencode, which does the accounting natively, so
the per-instance and overall cost show up live in the progress widget and in the
final `summary` line.

```bash
# Built-in / well-known model ids resolve automatically from the litellm table
bun packages/swebench/bin/opencode-swebench \
  --instances ./swebench_lite.jsonl --output ./predictions.jsonl \
  --model openai/gpt-4o
```

Pricing resolution order:

1. `--cost-input` / `--cost-output` (and `--cost-cache-read` / `--cost-cache-write`),
   USD per 1M tokens — explicit manual override.
2. `LITELLM_LOCAL_MODEL_COST_MAP=True` — force the price table bundled inside the
   installed litellm package (no network), same env var litellm / mini-swe-agent honour.
3. `--price-table <path|url>` — a specific litellm-format table.
4. Default — litellm's table on GitHub, falling back to the installed litellm
   package's bundled backup table when offline.

> **Self-hosted models (vLLM, Ollama, …) are usually _not_ in the litellm table**,
> so their cost resolves to `$0` and a `WARNING` is printed. Supply the price
> manually to get real numbers:
>
> ```bash
>   --model Qwen3-235B-A22B-FP8 --cost-input 0.5 --cost-output 1.5
> ```

## Container mode (mini-swe-agent parity)

By default the agent runs `bash` commands on the host. Pass `--container` to
run every agent shell command **inside the official SWE-bench eval image** for
that instance (the same image the harness uses, and the same environment
mini-swe-agent runs in), while opencode's file tools (`read`/`edit`/`grep`)
and the final `git diff` keep operating on local files.

```bash
bun packages/swebench/bin/opencode-swebench \
  --instances ./swebench_lite.jsonl --output ./predictions.jsonl \
  --model openai/gpt-4o \
  --container
```

This requires a `docker`- or `podman`-compatible CLI on `PATH`. Override the
image name with `--container-image <tmpl>`; the template supports `{instance}`
(normalized id: `__`->`_1776_`, lowercased) and `{instance_id}` (raw id):

```bash
  --container-image 'docker.io/swebench/sweb.eval.x86_64.{instance}:latest'
```

### How container mode works

No opencode core changes are required — it reuses opencode's `config.shell`
option. For each instance the runner:

1. Pulls the eval image if it is not already present locally.
2. Starts the image, checks out `base_commit` in `/testbed`, and `docker cp`s
   the image's built `/testbed` (including `.git` and any compiled artifacts /
   editable install) onto the host worktree.
3. Re-runs the container with the host worktree **bind-mounted over**
   `/testbed`, so edits made by opencode's file tools are visible inside the
   container and vice-versa.
4. Injects a small POSIX-sh wrapper as `config.shell`. opencode invokes the
   bash tool as `<wrapper> -c "<command>"`; the wrapper translates the current
   working directory from the host path to the container's `/testbed` path and
   runs `docker exec -w <path> <container> /bin/bash -c "<command>"`.
5. Tears the container down after the instance finishes (and force-removes any
   strays at the end of the run).

Because the bind mount copies the image's pre-built `/testbed` to the host
first, the compiled artifacts / editable install from the eval image are
preserved. This is faithful for SWE-bench Lite (mostly pure Python). Instances
that depend on absolute container build paths baked outside `/testbed` may need
extra care.

## How it works

For each SWE-bench instance the runner:

1. Clones `https://github.com/<repo>.git` into `<workspace-root>/<instance_id>`
   and checks out `base_commit` (skipped if the directory already exists).
2. Spawns a single long-lived `opencode serve` process via the JS SDK.
3. Targets the per-instance worktree using the `directory` query parameter
   so one server services all instances sequentially / concurrently.
4. Creates a session with permissive rules, sends the SWE-bench prompt
   (problem statement + repo path) and subscribes to the SSE event stream.
5. Auto-approves any permission request, auto-rejects the interactive
   `question` / `plan_*` permissions (matching `opencode run` behaviour).
6. Waits for `session.status` -> `idle`, then runs `git diff <base_commit>`
   inside the worktree to obtain the model patch.
7. Appends `{instance_id, model_name_or_path, model_patch}` to the output JSONL.

## Notes

- The runner does **not** apply `test_patch`; the official SWE-bench harness
  applies it on top of `base_commit + model_patch` during evaluation.
- The agent is restricted to the worktree directory; tools like `bash`/`edit`
  cannot escape it without the `external_directory` permission (denied here).
- Use `--keep-workspaces` to preserve clones for inspection. By default
  workspaces are kept (cloning is the expensive step) and you can re-run.
- With `--container`, agent `bash` commands run inside the official eval image
  instead of on the host (see "Container mode" above); file tools and the final
  `git diff` still operate on the host worktree.
