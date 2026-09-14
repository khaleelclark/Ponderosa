#!/usr/bin/env bash
set -euo pipefail
expected="$1"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || exit 2
short="${expected:0:8}"
service=ponderosa-project-rail-runtime.service
base_url=http://127.0.0.1:8798
root=/home/phoenix/ponderosa-project-rail-runtime
release="$root/releases/$short"
current="$root/current"
old_target="$root/releases/2899773b"
rollback_expected=2899773bc15a13e769960f56d4ab00d4c9927a19
env_dir=/home/phoenix/.config/ponderosa-project-rail-runtime
next_env="$env_dir/build.env.next-$short"
rollback_env="$env_dir/build.env.rollback-$short"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo "deployment lock is busy" >&2; exit 30; }
rollback() {
  sudo systemctl stop "$service" || true
  rollback_link="$root/.current.rollback-$short.$$"
  ln -s "$old_target" "$rollback_link"
  mv -Tf "$rollback_link" "$current"
  cp -a "$rollback_env" "$env_dir/build.env"
  sudo systemctl start "$service"
  for _ in $(seq 1 90); do
    health=$(curl -fsS "$base_url/api/health" 2>/dev/null || true)
    if jq -e --arg expected "$rollback_expected" '.status == "ok" and .revision == $expected' >/dev/null 2>&1 <<<"$health"; then echo "rollback_health=$health"; return 0; fi
    sleep 1
  done
  return 1
}
test -f "$release/apps/server/dist/main.js"
test -f "$release/apps/web/dist/index.html"
test -x "$release/dist/node-runtime/linux-x64/node"
test -f "$root/speech-packages/speech-kokoro-linux-x64-1/manifest.json"
test "$(git -C "$release" rev-parse HEAD)" = "$expected"
test "$(readlink -f "$current")" = "$old_target"
cp -a "$env_dir/build.env" "$next_env"
sed -i -e "s/^PONDEROSA_BUILD_SHA=.*/PONDEROSA_BUILD_SHA=$expected/" \
  -e "s/^PONDEROSA_BUILD_VERSION=.*/PONDEROSA_BUILD_VERSION=experiment-$short/" \
  -e '/^PONDEROSA_SPEECH_PACKAGE_DIRECTORY=/d' "$next_env"
sed -i '$a PONDEROSA_SPEECH_PACKAGE_DIRECTORY=/home/phoenix/ponderosa-project-rail-runtime/speech-packages' "$next_env"
grep -qx 'PONDEROSA_SPEECH_PACKAGE_DIRECTORY=/home/phoenix/ponderosa-project-rail-runtime/speech-packages' "$next_env"
health=$(curl -fsS "$base_url/api/health")
jq -e --arg expected "$rollback_expected" '.status == "ok" and .revision == $expected' >/dev/null <<<"$health"
cp -a "$env_dir/build.env" "$rollback_env"
snapshot=
for _ in $(seq 1 900); do
  snapshot=$(curl -fsS -X POST "$base_url/api/deployment/drain" || true)
  if jq -e '.readyForRestart == true' >/dev/null 2>&1 <<<"$snapshot"; then break; fi
  sleep 1
done
echo "drain_snapshot=${snapshot:-unavailable}"
if ! jq -e '.readyForRestart == true' >/dev/null 2>&1 <<<"${snapshot:-}"; then
  curl -fsS -X POST "$base_url/api/deployment/resume" >/dev/null 2>&1 || true
  exit 20
fi
trap 'trap - ERR; rollback; exit 23' ERR
sudo systemctl stop "$service"
new_link="$root/.current.$short.$$"
ln -s "$release" "$new_link"
mv -Tf "$new_link" "$current"
mv -f "$next_env" "$env_dir/build.env"
sudo systemctl start "$service"
for _ in $(seq 1 90); do
  health=$(curl -fsS "$base_url/api/health" 2>/dev/null || true)
  if jq -e --arg expected "$expected" '.status == "ok" and .revision == $expected' >/dev/null 2>&1 <<<"$health"; then
    echo "deployed_health=$health"
    echo "current_release=$(readlink -f "$current")"
    trap - ERR
    exit 0
  fi
  sleep 1
done
trap - ERR
rollback || exit 22
exit 21
