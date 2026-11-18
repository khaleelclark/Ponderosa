#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${PONDEROSA_DATA_DIR:?Set an explicit canonical data directory; never point qualification at live state}"
: "${PONDEROSA_LOCAL_MEMORY_CONFIG:?Set the absolute operator-owned memory configuration file}"
node_bin="${PONDEROSA_NODE_BIN:-node}"
"$node_bin" --input-type=module -e 'if(process.versions.node.split(".")[0]!=="24"||process.versions.modules!=="137")throw Error("This private native candidate requires Node24 / ABI137")'
if [ -f "$root/PRIVATE_BUILD.json" ]; then
 PONDEROSA_BUILD_SHA=$("$node_bin" -e 'process.stdout.write(require(process.argv[1]).commit)' "$root/PRIVATE_BUILD.json")
 export PONDEROSA_BUILD_SHA
fi
exec "$node_bin" "$root/apps/server/dist/main.js"
