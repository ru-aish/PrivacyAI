#!/usr/bin/env bash

provider_defaults() {
  local name="$1"
  case "$name" in
    ollama)
      PROVIDER_NAME="ollama"
      PROVIDER_LABEL="Ollama"
      PROVIDER_TYPE="ollama"
      PROVIDER_BASE_URL="http://127.0.0.1:11434"
      PROVIDER_API_KEY="ollama"
      PROVIDER_MODEL="qwen3.5:2b"
      PROVIDER_NEEDS_API_KEY=0
      ;;
    lmstudio)
      PROVIDER_NAME="lmstudio"
      PROVIDER_LABEL="LM Studio"
      PROVIDER_TYPE="openai-compatible"
      PROVIDER_BASE_URL="http://localhost:1234/v1"
      PROVIDER_API_KEY="lm-studio"
      PROVIDER_MODEL="qwen2.5-coder-3b-instruct"
      PROVIDER_NEEDS_API_KEY=0
      ;;
    openai)
      PROVIDER_NAME="openai"
      PROVIDER_LABEL="OpenAI"
      PROVIDER_TYPE="openai-compatible"
      PROVIDER_BASE_URL="https://api.openai.com/v1"
      PROVIDER_API_KEY=""
      PROVIDER_MODEL="gpt-4.1-mini"
      PROVIDER_NEEDS_API_KEY=1
      ;;
    gemini)
      PROVIDER_NAME="gemini"
      PROVIDER_LABEL="Gemini"
      PROVIDER_TYPE="openai-compatible"
      PROVIDER_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai"
      PROVIDER_API_KEY=""
      PROVIDER_MODEL="gemini-2.5-flash"
      PROVIDER_NEEDS_API_KEY=1
      ;;
    custom)
      PROVIDER_NAME="custom"
      PROVIDER_LABEL="Custom"
      PROVIDER_TYPE="openai-compatible"
      PROVIDER_BASE_URL=""
      PROVIDER_API_KEY=""
      PROVIDER_MODEL=""
      PROVIDER_NEEDS_API_KEY=0
      ;;
    *)
      return 1
      ;;
  esac
}

provider_normalize_base_url() {
  local value="$1"
  value="${value%/}"
  printf '%s' "$value"
}

provider_test_connection() {
  local provider_type="$1"
  local base_url="$2"
  local api_key="$3"
  local error_file="$4"

  base_url="$(provider_normalize_base_url "$base_url")"
  : >"$error_file"

  if [[ "$provider_type" == "ollama" ]]; then
    if curl -fsS --max-time 10 "${base_url}/api/tags" >"$error_file" 2>&1; then
      return 0
    fi
    return 1
  fi

  if curl -fsS --max-time 20 \
    -H "Authorization: Bearer ${api_key:-not-required}" \
    "${base_url}/models" >"$error_file" 2>&1; then
    return 0
  fi

  return 1
}

provider_ensure_ollama_running() {
  local base_url="$1"
  base_url="$(provider_normalize_base_url "$base_url")"

  if provider_test_connection "ollama" "$base_url" "" /dev/null; then
    return 0
  fi

  if ! ui_have_cmd ollama; then
    ui_log "Ollama is not installed. Get it from https://ollama.com/download"
    return 1
  fi

  ui_log "Starting Ollama..."
  nohup ollama serve >"${ROOT_DIR}/.ollama.log" 2>&1 &
  for _ in $(seq 1 20); do
    if provider_test_connection "ollama" "$base_url" "" /dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}

provider_pull_model_if_needed() {
  local model="$1"
  local log_file="${ROOT_DIR}/.ollama-pull.log"

  if ! ui_have_cmd ollama; then
    return 0
  fi

  if ollama list | awk 'NR>1 {print $1}' | grep -qx "$model"; then
    ui_log "Model already present: $model"
    return 0
  fi

  if ui_run_quiet "Pulling model: $model" "$log_file" ollama pull "$model"; then
    return 0
  fi

  ui_log "Model pull failed. You can retry later with: ollama pull $model"
  return 1
}

provider_write_env_file() {
  local env_file="$1"
  cat >"$env_file" <<EOF
PRIVATE_AI_PROVIDER=${PROVIDER_TYPE}
PRIVATE_AI_BASE_URL=${PROVIDER_BASE_URL}
PRIVATE_AI_API_KEY=${PROVIDER_API_KEY}
PRIVATE_AI_MODEL=${PROVIDER_MODEL}
PRIVATE_AI_NUM_CTX=8192
PRIVATE_AI_TIMEOUT_MS=120000
PRIVATE_AI_LOCAL_DETECTOR_ENABLED=false
EOF
}

provider_collect_custom_values() {
  PROVIDER_BASE_URL="$(ui_prompt "Base URL (OpenAI-compatible /v1 endpoint)" "$PROVIDER_BASE_URL")"
  PROVIDER_API_KEY="$(ui_prompt "API key (leave blank if not required)" "$PROVIDER_API_KEY")"
  PROVIDER_MODEL="$(ui_prompt "Model" "$PROVIDER_MODEL")"
  PROVIDER_TYPE="$(ui_prompt "Provider type (ollama or openai-compatible)" "${PROVIDER_TYPE:-openai-compatible}")"
}

