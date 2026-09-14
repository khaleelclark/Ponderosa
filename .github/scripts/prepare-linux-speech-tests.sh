#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y bubblewrap nodejs apparmor
test -x /usr/bin/bwrap
test -x /usr/bin/node
# Load Ubuntu's shipped restriction profile; keep userns protection enabled.
if [ -f /etc/apparmor.d/bwrap-userns-restrict ]; then
  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
fi
