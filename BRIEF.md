# BRIEF — AI Review Gate (self-hosted, GitHub + Claude Code)

## Goal
Build a **single self-hosted quality gate for AI-generated code** that:
1. Runs **during Claude Code sessions** (pre-write / pre-edit hook) with fast checks
2. Runs **on GitHub PRs** as one required check (`ai-review`) with the same policy
3. Prioritizes failure modes typical of LLM coding agents, not generic style nits

This is NOT a generic AI PR reviewer clone. It is a **compiler-like gate for coding agents**.

## Non-goals (do not build in MVP)
- Full SaaS / multi-tenant product
- Replacing CodeRabbit/Greptile feature-for-feature
- Heavy multi-agent “deep review” on every keystroke
- Supporting every language on day one

## Primary users
- Devs using Claude Code / similar agents on GitHub repos (start with **TypeScript/JavaScript + npm**)

## Core principles
1. **Deterministic checks first**, LLM review second (and optional in-session)
2. **One policy file** shared by hook + CI
3. **Fast in session** (seconds): registry + semgrep on touched files only
4. **Stricter in CI**: same checks + optional deeper review on full PR diff
5. Machine-readable failures the agent can fix (`CODE: message`)

## MVP scope

### A. Policy
File: `policy.yml`
- `block_on`: list of rule codes that fail the gate
- `critical_paths`: globs (e.g. `src/auth/**`, `src/payments/**`)
- Default block: missing registry packages, semgrep errors, high severity issues
- Style/nits: comment only, never block in MVP

### B. Registry check (critical differentiator)
- Parse added/changed `import` / `require` / `from` in TS/JS from a diff or file list
- Resolve bare package names (ignore relative `./` and `../`)
- Check package exists on **npm** registry
- Fail with: `REGISTRY_MISSING_PACKAGE: <name>`
- Skip node builtins

### C. Semgrep
- Run on changed files only in-session; on PR diff paths in CI
- Start with community rules for secrets + injection (or a minimal local ruleset)
- Map findings to codes like `SEMGREP_ERROR: ...`

### D. Orchestrator CLI
Package name suggestion: `ai-review-gate` (or `aigate`)

Commands:
- `aigate check --files f1 f2`  → session/hook use (fast)
- `aigate check --diff BASE...HEAD` → CI use
- `aigate print-policy` → debug
Exit codes: `0` pass, `1` block, `2` tool error

Output:
- Human summary on stderr/stdout
- Optional `--json` for machine use

### E. Claude Code hook integration
- Provide a script `hooks/pre-write.sh` (or equivalent) that:
  - receives file path(s) being written/edited
  - runs `aigate check --files ...`
  - exits non-zero on block so the write can be rejected / agent gets the error
- Document exact Claude Code hook wiring in README (keep config minimal)
- In-session: **no LLM review by default** (too slow). Only registry + semgrep.

### F. GitHub Action
- Reusable workflow: `.github/workflows/ai-review.yml` with `workflow_call`
- Example consumer workflow snippet in README
- On `pull_request`: checkout, run `aigate check --diff`, upload summary, fail job on block
- Optional: post a single PR comment summarizing blockers (keep noise low)

### G. Optional LLM review (CI only in MVP)
- Stub interface: `aigate review --diff` that can call an OpenAI-compatible endpoint
- Default **off** unless `AIGATE_LLM_URL` / key set
- If enabled: one short pass, high-signal only; must not duplicate registry/semgrep
- Prefer integrating later with existing tools (e.g. Open Code Review) rather than inventing a complex agent

## Repo structure (create this)