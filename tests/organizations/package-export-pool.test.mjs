import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, renameSync, rmSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataDirectoryAuthority } from '../../packages/native-host/dist/index.js';
import { openPackageExportPool } from '../../apps/server/src/package-export-pool.ts';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ponderosa-pool-test-'));
  const authority = new DataDirectoryAuthority(dir);
  let marker;
  const markers = {
    readMarker: () => marker,
    beginCreation: () => { assert.equal(marker, undefined); marker = {state:'intent', receipt:null}; },
    completeCreation: receipt => { assert.equal(marker.state, 'intent'); marker = {state:'ready', receipt}; },
  };
  return { dir, authority, markers, get marker() { return marker; }, set marker(v) { marker = v; },
    cleanup() { authority.close(); rmSync(dir,{recursive:true,force:true}); } };
}

test('issued pool persists and reopens through the exact held root', {skip: process.platform !== 'linux'}, () => {
  const f=fixture();
  try {
    let p=openPackageExportPool(f.authority, f.markers);
    p.write(0,Buffer.from('first')); p.sync();
    assert.equal(p.size(),5); assert.ok(p.allocatedBytes() >= 5);
    assert.equal(p.read(0,5).toString(),'first');
    assert.throws(() => p.write(4*1024**3, Buffer.from('x')),RangeError);
    p.close();
    p=openPackageExportPool(f.authority, f.markers);
    assert.equal(p.read(0,5).toString(),'first');
    p.write(0,Buffer.from('other')); p.sync();
    assert.equal(p.read(0,5).toString(),'other');
    p.close();
  } finally { f.cleanup(); }
});

test('interrupted issuance and foreign pre-existing files remain untouched', {skip: process.platform !== 'linux'}, () => {
  const f=fixture();
  try {
    const name=path.join(f.dir,'package-export-pool-v1.bin');
    writeFileSync(name,'foreign');
    assert.throws(() => openPackageExportPool(f.authority, f.markers));
    assert.equal(f.marker.state,'intent');
    assert.equal(readFileSync(name,'utf8'),'foreign');
    assert.throws(() => openPackageExportPool(f.authority, f.markers), /interrupted/);
    assert.equal(readFileSync(name,'utf8'),'foreign');
  } finally { f.cleanup(); }
});

test('created pool is held when ready marker publication fails', {skip: process.platform !== 'linux'}, () => {
  const f=fixture();
  try {
    const markers={...f.markers, completeCreation() { throw new Error('database unavailable'); }};
    assert.throws(() => openPackageExportPool(f.authority,markers),/database unavailable/);
    assert.equal(f.marker.state,'intent');
    assert.throws(() => openPackageExportPool(f.authority,f.markers),/interrupted/);
    assert.equal(readFileSync(path.join(f.dir,'package-export-pool-v1.bin')).length,0);
  } finally { f.cleanup(); }
});

test('replaced or hard-linked pool never writes the replacement', {skip: process.platform !== 'linux'}, () => {
  const f=fixture();
  try {
    const name=path.join(f.dir,'package-export-pool-v1.bin');
    const p=openPackageExportPool(f.authority,f.markers);
    p.write(0,Buffer.from('original')); p.sync();
    linkSync(name,path.join(f.dir,'extra-link'));
    assert.throws(() => p.write(0,Buffer.from('bad')),/link count/);
    unlinkSync(path.join(f.dir,'extra-link'));
    renameSync(name,path.join(f.dir,'original'));
    writeFileSync(name,'replacement');
    assert.throws(() => p.write(0,Buffer.from('bad')),/identity/);
    p.close();
    assert.throws(() => openPackageExportPool(f.authority,f.markers));
    assert.equal(readFileSync(name,'utf8'),'replacement');
    assert.equal(readFileSync(path.join(f.dir,'original'),'utf8'),'original');
  } finally { f.cleanup(); }
});

test('forged and closed root authorities cannot authorize the pool', {skip: process.platform !== 'linux'}, () => {
  const f=fixture();
  try {
    assert.throws(() => openPackageExportPool({rootPath:f.authority.rootPath},f.markers));
    const p=openPackageExportPool(f.authority,f.markers);
    f.authority.close();
    assert.throws(() => p.write(0,Buffer.from('x')));
    p.close();
  } finally { f.cleanup(); }
});

test('restrictive umask still creates a private readable and writable pool', {skip: process.platform !== 'linux'}, () => {
  const f=fixture();
  const previous=process.umask(0o777);
  try {
    const p=openPackageExportPool(f.authority,f.markers);
    assert.equal(statSync(path.join(f.dir,'package-export-pool-v1.bin')).mode & 0o777,0o600);
    p.write(0,Buffer.from('ok'));
    assert.equal(p.read(0,2).toString(),'ok');
    p.close();
  } finally { process.umask(previous); f.cleanup(); }
});
