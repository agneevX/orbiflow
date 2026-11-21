import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyApplication,
  compareIpv4,
  condenseServiceLabel,
  describeRemoteIp,
  formatBandwidth,
  formatBytes,
  formatDuration,
  hasTangibleTraffic,
  isActiveConnectionState,
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

test('isActiveConnectionState keeps TCP ESTABLISHED and assured stateless UDP/ICMP while rejecting closing states', () => {
  assert.equal(isActiveConnectionState('ESTABLISHED', 'TCP', true), true);
  assert.equal(isActiveConnectionState('TIME_WAIT', 'TCP', true), false);
  assert.equal(isActiveConnectionState('FIN_WAIT', 'TCP', true), false);
  assert.equal(isActiveConnectionState('CLOSE_WAIT', 'TCP', true), false);
  assert.equal(isActiveConnectionState('SYN_SENT', 'TCP', false), false);
  assert.equal(isActiveConnectionState('CLOSE', 'TCP', true), false);
  assert.equal(isActiveConnectionState('STATELESS', 'UDP', true), true);
  assert.equal(isActiveConnectionState('STATELESS', 'UDP', false), false);
  assert.equal(isActiveConnectionState('STATELESS', 'ICMP', true), true);
});

test('hasTangibleTraffic filters out idle/zero-Kbps throughput below 128 B/s', () => {
  assert.equal(hasTangibleTraffic(0, 0), false);
  assert.equal(hasTangibleTraffic(50, 50), false);
  assert.equal(hasTangibleTraffic(127, 0), false);
  assert.equal(hasTangibleTraffic(128, 0), true);
  assert.equal(hasTangibleTraffic(64, 64), true);
  assert.equal(hasTangibleTraffic(1000, 500), true);
});

test('describeRemoteIp resolves known infrastructure, cached rDNS hostnames, and categories', () => {
  const netflix = describeRemoteIp('23.246.18.145');
  assert.equal(netflix.service, 'Netflix');
  assert.equal(netflix.category, 'Streaming');

  const apple = describeRemoteIp('17.253.144.10');
  assert.equal(apple.service, 'Apple');
  assert.equal(apple.category, 'Apple & Devices');

  const dns = describeRemoteIp('1.1.1.1');
  assert.equal(dns.service, 'Cloudflare DNS');
  assert.equal(dns.category, 'DNS & Infrastructure');

  const unknown = describeRemoteIp('203.0.113.99');
  assert.equal(unknown.service, 'External IP');
  assert.equal(unknown.category, 'Other');

  const rdnsNetflix = describeRemoteIp('203.0.113.99', 'edge-video.nflxvideo.net');
  assert.equal(rdnsNetflix.service, 'Netflix');
  assert.equal(rdnsNetflix.category, 'Streaming');

  const rdnsYoutube = describeRemoteIp('203.0.113.100', 'rr1---sn-ab5l6nzy.googlevideo.com');
  assert.equal(rdnsYoutube.service, 'YouTube');
  assert.equal(rdnsYoutube.category, 'Streaming');

  const rdnsAws = describeRemoteIp('203.0.113.101', 'ec2-1-2-3-4.compute-1.amazonaws.com');
  assert.equal(rdnsAws.service, 'AWS Cloud');
  assert.equal(rdnsAws.category, 'Cloud & Hosting');

  const rdnsMultiPartTld = describeRemoteIp('203.0.113.102', 'api.portal.example.co.uk');
  assert.equal(rdnsMultiPartTld.service, 'example.co.uk');
  assert.equal(rdnsMultiPartTld.category, 'CDN & Web');

  const portFallbackSsh = describeRemoteIp('203.0.113.103', null, 'TCP', 22);
  assert.equal(portFallbackSsh.service, 'External IP');
  assert.equal(portFallbackSsh.category, 'Cloud & Hosting');
});

test('condenseServiceLabel and compareIpv4 format compact service labels and sort IPv4 numerically', () => {
  assert.equal(condenseServiceLabel('Valve / Steam', 'Steam Client'), 'Steam');
  assert.equal(condenseServiceLabel('AWS CloudFront', 'HTTPS / TLS'), 'CloudFront');
  assert.equal(condenseServiceLabel('External IP', 'QUIC / HTTP3'), 'QUIC');
  assert.equal(condenseServiceLabel('External IP', 'HTTPS / TLS'), 'HTTPS');

  const ips = ['192.168.1.105', '192.168.1.10', '192.168.1.24', '192.168.1.2'];
  assert.deepEqual(ips.sort(compareIpv4), [
    '192.168.1.2',
    '192.168.1.10',
    '192.168.1.24',
    '192.168.1.105',
  ]);
});
