export const MACOS_GUI_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function macosLauncherEntry() {
  return `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources/Ponderosa" && pwd)"
PATH="${MACOS_GUI_PATH}"
export PATH
exec "$ROOT/runtime/node" "$ROOT/app/launcher/dist/cli.js" engine --install-root "$ROOT" "$@"
`;
}
