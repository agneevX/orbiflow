import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Send,
  Trash2,
} from 'lucide-react';
import type {
  AlertEvent,
  AlertMetric,
  AlertRule,
  NotificationConfig,
  TimeFormat,
} from '../types/telemetry';
import { formatTimestamp } from '../lib/formatters';

interface AlertsViewProps {
  rules: AlertRule[];
  alerts: AlertEvent[];
  notifications: NotificationConfig;
  timeFormat?: TimeFormat;
  onSaveRules: (rules: AlertRule[]) => Promise<void>;
  onSaveNotifications: (cfg: NotificationConfig) => Promise<void>;
  onTestNotification: (
    channel: 'ntfy' | 'telegram',
    cfg: NotificationConfig
  ) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  onAcknowledgeAlert: (id: string) => Promise<void>;
  onClearAlerts: () => Promise<void>;
}

const METRIC_META: Record<
  AlertMetric,
  {
    unit: string;
    eventOnly?: boolean;
    description?: string;
    step?: number;
    min?: number;
    max?: number;
  }
> = {
  wan_rx_mbps: { unit: 'Mbps', min: 1, max: 100000 },
  wan_tx_mbps: { unit: 'Mbps', min: 1, max: 100000 },
  wan_combined_mbps: { unit: 'Mbps', min: 1, max: 100000 },
  host_rx_mbps: { unit: 'Mbps per device', min: 1, max: 100000 },
  host_tx_mbps: { unit: 'Mbps per device', min: 1, max: 100000 },
  host_flows: { unit: 'connections / device', min: 1, max: 100000 },
  total_flows: { unit: 'total connections', min: 1, max: 100000 },
  new_device: {
    unit: '',
    eventOnly: true,
    description: 'Triggers when a previously unseen device appears on your LAN',
  },
  agent_offline: {
    unit: '',
    eventOnly: true,
    description: 'Triggers when the live router agent disconnects from the server',
  },
  router_high_load: { unit: '1m load avg', step: 0.1, min: 0.1, max: 100 },
  router_high_mem: { unit: '% RAM', min: 1, max: 100 },
};

