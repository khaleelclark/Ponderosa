#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

parseArgs({ options: {}, strict: true, allowPositionals: false });
if (process.platform !== 'linux') throw new Error('AppImage sandbox setup is Linux-only.');
if (process.getuid() !== 0) throw new Error('AppImage sandbox setup requires administrator approval.');

const directory = '/etc/apparmor.d';
const target = `${directory}/ponderosa-appimage`;
const parser = '/sbin/apparmor_parser';
const profile = readFileSync(new URL('./ponderosa-appimage.profile', import.meta.url), 'utf8');
const directoryStat = lstatSync(directory);
if (!directoryStat.isDirectory() || directoryStat.uid !== 0 || (directoryStat.mode & 0o022)) {
  throw new Error('AppArmor policy directory must be a root-owned, non-writable directory.');
}
const parserStat = lstatSync(parser);
if (!parserStat.isFile() || parserStat.uid !== 0 || (parserStat.mode & 0o022)) {
  throw new Error('A trusted system apparmor_parser is required.');
}
let created = false;
if (existsSync(target)) {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || readFileSync(target, 'utf8') !== profile) {
    throw new Error('Existing Ponderosa AppArmor policy differs; it was preserved.');
  }
} else {
  writeFileSync(target, profile, { flag: 'wx', mode: 0o644 });
  created = true;
}
try {
  execFileSync(parser, ['--replace', '--skip-cache', target], {
    stdio: 'inherit', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
  });
} catch (error) {
  if (created) rmSync(target);
  throw error;
}
console.log('Ponderosa sandbox profile installed. Open the AppImage as your normal user.');
