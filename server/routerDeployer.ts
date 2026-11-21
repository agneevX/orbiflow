import { Client } from 'ssh2';
import { generatePythonProbe, type ProbeConfigOptions } from '../src/lib/probeTemplates';
import { validateDhcpLeasesPath } from '../src/lib/tablePreferences';

export interface RouterDeployRequest {
  host: string;
  port?: number;
  username?: string;
  authMethod?: 'password' | 'key';
  password?: string;
  privateKey?: string;
  remotePath?: string;
  restartAgent?: boolean;
  wsUrl: string;
  httpUrl?: string;
  token?: string;
  iface?: string;
  intervalSec?: number;
  probeId?: string;
  dhcpLeasesPath?: string;
}

export interface RouterDeployValidation {
  ok: boolean;
  error?: string;
  normalized?: {
    host: string;
    port: number;
    username: string;
    authMethod: 'password' | 'key';
    password?: string;
    privateKey?: string;
    remotePath: string;
    restartAgent: boolean;
    probeCfg: ProbeConfigOptions;
  };
}

export interface RouterDeployResult {
  ok: boolean;
  error?: string;
  remotePath?: string;
  restarted?: boolean;
  pid?: number;
  pythonBin?: string;
  steps: string[];
  message?: string;
}

const HOST_REGEX = /^[a-zA-Z0-9.-]{1,253}$/;
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{1,32}$/;
const REMOTE_PATH_REGEX = /^\/[a-zA-Z0-9._/-]{1,180}$/;
const IFACE_REGEX = /^[a-zA-Z0-9._:-]{1,32}$/;
const PROBE_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

function isBlockedTargetHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower.startsWith('127.') ||
    lower.startsWith('169.254.')
  ) {
    return true;
  }
  return false;
}

export function validateRouterDeployInput(body: Partial<RouterDeployRequest>): RouterDeployValidation {
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host || !HOST_REGEX.test(host) || host.includes('..') || isBlockedTargetHost(host)) {
    return { ok: false, error: 'Enter a valid router LAN IP address or hostname.' };
  }

  const rawPort = body.port === undefined ? 22 : Number(body.port);
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    return { ok: false, error: 'SSH port must be between 1 and 65535.' };
  }

  const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : 'root';
  if (!USERNAME_REGEX.test(username)) {
    return { ok: false, error: 'SSH username contains unsupported characters.' };
  }

  const authMethod: 'password' | 'key' = body.authMethod === 'key' ? 'key' : 'password';
  const password = typeof body.password === 'string' ? body.password : '';
  const privateKey = typeof body.privateKey === 'string' ? body.privateKey.trim() : '';

  if (authMethod === 'password' && !password) {
    return { ok: false, error: 'Enter the router SSH password.' };
  }
  if (authMethod === 'key' && !privateKey) {
    return { ok: false, error: 'Paste the SSH private key for router login.' };
  }

  const remotePath =
    typeof body.remotePath === 'string' && body.remotePath.trim()
      ? body.remotePath.trim()
      : '/opt/bin/orbi_probe.py';

  if (
    !REMOTE_PATH_REGEX.test(remotePath) ||
    remotePath.includes('..') ||
    remotePath.endsWith('/') ||
    remotePath === '/'
  ) {
    return {
      ok: false,
      error: 'Remote script path must be an absolute POSIX file path (e.g. /opt/bin/orbi_probe.py).',
    };
  }

  const wsUrl = typeof body.wsUrl === 'string' ? body.wsUrl.trim() : '';
  let parsedWs: URL;
  try {
    parsedWs = new URL(wsUrl);
  } catch {
    return { ok: false, error: 'Server WebSocket URL is invalid.' };
  }
  if (parsedWs.protocol !== 'ws:' && parsedWs.protocol !== 'wss:') {
    return { ok: false, error: 'Server WebSocket URL must start with ws:// or wss://.' };
  }

  const iface = typeof body.iface === 'string' && body.iface.trim() ? body.iface.trim() : 'eth0';
  if (!IFACE_REGEX.test(iface)) {
    return { ok: false, error: 'WAN interface name contains unsupported characters.' };
  }

  const probeId =
    typeof body.probeId === 'string' && body.probeId.trim()
      ? body.probeId.trim()
      : `router-${iface}`;
  if (!PROBE_ID_REGEX.test(probeId)) {
    return { ok: false, error: 'Probe ID contains unsupported characters.' };
  }

  const dhcpCheck = validateDhcpLeasesPath(body.dhcpLeasesPath || '');
  if (!dhcpCheck.ok) {
    return { ok: false, error: dhcpCheck.error || 'Invalid DHCP leases path.' };
  }

  const intervalSec = Math.max(1, Math.min(60, Math.round(Number(body.intervalSec) || 3)));
  const token = typeof body.token === 'string' ? body.token.trim().slice(0, 256) : '';
  const httpUrl =
    typeof body.httpUrl === 'string' && body.httpUrl.trim()
      ? body.httpUrl.trim()
      : wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/ws\/ingest$/i, '/api/ingest');

  return {
    ok: true,
    normalized: {
      host,
      port: rawPort,
      username,
      authMethod,
      password: authMethod === 'password' ? password : undefined,
      privateKey: authMethod === 'key' ? privateKey : undefined,
      remotePath,
      restartAgent: body.restartAgent !== false,
      probeCfg: {
        wsUrl,
        httpUrl,
        token,
        iface,
        intervalSec,
        probeId,
        dhcpLeasesPath: dhcpCheck.value,
      },
    },
  };
}

