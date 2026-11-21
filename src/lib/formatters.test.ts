import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyApplication,
  compareIpv4,
  computePerceivedRouterLoadPct,
  computeRouterCpuPct,
  computeWindowPeaks,
  condenseServiceLabel,
  describeRemoteIp,
  formatAppForProtocolFilter,
  formatBandwidth,
  formatBytes,
  formatDuration,
  formatTimestamp,
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

test('formatBandwidth formats Mbps and MB/s with 0 decimals, and <1Mbit/s as Kbps with 0 decimals', () => {
  assert.equal(formatBandwidth(0, 'Mbps'), '0 Kbps');
  assert.equal(formatBandwidth(62_500, 'Mbps'), '500 Kbps');
  assert.equal(formatBandwidth(62_500, 'MB/s'), '500 Kbps');
  assert.equal(formatBandwidth(125_000, 'Mbps'), '1 Mbps');
  assert.equal(formatBandwidth(12_500_000, 'Mbps'), '100 Mbps');
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

test('describeRemoteIp suppresses app categories for ICMP traffic while preserving hostnames', () => {
  const icmpCf = describeRemoteIp('1.1.1.1', null, 'ICMP', 0);
  assert.equal(icmpCf.service, 'Cloudflare DNS');
  assert.equal(icmpCf.category, 'Other');

  const icmpRdns = describeRemoteIp('203.0.113.50', 'edge-video.nflxvideo.net', 'ICMP', 0);
  assert.equal(icmpRdns.label, 'edge-video.nflxvideo.net');
  assert.equal(icmpRdns.category, 'Other');
});

test('formatTimestamp defaults to 12h format and supports explicit 24h format', () => {
  const sampleTs = new Date(2026, 4, 10, 15, 7, 9).getTime();
  const default12 = formatTimestamp(sampleTs, false, false);
  const explicit12 = formatTimestamp(sampleTs, false, false, '12h');
  const explicit24 = formatTimestamp(sampleTs, false, false, '24h');

  assert.equal(default12, explicit12);
  assert.match(default12, /3:07:09\s*PM/i);
  assert.match(explicit24, /15:07:09/);
  assert.doesNotMatch(explicit24, /AM|PM/i);
});

test('computeRouterCpuPct, computePerceivedRouterLoadPct, and computeWindowPeaks calculate bounded metrics', () => {
  assert.equal(computeRouterCpuPct(0, 2), 0);
  assert.equal(computeRouterCpuPct(1.0, 2), 50);
  assert.equal(computeRouterCpuPct(3.0, 2), 100);

  // CPU 50% * 0.6 = 30, Mem 40% * 0.3 = 12, Conntrack 25% * 0.1 = 2.5 => round(44.5) = 45
  assert.equal(
    computePerceivedRouterLoadPct({
      load1m: 1.0,
      memUsedPct: 40,
      conntrackCount: 4096,
      conntrackMax: 16384,
      cpuCores: 2,
    }),
    45
  );

  const peaks = computeWindowPeaks(
    [
      { timestamp: 1000, rxBps: 500, txBps: 100, activeFlows: 2, routerLoadPct: 22 },
      { timestamp: 4000, rxBps: 2500, txBps: 400, activeFlows: 5, routerLoadPct: 68 },
      { timestamp: 7000, rxBps: 1200, txBps: 900, activeFlows: 4, routerLoadPct: 41 },
    ],
    { rxBps: 1000, txBps: 200, routerLoadPct: 30 }
  );
  assert.deepEqual(peaks, { peakRxBps: 2500, peakTxBps: 900, peakRouterLoadPct: 68 });
});

test('formatAppForProtocolFilter removes redundant protocol labels when filtered', () => {
  assert.equal(formatAppForProtocolFilter('TCP / 8123', 'TCP', 8123, 'TCP'), 'Port 8123');
  assert.equal(formatAppForProtocolFilter('TCP / 8123', 'TCP', 8123, 'ALL'), 'TCP / 8123');
  assert.equal(formatAppForProtocolFilter('DNS over TCP', 'TCP', 53, 'TCP'), 'DNS');
  assert.equal(formatAppForProtocolFilter('ICMP Ping', 'ICMP', 0, 'ICMP'), 'Ping');
  assert.equal(formatAppForProtocolFilter('HTTPS / TLS', 'TCP', 443, 'TCP'), 'HTTPS / TLS');
});

