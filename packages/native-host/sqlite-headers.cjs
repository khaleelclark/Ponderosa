// Resolve through the declared dependency in both workspace and deployed trees.
// Never fall back to an OS SQLite header: the extension uses better-sqlite3's ABI.
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(path.dirname(require.resolve('better-sqlite3/package.json')), 'deps', 'sqlite3');
for (const file of ['sqlite3.h', 'sqlite3ext.h']) {
  if (!fs.existsSync(path.join(directory, file))) throw new Error('Native storage requires the bundled better-sqlite3 headers');
}
// Relative include paths also survive node-gyp makefiles in folders with spaces.
process.stdout.write(path.relative(__dirname, directory) || ".");
