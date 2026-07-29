import path from "node:path";

export interface WindowsInvocation {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function assertEnvironmentTransportValue(value: string, label: string): void {
  if (/[\u0000\r\n"]/u.test(value)) {
    throw new Error(`${label} contains a character that cannot be transported safely through cmd.exe`);
  }
}

/**
 * npm installs subscription CLIs as .cmd shims on Windows. Transport every
 * argument through a dedicated environment slot so cmd.exe never reparses
 * provider values as command text. Delayed expansion is disabled, and raw
 * values never appear in the /c program.
 */
export function containedWindowsInvocation(
  bin: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): WindowsInvocation {
  const extension = path.win32.extname(bin).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { bin, args: [...args], env: environment };
  }

  assertEnvironmentTransportValue(bin, "Windows command shim path");
  const env: NodeJS.ProcessEnv = { ...environment, PONDEROSA_CMD_SHIM: bin };
  const command = ['"%PONDEROSA_CMD_SHIM%"'];
  args.forEach((value, index) => {
    assertEnvironmentTransportValue(value, `Windows command shim argument ${index}`);
    const key = `PONDEROSA_CMD_ARG_${index}`;
    env[key] = value;
    command.push(`"%${key}%"`);
  });
  const commandInterpreter = environment.ComSpec?.trim() ||
    environment.COMSPEC?.trim() ||
    "cmd.exe";
  return {
    bin: commandInterpreter,
    args: ["/d", "/q", "/v:off", "/s", "/c", command.join(" ")],
    env,
  };
}
