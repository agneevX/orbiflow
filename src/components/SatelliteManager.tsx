import { useState } from 'react';
import {
  Check,
  KeyRound,
  Lock,
  Plus,
  Radio,
  Server,
  Trash2,
  Wifi,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import type {
  BandwidthUnit,
  PublicSatelliteConfig,
  SatelliteAuthMethod,
  SatelliteTelemetry,
} from '../types/telemetry';
import { formatBandwidth } from '../lib/formatters';
import { formatLinkSpeed } from '../lib/topology';

export interface SatelliteSavePayload {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SatelliteAuthMethod;
  password?: string;
  privateKey?: string;
  backhaulInterface?: string;
  pollIntervalSec: number;
  enabled: boolean;
}

interface SatelliteManagerProps {
  configs: PublicSatelliteConfig[];
  satellites: SatelliteTelemetry[];
  unit: BandwidthUnit;
  onSaveSatellite: (payload: SatelliteSavePayload) => Promise<{ ok: boolean; error?: string }>;
  onDeleteSatellite: (id: string) => Promise<void>;
  onTestSatellite: (
    payload: SatelliteSavePayload
  ) => Promise<{ ok: boolean; error?: string; summary?: string }>;
  compact?: boolean;
}

const EMPTY_FORM: SatelliteSavePayload = {
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: '',
  privateKey: '',
  backhaulInterface: '',
  pollIntervalSec: 5,
  enabled: true,
};

export function SatelliteManager({
  configs,
  satellites,
  unit,
  onSaveSatellite,
  onDeleteSatellite,
  onTestSatellite,
  compact = false,
}: SatelliteManagerProps) {
  const [formOpen, setFormOpen] = useState(configs.length === 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SatelliteSavePayload>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const telemetryById = new Map(satellites.map((s) => [s.id, s]));
  const simulatedSatellites = satellites.filter(
    (s) => s.source === 'simulator' && !configs.some((c) => c.id === s.id)
  );

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setStatusMsg(null);
    setFormOpen(true);
  };

  const openEdit = (cfg: PublicSatelliteConfig) => {
    setEditingId(cfg.id);
    setForm({
      id: cfg.id,
      name: cfg.name,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      authMethod: cfg.authMethod,
      password: '',
      privateKey: '',
      backhaulInterface: cfg.backhaulInterface || '',
      pollIntervalSec: cfg.pollIntervalSec,
      enabled: cfg.enabled,
    });
    setStatusMsg(null);
    setFormOpen(true);
  };

  const handleTest = async () => {
    setTesting(true);
    setStatusMsg(null);
    try {
      const res = await onTestSatellite({
        ...form,
        id: editingId || undefined,
      });
      if (res.ok) {
        setStatusMsg({ type: 'ok', text: res.summary || 'SSH connection succeeded.' });
      } else {
        setStatusMsg({ type: 'err', text: res.error || 'SSH test failed.' });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);
    try {
      const res = await onSaveSatellite({
        ...form,
        id: editingId || undefined,
      });
      if (res.ok) {
        setStatusMsg({ type: 'ok', text: `Saved ${form.name.trim()}. Polling started.` });
        setForm(EMPTY_FORM);
        setEditingId(null);
        setFormOpen(false);
      } else {
        setStatusMsg({ type: 'err', text: res.error || 'Unable to save satellite.' });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <p className="text-xs app-text-muted leading-relaxed">
            Polls Orbi satellites directly over SSH with{' '}
            <strong className="font-semibold app-text-secondary">zero files written</strong> to the
            satellite — safe for RAM-only / ephemeral satellite storage. Reads backhaul Rx/Tx,
            Ethernet port negotiation speeds, and connected LAN/Wi-Fi clients automatically.
          </p>
        </div>
        {!formOpen && (
          <button
            type="button"
            data-testid="add-satellite-btn"
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl app-btn-primary text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add Satellite
          </button>
        )}
      </div>

      {/* Configured SSH Satellites */}
      {configs.length > 0 && (
        <div className="divide-y app-border border app-border rounded-xl overflow-hidden">
          {configs.map((cfg) => {
            const live = telemetryById.get(cfg.id);
            const connected = Boolean(live?.connected);
            return (
              <div
                key={cfg.id}
                data-testid={`satellite-item-${cfg.id}`}
                className="p-3.5 app-input flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Radio
                      className={`h-3.5 w-3.5 shrink-0 ${
                        connected ? 'text-emerald-500' : 'text-amber-500'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="text-xs font-semibold truncate">{cfg.name}</span>
                    <span className="font-mono text-[11px] app-text-muted">
                      {cfg.username}@{cfg.host}:{cfg.port}
                    </span>
                  </div>
                  <div className="text-[11px] app-text-muted mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono tabular-nums">
                    <span className={connected ? 'text-emerald-500 font-medium' : 'text-amber-500'}>
                      {connected
                        ? 'SSH Connected'
                        : live?.lastError || (cfg.enabled ? 'Connecting...' : 'Paused')}
                    </span>
                    {connected && live && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          Backhaul {formatLinkSpeed(live.backhaulSpeedMbps, live.backhaulType, true)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          ↓ {formatBandwidth(live.rxBps, unit)} ↑ {formatBandwidth(live.txBps, unit)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{live.clients.length} clients</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEdit(cfg)}
                    className="px-2.5 py-1.5 rounded-lg border app-border app-surface app-row-hover text-[11px] font-medium transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove satellite ${cfg.name}`}
                    onClick={() => void onDeleteSatellite(cfg.id)}
                    className="p-1.5 rounded-lg border app-border app-surface hover:text-rose-500 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Active Dev Simulator Satellites Notice */}
      {simulatedSatellites.length > 0 && (
        <div className="p-3 rounded-xl border app-border app-input text-xs app-text-muted flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Wifi className="h-3.5 w-3.5 text-sky-500 shrink-0" aria-hidden="true" />
            <span className="truncate">
              Dev simulator providing {simulatedSatellites.length} sample satellites (
              {simulatedSatellites.map((s) => s.name).join(', ')}).
            </span>
          </div>
          <span className="font-mono text-[11px] text-sky-500 shrink-0">Dev Only</span>
        </div>
      )}

      {/* Add / Edit Satellite Form */}
      {formOpen && (
        <form
          onSubmit={handleSubmit}
          data-testid="satellite-form"
          className="p-4 rounded-xl border app-border app-input space-y-3.5"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold flex items-center gap-1.5">
              <Server className="h-3.5 w-3.5 text-sky-500" aria-hidden="true" />
              <span>{editingId ? 'Edit SSH Satellite' : 'Add SSH-Only Orbi Satellite'}</span>
            </h3>
            {configs.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setFormOpen(false);
                  setEditingId(null);
                  setStatusMsg(null);
                }}
                className="text-[11px] app-text-muted hover:opacity-100"
              >
                Cancel
              </button>
            )}
          </div>

          <div className={`grid grid-cols-1 ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-3`}>
            <div>
              <label htmlFor="sat-name" className="block text-[11px] app-text-muted mb-1">
                Satellite Name
              </label>
              <input
                id="sat-name"
                data-testid="sat-name-input"
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Living Room Satellite"
                className="w-full app-surface border app-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="sat-host" className="block text-[11px] app-text-muted mb-1">
                Satellite LAN IP / Host
              </label>
              <input
                id="sat-host"
                data-testid="sat-host-input"
                type="text"
                required
                value={form.host}
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                placeholder="192.168.1.2"
                className="w-full app-surface border app-border rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="sat-user" className="block text-[11px] app-text-muted mb-1">
                  SSH User
                </label>
                <input
                  id="sat-user"
                  type="text"
                  required
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="root"
                  className="w-full app-surface border app-border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label htmlFor="sat-port" className="block text-[11px] app-text-muted mb-1">
                  Port
                </label>
                <input
                  id="sat-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) || 22 }))}
                  className="w-full app-surface border app-border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <span className="block text-[11px] app-text-muted mb-1">SSH Authentication</span>
              <div className="grid grid-cols-2 app-surface border app-border rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, authMethod: 'password' }))}
                  className={`inline-flex items-center justify-center gap-1 py-1 text-[11px] font-medium rounded-md transition-colors ${
                    form.authMethod === 'password' ? 'app-btn-primary' : 'app-text-muted'
                  }`}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, authMethod: 'key' }))}
                  className={`inline-flex items-center justify-center gap-1 py-1 text-[11px] font-medium rounded-md transition-colors ${
                    form.authMethod === 'key' ? 'app-btn-primary' : 'app-text-muted'
                  }`}
                >
                  <KeyRound className="h-3 w-3" aria-hidden="true" />
                  SSH Key
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="sat-backhaul" className="block text-[11px] app-text-muted mb-1">
                Backhaul Interface (optional)
              </label>
              <input
                id="sat-backhaul"
                type="text"
                value={form.backhaulInterface}
                onChange={(e) => setForm((f) => ({ ...f, backhaulInterface: e.target.value }))}
                placeholder="Auto-detect (eth0 / ath2)"
                className="w-full app-surface border app-border rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label htmlFor="sat-interval" className="block text-[11px] app-text-muted mb-1">
                SSH Poll Interval (sec)
              </label>
              <input
                id="sat-interval"
                type="number"
                min={3}
                max={60}
                value={form.pollIntervalSec}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pollIntervalSec: Math.max(3, Number(e.target.value) || 5) }))
                }
                className="w-full app-surface border app-border rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          {form.authMethod === 'password' ? (
            <div>
              <label htmlFor="sat-password" className="block text-[11px] app-text-muted mb-1">
                SSH Password {editingId ? '(leave blank to keep existing)' : ''}
              </label>
              <input
                id="sat-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder={editingId ? '•••••••• (unchanged)' : 'Satellite SSH password'}
                className="w-full app-surface border app-border rounded-lg px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          ) : (
            <div>
              <label htmlFor="sat-key" className="block text-[11px] app-text-muted mb-1">
                SSH Private Key (PEM / OpenSSH) {editingId ? '(leave blank to keep existing)' : ''}
              </label>
              <textarea
                id="sat-key"
                rows={3}
                value={form.privateKey}
                onChange={(e) => setForm((f) => ({ ...f, privateKey: e.target.value }))}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="w-full app-surface border app-border rounded-lg px-3 py-1.5 text-[11px] font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
          )}

          {statusMsg && (
            <div
              className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${
                statusMsg.type === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                  : 'border-rose-500/30 bg-rose-500/10 text-rose-500'
              }`}
            >
              {statusMsg.type === 'ok' ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                className="rounded text-sky-500 focus:ring-sky-500"
              />
              <span>Enable live SSH polling</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={testing || !form.host.trim()}
                onClick={handleTest}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border app-border app-surface app-row-hover text-xs font-medium disabled:opacity-50 transition-colors"
              >
                {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Test SSH
              </button>
              <button
                type="submit"
                data-testid="save-satellite-btn"
                disabled={saving || !form.name.trim() || !form.host.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg app-btn-primary text-xs font-semibold disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : editingId ? 'Update Satellite' : 'Save Satellite'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
