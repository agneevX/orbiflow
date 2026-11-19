import { ArrowRight } from 'lucide-react';
import type { BandwidthUnit, HostSummary } from '../types/telemetry';
import type { ThemePalette } from '../lib/themes';
import { formatBandwidth, formatBytes } from '../lib/formatters';
import { TechTerm } from './TechTerm';

interface HostsViewProps {
  hosts: HostSummary[];
  unit: BandwidthUnit;
  theme: ThemePalette;
  onInspectHostFlows: (host: HostSummary) => void;
}

export function HostsView({ hosts, unit, theme, onInspectHostFlows }: HostsViewProps) {
  return (
    <div className="space-y-4">
      <div className="app-surface border rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b app-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold">
              Discovered Local Devices ({hosts.length})
            </h2>
            <p className="text-xs app-text-muted mt-0.5">
              Matched from router{' '}
              <TechTerm
                label="ARP"
                tip="Address Resolution Protocol table (/proc/net/arp) mapping local network IP addresses to each device's hardware MAC address."
              />{' '}
              and{' '}
              <TechTerm
                label="DHCP"
                tip="Dynamic Host Configuration Protocol leases containing the friendly hostnames your router assigned to devices."
              />{' '}
              tables against active internet connections
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b app-border text-[11px] font-medium app-text-muted app-sidebar">
                <th className="py-2.5 px-4">Device Name / Type</th>
                <th className="py-2.5 px-4">
                  <TechTerm
                    label="IP Address"
                    tip="The private IPv4 address assigned to this device on your local home network."
                  />
                </th>
                <th className="py-2.5 px-4">
                  <TechTerm
                    label="MAC Address"
                    tip="Media Access Control address — the unique hardware identifier burned into a device's network adapter."
                  />
                </th>
                <th className="py-2.5 px-4">Top Services</th>
                <th className="py-2.5 px-4 text-right">Connections</th>
                <th className="py-2.5 px-4 text-right">Download</th>
                <th className="py-2.5 px-4 text-right">Upload</th>
                <th className="py-2.5 px-4 text-right">Total Data</th>
                <th className="py-2.5 px-4 text-right">Action</th>
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
                hosts.map((host) => (
                  <tr key={host.ip} className="app-row-hover transition-colors">
                    <td className="py-3 px-4 whitespace-nowrap">
                      <div className="font-medium">{host.hostname}</div>
                      <div className="text-[11px] app-text-muted">{host.vendor}</div>
                    </td>
                    <td className="py-3 px-4 font-mono whitespace-nowrap tabular-nums">
                      {host.ip}
                    </td>
                    <td className="py-3 px-4 font-mono app-text-muted whitespace-nowrap">
                      {host.mac}
                    </td>
                    <td className="py-3 px-4 app-text-secondary whitespace-nowrap">
                      {host.topApps.length > 0 ? host.topApps.join(' · ') : 'Idle'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {host.activeFlows}
                    </td>
                    <td
                      className="py-3 px-4 text-right font-mono whitespace-nowrap tabular-nums"
                      style={{ color: theme.rxColor }}
                    >
                      {formatBandwidth(host.rxBps, unit)}
                    </td>
                    <td
                      className="py-3 px-4 text-right font-mono whitespace-nowrap tabular-nums"
                      style={{ color: theme.txColor }}
                    >
                      {formatBandwidth(host.txBps, unit)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono whitespace-nowrap tabular-nums">
                      {formatBytes(host.totalBytes)}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
