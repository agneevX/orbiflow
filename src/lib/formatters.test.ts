import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyApplication,
  describeRemoteIp,
  formatBandwidth,
  formatBytes,
  formatDuration,
  isPrivateIp,
} from './formatters';

test('formatBytes formats bytes with 0 decimal places', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3 GB');
});

test('formatBandwidth formats Mb/s and MB/s with 0 decimals, and <1Mbit/s as Kbps with 0 decimals', () => {
  assert.equal(formatBandwidth(0, 'Mb/s'), '0 Kbps');
  assert.equal(formatBandwidth(62_500, 'Mb/s'), '500 Kbps');
  assert.equal(formatBandwidth(62_500, 'MB/s'), '500 Kbps');
  assert.equal(formatBandwidth(125_000, 'Mb/s'), '1 Mb/s');
  assert.equal(formatBandwidth(12_500_000, 'Mb/s'), '100 Mb/s');
  assert.equal(formatBandwidth(12_500_000, 'MB/s'), '13 MB/s');
  assert.equal(formatBandwidth(250_000, 'MB/s'), '250 KB/s');
});

test('formatDuration handles seconds, minutes, hours, and days', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3720), '1h 2m');
  assert.equal(formatDuration(90000), '1d 1h');
});

test('isPrivateIp distinguishes RFC1918 and loopback from WAN IPs', () => {
  assert.equal(isPrivateIp('192.168.1.42'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('172.16.4.1'), true);
  assert.equal(isPrivateIp('172.32.0.1'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('classifyApplication identifies L7 protocols by transport and port', () => {
  assert.equal(classifyApplication('TCP', 51000, 443), 'HTTPS / TLS');
  assert.equal(classifyApplication('UDP', 51000, 443), 'QUIC / HTTP3');
  assert.equal(classifyApplication('UDP', 41000, 53), 'DNS');
  assert.equal(classifyApplication('UDP', 51820, 51820), 'WireGuard VPN');
  assert.equal(classifyApplication('ICMP', 0, 0), 'ICMP Ping');
});

test('describeRemoteIp resolves known infrastructure and cached rDNS hostnames', () => {
  assert.equal(describeRemoteIp('23.246.18.145').service, 'Netflix');
  assert.equal(describeRemoteIp('17.253.144.10').service, 'Apple');
  assert.equal(describeRemoteIp('203.0.113.99').service, 'External IP');
  assert.equal(
    describeRemoteIp('203.0.113.99', 'edge-video.nflxvideo.net').service,
    'Netflix'
  );
});
