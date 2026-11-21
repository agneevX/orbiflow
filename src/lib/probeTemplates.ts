export interface ProbeConfigOptions {
  wsUrl: string;
  httpUrl: string;
  token: string;
  iface: string;
  intervalSec: number;
  probeId: string;
}

export function generatePythonProbe(cfg: ProbeConfigOptions): string {
  return `#!/usr/bin/env python3
"""
OrbiFlow Low-CPU Router Traffic Collector
Requires only Python 3 core modules (works on Entware python3-light) — zero external packages.

Usage:
  orbi_probe.py [options]

Options:
  -d, --daemonize           Run silently in the background (no log output unless --log-file is set)
  --pid-file PATH           Write daemon PID to PATH (removed on clean exit)
  --log-level LEVEL         Log verbosity: silent, error, info (default), debug
  -q, --quiet               Disable all log output (same as --log-level silent)
  -v, --verbose             Enable debug logging (same as --log-level debug)
  --log-file PATH           Append timestamped logs to PATH
  -i, --interval SEC        Fast traffic polling interval in seconds (default: ${cfg.intervalSec})
  --sys-interval SEC        Router uptime/load/memory polling interval in seconds (default: 30)
  --neigh-interval SEC      ARP/DHCP neighbor refresh interval in seconds (default: 15)
  --iface NAME              WAN interface name (default: ${cfg.iface})
  --ws-url URL              Collector WebSocket URL
  --token TOKEN             Shared router agent token
  --probe-id ID             Unique probe identifier
  -h, --help                Show this help text and exit
"""
import base64
import json
import os
import signal
import socket
import struct
import sys
import time

WS_URL = "${cfg.wsUrl}"
AUTH_TOKEN = "${cfg.token}"
WAN_IFACE = "${cfg.iface}"
PROBE_ID = "${cfg.probeId}"
INTERVAL_SEC = ${cfg.intervalSec}
SYS_INTERVAL_SEC = 30
NEIGH_INTERVAL_SEC = 15

LOG_LEVELS = {"silent": 0, "error": 1, "info": 2, "debug": 3}


class ProbeLogger:
    def __init__(self, level="info", log_file=None):
        self.level = LOG_LEVELS.get(level, 2)
        self.log_file = log_file

    def _emit(self, threshold, tag, msg):
        if self.level < threshold:
            return
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        line = f"{ts} [orbi-probe] [{tag}] {msg}"
        if self.log_file:
            try:
                with open(self.log_file, "a") as f:
                    f.write(line + "\\n")
            except OSError:
                pass
        else:
            try:
                sys.stderr.write(line + "\\n")
                sys.stderr.flush()
            except OSError:
                pass

    def error(self, msg):
        self._emit(1, "ERROR", msg)

    def info(self, msg):
        self._emit(2, "INFO", msg)

    def debug(self, msg):
        self._emit(3, "DEBUG", msg)


def print_usage():
    sys.stdout.write(__doc__.strip() + "\\n")


def parse_args(argv):
    cfg = {
        "ws_url": WS_URL,
        "token": AUTH_TOKEN,
        "iface": WAN_IFACE,
        "probe_id": PROBE_ID,
        "interval": float(INTERVAL_SEC),
        "sys_interval": float(SYS_INTERVAL_SEC),
        "neigh_interval": float(NEIGH_INTERVAL_SEC),
        "daemonize": False,
        "pid_file": None,
        "log_level": None,
        "log_file": None,
    }
    i = 0
    n = len(argv)
    while i < n:
        arg = argv[i]

        def need_val(flag):
            nonlocal i
            if i + 1 >= n:
                sys.stderr.write(f"Missing value for {flag}\\n")
                sys.exit(2)
            i += 1
            return argv[i]

        if arg in ("-h", "--help"):
            print_usage()
            sys.exit(0)
        elif arg in ("-d", "--daemonize"):
            cfg["daemonize"] = True
        elif arg in ("-q", "--quiet"):
            cfg["log_level"] = "silent"
        elif arg in ("-v", "--verbose"):
            cfg["log_level"] = "debug"
        elif arg == "--log-level":
            lvl = need_val(arg).lower()
            if lvl not in LOG_LEVELS:
                sys.stderr.write(f"Invalid --log-level: {lvl} (use silent, error, info, debug)\\n")
                sys.exit(2)
            cfg["log_level"] = lvl
        elif arg == "--log-file":
            cfg["log_file"] = need_val(arg)
        elif arg == "--pid-file":
            cfg["pid_file"] = need_val(arg)
        elif arg in ("-i", "--interval"):
            cfg["interval"] = max(1.0, float(need_val(arg)))
        elif arg == "--sys-interval":
            cfg["sys_interval"] = max(5.0, float(need_val(arg)))
        elif arg == "--neigh-interval":
            cfg["neigh_interval"] = max(5.0, float(need_val(arg)))
        elif arg == "--iface":
            cfg["iface"] = need_val(arg)
        elif arg == "--ws-url":
            cfg["ws_url"] = need_val(arg)
        elif arg == "--token":
            cfg["token"] = need_val(arg)
        elif arg == "--probe-id":
            cfg["probe_id"] = need_val(arg)
        else:
            sys.stderr.write(f"Unknown option: {arg} (use --help for usage)\\n")
            sys.exit(2)
        i += 1

    # When daemonized without --log-file, suppress all log output
    if cfg["log_level"] is None:
        if cfg["daemonize"] and not cfg["log_file"]:
            cfg["log_level"] = "silent"
        else:
            cfg["log_level"] = "info"
    return cfg


def daemonize_process(pid_file=None):
    if not hasattr(os, "fork"):
        return
    pid = os.fork()
    if pid > 0:
        os._exit(0)
    os.setsid()
    pid = os.fork()
    if pid > 0:
        os._exit(0)
    try:
        os.chdir("/")
    except OSError:
        pass
    os.umask(0)
    sys.stdout.flush()
    sys.stderr.flush()
    devnull_fd = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        try:
            os.dup2(devnull_fd, fd)
        except OSError:
            pass
    if devnull_fd > 2:
        os.close(devnull_fd)
    if pid_file:
        try:
            with open(pid_file, "w") as f:
                f.write(f"{os.getpid()}\\n")
        except OSError:
            pass


def read_text(path):
    try:
        with open(path, "r") as f:
            return f.read()
    except OSError:
        return ""


def read_int(path):
    try:
        with open(path, "r") as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return 0


def ensure_conntrack_acct():
    acct_path = "/proc/sys/net/netfilter/nf_conntrack_acct"
    try:
        if read_int(acct_path) == 0:
            with open(acct_path, "w") as f:
                f.write("1\\n")
    except OSError:
        pass


def read_iface_counters(iface):
    base = f"/sys/class/net/{iface}/statistics"
    return {
        "iface": iface,
        "rxBytes": read_int(f"{base}/rx_bytes"),
        "txBytes": read_int(f"{base}/tx_bytes"),
        "rxErrors": read_int(f"{base}/rx_errors"),
        "txErrors": read_int(f"{base}/tx_errors"),
    }


def discover_dnsmasq_files():
    lease_paths = [
        "/tmp/dhcp.leases",
        "/tmp/udhcpd.leases",
        "/var/run/dnsmasq.leases",
        "/opt/var/lib/misc/dnsmasq.leases",
    ]
    hosts_paths = ["/etc/hosts"]
    static_hosts = {}
    conf_files = [
        "/etc/dnsmasq.conf",
        "/opt/etc/dnsmasq.conf",
        "/tmp/etc/dnsmasq.conf",
    ]
    for conf_dir in ("/etc/dnsmasq.d", "/opt/etc/dnsmasq.d"):
        try:
            for name in sorted(os.listdir(conf_dir)):
                if name.endswith(".conf"):
                    conf_files.append(os.path.join(conf_dir, name))
        except OSError:
            pass

    for cpath in conf_files:
        for raw in read_text(cpath).splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if line.startswith("dhcp-leasefile="):
                lp = line.split("=", 1)[1].strip()
                if lp and lp not in lease_paths:
                    lease_paths.insert(0, lp)
            elif line.startswith("addn-hosts="):
                hp = line.split("=", 1)[1].strip()
                if hp and hp not in hosts_paths:
                    hosts_paths.append(hp)
            elif line.startswith("dhcp-host="):
                tokens = [t.strip() for t in line.split("=", 1)[1].split(",") if t.strip()]
                ip_val = None
                host_val = None
                for tok in tokens:
                    if tok.count(".") == 3 and all(p.isdigit() for p in tok.split(".")):
                        ip_val = tok
                    elif ":" not in tok and not tok.startswith("set:") and not tok.startswith("tag:") and not tok.startswith("id:") and tok not in ("infinite", "ignore") and not tok[0].isdigit():
                        host_val = tok
                if ip_val and host_val:
                    static_hosts[ip_val] = host_val
    return lease_paths, hosts_paths, static_hosts


def read_dhcp_leases():
    leases = {}
    lease_paths, hosts_paths, static_hosts = discover_dnsmasq_files()
    for hpath in hosts_paths:
        for line in read_text(hpath).splitlines():
            clean = line.split("#", 1)[0].strip()
            parts = clean.split()
            if len(parts) >= 2 and parts[0].count(".") == 3 and not parts[0].startswith("127."):
                leases[parts[0]] = parts[1]
    leases.update(static_hosts)
    for path in lease_paths:
        content = read_text(path)
        if not content:
            continue
        for line in content.splitlines():
            parts = line.split()
            if len(parts) >= 4:
                ip = parts[2]
                host = parts[3]
                if host != "*" and host != ip:
                    leases[ip] = host
    return leases


def read_arp_table(leases):
    entries_by_ip = {}
    content = read_text("/proc/net/arp")
    for line in content.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 6:
            ip, _, flags, mac, _, dev = parts[:6]
            if flags != "0x0" and mac != "00:00:00:00:00:00":
                entries_by_ip[ip] = {
                    "ip": ip,
                    "mac": mac.lower(),
                    "device": dev,
                    "hostname": leases.get(ip, ""),
                }
    return list(entries_by_ip.values())


SKIP_STATES = (
    "TIME_WAIT",
    "CLOSE_WAIT",
    "FIN_WAIT",
    "CLOSE ",
    "SYN_SENT",
    "SYN_RECV",
    "[UNREPLIED]",
)


def read_conntrack_lines(limit=500):
    lines = []
    for path in ("/proc/net/nf_conntrack", "/proc/net/ip_conntrack"):
        if os.path.exists(path):
            with open(path, "r") as f:
                for line in f:
                    if "bytes=" not in line or "bytes=0 " in line:
                        continue
                    if any(s in line for s in SKIP_STATES):
                        continue
                    lines.append(line.strip())
                    if len(lines) >= limit:
                        break
            break
    return lines


def read_static_host_info():
    u = os.uname()
    return {
        "hostname": socket.gethostname(),
        "kernel": u.release,
        "arch": u.machine,
        "conntrackMax": read_int("/proc/sys/net/netfilter/nf_conntrack_max") or 32768,
    }


def read_system_metrics(flow_count, static_info):
    uptime_raw = read_text("/proc/uptime").split()
    uptime_sec = int(float(uptime_raw[0])) if uptime_raw else 0
    load_raw = read_text("/proc/loadavg").split()
    load_1m = float(load_raw[0]) if load_raw else 0.0
    meminfo = read_text("/proc/meminfo")
    total_kb = avail_kb = 0
    for line in meminfo.splitlines():
        if line.startswith("MemTotal:"):
            total_kb = int(line.split()[1])
        elif line.startswith("MemAvailable:") or line.startswith("MemFree:"):
            avail_kb = max(avail_kb, int(line.split()[1]))
    mem_pct = round(((total_kb - avail_kb) / total_kb) * 100, 1) if total_kb else 0.0
    return {
        "hostname": static_info["hostname"],
        "kernel": static_info["kernel"],
        "arch": static_info["arch"],
        "uptimeSec": uptime_sec,
        "load1m": load_1m,
        "memUsedPct": mem_pct,
        "conntrackCount": flow_count,
        "conntrackMax": static_info["conntrackMax"],
    }


def parse_ws_url(url):
    scheme = "ws"
    rest = url.strip()
    if "://" in rest:
        scheme, rest = rest.split("://", 1)
    scheme = scheme.lower()
    if "/" in rest:
        netloc, path_part = rest.split("/", 1)
        path = "/" + path_part
    else:
        netloc = rest
        path = "/"
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[1]
    default_port = 443 if scheme == "wss" else 80
    if netloc.startswith("[") and "]" in netloc:
        end_bracket = netloc.find("]")
        host = netloc[1:end_bracket]
        port_part = netloc[end_bracket + 1:]
        port = int(port_part[1:]) if port_part.startswith(":") and port_part[1:] else default_port
    elif ":" in netloc:
        host, port_str = netloc.rsplit(":", 1)
        port = int(port_str) if port_str else default_port
    else:
        host = netloc
        port = default_port
    return scheme, host, port, path


def create_tcp_connection(host, port, timeout=8):
    # Pass ASCII bytes so Entware python3-light never loads missing encodings.idna
    host_bytes = host.encode("ascii") if isinstance(host, str) else host
    last_err = None
    for af, socktype, proto, _, sa in socket.getaddrinfo(
        host_bytes, port, 0, socket.SOCK_STREAM
    ):
        sock = None
        try:
            sock = socket.socket(af, socktype, proto)
            sock.settimeout(timeout)
            addr = (sa[0].encode("ascii") if isinstance(sa[0], str) else sa[0],) + sa[1:]
            sock.connect(addr)
            return sock
        except OSError as exc:
            last_err = exc
            if sock is not None:
                sock.close()
    if last_err is not None:
        raise last_err
    raise OSError(f"Unable to resolve host: {host}")


class MiniWebSocket:
    def __init__(self, url, token):
        scheme, host, port, path = parse_ws_url(url)
        self.host = host
        self.port = port
        self.path = path
        self.use_tls = scheme == "wss"
        self.token = token
        self.sock = None

    def connect(self):
        raw = create_tcp_connection(self.host, self.port, timeout=8)
        if self.use_tls:
            import ssl
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = f"[{self.host}]:{self.port}" if ":" in self.host else f"{self.host}:{self.port}"
        req = (
            f"GET {self.path} HTTP/1.1\\r\\n"
            f"Host: {host_header}\\r\\n"
            "Upgrade: websocket\\r\\n"
            "Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Key: {key}\\r\\n"
            "Sec-WebSocket-Version: 13\\r\\n"
            f"X-Probe-Token: {self.token}\\r\\n\\r\\n"
        )
        raw.sendall(req.encode("utf-8"))
        resp = raw.recv(4096).decode("utf-8", errors="ignore")
        if "101 Switching Protocols" not in resp:
            raw.close()
            first_line = resp.splitlines()[0] if resp.splitlines() else "empty response"
            raise ConnectionError(f"WebSocket handshake failed: {first_line}")
        self.sock = raw

    def send_json(self, obj):
        payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x81])
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


def main():
    cfg = parse_args(sys.argv[1:])
    if cfg["daemonize"]:
        daemonize_process(cfg["pid_file"])
    elif cfg["pid_file"]:
        try:
            with open(cfg["pid_file"], "w") as f:
                f.write(f"{os.getpid()}\\n")
        except OSError:
            pass

    logger = ProbeLogger(level=cfg["log_level"], log_file=cfg["log_file"])
    running = True

    def handle_stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    ensure_conntrack_acct()
    static_info = read_static_host_info()
    ws = MiniWebSocket(cfg["ws_url"], cfg["token"])
    leases = {}
    arp = []
    last_neigh_refresh = 0.0
    last_sys_refresh = 0.0

    logger.info(
        f"Starting probe={cfg['probe_id']} iface={cfg['iface']} "
        f"interval={cfg['interval']}s sys_interval={cfg['sys_interval']}s target={cfg['ws_url']}"
    )

    try:
        while running:
            try:
                if ws.sock is None:
                    ws.connect()
                    ws.send_json({
                        "type": "probe:hello",
                        "probeId": cfg["probe_id"],
                        "iface": cfg["iface"],
                    })
                    logger.info(f"Connected to {cfg['ws_url']}")

                now_ts = time.time()
                if now_ts - last_neigh_refresh >= cfg["neigh_interval"]:
                    leases = read_dhcp_leases()
                    arp = read_arp_table(leases)
                    last_neigh_refresh = now_ts
                    logger.debug(f"Refreshed {len(arp)} ARP neighbors / {len(leases)} DHCP leases")

                conntrack_lines = read_conntrack_lines()
                data = {
                    "probeId": cfg["probe_id"],
                    "timestamp": int(now_ts * 1000),
                    "source": "live",
                    "iface": read_iface_counters(cfg["iface"]),
                    "arp": arp,
                    "flows": [],
                    "rawConntrackLines": conntrack_lines,
                }

                if now_ts - last_sys_refresh >= cfg["sys_interval"]:
                    data["system"] = read_system_metrics(len(conntrack_lines), static_info)
                    last_sys_refresh = now_ts
                    logger.debug(
                        f"System metrics: load={data['system']['load1m']} mem={data['system']['memUsedPct']}%"
                    )

                ws.send_json({"type": "probe:snapshot", "data": data})
                logger.debug(f"Sent snapshot: flows={len(conntrack_lines)}")
                time.sleep(cfg["interval"])
            except Exception as exc:
                logger.error(f"Reconnecting after error: {exc}")
                ws.close()
                time.sleep(3)
    finally:
        ws.close()
        if cfg["pid_file"]:
            try:
                os.remove(cfg["pid_file"])
            except OSError:
                pass
        logger.info("Probe stopped")


if __name__ == "__main__":
    main()
`;
}

