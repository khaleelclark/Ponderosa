#!/usr/bin/env bash
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo "This setup is only for disposable GitHub-hosted Linux runners." >&2
  exit 1
fi
sudo apt-get update
sudo apt-get install -y bubblewrap nodejs apparmor
test -x /usr/bin/bwrap
test -x /usr/bin/node
# Ubuntu 24.04's bwrap 0.9 restriction profile can deny loopback setup inside
# the new network namespace (RTM_NEWADDR). Give bwrap the documented userns
# exception only on this disposable runner; do not disable global protection.
# https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890
profile="$(mktemp "${RUNNER_TEMP}/ponderosa-bwrap.XXXXXX")"
cat > "$profile" <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
sudo apparmor_parser -r "$profile"
