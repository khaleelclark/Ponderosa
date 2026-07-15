import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

export const defaultWebPushEnvPath = (): string =>
  path.join(homedir(), ".config", "ponderosa", "push.env");

export async function configureWebPush(
  outputPath = defaultWebPushEnvPath(),
  subject = "mailto:admin@localhost",
): Promise<string> {
  const keys = webpush.generateVAPIDKeys();
  const contents = [
    `PONDEROSA_VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `PONDEROSA_VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `PONDEROSA_VAPID_SUBJECT=${subject}`,
    "",
  ].join("\n");

  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(outputPath), 0o700);
  await writeFile(outputPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return outputPath;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2];
  const subject = process.argv[3];
  try {
    const written = await configureWebPush(outputPath, subject);
    console.log(`Web Push credentials written to ${written}`);
    console.log("Restart Ponderosa to load them: sudo systemctl restart ponderosa");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.error("Web Push credentials already exist; refusing to overwrite active subscriptions.");
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
