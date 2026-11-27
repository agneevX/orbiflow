import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintDeviceHint,
  isRandomizedMac,
  lookupMacVendor,
  resolveHostIdentity,
  stripLocalDomain,
} from './deviceIdentity';
import { LanResolver, parseDnsServers } from '../../server/lanResolver';

test('isRandomizedMac detects IEEE 802.3 locally administered unicast MAC addresses', () => {
  // Locally administered bit (0x02) set, multicast bit (0x01) clear -> 2nd hex digit in {2,6,a,e}
  assert.equal(isRandomizedMac('da:a1:19:4c:82:10'), true);
  assert.equal(isRandomizedMac('02:42:ac:11:00:02'), true);
  assert.equal(isRandomizedMac('66:1b:2c:3d:4e:5f'), true);
  assert.equal(isRandomizedMac('ae:91:00:11:22:33'), true);

  // Universally administered (real OUI hardware MACs)
  assert.equal(isRandomizedMac('f0:18:98:4b:91:c0'), false); // Apple
  assert.equal(isRandomizedMac('00:11:32:9e:44:7b'), false); // Synology
  assert.equal(isRandomizedMac('00:00:00:00:00:00'), false); // Unknown placeholder
});

test('lookupMacVendor flags randomized MACs and identifies known hardware OUIs', () => {
  const rand = lookupMacVendor('da:a1:19:4c:82:10', 'Some Stale Vendor');
  assert.equal(rand.isRandomized, true);
  assert.equal(rand.vendor, 'Private / Randomized MAC');

  const syn = lookupMacVendor('00:11:32:9e:44:7b');
  assert.equal(syn.isRandomized, false);
  assert.equal(syn.vendor, 'Synology');
});

test('stripLocalDomain strips domain suffixes cleanly when enabled', () => {
  assert.equal(stripLocalDomain('macbook-pro.home.arpa.', true), 'macbook-pro');
  assert.equal(stripLocalDomain('livingroom-atv.lan', true), 'livingroom-atv');
  assert.equal(stripLocalDomain('livingroom-atv.lan.', false), 'livingroom-atv.lan');
});

test('fingerprintDeviceHint identifies Apple, IoT, and Gaming devices from flow patterns', () => {
  assert.equal(
    fingerprintDeviceHint([
      { dstService: 'Apple', app: 'Apple APNs', dport: 5223 },
      { dstService: 'Apple', app: 'HTTPS / TLS', dport: 443 },
    ]),
    'Apple Device'
  );

  assert.equal(
    fingerprintDeviceHint([
      { dstService: 'Valve / Steam', app: 'Steam Client', dport: 27015 },
      { dstService: 'Discord', app: 'HTTPS / TLS', dport: 443 },
    ]),
    'Gaming Device'
  );
});

test('resolveHostIdentity prioritizes alias > LAN DNS PTR > DHCP > fingerprint > IP', () => {
  const ip = '192.168.1.91';
  const mac = 'da:a1:19:4c:82:10';

  // 1. No alias, no PTR, no DHCP, has behavioral hint
  const fp = resolveHostIdentity({
    ip,
    mac,
    deviceHint: 'Apple Device',
    aliases: {},
    stripDomain: true,
  });
  assert.equal(fp.nameSource, 'fingerprint');
  assert.equal(fp.isRandomizedMac, true);
  assert.equal(fp.hostname, 'Apple Device (.91)');
  assert.equal(fp.vendor, 'Apple Device · Private MAC');

  // 2. LAN DNS PTR overrides DHCP & fingerprint
  const ptr = resolveHostIdentity({
    ip,
    mac,
    dhcpHostname: 'old-dhcp-name',
    ptrHostname: 'iphone-bedroom.lan.',
    deviceHint: 'Apple Device',
    aliases: {},
    stripDomain: true,
  });
  assert.equal(ptr.nameSource, 'lan-dns');
  assert.equal(ptr.hostname, 'iphone-bedroom');
  assert.equal(ptr.ptrHostname, 'iphone-bedroom.lan');

  // 3. User custom alias overrides LAN DNS PTR
  const aliased = resolveHostIdentity({
    ip,
    mac,
    ptrHostname: 'iphone-bedroom.lan',
    aliases: {
      [`mac:${mac}`]: { key: `mac:${mac}`, matchBy: 'mac', name: "Alex's iPhone" },
    },
    stripDomain: true,
  });
  assert.equal(aliased.nameSource, 'alias');
  assert.equal(aliased.hostname, "Alex's iPhone");

  // 4. Disabling inferDeviceNames falls back to raw IP & generic Private MAC vendor
  const noInfer = resolveHostIdentity({
    ip,
    mac,
    deviceHint: 'Apple Device',
    aliases: {},
    stripDomain: true,
    inferDeviceNames: false,
  });
  assert.equal(noInfer.nameSource, 'ip');
  assert.equal(noInfer.hostname, ip);
  assert.equal(noInfer.vendor, 'Private / Randomized MAC');
  assert.equal(noInfer.deviceHint, 'Apple Device');
});

test('LanResolver only resolves private IPs, honors enabled toggle, and defaults to container DNS', () => {
  assert.deepEqual(parseDnsServers('192.168.1.2, 192.168.1.1:5353'), [
    '192.168.1.2',
    '192.168.1.1:5353',
  ]);
  assert.deepEqual(parseDnsServers(''), []);

  // Default config uses container DNS (server === '') and enabled === true
  const defaultResolver = new LanResolver();
  assert.equal(defaultResolver.getConfig().enabled, true);
  assert.equal(defaultResolver.getConfig().server, '');

  // Disabled resolver returns null even for cached private IPs
  const disabled = new LanResolver({ enabled: false, server: '192.168.1.2', ttlSec: 300 });
  disabled.setEntry('192.168.1.24', 'macbook-pro.lan');
  assert.equal(disabled.lookup('192.168.1.24'), null);

  // Enabled resolver returns cached private IP PTRs and ignores public IPs
  const enabled = new LanResolver({ enabled: true, server: '', ttlSec: 300 });
  enabled.setEntry('192.168.1.24', 'macbook-pro.lan');
  assert.equal(enabled.lookup('192.168.1.24'), 'macbook-pro.lan');
  assert.equal(enabled.lookup('1.1.1.1'), null);
  assert.equal(enabled.getStats().resolved, 1);
});
