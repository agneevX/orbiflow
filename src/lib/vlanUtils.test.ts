import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatchingVlan,
  getIpv4Slash24,
  ipMatchesCidr,
  parseIpv4Cidr,
  sanitizeVlanConfigs,
  validateVlanCidr,
} from './vlanUtils';
import type { VlanConfig } from '../types/telemetry';

test('parseIpv4Cidr normalizes host bits and rejects invalid CIDRs', () => {
  const parsed = parseIpv4Cidr('10.0.1.55/24');
  assert.ok(parsed);
  assert.equal(parsed.normalized, '10.0.1.0/24');
  assert.equal(parsed.prefix, 24);

  assert.equal(parseIpv4Cidr('192.168.10.0/23')?.normalized, '192.168.10.0/23');
  assert.equal(parseIpv4Cidr('10.0.1.1/32')?.normalized, '10.0.1.1/32');
  assert.equal(parseIpv4Cidr('10.0.1.0/33'), null);
  assert.equal(parseIpv4Cidr('999.0.1.0/24'), null);
  assert.equal(parseIpv4Cidr('not-a-cidr'), null);

  assert.equal(validateVlanCidr('10.0.1.0/24').ok, true);
  assert.equal(validateVlanCidr('10.0.1.0/4').ok, false);
});

test('ipMatchesCidr and getIpv4Slash24 accurately match subnets', () => {
  assert.equal(ipMatchesCidr('10.0.1.42', '10.0.1.0/24'), true);
  assert.equal(ipMatchesCidr('10.0.2.42', '10.0.1.0/24'), false);
  assert.equal(ipMatchesCidr('172.17.0.5', '172.16.0.0/12'), true);
  assert.equal(ipMatchesCidr('192.168.1.5', '172.16.0.0/12'), false);
  assert.equal(getIpv4Slash24('10.0.1.88'), '10.0.1.0/24');
  assert.equal(getIpv4Slash24('invalid'), null);
});

test('findMatchingVlan chooses longest-prefix CIDR match', () => {
  const vlans: VlanConfig[] = [
    { id: 'v1', name: 'Corp Space', cidr: '10.0.0.0/16' },
    { id: 'v2', name: 'Docker Containers', cidr: '10.0.1.0/24', vlanId: 10 },
  ];

  const docker = findMatchingVlan('10.0.1.25', vlans);
  assert.equal(docker?.name, 'Docker Containers');
  assert.equal(docker?.vlanId, 10);

  const corp = findMatchingVlan('10.0.9.5', vlans);
  assert.equal(corp?.name, 'Corp Space');

  assert.equal(findMatchingVlan('192.168.1.10', vlans), null);
});

test('sanitizeVlanConfigs normalizes CIDRs, deduplicates, and filters invalid entries', () => {
  const clean = sanitizeVlanConfigs([
    { id: '1', name: '  Docker VLAN  ', cidr: '10.0.1.99/24', vlanId: 10 },
    { id: '2', name: 'Duplicate', cidr: '10.0.1.0/24' },
    { id: '3', name: 'Bad CIDR', cidr: '300.1.1.0/24' },
    { id: '4', name: '', cidr: '10.0.2.0/24' },
    { id: '5', name: 'IoT', cidr: '192.168.30.0/24', vlanId: 30 },
  ]);

  assert.equal(clean.length, 2);
  assert.equal(clean[0].name, 'Docker VLAN');
  assert.equal(clean[0].cidr, '10.0.1.0/24');
  assert.equal(clean[0].vlanId, 10);
  assert.equal(clean[1].name, 'IoT');
  assert.equal(clean[1].cidr, '192.168.30.0/24');
});
