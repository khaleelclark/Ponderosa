const MAX_APPLE_VERSION_COMPONENT_DIGITS = 18;
const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}

function normalizedDecimal(value, label) {
  if (!/^\d+$/u.test(value) ||
      value.length > MAX_APPLE_VERSION_COMPONENT_DIGITS) {
    throw new Error(`${label} must contain 1-${MAX_APPLE_VERSION_COMPONENT_DIGITS} decimal digits.`);
  }
  return value.replace(/^0+(?=\d)/u, "");
}

function parsedVersion(version) {
  if (typeof version !== "string") {
    throw new TypeError("Build version must be a string.");
  }
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Unsupported build version for macOS metadata: ${version}`);
  }
  return {
    major: normalizedDecimal(match[1], "Major version"),
    minor: normalizedDecimal(match[2], "Minor version"),
    patch: normalizedDecimal(match[3], "Patch version"),
  };
}

export function numericAppleVersion(version) {
  const { major, minor, patch } = parsedVersion(version);
  return `${major}.${minor}.${patch}`;
}

export function numericAppleBuildVersion(version) {
  const { major, minor, patch } = parsedVersion(version);
  const candidates = [...version.matchAll(/(?:^|[._+-])mac(\d+)(?=$|[._+-])/giu)];
  if (candidates.length > 1) {
    throw new Error(`Build version contains multiple macOS candidate identifiers: ${version}`);
  }
  if (candidates.length === 0) return `${major}.${minor}.${patch}`;
  const candidate = normalizedDecimal(candidates[0][1], "macOS candidate");
  return `${major}.${minor}.${candidate}`;
}

export function expectedMacosBundleIdentity(manifest) {
  if (typeof manifest?.commit !== "string" || manifest.commit.length === 0) {
    throw new Error("Build manifest commit must be a non-empty string.");
  }
  return {
    bundleVersion: numericAppleBuildVersion(manifest.version),
    shortVersion: numericAppleVersion(manifest.version),
    exactVersion: manifest.version,
    exactCommit: manifest.commit,
    infoString: `Ponderosa Beta ${manifest.version} (${manifest.commit.slice(0, 8)})`,
  };
}

export function assertMacosBundleIdentity(manifest, actual) {
  const expected = expectedMacosBundleIdentity(manifest);
  for (const key of [
    "bundleVersion",
    "shortVersion",
    "exactVersion",
    "exactCommit",
    "infoString",
  ]) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(`Installed macOS application has unexpected ${key}.`);
    }
  }
  return expected;
}

export function macosInfoPlist(manifest) {
  const identity = expectedMacosBundleIdentity(manifest);
  const bundleVersion = xmlEscape(identity.bundleVersion);
  const shortVersion = xmlEscape(identity.shortVersion);
  const exactVersion = xmlEscape(identity.exactVersion);
  const exactCommit = xmlEscape(identity.exactCommit);
  const infoString = xmlEscape(identity.infoString);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Ponderosa Beta</string>
<key>CFBundleDisplayName</key><string>Ponderosa Beta</string>
<key>CFBundleIdentifier</key><string>app.ponderosa.beta</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
<key>CFBundleShortVersionString</key><string>${shortVersion}</string>
<key>CFBundleGetInfoString</key><string>${infoString}</string>
<key>PonderosaBuildVersion</key><string>${exactVersion}</string>
<key>PonderosaBuildCommit</key><string>${exactCommit}</string>
<key>CFBundleExecutable</key><string>Ponderosa</string>
<key>CFBundleIconFile</key><string>Ponderosa.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`;
}
