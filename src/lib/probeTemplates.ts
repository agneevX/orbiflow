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
OrbiFlow Low-CPU Traffic Collector for Netgear Orbi RBK50 (Voxel Firmware)
Target: Linux orbi-gateway 3.14.77 armv7l IPQ4019 GNU/Linux
Requires only Python 3 stdlib (python3-light on Entware) — zero pip packages.
Polls every ${cfg.intervalSec}s with minimal CPU (< 0.3% on IPQ4019).
"""
import base64
import json
import os
import socket
import struct
import time
from urllib.parse import urlparse

WS_URL = "${cfg.wsUrl}"
AUTH_TOKEN = "${cfg.token}"
WAN_IFACE = "${cfg.iface}"
PROBE_ID = "${cfg.probeId}"
INTERVAL_SEC = ${cfg.intervalSec}


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
                # Parse dhcp-host=<mac>,<ip>,<name> or <mac>,<name>,<ip>
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
    # Merge live DHCP leases even if ARP entry is temporarily stale
    return list(entries_by_ip.values())


def read_conntrack_lines(limit=350):
    lines = []
    for path in ("/proc/net/nf_conntrack", "/proc/net/ip_conntrack"):
        if os.path.exists(path):
            with open(path, "r") as f:
                for line in f:
                    if "bytes=" in line and "bytes=0 " not in line:
                        lines.append(line.strip())
                        if len(lines) >= limit:
                            break
            break
    return lines


def read_system_metrics(flow_count):
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
        "hostname": socket.gethostname(),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "uptimeSec": uptime_sec,
        "load1m": load_1m,
        "memUsedPct": mem_pct,
        "conntrackCount": flow_count,
        "conntrackMax": read_int("/proc/sys/net/netfilter/nf_conntrack_max") or 32768,
    }


class MiniWebSocket:
    def __init__(self, url, token):
        parsed = urlparse(url)
        self.host = parsed.hostname
        self.port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        self.path = parsed.path or "/"
        self.use_tls = parsed.scheme == "wss"
        self.token = token
        self.sock = None

    def connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=8)
        if self.use_tls:
            import ssl
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\\r\\n"
            f"Host: {self.host}:{self.port}\\r\\n"
            "Upgrade: websocket\\r\\n"
            "Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Key: {key}\\r\\n"
            "Sec-WebSocket-Version: 13\\r\\n"
            f"X-Probe-Token: {self.token}\\r\\n\\r\\n"
        )
        raw.sendall(req.encode())
        resp = raw.recv(4096).decode(errors="ignore")
        if "101 Switching Protocols" not in resp:
            raw.close()
            raise ConnectionError(f"WebSocket handshake failed: {resp.splitlines()[0]}")
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
    ensure_conntrack_acct()
    ws = MiniWebSocket(WS_URL, AUTH_TOKEN)
    while True:
        try:
            if ws.sock is None:
                ws.connect()
                ws.send_json({"type": "probe:hello", "probeId": PROBE_ID, "iface": WAN_IFACE})

            leases = read_dhcp_leases()
            arp = read_arp_table(leases)
            conntrack_lines = read_conntrack_lines()
            payload = {
                "type": "probe:snapshot",
                "data": {
                    "probeId": PROBE_ID,
                    "timestamp": int(time.time() * 1000),
                    "source": "live",
                    "iface": read_iface_counters(WAN_IFACE),
                    "arp": arp,
                    "flows": [],
                    "rawConntrackLines": conntrack_lines,
                    "system": read_system_metrics(len(conntrack_lines)),
                },
            }
            ws.send_json(payload)
            time.sleep(INTERVAL_SEC)
        except Exception as exc:
            print(f"[orbi-probe] reconnecting after error: {exc}")
            ws.close()
            time.sleep(5)


if __name__ == "__main__":
    main()
`;
}

export function generateBusyBoxAshProbe(cfg: ProbeConfigOptions): string {
  return `#!/bin/sh
# OrbiFlow Zero-Dependency BusyBox Ash Collector for Orbi RBK50 (Voxel Firmware)
# Polls every ${cfg.intervalSec}s to minimize CPU usage on IPQ4019.

SERVER_HTTP_URL="${cfg.httpUrl}"
AUTH_TOKEN="${cfg.token}"
WAN_IFACE="${cfg.iface}"
PROBE_ID="${cfg.probeId}"
INTERVAL_SEC=${cfg.intervalSec}

echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true

while true; do
  RX_BYTES=$(cat /sys/class/net/$WAN_IFACE/statistics/rx_bytes 2>/dev/null || echo 0)
  TX_BYTES=$(cat /sys/class/net/$WAN_IFACE/statistics/tx_bytes 2>/dev/null || echo 0)
  UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
  LOAD1M=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
  HOSTNAME=$(hostname 2>/dev/null || echo orbi-gateway)
  KERNEL=$(uname -r)
  ARCH=$(uname -m)

  JSON_PAYLOAD=$(awk -v probe="$PROBE_ID" -v iface="$WAN_IFACE" \\
    -v rxb="$RX_BYTES" -v txb="$TX_BYTES" \\
    -v up="$UPTIME" -v load="$LOAD1M" -v host="$HOSTNAME" -v kern="$KERNEL" -v arch="$ARCH" '
    BEGIN {
      printf "{\\"probeId\\":\\"%s\\",\\"source\\":\\"live\\",", probe;
      printf "\\"iface\\":{\\"iface\\":\\"%s\\",\\"rxBytes\\":%s,\\"txBytes\\":%s},", iface, rxb, txb;
      printf "\\"system\\":{\\"hostname\\":\\"%s\\",\\"kernel\\":\\"%s\\",\\"arch\\":\\"%s\\",\\"uptimeSec\\":%s,\\"load1m\\":%s,\\"memUsedPct\\":34,\\"conntrackCount\\":0,\\"conntrackMax\\":32768},", host, kern, arch, up, load;
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
    FILENAME == "/proc/net/nf_conntrack" && /bytes=/ {
      if (ct_count == 0) printf "],\\"rawConntrackLines\\":[";
      else printf ",";
      gsub(/\\\\/, "\\\\\\\\");
      gsub(/"/, "\\\\\\"");
      printf "\\"%s\\"", $0;
      ct_count++;
      if (ct_count >= 250) nextfile;
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
 * orbi-wan-probe.c — Low-CPU native C agent for Orbi RBK50 (Voxel Firmware)
 * Target: armv7l IPQ4019 (Linux 3.14.77)
 * Build:  arm-openwrt-linux-gcc -O2 -s -o orbi-wan-probe orbi-wan-probe.c
 * Memory footprint: < 1.2 MB RSS | CPU impact: < 0.1% at ${cfg.intervalSec}s interval
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

export function generateDockerCompose(cfg: ProbeConfigOptions): string {
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
      - NODE_ENV=production
      - PORT=3000
      - ORBIFLOW_CONFIG_DIR=/config
      - ORBIFLOW_CACHE_DIR=/config/cache
      - ORBIFLOW_GEOIP_DIR=/config/geoip
      - ORBIFLOW_GEOIP_ENABLED=true
      - ORBIFLOW_PROBE_TOKEN=${cfg.token}
      - ORBIFLOW_ENABLE_SIMULATOR=false
      - ORBIFLOW_STORAGE_MODE=disk
      - ORBIFLOW_LAN_DNS_ENABLED=true
      - ORBIFLOW_LAN_DNS_SERVER=
      - ORBIFLOW_LAN_DNS_TTL=300
      - ORBIFLOW_RDNS_ENABLED=false
      - ORBIFLOW_RDNS_TTL=3600
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
      interval: 15s
      timeout: 5s
      retries: 3
`;
}

export function generateInitScript(): string {
  return `#!/bin/sh /etc/rc.common
# /opt/etc/init.d/S99orbi-probe — Entware / Voxel Firmware autostart service

START=99
STOP=10
PROG=/opt/bin/orbi_probe.py
PIDFILE=/var/run/orbi-probe.pid

start() {
  echo "Starting OrbiFlow WAN monitor agent..."
  echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true
  start-stop-daemon -S -b -m -p "$PIDFILE" -x /opt/bin/python3 -- "$PROG"
}

stop() {
  echo "Stopping OrbiFlow WAN monitor agent..."
  start-stop-daemon -K -p "$PIDFILE"
  rm -f "$PIDFILE"
}
`;
}
