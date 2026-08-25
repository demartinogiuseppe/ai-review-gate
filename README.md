# ai-review-gate

**Same policy in the agent session and in CI. The error goes back to the agent in the
same turn.**

Most AI review tools comment on a pull request after the agent has finished and moved
on. By then the mistake is three files deep, and you are the one unpicking it.
ai-review-gate closes the loop while the session is still open:

```
generate -> reject -> repair
```

The agent writes a file. The hook checks it in milliseconds and exits `2`. Claude Code
puts the findings back in front of the model, which repairs them before it writes
anything else. The same `policy.yml` then runs over the whole diff as one required
`ai-review` check on the pull request, so the rule that stopped the write in session is
the rule that stops the merge. They load the same file; they cannot drift.

Feedback latency is the product. The checks are the engine.

## What the agent sees

```
BLOCKING (1)
  REGISTRY_MISSING_PACKAGE: "claude-super-helper-toolkit" does not exist
    (not found on the registry); imported as "claude-super-helper-toolkit" [src/app.ts:2]
    fix: remove the import of "claude-super-helper-toolkit" or replace it with a package that actually exists

aigate: BLOCK — 1 blocking finding(s) in 1 file(s) (431ms)
```

Every finding is `CODE: message [file:line]` plus a `fix:` line, because the reader is
usually an agent correcting its own output rather than a human reading a report. Exit
codes are the whole contract: **0** pass, **1** blocked by policy, **2** the gate itself
failed.

## Engines today

The loop is the product. What runs inside it is meant to be swapped and added to.

- **npm registry.** Imported packages that do not exist, caught at write time instead
  of at install time. Lookups are cached on disk, so a repeat write costs single-digit
  milliseconds.
- **semgrep.** A small local ruleset aimed at agent output rather than style: secrets,
  interpolated shell and SQL, disabled TLS verification, swallowed errors, placeholder
  implementations. Optional; if semgrep is missing the gate says so and carries on.
- **Optional LLM pass.** Off unless you point it at an endpoint. CI only, advisory by
  default, and forbidden from repeating what the deterministic checks already said.

Self-hosted throughout: your runner, your policy file, no review SaaS in the path.

## Design rules

1. **Deterministic checks first.** The LLM pass is optional, CI-only, and advisory.
2. **One policy file.** The hook and the PR check load the same `policy.yml`. They
   cannot drift.
3. **Fast in session.** Registry + semgrep, changed files only. Repeat lookups are
   cached on disk, so a second write costs single-digit milliseconds.
4. **Stricter in CI.** Same checks over the whole PR diff, plus an optional LLM pass.
5. **Machine-readable failures.** Every line is `CODE: message [file:line]`, because
   the reader is usually an agent trying to fix its own mistake.
6. **A broken gate never blocks.** Registry unreachable, semgrep missing, endpoint
   down: those degrade to notes. A gate that fails honest PRs gets deleted.

## Install

```bash
npm install --save-dev ai-review-gate
npx aigate print-policy          # see what is in effect
```

Node 18+. Zero runtime dependencies. semgrep is optional — install it with
`pipx install semgrep` to enable the static-analysis rules.

## Usage

```bash
aigate check --files src/a.ts src/b.ts   # fast; what the hook runs
aigate check --diff origin/main...HEAD   # the whole PR; what CI runs
aigate check --diff HEAD~1...HEAD --json # machine-readable
aigate print-policy                      # resolved policy and where it came from
aigate review --diff origin/main...HEAD  # optional LLM pass (off unless configured)
```

Exit codes: **0** pass, **1** blocked by policy, **2** the gate itself failed.
Those three are the whole contract — everything downstream keys off them.

Useful flags: `--format human|json|markdown`, `--output <file>`, `--policy <path>`,
`--no-registry`, `--no-semgrep`, `--no-color`, `--cwd <dir>`. `--files -` reads
newline-separated paths from stdin.

## Policy

`policy.yml`, discovered by walking up from the working directory:

```yaml
version: 1

block_on:                      # these codes fail the gate; everything else is a note
  - REGISTRY_MISSING_PACKAGE
  - SEMGREP_ERROR

critical_paths:                # where the bar is higher
  - "src/auth/**"
  - "src/payments/**"

critical_path_block_on:        # extra codes that block, but only in those paths
  - SEMGREP_WARNING

ignore_paths:
  - "**/node_modules/**"
  - "**/dist/**"

registry:
  enabled: true
  timeout_ms: 4000
  allow_offline: true          # unreachable registry warns, never blocks
  allowlist: []                # internal packages that will never resolve publicly
  registry_url: "https://registry.npmjs.org"
  cache_ttl_hours: 168

semgrep:
  enabled: true
  config: ["semgrep/rules.yml"]   # add "p/secrets", "p/javascript" in CI
  timeout_ms: 60000

llm:
  enabled: false
  url: ""
  model: "gpt-4o-mini"
```

