import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteUrl, getDocumentTitle, parseRouteFromLocation } from './routing';

test('parseRouteFromLocation parses top-level slugs, sub-tabs, and connection query', () => {
  assert.deepEqual(parseRouteFromLocation('/', ''), {
    tab: 'overview',
    devicesSubTab: 'list',
    query: '',
  });
  assert.deepEqual(parseRouteFromLocation('/devices', ''), {
    tab: 'hosts',
    devicesSubTab: 'list',
    query: '',
  });
  assert.deepEqual(parseRouteFromLocation('/devices/network-map', ''), {
    tab: 'hosts',
    devicesSubTab: 'map',
    query: '',
  });
  assert.deepEqual(parseRouteFromLocation('/connections', '?q=10.0.1.20'), {
    tab: 'flows',
    devicesSubTab: 'list',
    query: '10.0.1.20',
  });
  assert.deepEqual(parseRouteFromLocation('/settings/', ''), {
    tab: 'settings',
    devicesSubTab: 'list',
    query: '',
  });
  assert.deepEqual(parseRouteFromLocation('/alerts', ''), {
    tab: 'alerts',
    devicesSubTab: 'list',
    query: '',
  });
  assert.deepEqual(parseRouteFromLocation('/agent', ''), {
    tab: 'setup',
    devicesSubTab: 'list',
    query: '',
  });
  // Unknown slug falls back to Home
  assert.deepEqual(parseRouteFromLocation('/unknown/slug', ''), {
    tab: 'overview',
    devicesSubTab: 'list',
    query: '',
  });
});

test('buildRouteUrl and getDocumentTitle produce clean slugs and browser titles', () => {
  assert.equal(buildRouteUrl('overview', 'list'), '/');
  assert.equal(buildRouteUrl('hosts', 'list'), '/devices');
  assert.equal(buildRouteUrl('hosts', 'map'), '/devices/network-map');
  assert.equal(buildRouteUrl('flows', 'list', '192.168.1.10'), '/connections?q=192.168.1.10');
  assert.equal(buildRouteUrl('setup', 'list'), '/agent');
  assert.equal(buildRouteUrl('settings', 'list'), '/settings');

  assert.equal(getDocumentTitle('overview', 'list'), 'Home - OrbiFlow');
  assert.equal(getDocumentTitle('flows', 'list'), 'Connections - OrbiFlow');
  assert.equal(getDocumentTitle('hosts', 'list'), 'Devices - OrbiFlow');
  assert.equal(getDocumentTitle('hosts', 'map'), 'Network Map - OrbiFlow');
  assert.equal(getDocumentTitle('alerts', 'list'), 'Alerts - OrbiFlow');
  assert.equal(getDocumentTitle('setup', 'list'), 'Agent - OrbiFlow');
  assert.equal(getDocumentTitle('settings', 'list'), 'Settings - OrbiFlow');
});
