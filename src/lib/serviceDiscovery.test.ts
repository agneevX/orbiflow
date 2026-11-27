import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LanServiceDiscovery,
  buildDnsQueryPacket,
  buildNetbiosStatQuery,
  extractMdnsDiscoveries,
  isSafeLanTargetIp,
  parseDnsPacket,
  parseNetbiosNodeStatus,
  parseSsdpHeaders,
  parseUpnpDeviceXml,
} from '../../server/serviceDiscovery';

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.+$/, '').split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const b = Buffer.from(part, 'utf8');
    chunks.push(Buffer.from([b.length]), b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function buildRr(name: string, type: number, rdata: Buffer, ttl = 120): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2); // IN
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function buildTxtRdata(entries: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const b = Buffer.from(entry, 'utf8');
    chunks.push(Buffer.from([b.length]), b);
  }
  return Buffer.concat(chunks);
}

function buildSrvRdata(port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function buildMdnsResponse(records: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // Standard query response, AA
  header.writeUInt16BE(records.length, 6); // ANCOUNT
  return Buffer.concat([header, ...records]);
}

test('isSafeLanTargetIp allows RFC1918 LAN targets and blocks loopback/link-local/public IPs', () => {
  assert.equal(isSafeLanTargetIp('192.168.1.42'), true);
  assert.equal(isSafeLanTargetIp('10.0.20.15'), true);
  assert.equal(isSafeLanTargetIp('172.16.5.9'), true);

  assert.equal(isSafeLanTargetIp('127.0.0.1'), false);
  assert.equal(isSafeLanTargetIp('169.254.169.254'), false);
  assert.equal(isSafeLanTargetIp('8.8.8.8'), false);
  assert.equal(isSafeLanTargetIp('not-an-ip'), false);
});

test('mDNS parser extracts Google Cast friendly name (fn) and model (md)', () => {
  const instance = 'Chromecast-a1b2c3d4._googlecast._tcp.local';
  const target = 'chromecast-a1b2.local';
  const packet = buildMdnsResponse([
    buildRr('_googlecast._tcp.local', 12, encodeName(instance)),
    buildRr(instance, 33, buildSrvRdata(8009, target)),
    buildRr(instance, 16, buildTxtRdata(['fn=Bedroom Chromecast', 'md=Chromecast with Google TV'])),
    buildRr(target, 1, Buffer.from([192, 168, 1, 91])),
  ]);

  const records = parseDnsPacket(packet);
  assert.equal(records.length, 4);

  const candidates = extractMdnsDiscoveries(records, '192.168.1.91');
  const cast = candidates.find((c) => c.protocol === 'Google Cast');
  assert.ok(cast);
  assert.equal(cast.ip, '192.168.1.91');
  assert.equal(cast.name, 'Bedroom Chromecast');
  assert.equal(cast.model, 'Chromecast with Google TV');
});

test('mDNS parser extracts ADB wireless debugging device name from TXT name and ignores opaque serial instance', () => {
  const instance = 'adb-3A141FDH20041C-k9pR2a._adb-tls-connect._tcp.local';
  const target = 'pixel-9-pro.local';
  const packet = buildMdnsResponse([
    buildRr('_adb-tls-connect._tcp.local', 12, encodeName(instance)),
    buildRr(instance, 33, buildSrvRdata(37123, target)),
    buildRr(instance, 16, buildTxtRdata(['name=Pixel 9 Pro', 'v=2'])),
    buildRr(target, 1, Buffer.from([192, 168, 1, 55])),
  ]);

  const records = parseDnsPacket(packet);
  const candidates = extractMdnsDiscoveries(records, '192.168.1.55');
  const adb = candidates.find((c) => c.protocol === 'ADB');
  assert.ok(adb);
  assert.equal(adb.ip, '192.168.1.55');
  assert.equal(adb.name, 'Pixel 9 Pro');
});

test('mDNS parser strips AirPlay RAOP 12-hex MAC prefix', () => {
  const instance = 'A483E7112233@Living Room HomePod._raop._tcp.local';
  const target = 'Living-Room-HomePod.local';
  const packet = buildMdnsResponse([
    buildRr('_raop._tcp.local', 12, encodeName(instance)),
    buildRr(instance, 33, buildSrvRdata(7000, target)),
    buildRr(target, 1, Buffer.from([192, 168, 1, 60])),
  ]);

  const candidates = extractMdnsDiscoveries(parseDnsPacket(packet), '192.168.1.60');
  const raop = candidates.find((c) => c.protocol === 'AirPlay Audio');
  assert.ok(raop);
  assert.equal(raop.name, 'Living Room HomePod');
});

test('buildDnsQueryPacket encodes valid mDNS query headers', () => {
  const query = buildDnsQueryPacket('_googlecast._tcp.local', 12, true);
  assert.equal(query.readUInt16BE(4), 1); // QDCOUNT
  assert.equal(query.readUInt16BE(query.length - 4), 12); // PTR
  assert.equal(query.readUInt16BE(query.length - 2), 0x8001); // QU bit + IN
});

test('SSDP header and UPnP device XML parsers extract friendlyName and modelName', () => {
  const rawSsdp = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'LOCATION: http://192.168.1.77:8008/ssdp/device-desc.xml',
    'ST: urn:dial-multiscreen-org:service:dial:1',
    'USN: uuid:1234',
    '',
  ].join('\r\n');

  const headers = parseSsdpHeaders(rawSsdp);
  assert.equal(headers.location, 'http://192.168.1.77:8008/ssdp/device-desc.xml');
  assert.equal(headers.st, 'urn:dial-multiscreen-org:service:dial:1');

  const xml = `<?xml version="1.0"?>
    <root><device>
      <friendlyName>Living Room &amp; Den TV</friendlyName>
      <modelName>LG OLED65C3</modelName>
      <manufacturer>LG Electronics</manufacturer>
    </device></root>`;
  const parsed = parseUpnpDeviceXml(xml);
  assert.equal(parsed.friendlyName, 'Living Room & Den TV');
  assert.equal(parsed.modelName, 'LG OLED65C3');
  assert.equal(parsed.manufacturer, 'LG Electronics');
});

