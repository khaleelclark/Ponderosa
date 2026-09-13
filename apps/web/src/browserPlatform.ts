/** iPadOS may request desktop sites and identify as a Mac. */
export function isIOSDevice(device = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return Boolean(device && (/iPad|iPhone|iPod/.test(device.userAgent) ||
    (device.platform === "MacIntel" && device.maxTouchPoints > 1)));
}
