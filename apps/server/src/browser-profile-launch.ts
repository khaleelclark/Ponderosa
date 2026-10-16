import { constants, promises as fs } from "@ponderosa/native-host/fs";

// FDs 3/4 belong to Chrome's CDP pipe. FD 5 is the exact owned profile,
// inherited by Chrome rather than a /proc/self path belonging to its parent.
export const CHILD_BROWSER_PROFILE_PATH = "/proc/self/fd/5";

export function openBrowserProfileDescriptor(profileDir: string) {
  return process.platform === "linux"
    ? fs.open(profileDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    : Promise.resolve(undefined);
}
