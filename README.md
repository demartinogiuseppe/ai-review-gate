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
        "matcher": "Write|Edit|MultiEdit",
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
