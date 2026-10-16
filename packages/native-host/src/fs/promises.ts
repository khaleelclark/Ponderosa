import { promises } from "../fs.js";
export * from "node:fs/promises";
export const { open, readFile, writeFile, appendFile, stat, lstat, mkdir, readdir, rename, link, unlink, rm, rmdir, chmod, access, realpath, copyFile, readlink } = promises;
export default promises;
