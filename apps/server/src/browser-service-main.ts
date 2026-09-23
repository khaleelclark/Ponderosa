import path from "node:path";
import { startBrowserService } from "./browser-service.js";
import { chromeBrowserDriverFactory } from "./chrome-cdp-driver.js";

const dataDir = process.env.PONDEROSA_DATA_DIR;
const socket = process.env.PONDEROSA_BROWSER_SERVICE_SOCKET;
if (!dataDir || !socket || !path.isAbsolute(dataDir) || !path.isAbsolute(socket)) throw new Error("Browser service requires absolute configured data and socket paths.");
const service = await startBrowserService(socket, dataDir, chromeBrowserDriverFactory(dataDir));
let closing = false;
const close = () => { if (closing) return; closing = true; void service.close().then(() => process.exit(0), () => process.exit(1)); };
process.on("SIGTERM", close);
process.on("SIGINT", close);