export function AlertsView({
  rules,
  alerts,
  notifications,
  timeFormat = '12h',
  onSaveRules,
  onSaveNotifications,
  onTestNotification,
  onAcknowledgeAlert,
  onClearAlerts,
}: AlertsViewProps) {
  const [draftRules, setDraftRules] = useState<AlertRule[]>(rules);
  const [savingRules, setSavingRules] = useState(false);
  const [savedRulesNote, setSavedRulesNote] = useState('');

  const [draftNotif, setDraftNotif] = useState<NotificationConfig>(notifications);
  const [savingNotif, setSavingNotif] = useState(false);
  const [savedNotifNote, setSavedNotifNote] = useState('');
  const [showNtfyToken, setShowNtfyToken] = useState(false);
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [testingChannel, setTestingChannel] = useState<'ntfy' | 'telegram' | null>(null);
  const [testNotice, setTestNotice] = useState<{
    channel: 'ntfy' | 'telegram';
    ok: boolean;
    text: string;
  } | null>(null);

  const rulesSignature = JSON.stringify(rules);
  const notifSignature = JSON.stringify(notifications);

  useEffect(() => {
    setDraftRules(rules);
    // Only resync local draft when server-side rule values actually change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesSignature]);

  useEffect(() => {
    setDraftNotif(notifications);
    // Only resync local draft when server-side notification settings actually change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifSignature]);

  const handleToggleRule = (id: string) => {
    setDraftRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const handleThresholdChange = (rule: AlertRule, rawVal: string) => {
    const meta = METRIC_META[rule.metric];
    const parsed = Number(rawVal);
    const minVal = meta.min ?? 1;
    const maxVal = meta.max ?? 100000;
    const val = Number.isFinite(parsed)
      ? Math.min(maxVal, Math.max(minVal, parsed))
      : minVal;
    setDraftRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, threshold: val } : r))
    );
  };

  const handleSubmitRules = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRules(true);
    try {
      await onSaveRules(draftRules);
      setSavedRulesNote('Saved');
      setTimeout(() => setSavedRulesNote(''), 2500);
    } finally {
      setSavingRules(false);
    }
  };

  const handleSubmitNotifications = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingNotif(true);
    try {
      await onSaveNotifications(draftNotif);
      setSavedNotifNote('Saved to config.json');
      setTimeout(() => setSavedNotifNote(''), 2500);
    } finally {
      setSavingNotif(false);
    }
  };

  const handleTest = async (channel: 'ntfy' | 'telegram') => {
    setTestingChannel(channel);
    setTestNotice(null);
    try {
      const res = await onTestNotification(channel, draftNotif);
      setTestNotice({
        channel,
        ok: res.ok,
        text: res.ok
          ? res.detail || `Test alert sent via ${channel}`
          : res.error || `Failed to send ${channel} test`,
      });
    } finally {
      setTestingChannel(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Alert Rules */}
        <form
          onSubmit={handleSubmitRules}
          data-testid="alert-rules-form"
          className="xl:col-span-5 app-surface border rounded-2xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold">Alert Rules</h2>
              <p className="text-xs app-text-muted mt-0.5">
                Evaluated server-side on every incoming snapshot
              </p>
            </div>
            {savedRulesNote && (
              <span className="text-xs font-medium text-emerald-500 inline-flex items-center gap-1">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                {savedRulesNote}
              </span>
            )}
          </div>

          <div className="divide-y app-border">
            {draftRules.map((rule) => {
              const meta = METRIC_META[rule.metric] || { unit: '' };
              return (
                <div key={rule.id} className="py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <label
                      htmlFor={`rule-toggle-${rule.id}`}
                      className="text-xs sm:text-sm font-medium cursor-pointer"
                    >
                      {rule.name}
                    </label>
                    <input
                      id={`rule-toggle-${rule.id}`}
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => handleToggleRule(rule.id)}
                      className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500 shrink-0"
                    />
                  </div>

                  {meta.eventOnly ? (
                    <p className="text-[11px] app-text-muted">{meta.description}</p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={`rule-threshold-${rule.id}`}
                        className="text-xs app-text-muted whitespace-nowrap"
                      >
                        Trigger above
                      </label>
                      <input
                        id={`rule-threshold-${rule.id}`}
                        type="number"
                        step={meta.step ?? 1}
                        min={meta.min ?? 1}
                        max={meta.max ?? 100000}
                        value={rule.threshold}
                        onChange={(e) => handleThresholdChange(rule, e.target.value)}
                        className="w-24 app-input border rounded-xl px-2.5 py-1 text-xs font-mono tabular-nums focus:outline-none focus:border-sky-500"
                      />
                      <span className="text-xs font-mono app-text-muted">{meta.unit}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={savingRules}
              className="w-full py-2.5 px-4 rounded-xl app-btn-primary disabled:opacity-60 text-xs font-semibold transition-colors"
            >
              {savingRules ? 'Saving Rules...' : 'Save Alert Rules'}
            </button>
          </div>
        </form>

        {/* Right column: Notification Channels + Triggered Events */}
        <div className="xl:col-span-7 space-y-6">
          {/* Notification Channels: ntfy + Telegram */}
          <form
            onSubmit={handleSubmitNotifications}
            data-testid="notification-channels-form"
            className="app-surface border rounded-2xl p-5 space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold flex items-center gap-2">
                  <BellRing className="h-4 w-4 text-sky-500 shrink-0" aria-hidden="true" />
                  <span>Notification Channels</span>
                </h2>
                <p className="text-xs app-text-muted mt-0.5">
                  Push triggered alerts directly to ntfy or Telegram from the server
                </p>
              </div>
              {savedNotifNote && (
                <span className="text-xs font-medium text-emerald-500 inline-flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  {savedNotifNote}
                </span>
              )}
            </div>

            {/* ntfy Section */}
            <div className="rounded-xl border app-border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold">ntfy</h3>
                  <p className="text-[11px] app-text-muted">
                    Works with ntfy.sh or any self-hosted ntfy server
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <span>Enabled</span>
                  <input
                    type="checkbox"
                    data-testid="ntfy-enabled-toggle"
                    checked={draftNotif.ntfy.enabled}
                    onChange={(e) =>
                      setDraftNotif((prev) => ({
                        ...prev,
                        ntfy: { ...prev.ntfy, enabled: e.target.checked },
                      }))
                    }
                    className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="ntfy-url" className="block text-[11px] app-text-muted">
                    Server URL
                  </label>
                  <input
                    id="ntfy-url"
                    data-testid="ntfy-url-input"
                    type="url"
                    value={draftNotif.ntfy.serverUrl}
                    onChange={(e) =>
                      setDraftNotif((prev) => ({
                        ...prev,
                        ntfy: { ...prev.ntfy, serverUrl: e.target.value },
                      }))
                    }
                    placeholder="https://ntfy.sh"
                    className="w-full app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="ntfy-topic" className="block text-[11px] app-text-muted">
                    Topic
                  </label>
                  <input
                    id="ntfy-topic"
                    data-testid="ntfy-topic-input"
                    type="text"
                    value={draftNotif.ntfy.topic}
                    onChange={(e) =>
                      setDraftNotif((prev) => ({
                        ...prev,
                        ntfy: { ...prev.ntfy, topic: e.target.value },
                      }))
                    }
                    placeholder="my-orbiflow-alerts"
                    className="w-full app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="ntfy-token" className="block text-[11px] app-text-muted">
                    Access Token (optional)
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="ntfy-token"
                      type={showNtfyToken ? 'text' : 'password'}
                      value={draftNotif.ntfy.token}
                      onChange={(e) =>
                        setDraftNotif((prev) => ({
                          ...prev,
                          ntfy: { ...prev.ntfy, token: e.target.value },
                        }))
                      }
                      placeholder="tk_..."
                      className="flex-1 min-w-0 app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNtfyToken((v) => !v)}
                      aria-label={showNtfyToken ? 'Hide ntfy token' : 'Show ntfy token'}
                      className="inline-flex items-center justify-center h-8 w-8 rounded-xl border app-border app-surface app-row-hover shrink-0"
                    >
                      {showNtfyToken ? (
                        <EyeOff className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                      ) : (
                        <Eye className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor="ntfy-priority" className="block text-[11px] app-text-muted">
                    Priority
                  </label>
                  <select
                    id="ntfy-priority"
                    value={draftNotif.ntfy.priority}
                    onChange={(e) =>
                      setDraftNotif((prev) => ({
                        ...prev,
                        ntfy: {
                          ...prev.ntfy,
                          priority: e.target.value as NotificationConfig['ntfy']['priority'],
                        },
                      }))
                    }
                    className="w-full app-input border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-sky-500"
                  >
                    <option value="low">Low</option>
                    <option value="default">Default</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="text-[11px] min-h-[16px]">
                  {testNotice?.channel === 'ntfy' && (
                    <span
                      className={
                        testNotice.ok ? 'text-emerald-500 font-medium' : 'text-red-500'
                      }
                    >
                      {testNotice.text}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  data-testid="test-ntfy-btn"
                  disabled={testingChannel !== null}
                  onClick={() => void handleTest('ntfy')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-surface app-row-hover disabled:opacity-60 text-xs font-medium transition-colors"
                >
                  <Send className="h-3 w-3 app-text-muted" aria-hidden="true" />
                  {testingChannel === 'ntfy' ? 'Sending...' : 'Send Test'}
                </button>
              </div>
            </div>

            {/* Telegram Section */}
            <div className="rounded-xl border app-border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold">Telegram</h3>
                  <p className="text-[11px] app-text-muted">
                    Create a bot via @BotFather and enter your bot token and chat ID
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
                  <span>Enabled</span>
                  <input
                    type="checkbox"
                    data-testid="telegram-enabled-toggle"
                    checked={draftNotif.telegram.enabled}
                    onChange={(e) =>
                      setDraftNotif((prev) => ({
                        ...prev,
                        telegram: { ...prev.telegram, enabled: e.target.checked },
                      }))
                    }
                    className="h-4 w-4 rounded text-sky-500 focus:ring-sky-500"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="tg-token" className="block text-[11px] app-text-muted">
                    Bot Token
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id="tg-token"
                      data-testid="telegram-token-input"
                      type={showTelegramToken ? 'text' : 'password'}
                      value={draftNotif.telegram.botToken}
                      onChange={(e) =>
                        setDraftNotif((prev) => ({
                          ...prev,
                          telegram: { ...prev.telegram, botToken: e.target.value },
                        }))
                      }
                      placeholder="123456:ABC-DEF..."
                      className="flex-1 min-w-0 app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTelegramToken((v) => !v)}
                      aria-label={
                        showTelegramToken ? 'Hide Telegram bot token' : 'Show Telegram bot token'
                      }
                      className="inline-flex items-center justify-center h-8 w-8 rounded-xl border app-border app-surface app-row-hover shrink-0"
                    >
                      {showTelegramToken ? (
                        <EyeOff className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                      ) : (
                        <Eye className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor="tg-chat-id" className="block text-[11px] app-text-muted">
                    Chat ID
                  </label>
                  <input
                    id="tg-chat-id"
                    data-testid="telegram-chatid-input"
                    type="text"
                    value={draftNotif.telegram.chatId}
                    onChange={(e) =>
                      setDraftNotif((prev) => ({
                        ...prev,
                        telegram: { ...prev.telegram, chatId: e.target.value },
                      }))
                    }
                    placeholder="-1001234567890"
                    className="w-full app-input border rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="text-[11px] min-h-[16px]">
                  {testNotice?.channel === 'telegram' && (
                    <span
                      className={
                        testNotice.ok ? 'text-emerald-500 font-medium' : 'text-red-500'
                      }
                    >
                      {testNotice.text}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  data-testid="test-telegram-btn"
                  disabled={testingChannel !== null}
                  onClick={() => void handleTest('telegram')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-surface app-row-hover disabled:opacity-60 text-xs font-medium transition-colors"
                >
                  <Send className="h-3 w-3 app-text-muted" aria-hidden="true" />
                  {testingChannel === 'telegram' ? 'Sending...' : 'Send Test'}
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                data-testid="save-notifications-btn"
                disabled={savingNotif}
                className="px-4 py-2.5 rounded-xl app-btn-primary disabled:opacity-60 text-xs font-semibold transition-colors"
              >
                {savingNotif ? 'Saving Channels...' : 'Save Notification Channels'}
              </button>
            </div>
          </form>

          {/* Triggered Alert Events */}
          <section className="app-surface border rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b app-border flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-sm font-semibold">
                  Triggered Alert Events ({alerts.length})
                </h2>
                <p className="text-xs app-text-muted mt-0.5">
                  Cooldown per rule prevents duplicate notifications during sustained spikes
                </p>
              </div>
              {alerts.length > 0 && (
                <button
                  type="button"
                  onClick={onClearAlerts}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border app-border app-row-hover text-xs transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5 app-text-muted" aria-hidden="true" />
                  Clear All
                </button>
              )}
            </div>

            {alerts.length === 0 ? (
              <div className="py-12 px-6 text-center space-y-2">
                <CheckCircle2 className="h-7 w-7 text-emerald-500 mx-auto" aria-hidden="true" />
                <p className="text-sm font-medium">No active alerts</p>
                <p className="text-xs app-text-muted max-w-sm mx-auto">
                  Enable rules on the left or configure ntfy / Telegram above to receive real-time
                  alerts.
                </p>
              </div>
            ) : (
              <div className="divide-y app-border">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`p-4 flex items-start justify-between gap-4 ${
                      alert.acknowledged ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <AlertTriangle
                        className={`h-4 w-4 mt-0.5 shrink-0 ${
                          alert.severity === 'critical' ? 'text-red-500' : 'text-amber-500'
                        }`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-medium">{alert.ruleName}</span>
                          <span className="app-text-muted">·</span>
                          <span
                            className={`font-mono uppercase ${
                              alert.severity === 'critical' ? 'text-red-500' : 'text-amber-500'
                            }`}
                          >
                            {alert.severity}
                          </span>
                          <span className="app-text-muted">·</span>
                          <span className="font-mono app-text-muted tabular-nums">
                            {formatTimestamp(alert.timestamp, false, false, timeFormat)}
                          </span>
                        </div>
                        <p className="text-xs app-text-secondary mt-1">{alert.message}</p>
                      </div>
                    </div>

                    {!alert.acknowledged && (
                      <button
                        type="button"
                        onClick={() => onAcknowledgeAlert(alert.id)}
                        className="px-2.5 py-1 rounded-xl border app-border app-row-hover text-xs whitespace-nowrap shrink-0"
                      >
                        Acknowledge
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
