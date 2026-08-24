#!/usr/bin/env sh
# POSIX wrapper around the aigate Claude Code hook.
#
# Wire this as a PostToolUse hook on Write|Edit|MultiEdit (see README for why
# PostToolUse and not PreToolUse). It forwards the hook JSON on stdin, or any
# file paths given as arguments, to hooks/aigate-hook.mjs.
#
#   exit 0  allow
#   exit 2  block; stderr is fed back to the agent
set -eu

HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$HOOK_DIR/aigate-hook.mjs" "$@"