provider_collect_api_key() {
  local label="$1"
  local current="${2:-}"

  while [[ -z "$PROVIDER_API_KEY" ]]; do
    PROVIDER_API_KEY="$(ui_prompt_secret "$label")"
    if [[ -z "$PROVIDER_API_KEY" && -n "$current" ]]; then
      PROVIDER_API_KEY="$current"
    fi
    if [[ -z "$PROVIDER_API_KEY" ]]; then
      ui_log "An API key is required for ${PROVIDER_LABEL}."
    fi
  done
}

provider_handle_failure() {
  local error_file="$1"
  shift

  while true; do
    ui_log ""
    ui_log "Connection failed for ${PROVIDER_LABEL}."
    if [[ -s "$error_file" ]]; then
      ui_log "Details:"
      tail -n 5 "$error_file" | sed 's/^/  /'
    fi
    ui_log ""
    ui_log "  1) Retry"
    ui_log "  2) Change URL"
    if [[ "$PROVIDER_NEEDS_API_KEY" == "1" ]]; then
      ui_log "  3) Change API key"
      ui_log "  4) Choose a different provider"
    elif [[ "$PROVIDER_NAME" == "ollama" ]]; then
      ui_log "  3) Start Ollama"
      ui_log "  4) Choose a different provider"
    else
      ui_log "  3) Choose a different provider"
    fi

    local choice
    choice="$(ui_prompt_choice "What would you like to do" "1")"

    case "$choice" in
      1)
        return 0
        ;;
      2)
        PROVIDER_BASE_URL="$(ui_prompt "Base URL" "$PROVIDER_BASE_URL")"
        return 0
        ;;
      3)
        if [[ "$PROVIDER_NEEDS_API_KEY" == "1" ]]; then
          PROVIDER_API_KEY=""
          provider_collect_api_key "${PROVIDER_LABEL} API key"
          return 0
        fi
        if [[ "$PROVIDER_NAME" == "ollama" ]]; then
          provider_ensure_ollama_running "$PROVIDER_BASE_URL" || true
          return 0
        fi
        return 2
        ;;
      4)
        return 2
        ;;
      *)
        ui_log "Please choose a valid option."
        ;;
    esac
  done
}

provider_configure_interactive() {
  local selected=""
  local error_file="${ROOT_DIR}/.setup-provider-test.log"

  while true; do
    if ! ui_menu "Choose your AI provider:" \
      "Ollama (local)" \
      "LM Studio (local)" \
      "OpenAI (cloud)" \
      "Gemini (cloud)" \
      "Custom"; then
      ui_log "Invalid choice. Try again."
      continue
    fi

    case "$REPLY" in
      "Ollama (local)") selected="ollama" ;;
      "LM Studio (local)") selected="lmstudio" ;;
      "OpenAI (cloud)") selected="openai" ;;
      "Gemini (cloud)") selected="gemini" ;;
      "Custom") selected="custom" ;;
    esac

    provider_defaults "$selected"

    if [[ "$selected" == "custom" ]]; then
      provider_collect_custom_values
    elif [[ "$PROVIDER_NEEDS_API_KEY" == "1" ]]; then
      provider_collect_api_key "${PROVIDER_LABEL} API key"
    fi

    if [[ "$PROVIDER_NAME" == "ollama" ]]; then
      provider_ensure_ollama_running "$PROVIDER_BASE_URL" || true
    fi

    while true; do
      ui_log ""
      ui_log "Testing ${PROVIDER_LABEL} at ${PROVIDER_BASE_URL}..."

      if provider_test_connection "$PROVIDER_TYPE" "$PROVIDER_BASE_URL" "$PROVIDER_API_KEY" "$error_file"; then
        ui_log "✓ ${PROVIDER_LABEL} is reachable."

        if [[ "$PROVIDER_NAME" == "ollama" ]]; then
          provider_pull_model_if_needed "$PROVIDER_MODEL" || true
        fi

        return 0
      fi

      local action=0
      provider_handle_failure "$error_file" || action=$?
      if [[ "$action" -eq 2 ]]; then
        break
      fi
    done
  done
}

provider_configure_noninteractive() {
  local selected="${PRIVACY_AI_SETUP_PROVIDER:-ollama}"
  local error_file="${ROOT_DIR}/.setup-provider-test.log"

  provider_defaults "$selected" || provider_defaults "ollama"

  if [[ "$PROVIDER_NEEDS_API_KEY" == "1" ]]; then
    PROVIDER_API_KEY="${PRIVATE_AI_API_KEY:-${OPENAI_API_KEY:-}}"
    if [[ -z "$PROVIDER_API_KEY" ]]; then
      ui_log "Missing API key for ${PROVIDER_LABEL}. Set PRIVATE_AI_API_KEY before running non-interactive setup."
      return 1
    fi
  fi

  if [[ "$PROVIDER_NAME" == "ollama" ]]; then
    provider_ensure_ollama_running "$PROVIDER_BASE_URL" || return 1
    provider_pull_model_if_needed "$PROVIDER_MODEL" || true
  fi

  if provider_test_connection "$PROVIDER_TYPE" "$PROVIDER_BASE_URL" "$PROVIDER_API_KEY" "$error_file"; then
    ui_log "✓ ${PROVIDER_LABEL} is reachable."
    return 0
  fi

  ui_log "Connection failed for ${PROVIDER_LABEL}."
  if [[ -s "$error_file" ]]; then
    tail -n 5 "$error_file" | sed 's/^/  /'
  fi
  return 1
}

provider_configure() {
  if ui_is_interactive; then
    provider_configure_interactive
  else
    provider_configure_noninteractive
  fi
}