function execSshCommand(
  conn: Client,
  command: string,
  stdinPayload?: string,
  timeoutMs = 15_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('SSH command timed out on router'));
      }
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (chunk: Buffer) => {
        if (stdout.length < 16_384) stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({ code: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
        }
      });

      if (stdinPayload !== undefined) {
        stream.end(Buffer.from(stdinPayload, 'utf8'));
      }
    });
  });
}

export async function deployAndRestartRouterAgent(
  body: Partial<RouterDeployRequest>
): Promise<RouterDeployResult> {
  const validation = validateRouterDeployInput(body);
  if (!validation.ok || !validation.normalized) {
    return {
      ok: false,
      error: validation.error || 'Invalid deployment parameters.',
      steps: [],
    };
  }

  const {
    host,
    port,
    username,
    authMethod,
    password,
    privateKey,
    remotePath,
    restartAgent,
    probeCfg,
  } = validation.normalized;

  const scriptContent = generatePythonProbe(probeCfg);
  const lastSlash = remotePath.lastIndexOf('/');
  const parentDir = lastSlash > 0 ? remotePath.slice(0, lastSlash) : '/';
  const scriptBase = remotePath.slice(lastSlash + 1);
  const tmpPath = `${remotePath}.tmp.${Date.now().toString(36)}`;
  const steps: string[] = [];

  const conn = new Client();

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          conn.end();
          reject(new Error(`SSH connection to ${host}:${port} timed out`));
        }
      }, 10_000);

      conn
        .on('ready', () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
        })
        .on('error', (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        })
        .connect({
          host,
          port,
          username,
          ...(authMethod === 'key' ? { privateKey } : { password }),
          readyTimeout: 10_000,
          tryKeyboard: false,
        });
    });

    steps.push(`Connected to ${username}@${host}:${port} via SSH`);

    // Safely stream script via stdin to temp file, chmod +x, and atomically move into place
    const uploadCmd = `mkdir -p '${parentDir}' && cat > '${tmpPath}' && chmod 755 '${tmpPath}' && mv -f '${tmpPath}' '${remotePath}'`;
    const uploadRes = await execSshCommand(conn, uploadCmd, scriptContent, 15_000);
    if (uploadRes.code !== 0) {
      throw new Error(
        `Failed to write ${remotePath}: ${uploadRes.stderr || `exit code ${uploadRes.code}`}`
      );
    }
    steps.push(`Updated probe script at ${remotePath} (${scriptContent.length} bytes)`);

    if (!restartAgent) {
      return {
        ok: true,
        remotePath,
        restarted: false,
        steps,
        message: `Updated ${remotePath} on ${host}.`,
      };
    }

    // Enable conntrack accounting, stop any running probe instances, and start fresh daemon
    const restartCmd = [
      'echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true',
      'PID_FILE=/var/run/orbi-probe.pid',
      'if [ -f "$PID_FILE" ]; then OLD_PID=$(cat "$PID_FILE" 2>/dev/null); [ -n "$OLD_PID" ] && kill "$OLD_PID" 2>/dev/null || true; fi',
      `for p in /proc/[0-9]*; do pid=\${p#/proc/}; cmd=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null || true); case "$cmd" in *'${scriptBase}'*) kill "$pid" 2>/dev/null || true ;; esac; done`,
      'sleep 1',
      `for p in /proc/[0-9]*; do pid=\${p#/proc/}; cmd=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null || true); case "$cmd" in *'${scriptBase}'*) kill -9 "$pid" 2>/dev/null || true ;; esac; done`,
      'PY_BIN=""',
      'if [ -x /opt/bin/python3 ]; then PY_BIN=/opt/bin/python3; elif command -v python3 >/dev/null 2>&1; then PY_BIN=$(command -v python3); fi',
      'if [ -z "$PY_BIN" ]; then echo "ERR_NO_PYTHON3"; exit 127; fi',
      `"$PY_BIN" '${remotePath}' -d --pid-file "$PID_FILE" </dev/null >/dev/null 2>&1`,
      'sleep 1',
      'NEW_PID=$(cat "$PID_FILE" 2>/dev/null || true)',
      'if [ -n "$NEW_PID" ] && [ -d "/proc/$NEW_PID" ]; then echo "OK_PID=$NEW_PID PY=$PY_BIN"; else echo "ERR_NOT_RUNNING PY=$PY_BIN"; exit 1; fi',
    ].join('; ');

    const restartRes = await execSshCommand(conn, restartCmd, undefined, 15_000);
    if (restartRes.stdout.includes('ERR_NO_PYTHON3')) {
      throw new Error('python3 was not found on the router (/opt/bin/python3 or PATH). Install python3-light via opkg first.');
    }
    if (restartRes.code !== 0 || !restartRes.stdout.includes('OK_PID=')) {
      throw new Error(
        `Script updated, but agent failed to stay running: ${restartRes.stderr || restartRes.stdout || `exit code ${restartRes.code}`}`
      );
    }

    const pidMatch = restartRes.stdout.match(/OK_PID=(\d+)/);
    const pyMatch = restartRes.stdout.match(/PY=(\S+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : undefined;
    const pythonBin = pyMatch ? pyMatch[1] : undefined;

    steps.push(
      `Restarted agent cleanly${pid ? ` (PID ${pid})` : ''}${pythonBin ? ` using ${pythonBin}` : ''}`
    );

    return {
      ok: true,
      remotePath,
      restarted: true,
      pid,
      pythonBin,
      steps,
      message: `Updated ${remotePath} and restarted agent${pid ? ` (PID ${pid})` : ''} on ${host}.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SSH deployment failed';
    return {
      ok: false,
      error: msg,
      remotePath,
      steps,
    };
  } finally {
    try {
      conn.end();
    } catch {
      // ignore close errors
    }
  }
}
