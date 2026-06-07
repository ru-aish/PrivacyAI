#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
LIB_DIR="$ROOT_DIR/scripts/lib"

source "$LIB_DIR/ui.sh"
source "$LIB_DIR/providers.sh"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --provider)
        shift
        export PRIVACY_AI_SETUP_PROVIDER="${1:-ollama}"
        ;;
      *)
        ui_log "Unknown option: $1"
        exit 1
        ;;
    esac
    shift
  done
}

setup_node_dependencies() {
  local log_file="${ROOT_DIR}/.pnpm-install.log"

  if ! ui_have_cmd pnpm; then
    ui_log "pnpm not found. Install it from https://pnpm.io/installation"
    return 1
  fi

  ui_run_quiet "Installing Node dependencies..." "$log_file" \
    pnpm install --reporter=append-only
}

main() {
  parse_args "$@"

  ui_log "PrivacyAI setup"
  ui_log "Repository: $ROOT_DIR"
  ui_log ""

  setup_node_dependencies

  if provider_configure; then
    provider_write_env_file "$ENV_FILE"
    ui_log ""
    ui_log "Wrote env file: $ENV_FILE"
  else
    ui_log "Provider setup did not complete."
    exit 1
  fi

  ui_log ""
  ui_log "Ready."
  ui_log "SDK docs: packages/sdk/README.md"
  ui_log "Web demo: npm run demo"
}

main "$@"