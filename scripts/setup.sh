#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
MODEL="${PRIVATE_AI_MODEL:-qwen3.5:2b}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"

log() {
  printf '%s\n' "$1"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

detect_gpu() {
  if have_cmd nvidia-smi; then
    echo "nvidia"
  elif have_cmd rocm-smi || have_cmd rocminfo; then
    echo "rocm"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    echo "apple-silicon-or-intel"
  else
    echo "cpu"
  fi
}

ensure_env_file() {
  cat > "$ENV_FILE" <<EOF
PRIVATE_AI_PROVIDER=ollama
PRIVATE_AI_BASE_URL=http://127.0.0.1:11434
PRIVATE_AI_API_KEY=ollama
PRIVATE_AI_MODEL=$MODEL
PRIVATE_AI_NUM_CTX=8192
PRIVATE_AI_TIMEOUT_MS=120000
EOF
}

ensure_ollama_running() {
  if curl -fs "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
    return 0
  fi

  if ! have_cmd ollama; then
    log "Ollama is not installed."
    log "Install it from: https://ollama.com/download"
    return 1
  fi

  log "Starting Ollama in the background..."
  nohup ollama serve >"$ROOT_DIR/.ollama.log" 2>&1 &
  for _ in $(seq 1 20); do
    if curl -fs "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  log "Ollama did not become ready."
  return 1
}

pull_model() {
  if ! have_cmd ollama; then
    return 1
  fi

  if ollama list | awk 'NR>1 {print $1}' | grep -qx "$MODEL"; then
    log "Model already present: $MODEL"
    return 0
  fi

  log "Pulling model: $MODEL"
  ollama pull "$MODEL"
}

setup_python_service() {
  if ! have_cmd python3; then
    log "python3 not found; skipping service gateway setup."
    return 0
  fi

  local service_dir="$ROOT_DIR/apps/service-gateway"
  local venv_dir="$service_dir/.venv"

  if [[ ! -d "$venv_dir" ]]; then
    log "Creating Python virtual environment for the service gateway..."
    python3 -m venv "$venv_dir"
  fi

  log "Installing Python dependencies for the service gateway..."
  if "$venv_dir/bin/pip" install -r "$service_dir/requirements.txt"; then
    log "Python service gateway dependencies installed."
  else
    log "Python dependency installation failed; you can rerun it manually later."
  fi
}

main() {
  log "PrivacyAI setup"
  log "Repository: $ROOT_DIR"
  log "GPU: $(detect_gpu)"
  log "Model: $MODEL"
  log ""

  ensure_env_file
  log "Wrote env file: $ENV_FILE"

  if ensure_ollama_running; then
    pull_model
  fi

  setup_python_service

  log ""
  log "Ready."
  log "SDK: https://github.com/ru-aish/PrivacyAI/tree/main/packages/sdk"
  log "Web demo: run apps/service-gateway/app.py"
  log "Service docs: docs/service/README.md"
}

main "$@"
