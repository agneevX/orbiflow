import type { AlertEvent, NotificationConfig } from '../src/types/telemetry';

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  ntfy: {
    enabled: false,
    serverUrl: 'https://ntfy.sh',
    topic: '',
    token: '',
    priority: 'default',
  },
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
  },
};

export interface NotificationResult {
  channel: 'ntfy' | 'telegram';
  ok: boolean;
  error?: string;
}

type FetchLike = typeof fetch;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function sanitizeNotificationConfig(
  raw?: Partial<NotificationConfig> | null
): NotificationConfig {
  const ntfy = raw?.ntfy;
  const telegram = raw?.telegram;
  const rawPriority = ntfy?.priority;
  const priority: NotificationConfig['ntfy']['priority'] =
    rawPriority === 'low' ||
    rawPriority === 'default' ||
    rawPriority === 'high' ||
    rawPriority === 'urgent'
      ? rawPriority
      : 'default';

  return {
    ntfy: {
      enabled: Boolean(ntfy?.enabled),
      serverUrl:
        typeof ntfy?.serverUrl === 'string' && ntfy.serverUrl.trim()
          ? ntfy.serverUrl.trim().replace(/\/+$/, '')
          : 'https://ntfy.sh',
      topic: typeof ntfy?.topic === 'string' ? ntfy.topic.trim().replace(/^\/+/, '') : '',
      token: typeof ntfy?.token === 'string' ? ntfy.token.trim() : '',
      priority,
    },
    telegram: {
      enabled: Boolean(telegram?.enabled),
      botToken: typeof telegram?.botToken === 'string' ? telegram.botToken.trim() : '',
      chatId: typeof telegram?.chatId === 'string' ? telegram.chatId.trim() : '',
    },
  };
}

export function formatAlertNotification(alert: AlertEvent): {
  title: string;
  body: string;
  ntfyPriority: string;
  ntfyTags: string;
  telegramHtml: string;
} {
  const severityTag = alert.severity === 'critical' ? 'CRITICAL' : 'WARNING';
  const title = `OrbiFlow [${severityTag}]: ${alert.ruleName}`;
  const timeStr = new Date(alert.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const body = `${alert.message}\nTime: ${timeStr}`;
  const ntfyPriority = alert.severity === 'critical' ? 'high' : 'default';
  const ntfyTags = alert.severity === 'critical' ? 'rotating_light,warning' : 'warning';
  const telegramHtml =
    `<b>OrbiFlow ${escapeHtml(severityTag)}</b> — ${escapeHtml(alert.ruleName)}\n` +
    `${escapeHtml(alert.message)}\n` +
    `<code>${escapeHtml(timeStr)}</code>`;

  return { title, body, ntfyPriority, ntfyTags, telegramHtml };
}

export class NotificationDispatcher {
  private config: NotificationConfig;
  private readonly fetchFn: FetchLike;

  constructor(initial?: Partial<NotificationConfig> | null, fetchFn: FetchLike = fetch) {
    this.config = sanitizeNotificationConfig(initial);
    this.fetchFn = fetchFn;
  }

  public getConfig(): NotificationConfig {
    return {
      ntfy: { ...this.config.ntfy },
      telegram: { ...this.config.telegram },
    };
  }

  public updateConfig(next?: Partial<NotificationConfig> | null): NotificationConfig {
    this.config = sanitizeNotificationConfig({
      ntfy: { ...this.config.ntfy, ...(next?.ntfy || {}) },
      telegram: { ...this.config.telegram, ...(next?.telegram || {}) },
    });
    return this.getConfig();
  }

  public async sendNtfy(
    alert: AlertEvent,
    overrideConfig?: NotificationConfig['ntfy']
  ): Promise<NotificationResult> {
    const cfg = overrideConfig ? sanitizeNotificationConfig({ ntfy: overrideConfig }).ntfy : this.config.ntfy;
    if (!cfg.serverUrl || !cfg.topic) {
      return { channel: 'ntfy', ok: false, error: 'ntfy server URL and topic are required.' };
    }
    if (!/^https?:\/\//i.test(cfg.serverUrl)) {
      return { channel: 'ntfy', ok: false, error: 'ntfy server URL must start with http:// or https://.' };
    }

    const formatted = formatAlertNotification(alert);
    const endpoint = `${cfg.serverUrl}/${encodeURIComponent(cfg.topic)}`;
    const headers: Record<string, string> = {
      Title: formatted.title,
      Priority: cfg.priority === 'default' ? formatted.ntfyPriority : cfg.priority,
      Tags: formatted.ntfyTags,
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (cfg.token) {
      headers.Authorization = `Bearer ${cfg.token}`;
    }

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: formatted.body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          channel: 'ntfy',
          ok: false,
          error: `ntfy returned HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
        };
      }
      return { channel: 'ntfy', ok: true };
    } catch (err) {
      return {
        channel: 'ntfy',
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to reach ntfy server.',
      };
    }
  }

  public async sendTelegram(
    alert: AlertEvent,
    overrideConfig?: NotificationConfig['telegram']
  ): Promise<NotificationResult> {
    const cfg = overrideConfig
      ? sanitizeNotificationConfig({ telegram: overrideConfig }).telegram
      : this.config.telegram;
    if (!cfg.botToken || !cfg.chatId) {
      return {
        channel: 'telegram',
        ok: false,
        error: 'Telegram Bot Token and Chat ID are required.',
      };
    }

    const formatted = formatAlertNotification(alert);
    const endpoint = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;

    try {
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: formatted.telegramHtml,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          channel: 'telegram',
          ok: false,
          error: `Telegram returned HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
        };
      }
      return { channel: 'telegram', ok: true };
    } catch (err) {
      return {
        channel: 'telegram',
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to reach Telegram API.',
      };
    }
  }

  public async dispatchAlert(alert: AlertEvent): Promise<NotificationResult[]> {
    const tasks: Promise<NotificationResult>[] = [];
    if (this.config.ntfy.enabled && this.config.ntfy.topic) {
      tasks.push(this.sendNtfy(alert));
    }
    if (this.config.telegram.enabled && this.config.telegram.botToken && this.config.telegram.chatId) {
      tasks.push(this.sendTelegram(alert));
    }
    if (tasks.length === 0) return [];
    return Promise.all(tasks);
  }
}
