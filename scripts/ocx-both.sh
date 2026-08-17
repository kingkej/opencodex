#!/bin/zsh
set -euo pipefail

readonly actual_user_home="/Users/kej"
readonly shared_opencodex_home="${actual_user_home}/.opencodex"
readonly original_codex_home="${actual_user_home}/.codex"
readonly shambotex_codex_home="${actual_user_home}/Library/Application Support/Parall/Shambotex/.codex"
readonly develotexgpt_codex_home="${actual_user_home}/Library/Application Support/Parall/DevelotexGPT/.codex"
readonly ocx_executable="${actual_user_home}/Documents/opencodex/bin/ocx.mjs"
readonly stable_path="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${actual_user_home}/.local/bin"

run_for_original() {
  env \
    HOME="${actual_user_home}" \
    PATH="${stable_path}" \
    OPENCODEX_HOME="${shared_opencodex_home}" \
    CODEX_HOME="${original_codex_home}" \
    "${ocx_executable}" "$@"
}

run_for_shambotex() {
  env \
    HOME="${actual_user_home}" \
    PATH="${stable_path}" \
    OPENCODEX_HOME="${shared_opencodex_home}" \
    CODEX_HOME="${shambotex_codex_home}" \
    "${ocx_executable}" "$@"
}

run_for_develotexgpt() {
  env \
    HOME="${actual_user_home}" \
    PATH="${stable_path}" \
    OPENCODEX_HOME="${shared_opencodex_home}" \
    CODEX_HOME="${develotexgpt_codex_home}" \
    "${ocx_executable}" "$@"
}

print_usage() {
  cat <<'USAGE'
Usage: ocx-both <command>

Commands:
  start     Install/start the shared service and sync all Codex homes
  sync      Refresh providers/models and inject all Codex homes
  status    Show shared proxy and service status
  gui       Ensure routing for all homes and open the provider dashboard
  stop      Restore all homes and stop the shared service
  restore   Restore all homes without stopping the proxy
  back      Reconnect all homes to an already-running proxy
  doctor    Run OpenCodex diagnostics against the shared installation
USAGE
}

command_name="${1:-status}"

case "${command_name}" in
  start)
    run_for_original service install
    run_for_shambotex sync
    run_for_develotexgpt sync
    ;;
  sync)
    run_for_original sync
    run_for_shambotex sync
    run_for_develotexgpt sync
    ;;
  status)
    run_for_original status
    ;;
  gui)
    run_for_original ensure
    run_for_shambotex sync
    run_for_develotexgpt sync
    run_for_original gui
    ;;
  stop)
    run_for_develotexgpt restore
    run_for_shambotex restore
    run_for_original service stop
    ;;
  restore)
    run_for_develotexgpt restore
    run_for_shambotex restore
    run_for_original restore
    ;;
  back)
    run_for_original restore back
    run_for_shambotex restore back
    run_for_develotexgpt restore back
    ;;
  doctor)
    run_for_original doctor
    ;;
  help|-h|--help)
    print_usage
    ;;
  *)
    print_usage >&2
    exit 64
    ;;
esac
