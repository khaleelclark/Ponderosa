# Allow only Ponderosa's AppImage Electron executable to create its sandbox.
# The FUSE mount name varies across launches and versions.
abi <abi/4.0>,
include <tunables/global>

profile ponderosa-appimage /**/.mount_*/usr/lib/ponderosa-engine/ponderosa-engine flags=(unconfined) {
  userns,
}
