import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MaxMindService, isValidMmdbBuffer } from '../../server/geoip';

test('isValidMmdbBuffer rejects invalid buffers and accepts MMDB metadata marker', () => {
  assert.equal(isValidMmdbBuffer(Buffer.from('not a database')), false);
  const fakeMmdb = Buffer.concat([
    Buffer.alloc(32, 0),
    Buffer.from('\xab\xcd\xefMaxMind.com', 'latin1'),
    Buffer.from([0x01, 0x02]),
  ]);
  assert.equal(isValidMmdbBuffer(fakeMmdb), true);
});

test('MaxMindService handles missing databases gracefully and validates uploads', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbiflow-geoip-'));
  try {
    const svc = new MaxMindService({ enabled: true, geoipDir: tmpDir });
    const stats = await svc.reload();
    assert.equal(stats.activeDir, tmpDir);
    assert.equal(stats.cityLoaded, false);
    assert.equal(stats.asnLoaded, false);
    assert.equal(svc.lookup('8.8.8.8'), null);
    assert.equal(svc.lookup('192.168.1.10'), null);

    // Reject non-.mmdb upload
    const badExt = await svc.saveUploadedDb('notes.txt', Buffer.from('hello'));
    assert.equal(badExt.ok, false);
    assert.ok(badExt.error?.includes('.mmdb'));

    // Reject corrupt .mmdb upload
    const badContent = await svc.saveUploadedDb('GeoLite2-City.mmdb', Buffer.from('corrupt data'));
    assert.equal(badContent.ok, false);
    assert.ok(badContent.error?.includes('valid MaxMind'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
