import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configureWebPush } from "../src/configure-web-push.js";

describe("configureWebPush", () => {
  it("creates a private environment file and refuses to rotate it implicitly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ponderosa-push-"));
    const output = path.join(root, "config", "push.env");

    await configureWebPush(output, "mailto:operator@example.com");

    const contents = await readFile(output, "utf8");
    expect(contents).toMatch(/^PONDEROSA_VAPID_PUBLIC_KEY=[A-Za-z0-9_-]+$/m);
    expect(contents).toMatch(/^PONDEROSA_VAPID_PRIVATE_KEY=[A-Za-z0-9_-]+$/m);
    expect(contents).toContain("PONDEROSA_VAPID_SUBJECT=mailto:operator@example.com");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(output))).mode & 0o777).toBe(0o700);

    await expect(configureWebPush(output)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
