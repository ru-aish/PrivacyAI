#!/usr/bin/env bash

ui_log() {
  printf '%s\n' "$1"
}

ui_have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ui_is_interactive() {
  [[ -t 0 && -t 1 ]]
}

ui_spinner() {
  local pid="$1"
  local message="$2"
  local log_file="${3:-}"
  local frames='|/-\'
  local index=0

  while kill -0 "$pid" 2>/dev/null; do
    index=$(( (index + 1) % 4 ))
    printf '\r\033[K%s %s' "${frames:index:1}" "$message"
    sleep 0.12
  done

  wait "$pid"
  local status=$?

  if [[ "$status" -eq 0 ]]; then
    printf '\r\033[K✓ %s\n' "$message"
  else
    printf '\r\033[K✗ %s\n' "$message"
    if [[ -n "$log_file" && -f "$log_file" ]]; then
      ui_log ""
      ui_log "Last lines from the install log:"
      tail -n 30 "$log_file" >&2 || true
    fi
  fi

  return "$status"
}

ui_run_quiet() {
  local message="$1"
  local log_file="$2"
  shift 2

  : >"$log_file"
  ("$@") >"$log_file" 2>&1 &
  local pid=$!
  ui_spinner "$pid" "$message" "$log_file"
}

ui_prompt() {
  local label="$1"
  local default="${2:-}"
  local value=""

  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$label" "$default" >/dev/tty
  else
    printf '%s: ' "$label" >/dev/tty
  fi

  read -r value </dev/tty
  if [[ -z "$value" ]]; then
    value="$default"
  fi
  printf '%s' "$value"
}

ui_prompt_secret() {
  local label="$1"
  local value=""

  printf '%s: ' "$label" >/dev/tty
  read -rs value </dev/tty
  printf '\n' >/dev/tty
  printf '%s' "$value"
}

ui_prompt_choice() {
  local prompt="$1"
  local default="${2:-1}"
  local choice=""

  printf '%s [%s]: ' "$prompt" "$default" >/dev/tty
  read -r choice </dev/tty
  if [[ -z "$choice" ]]; then
    choice="$default"
  fi
  printf '%s' "$choice"
}

ui_menu() {
  local title="$1"
  shift

  ui_log ""
  ui_log "$title"
  ui_log ""

  local index=1
  local options=()
  local line=""

  while [[ $# -gt 0 ]]; do
    options+=("$1")
    ui_log "  $index) $1"
    shift
    index=$((index + 1))
  done

  ui_log ""
  line="$(ui_prompt_choice "Enter choice" "1")"
  if [[ ! "$line" =~ ^[0-9]+$ ]] || (( line < 1 || line > ${#options[@]} )); then
    return 1
  fi

  REPLY="${options[line - 1]}"
  return 0
}