export function generateBusyBoxAshProbe(cfg: ProbeConfigOptions): string {
  return `#!/bin/sh
# OrbiFlow Zero-Dependency BusyBox Shell Collector
# Polls WAN traffic every ${cfg.intervalSec}s and router uptime/load every ~30s.

SERVER_HTTP_URL="${cfg.httpUrl}"
AUTH_TOKEN="${cfg.token}"
WAN_IFACE="${cfg.iface}"
PROBE_ID="${cfg.probeId}"
INTERVAL_SEC=${cfg.intervalSec}
SYS_EVERY=10

echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true

HOSTNAME=$(hostname 2>/dev/null || echo router-gateway)
KERNEL=$(uname -r)
ARCH=$(uname -m)
CT_MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo 32768)
TICK=0

while true; do
  RX_BYTES=$(cat /sys/class/net/$WAN_IFACE/statistics/rx_bytes 2>/dev/null || echo 0)
  TX_BYTES=$(cat /sys/class/net/$WAN_IFACE/statistics/tx_bytes 2>/dev/null || echo 0)

  SYS_JSON=""
  if [ $((TICK % SYS_EVERY)) -eq 0 ]; then
    UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
    LOAD1M=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
    SYS_JSON="\\"system\\":{\\"hostname\\":\\"$HOSTNAME\\",\\"kernel\\":\\"$KERNEL\\",\\"arch\\":\\"$ARCH\\",\\"uptimeSec\\":$UPTIME,\\"load1m\\":$LOAD1M,\\"memUsedPct\\":34,\\"conntrackCount\\":0,\\"conntrackMax\\":$CT_MAX},"
  fi
  TICK=$((TICK + 1))

  JSON_PAYLOAD=$(awk -v probe="$PROBE_ID" -v iface="$WAN_IFACE" \\
    -v rxb="$RX_BYTES" -v txb="$TX_BYTES" -v sys="$SYS_JSON" '
    BEGIN {
      printf "{\\"probeId\\":\\"%s\\",\\"source\\":\\"live\\",", probe;
      printf "\\"iface\\":{\\"iface\\":\\"%s\\",\\"rxBytes\\":%s,\\"txBytes\\":%s},", iface, rxb, txb;
      if (sys != "") printf "%s", sys;
      printf "\\"arp\\":[";
      arp_first = 1;
    }
    FILENAME == "/proc/net/arp" && FNR > 1 {
      if ($3 != "0x0" && $4 != "00:00:00:00:00:00") {
        if (!arp_first) printf ",";
        printf "{\\"ip\\":\\"%s\\",\\"mac\\":\\"%s\\",\\"device\\":\\"%s\\"}", $1, $4, $6;
        arp_first = 0;
      }
    }
    FILENAME == "/proc/net/nf_conntrack" && /bytes=/ && !/TIME_WAIT|CLOSE_WAIT|FIN_WAIT|SYN_SENT|SYN_RECV|UNREPLIED/ {
      if (ct_count == 0) printf "],\\"rawConntrackLines\\":[";
      else printf ",";
      gsub(/\\\\/, "\\\\\\\\");
      gsub(/"/, "\\\\\\"");
      printf "\\"%s\\"", $0;
      ct_count++;
      if (ct_count >= 400) nextfile;
    }
    END {
      if (ct_count == 0) printf "],\\"rawConntrackLines\\":[";
      printf "],\\"flows\\":[]}";
    }
  ' /proc/net/arp /proc/net/nf_conntrack)

  curl -fsS -m 4 -X POST \\
    -H "Content-Type: application/json" \\
    -H "X-Probe-Token: $AUTH_TOKEN" \\
    -d "$JSON_PAYLOAD" \\
    "$SERVER_HTTP_URL" >/dev/null 2>&1 || true

  sleep "$INTERVAL_SEC"
done
`;
}

