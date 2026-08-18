#!/bin/zsh
# Relaunch the opencodex proxy from THIS repo's source (not the globally installed
# @bitkyc08/opencodex package — `opencodex restart` starts that one and fails health).
#
#   scripts/ocx-relaunch.sh            # stop + start + wait for /healthz
#   scripts/ocx-relaunch.sh --no-wait  # don't block on the health check
#
# Logs go to ~/.opencodex/relaunch.log.
set -euo pipefail

readonly repo_dir="${0:A:h:h}"
readonly ocx="${repo_dir}/bin/ocx.mjs"
readonly config_json="${OPENCODEX_HOME:-${HOME}/.opencodex}/config.json"
readonly log_file="${OPENCODEX_HOME:-${HOME}/.opencodex}/relaunch.log"
readonly wait_for_health="${1:-}"

port="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",10100))' "${config_json}" 2>/dev/null || echo 10100)"

print "[ocx-relaunch] repo: ${repo_dir}"
print "[ocx-relaunch] port: ${port}"

# 1. Stop whatever currently holds the port. SIGTERM first so the proxy restores
#    Codex config on its way out; SIGKILL only if it is still there after 5s.
pids=($(/usr/sbin/lsof -tnP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true))
if (( ${#pids} > 0 )); then
  print "[ocx-relaunch] stopping pid(s): ${pids}"
  kill ${pids} 2>/dev/null || true
  for _ in {1..10}; do
    /usr/sbin/lsof -tnP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
  if /usr/sbin/lsof -tnP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    print "[ocx-relaunch] force killing"
    kill -9 ${pids} 2>/dev/null || true
    sleep 1
  fi
fi

# 2. Start detached from this shell so it survives the terminal that launched it.
print "[ocx-relaunch] starting from source"
: > "${log_file}"
(cd "${repo_dir}" && nohup "${ocx}" start >>"${log_file}" 2>&1 &)

if [[ "${wait_for_health}" == "--no-wait" ]]; then
  print "[ocx-relaunch] started; logs: ${log_file}"
  exit 0
fi

# 3. Wait for the proxy to answer /healthz before reporting success.
for _ in {1..40}; do
  if /usr/bin/curl -fsS -o /dev/null "http://127.0.0.1:${port}/healthz" 2>/dev/null; then
    print "[ocx-relaunch] healthy on http://127.0.0.1:${port}"
    exit 0
  fi
  sleep 0.5
done

print "[ocx-relaunch] proxy did not become healthy — last log lines:" >&2
tail -20 "${log_file}" >&2
exit 1
