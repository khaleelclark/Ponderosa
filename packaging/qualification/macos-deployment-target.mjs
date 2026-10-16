function loadCommandBlocks(output) {
  return output.split(/(?=^Load command \d+\s*$)/mu);
}

function field(block, name) {
  return block.match(new RegExp(`^\\s*${name}\\s+(\\d+(?:\\.\\d+){1,2})\\s*$`, "mu"))?.[1];
}

/** Extract only the deployment target from the Mach-O load commands that own
 * it. Other commands contain unrelated `version` fields that may be much
 * larger than the supported macOS version. */
export function macosDeploymentTargets(otoolOutput) {
  const targets = [];
  for (const block of loadCommandBlocks(otoolOutput)) {
    if (/^\s*cmd\s+LC_BUILD_VERSION\s*$/mu.test(block)) {
      const target = field(block, "minos");
      if (target) targets.push(target);
    } else if (/^\s*cmd\s+LC_VERSION_MIN_MACOSX\s*$/mu.test(block)) {
      const target = field(block, "version");
      if (target) targets.push(target);
    }
  }
  return targets;
}

function versionParts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

export function macosDeploymentTargetAtMost(actual, maximum) {
  const left = versionParts(actual);
  const right = versionParts(maximum);
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart < rightPart) return true;
    if (leftPart > rightPart) return false;
  }
  return true;
}
