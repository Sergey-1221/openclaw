#!/usr/bin/env bash
# Agent workspace setup for Avelton-claw: run when Code.Avelton provisions this
# repository onto a machine (OpenHands-avelton2 scripts/provision-remote-workspace.sh)
# and by OpenHands at conversation start; safe to run by hand, and to source.
#
# Installs dependencies only where they are missing, so a second run is quick, and
# skips anything unavailable with a warning instead of failing. Written by
# OpenHands-avelton2 `npm run projects -- onboard`; edit freely, nothing regenerates it.

_Avelton_claw_openhands_setup() (
  set -u
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$SCRIPT_DIR/.." || exit 1

  warn() { printf '\033[1;33m[setup] %s\033[0m\n' "$*"; }
  info() { printf '[setup] %s\n' "$*"; }
  have() { command -v "$1" >/dev/null 2>&1; }

  if [ -d "./node_modules" ]; then
    info "Avelton-claw: node_modules present"
  elif have pnpm || { have corepack && corepack enable pnpm >/dev/null 2>&1 && have pnpm; }; then
    info "Avelton-claw: pnpm install --frozen-lockfile"
    (cd "." && pnpm install --frozen-lockfile) || warn "Avelton-claw: pnpm install failed"
  else
    warn "Avelton-claw: pnpm not found — skipped"
  fi
)

_Avelton_claw_openhands_setup
status=$?
return "$status" 2>/dev/null || exit "$status"