Severity does not decide anything — `block_on` does. An `error` the policy does not
list is a note; an `info` the policy does list blocks. One list, one place to look.

### Codes

| Code | Severity | Blocks by default | Meaning |
| --- | --- | --- | --- |
| `REGISTRY_MISSING_PACKAGE` | error | **yes** | Imported package does not exist on the registry |
| `REGISTRY_UNDECLARED_PACKAGE` | warning | no | Package is real but missing from `package.json` |
| `REGISTRY_UNVERIFIED` | warning | no | Could not reach the registry; existence unknown |
| `SEMGREP_ERROR` | error | **yes** | semgrep rule at ERROR severity |
| `SEMGREP_WARNING` | warning | in critical paths | semgrep rule at WARNING severity |
| `SEMGREP_INFO` | info | no | semgrep rule at INFO severity |
| `SEMGREP_UNAVAILABLE` | info | no | semgrep not installed, timed out, or misconfigured |
| `CRITICAL_PATH_TOUCHED` | info | no | The change touches a path marked critical |
| `LLM_ISSUE` | varies | no | Finding from the optional LLM pass |
| `LLM_UNAVAILABLE` | info | no | The LLM pass was skipped or failed |

## Claude Code hook

Add to `.claude/settings.json` (or `.claude/settings.local.json`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node ./node_modules/ai-review-gate/hooks/aigate-hook.mjs",
            "timeout": 20
          }
        ]
      },
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "node ./node_modules/ai-review-gate/hooks/aigate-hook.mjs",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

That is the whole configuration. The hook reads Claude Code's JSON payload from
stdin, pulls out the touched paths, runs `aigate check --files`, and exits **2** on a
block — which is how Claude Code feeds the findings back to the agent so it fixes them
in the same turn. On a clean write it prints nothing.

**Bash, sed and heredoc writes are covered via changed-file detection.** An agent that
edits a file with `cat > src/app.ts <<'EOF'`, `sed -i`, or a python script sends a
payload with no file path in it, so a matcher on `Write|Edit|MultiEdit` alone never
runs and the change reaches the pull request ungated. That is a hole in the loop, not a
gap in coverage, which is why the second matcher exists. On a shell command the hook
checks whether the command could have written anything at all, and only then asks git
what the worktree is carrying: `git status --porcelain` (not `git diff`, because a
heredoc usually produces an untracked file that `git diff` cannot see), narrowed to
source files modified in the last five minutes, capped at 40, then handed to the same
`aigate check --files`. A read-only command exits 0 without spawning git. So does a
command that only touched files the policy ignores.

Two consequences worth knowing before you wire it up. The write-detection is a
heuristic over the command string, generous by design but not a proof: set
`AIGATE_HOOK_ALL_COMMANDS=1` to run the changed-file scan after every command instead.
And because the scan looks at the worktree rather than at one file, a blocking finding
that is already sitting uncommitted will be reported again after the next shell write,
until it is fixed or committed.

**Why PostToolUse and not PreToolUse.** PreToolUse fires *before* the write lands, so
the file on disk still holds the old content — the check would pass on precisely the
change you wanted to catch. PostToolUse runs against what was actually written. The
write is not undone; the agent is told to fix it, immediately, before moving on.

POSIX users can point the hook at `hooks/pre-write.sh` instead; it is a thin wrapper
around the same script. Both work on Windows, macOS and Linux.

Environment:

| Variable | Effect |
| --- | --- |
| `AIGATE_BIN` | Path to the aigate CLI entry point (defaults to the installed package) |
| `AIGATE_HOOK_STRICT=1` | Fail closed: block when the gate itself cannot run |
| `AIGATE_HOOK_VERBOSE=1` | Also print the report on a passing check |
| `AIGATE_CACHE_DIR` | Where the registry cache lives (default `.aigate-cache/`) |
| `AIGATE_HOOK_ALL_COMMANDS=1` | Run the changed-file scan after every shell command, not just write-looking ones |
| `AIGATE_COMMAND_WINDOW_MS` | How recent a change must be to count as the command's (default `300000`) |

No LLM runs in-session. It is too slow for a write hook and the deterministic checks
already cover what an agent gets wrong on that timescale.