test('NetBIOS NBSTAT query builder and response parser extract unique workstation hostname', () => {
  const query = buildNetbiosStatQuery(0x1234);
  assert.equal(query.length, 50);
  assert.equal(query.readUInt16BE(0), 0x1234);
  assert.equal(query.readUInt16BE(46), 0x0021); // NBSTAT

  // Construct synthetic NBSTAT response with a group entry (ignored) and a unique workstation entry
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6); // ANCOUNT = 1

  const nameField = Buffer.concat([Buffer.from([0x20, 0x43, 0x4b]), Buffer.alloc(30, 0x41), Buffer.from([0])]);
  const entry1 = Buffer.alloc(18);
  entry1.write('WORKGROUP      ', 0, 'ascii');
  entry1[15] = 0x00;
  entry1.writeUInt16BE(0x8400, 16); // group flag set -> must be skipped

  const entry2 = Buffer.alloc(18);
  entry2.write('GAMING-PC      ', 0, 'ascii');
  entry2[15] = 0x00;
  entry2.writeUInt16BE(0x0400, 16); // unique workstation name

  const rdata = Buffer.concat([Buffer.from([2]), entry1, entry2]);
  const rrHead = Buffer.alloc(10);
  rrHead.writeUInt16BE(0x0021, 0); // NBSTAT
  rrHead.writeUInt16BE(0x0001, 2); // IN
  rrHead.writeUInt32BE(0, 4);
  rrHead.writeUInt16BE(rdata.length, 8);

  const response = Buffer.concat([header, nameField, rrHead, rdata]);
  assert.equal(parseNetbiosNodeStatus(response), 'GAMING-PC');
});

test('LanServiceDiscovery merges multi-protocol services and preserves highest-priority friendly name', () => {
  const discovery = new LanServiceDiscovery();
  const events: string[] = [];
  discovery.setOnDiscovered((entry) => events.push(`${entry.ip}:${entry.name}`));

  // First discover lower-priority NetBIOS name
  discovery.ingestCandidate({
    ip: '192.168.1.55',
    name: 'PIXEL-PHONE',
    protocol: 'NetBIOS',
    serviceLabel: 'NetBIOS',
    score: 70,
  });

  // Then discover higher-priority ADB name + model
  discovery.ingestCandidate({
    ip: '192.168.1.55',
    name: 'Pixel 9 Pro',
    protocol: 'ADB',
    model: 'Pixel 9 Pro',
    serviceLabel: 'ADB',
    score: 88,
  });

  // Then discover lower-priority SSH on same IP (should keep Pixel 9 Pro name, but add SSH service)
  discovery.ingestCandidate({
    ip: '192.168.1.55',
    name: 'localhost-ssh',
    protocol: 'SSH',
    serviceLabel: 'SSH',
    score: 76,
  });

  const result = discovery.lookup('192.168.1.55');
  assert.ok(result);
  assert.equal(result.name, 'Pixel 9 Pro');
  assert.equal(result.protocol, 'ADB');
  assert.equal(result.model, 'Pixel 9 Pro');
  assert.deepEqual(result.services, ['NetBIOS', 'ADB', 'SSH']);
  assert.equal(events.length, 3);

  // Public IP candidate is safely ignored
  discovery.ingestCandidate({
    ip: '8.8.8.8',
    name: 'dns.google',
    protocol: 'Google Cast',
    serviceLabel: 'Google Cast',
    score: 95,
  });
  assert.equal(discovery.lookup('8.8.8.8'), null);
});
