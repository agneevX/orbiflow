#!/usr/bin/env python3
"""
OrbiFlow Lightweight Telemetry Probe for Netgear Orbi RBK50 (Voxel Firmware)
Target: Linux orbi-gateway 3.14.77 armv7l IPQ4019 GNU/Linux
Requires only Python 3 core stdlib (python3-light on Entware) — zero urllib or pip packages.
"""
import base64
import json
import os
import socket
import struct
import time

WS_URL = os.environ.get("ORBIFLOW_WS_URL", "ws://192.168.1.10:3000/ws/ingest")
AUTH_TOKEN = os.environ.get("ORBIFLOW_PROBE_TOKEN", "orbi-rbk50-voxel-secret")
WAN_IFACE = os.environ.get("ORBIFLOW_WAN_IFACE", "eth0")
PROBE_ID = os.environ.get("ORBIFLOW_PROBE_ID", "orbi-rbk50-eth0")
INTERVAL_SEC = float(os.environ.get("ORBIFLOW_INTERVAL", "5"))


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
                f.write("1\n")
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
                    elif (
                        ":" not in tok
                        and not tok.startswith("set:")
                        and not tok.startswith("tag:")
                        and not tok.startswith("id:")
                        and tok not in ("infinite", "ignore")
                        and not tok[0].isdigit()
                    ):
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
        raw = socket.create_connection((self.host, self.port), timeout=8)
        if self.use_tls:
            import ssl
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode()
        host_header = f"[{self.host}]:{self.port}" if ":" in self.host else f"{self.host}:{self.port}"
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"X-Probe-Token: {self.token}\r\n\r\n"
        )
        raw.sendall(req.encode())
        resp = raw.recv(4096).decode(errors="ignore")
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
            time.sleep(3)


if __name__ == "__main__":
    main()
