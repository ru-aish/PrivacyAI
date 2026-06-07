#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
LIB_DIR="$ROOT_DIR/scripts/lib"
WITH_SERVICE=0

source "$LIB_DIR/ui.sh"
source "$LIB_DIR/providers.sh"

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-service)
        WITH_SERVICE=1
        ;;
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

setup_python_service() {
  if [[ "$WITH_SERVICE" -ne 1 ]]; then
    return 0
  fi

  if ! ui_have_cmd python3; then
    ui_log "python3 not found; skipping service gateway setup."
    return 0
  fi

  local service_dir="$ROOT_DIR/apps/service-gateway"
  local venv_dir="$service_dir/.venv"
  local log_file="${ROOT_DIR}/.pip-install.log"

  if [[ ! -d "$venv_dir" ]]; then
    ui_log "Creating Python virtual environment..."
    python3 -m venv "$venv_dir"
  fi

  if ui_run_quiet "Installing Python dependencies..." "$log_file" \
    "$venv_dir/bin/pip" install -r "$service_dir/requirements.txt"; then
    return 0
  fi

  ui_log "Python dependency installation failed. Retry with: npm run setup -- --with-service"
  return 1
}

main() {
  parse_args "$@"

  ui_log "PrivacyAI setup"
  ui_log "Repository: $ROOT_DIR"
  ui_log ""

  setup_node_dependencies
  setup_python_service

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
  if [[ "$WITH_SERVICE" -eq 1 ]]; then
    ui_log "Service gateway: cd apps/service-gateway && .venv/bin/python app.py"
  else
    ui_log "Optional service gateway: npm run setup -- --with-service"
  fi
}

main "$@"