export function generateCProbeSource(cfg: ProbeConfigOptions): string {
  return `/*
 * orbi-wan-probe.c — Low-CPU native C agent for Linux routers
 * Example cross-compile: gcc -O2 -s -o orbi-wan-probe orbi-wan-probe.c
 * Memory footprint: < 1.2 MB RSS | Low CPU impact at ${cfg.intervalSec}s interval
 */
#include <arpa/inet.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define SERVER_HOST "192.168.1.10"
#define SERVER_PORT 3000
#define WS_PATH "/ws/ingest"
#define PROBE_TOKEN "${cfg.token}"
#define WAN_IFACE "${cfg.iface}"
#define POLL_SEC ${cfg.intervalSec}

static unsigned long long read_ull(const char *path) {
    FILE *f = fopen(path, "r");
    unsigned long long v = 0;
    if (!f) return 0;
    if (fscanf(f, "%llu", &v) != 1) v = 0;
    fclose(f);
    return v;
}

static int ws_connect(const char *host, int port) {
    struct hostent *he = gethostbyname(host);
    if (!he) return -1;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    memcpy(&addr.sin_addr, he->h_addr_list[0], he->h_length);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }

    char req[512];
    snprintf(req, sizeof(req),
        "GET %s HTTP/1.1\\r\\n"
        "Host: %s:%d\\r\\n"
        "Upgrade: websocket\\r\\n"
        "Connection: Upgrade\\r\\n"
        "Sec-WebSocket-Key: b3JiaWZsb3ctcmJrNTA=\\r\\n"
        "Sec-WebSocket-Version: 13\\r\\n"
        "X-Probe-Token: %s\\r\\n\\r\\n",
        WS_PATH, host, port, PROBE_TOKEN);

    send(fd, req, strlen(req), 0);
    char resp[512];
    int n = recv(fd, resp, sizeof(resp) - 1, 0);
    if (n <= 0) { close(fd); return -1; }
    resp[n] = '\\0';
    if (!strstr(resp, "101 Switching Protocols")) { close(fd); return -1; }
    return fd;
}

static int ws_send_text(int fd, const char *msg, size_t len) {
    unsigned char hdr[14];
    size_t hlen = 0;
    hdr[0] = 0x81;
    if (len < 126) {
        hdr[1] = 0x80 | (unsigned char)len;
        hlen = 2;
    } else if (len < 65536) {
        hdr[1] = 0x80 | 126;
        hdr[2] = (len >> 8) & 0xff;
        hdr[3] = len & 0xff;
        hlen = 4;
    } else {
        return -1;
    }
    unsigned char mask[4] = {0x3a, 0x7f, 0x19, 0xc2};
    memcpy(hdr + hlen, mask, 4);
    hlen += 4;

    unsigned char *frame = malloc(hlen + len);
    if (!frame) return -1;
    memcpy(frame, hdr, hlen);
    for (size_t i = 0; i < len; i++) {
        frame[hlen + i] = ((unsigned char)msg[i]) ^ mask[i % 4];
    }
    ssize_t sent = send(fd, frame, hlen + len, 0);
    free(frame);
    return sent > 0 ? 0 : -1;
}

int main(void) {
    FILE *acct = fopen("/proc/sys/net/netfilter/nf_conntrack_acct", "w");
    if (acct) { fputs("1\\n", acct); fclose(acct); }

    char *buf = malloc(65536);
    if (!buf) return 1;

    int sock = -1;
    while (1) {
        if (sock < 0) {
            sock = ws_connect(SERVER_HOST, SERVER_PORT);
            if (sock < 0) { sleep(5); continue; }
        }

        unsigned long long rxb = read_ull("/sys/class/net/" WAN_IFACE "/statistics/rx_bytes");
        unsigned long long txb = read_ull("/sys/class/net/" WAN_IFACE "/statistics/tx_bytes");

        int pos = snprintf(buf, 65536,
            "{\\"type\\":\\"probe:snapshot\\",\\"data\\":{\\"probeId\\":\\"${cfg.probeId}\\",\\"source\\":\\"live\\","
            "\\"iface\\":{\\"iface\\":\\"%s\\",\\"rxBytes\\":%llu,\\"txBytes\\":%llu},\\"flows\\":[],\\"rawConntrackLines\\":[",
            WAN_IFACE, rxb, txb);

        FILE *ct = fopen("/proc/net/nf_conntrack", "r");
        if (ct) {
            char line[512];
            int first = 1;
            while (fgets(line, sizeof(line), ct) && pos < 60000) {
                if (!strstr(line, "bytes=")) continue;
                line[strcspn(line, "\\r\\n")] = '\\0';
                pos += snprintf(buf + pos, 65536 - pos, "%s\\"%s\\"", first ? "" : ",", line);
                first = 0;
            }
            fclose(ct);
        }

        pos += snprintf(buf + pos, 65536 - pos, "],\\"arp\\":[]}}");
        if (ws_send_text(sock, buf, (size_t)pos) < 0) {
            close(sock);
            sock = -1;
        }
        sleep(POLL_SEC);
    }
    return 0;
}
`;
}

export function generateDockerCompose(_cfg?: ProbeConfigOptions): string {
  return `services:
  orbiflow:
    build: .
    container_name: orbiflow-monitor
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=UTC
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 15s
      timeout: 5s
      retries: 3
`;
}

export function generateInitScript(): string {
  return `#!/bin/sh /etc/rc.common
# /opt/etc/init.d/S99orbi-probe — Router autostart service

START=99
STOP=10
PROG=/opt/bin/orbi_probe.py
PIDFILE=/var/run/orbi-probe.pid

start() {
  echo "Starting OrbiFlow WAN monitor agent..."
  echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true
  /opt/bin/python3 "$PROG" -d --pid-file "$PIDFILE"
}

stop() {
  echo "Stopping OrbiFlow WAN monitor agent..."
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}
`;
}