## GitHub Action

Call the reusable workflow from your own:

```yaml
# .github/workflows/pr.yml
name: pr
on: pull_request

jobs:
  ai-review:
    permissions:
      contents: read
      pull-requests: write     # only needed for the summary comment
    uses: your-org/ai-review-gate/.github/workflows/ai-review.yml@v0
    with:
      node-version: '20'
      policy: policy.yml
      install-semgrep: true
      comment: true
```

Then make `ai-review` a required status check in branch protection.

The job checks out with full history (the gate diffs against the merge base), runs
`aigate check --diff <base>...HEAD`, writes the markdown report to the job summary,
uploads `aigate-report.json` as an artifact, and posts **one** PR comment that it
updates in place on every run rather than adding a new one.

Inputs: `node-version`, `policy`, `working-directory`, `aigate-spec`,
`install-semgrep`, `comment`, `llm-review`. Secrets: `llm-url`, `llm-api-key`.

## Optional LLM review

Off unless an endpoint is configured. It is deliberately narrow: the prompt forbids
repeating anything the deterministic checks already cover, and asks only for defects
no rule can express — logic that contradicts the diff's own intent, a mutation missing
from a sibling branch, a dropped async failure, a removed security check.

```yaml
with:
  llm-review: true
secrets:
  llm-url: ${{ secrets.AIGATE_LLM_URL }}       # any OpenAI-compatible endpoint
  llm-api-key: ${{ secrets.AIGATE_LLM_API_KEY }}
```

Locally: `AIGATE_LLM_URL=... AIGATE_LLM_API_KEY=... aigate review --diff main...HEAD`.

`LLM_ISSUE` is not in `block_on`, so the pass is advisory until you add it. That is on
purpose — a model having a bad day should not fail anyone's build.

## The semgrep engine

One engine under the loop, off the shelf and replaceable. `semgrep/rules.yml` ships a
small ruleset aimed at agent output, not style: hardcoded credentials, AWS keys and
private key blocks, `eval` on non-literals, shell and SQL built by interpolation,
disabled TLS verification, swallowed errors, non-null assertions on parsed input, and
placeholder implementations left behind.

Add the community packs in CI for more coverage:

```yaml
semgrep:
  config: ["semgrep/rules.yml", "p/secrets", "p/javascript"]
```

If semgrep is not installed the gate reports `SEMGREP_UNAVAILABLE` and carries on with
the registry check, so nobody is forced to install a Python toolchain to get value.

## Data and privacy

No telemetry. Nothing is reported back to the author of this tool, in any
configuration: there is no account, no service behind it, and one hardcoded URL in the
entire codebase (`registry.npmjs.org`, and you can point that elsewhere).

**The gate never calls a model.** `aigate check` is the hook and the PR check, and it
has no LLM code path at all: `src/gate.ts` does not import one. That is structural
rather than a default someone can flip in a config file.

What leaves your machine, and when:

| Path | What is sent | Where |
| --- | --- | --- |
| Registry check | Imported **package names**, never file contents | `registry.registry_url`, npm by default |
| semgrep | Nothing | Local process |
| `aigate review` | The diff, truncated | The endpoint **you** configure, and nowhere else |

Package names are metadata, but they are still metadata: on a private repo, an internal
package name tells a public registry that the name exists. Set `registry.allowlist` for
those, and they are never looked up.

Registry answers are cached in `.aigate-cache/` (gitignored) so the second write costs
no network at all.

The LLM pass is off until you give it an endpoint, via `AIGATE_LLM_URL` or `llm.url` in
the policy; with no URL it never runs. When it does run it sends the diff to that
endpoint, whether that is OpenAI, a gateway your company controls, or a model on your
laptop. One thing worth knowing before you enable it: the API key is read as
`AIGATE_LLM_API_KEY` first and falls back to `OPENAI_API_KEY`, so if you already have
that variable in your environment, that is the key it will use.

## Development

```bash
npm install
npm run build
npm test          # builds, then runs the node:test suite
node dist/src/cli.js check --files src/cli.ts
```

Layout: `src/checks/` holds the checks (each returns findings and decides nothing),
`src/gate.ts` is the only place findings become a verdict, `src/report.ts` formats,
`src/cli.ts` wires it up. Tests use fake registries and fake process runners, so the
suite is fully offline and deterministic.

## Scope

In: TypeScript/JavaScript, npm, GitHub, Claude Code.

Not in this version: other languages and registries, multi-tenant SaaS, a deep
multi-agent review on every keystroke, or feature parity with hosted PR reviewers.
