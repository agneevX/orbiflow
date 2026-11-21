import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONNECTIONS_TABLE_PREFS,
  DEFAULT_DEVICES_TABLE_PREFS,
  DEFAULT_TABLE_PREFERENCES,
  sanitizeConnectionsTablePrefs,
  sanitizeDevicesTablePrefs,
  sanitizeTablePreferences,
  validateDhcpLeasesPath,
  validateDnsServer,
} from './tablePreferences';

test('DEFAULT_CONNECTIONS_TABLE_PREFS matches exact 7 user-friendly default columns and hides technical fields', () => {
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showAppProtocol, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showProtocol, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showLocalDevice, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showDestination, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showDestinationRdns, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showDownload, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showUpload, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showTotal, true);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showDuration, true);

  // Hidden by default
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showLocalPort, false);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showLocalIp, false);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showCategory, false);
  assert.equal(DEFAULT_CONNECTIONS_TABLE_PREFS.showDestinationIpPort, false);
});

test('DEFAULT_DEVICES_TABLE_PREFS hides technical MAC and connection count columns by default', () => {
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showIp, true);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showVendorSource, true);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showConnection, true);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showTopServices, true);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showDownload, true);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showUpload, true);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showTotal, true);

  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showMac, false);
  assert.equal(DEFAULT_DEVICES_TABLE_PREFS.showConnections, false);
});

test('sanitizeTablePreferences merges partial updates safely and prevents hiding every column', () => {
  const merged = sanitizeTablePreferences(
    {
      connections: { showCategory: true, showLocalPort: true, showProtocol: 'invalid' },
      devices: { showMac: true, showConnections: true },
    },
    DEFAULT_TABLE_PREFERENCES
  );
  assert.equal(merged.connections.showCategory, true);
  assert.equal(merged.connections.showLocalPort, true);
  assert.equal(merged.connections.showProtocol, true); // fallback kept
  assert.equal(merged.devices.showMac, true);
  assert.equal(merged.devices.showConnections, true);

  // If all columns are turned off, Destination remains enabled
  const allOff = sanitizeConnectionsTablePrefs({
    showAppProtocol: false,
    showLocalDevice: false,
    showDestination: false,
    showDestinationIpPort: false,
    showCategory: false,
    showDownload: false,
    showUpload: false,
    showTotal: false,
    showDuration: false,
  });
  assert.equal(allOff.showDestination, true);

  const devSanitized = sanitizeDevicesTablePrefs(null);
  assert.deepEqual(devSanitized, DEFAULT_DEVICES_TABLE_PREFS);
});

test('validateDhcpLeasesPath accepts empty or safe absolute POSIX file paths and rejects traversal or shell injection', () => {
  assert.deepEqual(validateDhcpLeasesPath(''), { ok: true, value: '' });
  assert.deepEqual(validateDhcpLeasesPath('   '), { ok: true, value: '' });
  assert.deepEqual(validateDhcpLeasesPath('/tmp/dhcp.leases'), {
    ok: true,
    value: '/tmp/dhcp.leases',
  });
  assert.deepEqual(validateDhcpLeasesPath('/opt/var/lib/misc/dnsmasq.leases'), {
    ok: true,
    value: '/opt/var/lib/misc/dnsmasq.leases',
  });

  // Rejects relative paths, traversal, trailing slashes, and shell metacharacters
  assert.equal(validateDhcpLeasesPath('tmp/dhcp.leases').ok, false);
  assert.equal(validateDhcpLeasesPath('/tmp/../etc/shadow').ok, false);
  assert.equal(validateDhcpLeasesPath('/tmp/dhcp.leases; rm -rf /').ok, false);
  assert.equal(validateDhcpLeasesPath('/tmp/$(id)').ok, false);
  assert.equal(validateDhcpLeasesPath('/tmp/leases/').ok, false);
});

test('validateDnsServer accepts blank, IPv4, IPv4:port, IPv6, and [IPv6]:port while rejecting malformed input', () => {
  assert.deepEqual(validateDnsServer(''), { ok: true, value: '' });
  assert.deepEqual(validateDnsServer('   '), { ok: true, value: '' });
  assert.deepEqual(validateDnsServer('1.1.1.1'), { ok: true, value: '1.1.1.1' });
  assert.deepEqual(validateDnsServer('9.9.9.9:5353'), { ok: true, value: '9.9.9.9:5353' });
  assert.deepEqual(validateDnsServer('2606:4700:4700::1111'), { ok: true, value: '2606:4700:4700::1111' });
  assert.deepEqual(validateDnsServer('[2606:4700:4700::1111]:53'), {
    ok: true,
    value: '[2606:4700:4700::1111]:53',
  });

  assert.equal(validateDnsServer('999.1.1.1').ok, false);
  assert.equal(validateDnsServer('1.1.1.1:70000').ok, false);
  assert.equal(validateDnsServer('dns.google').ok, false);
  assert.equal(validateDnsServer('1.1.1.1; rm -rf /').ok, false);
});

