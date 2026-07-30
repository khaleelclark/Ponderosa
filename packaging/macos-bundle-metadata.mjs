function xmlEscape(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}

export function numericAppleVersion(version) {
  const values = version.match(/\d+/gu)?.slice(0, 3) ?? [];
  return [...values, "0", "0", "0"].slice(0, 3).join(".");
}

export function numericAppleBuildVersion(version) {
  const marketingVersion = numericAppleVersion(version);
  const candidate = version.match(/(?:^|[._+-])mac(\d+)(?:$|[._+-])/iu);
  if (!candidate) return marketingVersion;
  const [major = "0", minor = "0"] = marketingVersion.split(".");
  return `${major}.${minor}.${Number.parseInt(candidate[1], 10)}`;
}

export function macosInfoPlist(manifest) {
  const marketingVersion = numericAppleVersion(manifest.version);
  const buildVersion = numericAppleBuildVersion(manifest.version);
  const exactVersion = xmlEscape(manifest.version);
  const exactCommit = xmlEscape(manifest.commit);
  const description = xmlEscape(
    `Ponderosa Beta ${manifest.version} (${manifest.commit.slice(0, 8)})`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Ponderosa Beta</string>
<key>CFBundleDisplayName</key><string>Ponderosa Beta</string>
<key>CFBundleIdentifier</key><string>app.ponderosa.beta</string>
<key>CFBundleVersion</key><string>${buildVersion}</string>
<key>CFBundleShortVersionString</key><string>${marketingVersion}</string>
<key>CFBundleGetInfoString</key><string>${description}</string>
<key>PonderosaBuildVersion</key><string>${exactVersion}</string>
<key>PonderosaBuildCommit</key><string>${exactCommit}</string>
<key>CFBundleExecutable</key><string>Ponderosa</string>
<key>CFBundleIconFile</key><string>Ponderosa.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`;
}
