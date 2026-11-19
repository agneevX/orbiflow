import { useState } from 'react';
import { ArrowRight, Check, Pencil, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { BandwidthUnit, DeviceNameSource, HostSummary } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import { formatBandwidth, formatBytes } from '../lib/formatters';
import { TechTerm } from './TechTerm';

interface HostsViewProps {
  hosts: HostSummary[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  onInspectHostFlows: (host: HostSummary) => void;
  onSaveAlias: (alias: { key: string; matchBy: 'mac' | 'ip'; name: string }) => Promise<void>;
  onDeleteAlias: (key: string) => Promise<void>;
}

const SOURCE_META: Record<DeviceNameSource, { label: string; tip: string }> = {
  alias: {
    label: 'Custom',
    tip: 'Manually named by you and saved persistently in /config/config.json.',
  },
  'lan-dns': {
    label: 'LAN DNS',
    tip: 'Resolved via reverse PTR lookup against your local DNS server / router dnsmasq.',
  },
  dhcp: {
    label: 'DHCP',
    tip: 'Hostname reported by the router DHCP lease file or static hosts table.',
  },
  fingerprint: {
    label: 'Inferred',
    tip: 'No DHCP or DNS name was found (common with Private Wi-Fi MACs). Device type was inferred from its live traffic destinations. Click the rename icon to label it permanently.',
  },
  ip: {
    label: 'IP Only',
    tip: 'No hostname resolved yet from LAN DNS, DHCP, or traffic patterns. Click the rename icon to label this device.',
  },
};

export function HostsView({
  hosts,
  unit,
  theme,
  onInspectHostFlows,
  onSaveAlias,
  onDeleteAlias,
}: HostsViewProps) {
  const [editingIp, setEditingIp] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [matchBy, setMatchBy] = useState<'mac' | 'ip'>('mac');
  const [saving, setSaving] = useState(false);

  const randomizedCount = hosts.filter((h) => h.isRandomizedMac).length;

  const startEdit = (host: HostSummary) => {
    setEditingIp(host.ip);
    setDraftName(host.nameSource === 'ip' ? '' : host.hostname);
    const hasRealMac = host.mac && host.mac !== '00:00:00:00:00:00';
    setMatchBy(host.aliasMatchBy ?? (hasRealMac ? 'mac' : 'ip'));
  };

  const cancelEdit = () => {
    setEditingIp(null);
    setDraftName('');
  };

  const commitEdit = async (host: HostSummary) => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      cancelEdit();
      return;
    }
    const key = matchBy === 'mac' ? `mac:${host.mac}` : `ip:${host.ip}`;
    setSaving(true);
    try {
      await onSaveAlias({ key, matchBy, name: trimmed });
      setEditingIp(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b app-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold">
              Discovered Local Devices ({hosts.length})
            </h2>
            <p className="text-xs app-text-muted mt-0.5">
              Resolved via{' '}
              <TechTerm
                label="LAN DNS (PTR)"
                tip="Queries your local DNS server or custom router dnsmasq for private IP reverse lookups, independent of external WAN rDNS."
              />
              , router{' '}
              <TechTerm
                label="ARP / DHCP"
                tip="Combines /proc/net/arp neighbor entries with custom dnsmasq leases, static dhcp-host records, and /etc/hosts."
              />
              , and passive traffic hints for nameless devices
            </p>
          </div>
          {randomizedCount > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-amber-500">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <TechTerm
                label={`${randomizedCount} Private MAC ${randomizedCount === 1 ? 'device' : 'devices'}`}
                tip="Devices using IEEE 802.3 locally administered (randomized) MAC addresses (iOS Private Wi-Fi Address, Android Randomized MAC, Windows). Per-network randomized MACs usually stay consistent on your home SSID so pinning a custom name by MAC works across IP renewals."
              />
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b app-border text-[11px] font-medium app-text-muted app-sidebar">
                <th className="py-2.5 px-3">Device Name / Type</th>
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="IP Address"
                    tip="The private IPv4 address assigned to this device on your local home network."
                  />
                </th>
                <th className="py-2.5 px-3">
                  <TechTerm
                    label="MAC Address"
                    tip="Hardware network identifier. Addresses with the IEEE locally administered bit set (2nd hex digit 2, 6, a, or e) are flagged as Private MACs."
                  />
                </th>
                <th className="py-2.5 px-3">Top Services</th>
                <th className="py-2.5 px-3 text-right">Conns</th>
                <th className="py-2.5 px-3 text-right">Download</th>
                <th className="py-2.5 px-3 text-right">Upload</th>
                <th className="py-2.5 px-3 text-right">Total</th>
                <th className="py-2.5 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y app-border text-xs">
              {hosts.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center app-text-muted">
                    No local devices reported by agent yet.
                  </td>
                </tr>
              ) : (
                hosts.map((host) => {
                  const isEditing = editingIp === host.ip;
                  const sourceMeta = SOURCE_META[host.nameSource] || SOURCE_META.ip;
                  const hasValidMac = host.mac && host.mac !== '00:00:00:00:00:00';

                  return (
                    <tr key={host.ip} className="app-row-hover transition-colors">
                      <td className="py-3 px-3 min-w-[180px]">
                        {isEditing ? (
                          <div className="space-y-1.5" data-testid="device-rename-form">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                data-testid="device-rename-input"
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    void commitEdit(host);
                                  } else if (e.key === 'Escape') {
                                    cancelEdit();
                                  }
                                }}
                                placeholder="e.g. Alex's iPhone"
                                autoFocus
                                className="w-40 app-input border rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-sky-500"
                              />
                              <button
                                type="button"
                                data-testid="device-rename-save"
                                disabled={saving}
                                onClick={() => void commitEdit(host)}
                                aria-label="Save custom device name"
                                className="p-1 rounded-lg app-btn-primary"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                aria-label="Cancel rename"
                                className="p-1 rounded-lg border app-border app-row-hover app-text-muted"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] app-text-muted">
                              <span>Pin by:</span>
                              {hasValidMac && (
                                <label className="inline-flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`match-${host.ip}`}
                                    checked={matchBy === 'mac'}
                                    onChange={() => setMatchBy('mac')}
                                    className="text-sky-500"
                                  />
                                  <span>MAC</span>
                                </label>
                              )}
                              <label className="inline-flex items-center gap-1 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`match-${host.ip}`}
                                  checked={matchBy === 'ip'}
                                  onChange={() => setMatchBy('ip')}
                                  className="text-sky-500"
                                />
                                <span>IP</span>
                              </label>
                              {host.aliasKey && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await onDeleteAlias(host.aliasKey!);
                                    setEditingIp(null);
                                  }}
                                  className="inline-flex items-center gap-1 text-amber-500 hover:underline ml-auto"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Reset
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium">{host.hostname}</span>
                              <button
                                type="button"
                                data-testid={`rename-host-${host.ip}`}
                                onClick={() => startEdit(host)}
                                aria-label={`Rename ${host.hostname}`}
                                title="Assign custom device name (saved in /config/config.json)"
                                className="p-1 rounded-lg app-text-muted hover:text-sky-500 transition-colors"
                              >
                                <Pencil className="h-3 w-3" aria-hidden="true" />
                              </button>
                            </div>
                            <div className="text-[11px] app-text-muted flex items-center gap-1.5 flex-wrap">
                              <span>{host.vendor}</span>
                              <span aria-hidden="true">·</span>
                              <TechTerm
                                label={sourceMeta.label}
                                tip={
                                  host.ptrHostname
                                    ? `${sourceMeta.tip} Full PTR: ${host.ptrHostname}`
                                    : sourceMeta.tip
                                }
                              />
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-3 font-mono whitespace-nowrap tabular-nums">
                        {host.ip}
                      </td>
                      <td className="py-3 px-3 font-mono app-text-muted whitespace-nowrap">
                        <div>{host.mac}</div>
                        {host.isRandomizedMac && (
                          <div className="text-[11px] font-sans text-amber-500 mt-0.5">
                            <TechTerm
                              label="Private MAC"
                              tip="IEEE 802.3 locally administered (randomized) MAC address. On iOS/Android home Wi-Fi this address typically stays fixed per SSID, so naming it by MAC persists across DHCP renewals."
                            />
                          </div>
                        )}
                      </td>
                      <td
                        className="py-3 px-3 app-text-secondary whitespace-nowrap max-w-[170px] truncate"
                        title={host.topApps.join(' · ')}
                      >
                        {host.topApps.length > 0 ? host.topApps.join(' · ') : 'Idle'}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums">
                        {host.activeFlows}
                      </td>
                      <td
                        className="py-3 px-3 text-right font-mono whitespace-nowrap tabular-nums"
                        style={{ color: theme.rxColor }}
                      >
                        {formatBandwidth(host.rxBps, unit)}
                      </td>
                      <td
                        className="py-3 px-3 text-right font-mono whitespace-nowrap tabular-nums"
                        style={{ color: theme.txColor }}
                      >
                        {formatBandwidth(host.txBps, unit)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono whitespace-nowrap tabular-nums">
                        {formatBytes(host.totalBytes)}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onInspectHostFlows(host)}
                          aria-label={`View connections for ${host.hostname}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border app-border app-row-hover transition-colors"
                        >
                          Connections
                          <ArrowRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
