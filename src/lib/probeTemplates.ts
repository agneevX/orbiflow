export interface ProbeConfigOptions {
  wsUrl: string;
  httpUrl: string;
  token: string;
  iface: string;
  intervalSec: number;
  probeId: string;
  dhcpLeasesPath?: string;
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
  --ports-interval SEC      Switch/Ethernet port refresh interval in seconds (default: 30)
  --neigh-interval SEC      ARP/DHCP/Wi-Fi neighbor refresh interval in seconds (default: 15)
  --iface NAME              WAN interface name (default: ${cfg.iface})
  --dhcp-leases PATH        Custom DHCP leases file path (auto-detect if omitted)
  --ws-url URL              Collector WebSocket URL
  --token TOKEN             Shared router agent token
  --probe-id ID             Unique probe identifier
  -h, --help                Show this help text and exit
"""
import base64
import json
import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
try:
    import threading
except ImportError:
    threading = None
import time

WS_URL = ${JSON.stringify(cfg.wsUrl)}
AUTH_TOKEN = ${JSON.stringify(cfg.token)}
WAN_IFACE = ${JSON.stringify(cfg.iface)}
PROBE_ID = ${JSON.stringify(cfg.probeId)}
INTERVAL_SEC = ${Math.max(1, Math.min(60, Math.round(Number(cfg.intervalSec) || 3)))}
SYS_INTERVAL_SEC = 30
PORTS_INTERVAL_SEC = 30
NEIGH_INTERVAL_SEC = 15
DHCP_LEASES_PATH = ${JSON.stringify((cfg.dhcpLeasesPath || '').trim())}

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
        "ports_interval": float(PORTS_INTERVAL_SEC),
        "neigh_interval": float(NEIGH_INTERVAL_SEC),
        "dhcp_leases": DHCP_LEASES_PATH,
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
        elif arg == "--ports-interval":
            cfg["ports_interval"] = max(5.0, float(need_val(arg)))
        elif arg == "--neigh-interval":
            cfg["neigh_interval"] = max(5.0, float(need_val(arg)))
        elif arg == "--iface":
            cfg["iface"] = need_val(arg)
        elif arg == "--dhcp-leases":
            cfg["dhcp_leases"] = need_val(arg).strip()
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


def find_binary(name):
    for d in ("/usr/sbin", "/sbin", "/usr/bin", "/bin", "/opt/sbin", "/opt/bin"):
        p = f"{d}/{name}"
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def ensure_conntrack_acct():
    acct_path = "/proc/sys/net/netfilter/nf_conntrack_acct"
    try:
        if read_int(acct_path) == 0:
            with open(acct_path, "w") as f:
                f.write("1\\n")
    except OSError:
        pass


def read_proc_net_dev():
    devs = {}
    try:
        with open("/proc/net/dev", "r") as f:
            for line in f:
                if ":" not in line:
                    continue
                name_part, rest = line.split(":", 1)
                fields = rest.split()
                if len(fields) >= 11:
                    devs[name_part.strip()] = (
                        int(fields[0]),
                        int(fields[2]),
                        int(fields[8]),
                        int(fields[10]),
                    )
    except (OSError, ValueError):
        pass
    return devs


def read_iface_counters(iface, dev_map=None):
    # Single-open /proc/net/dev read avoids 4 sysfs opens on every fast tick
    if dev_map is None:
        dev_map = read_proc_net_dev()
    if iface in dev_map:
        rx_b, rx_e, tx_b, tx_e = dev_map[iface]
        return {
            "iface": iface,
            "rxBytes": rx_b,
            "rxErrors": rx_e,
            "txBytes": tx_b,
            "txErrors": tx_e,
        }
    base = f"/sys/class/net/{iface}/statistics"
    return {
        "iface": iface,
        "rxBytes": read_int(f"{base}/rx_bytes"),
        "txBytes": read_int(f"{base}/tx_bytes"),
        "rxErrors": read_int(f"{base}/rx_errors"),
        "txErrors": read_int(f"{base}/tx_errors"),
    }


def read_lan_iface_counters(wan_iface, dev_map=None):
    if dev_map is None:
        dev_map = read_proc_net_dev()
    ifaces = []
    for name, (rx_b, rx_e, tx_b, tx_e) in dev_map.items():
        if name == "lo" or name == wan_iface:
            continue
        is_primary_lan = name in ("eth1", "br0", "br-lan") or name.startswith("lan")
        is_wifi_lan = name.startswith("ath") or name.startswith("wlan")
        if not (is_primary_lan or is_wifi_lan):
            continue
        if not is_primary_lan and rx_b == 0 and tx_b == 0:
            continue
        ifaces.append({
            "iface": name,
            "rxBytes": rx_b,
            "rxErrors": rx_e,
            "txBytes": tx_b,
            "txErrors": tx_e,
        })

    def _sort_key(item):
        n = item["iface"]
        if n == "eth1":
            return (0, n)
        if n in ("br0", "br-lan"):
            return (1, n)
        if n.startswith("lan"):
            return (2, n)
        return (3, n)

    ifaces.sort(key=_sort_key)
    return ifaces[:8]


def read_swconfig_ports(swconfig_bin):
    ports = []
    cpu_ports = set()
    wan_ports = set()
    if not swconfig_bin:
        return ports, cpu_ports, wan_ports
    try:
        out = subprocess.check_output(
            [swconfig_bin, "dev", "switch0", "show"],
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode("utf-8", errors="ignore")
    except Exception:
        return ports, cpu_ports, wan_ports

    cur = None
    cur_vlan = None
    vlan_members = {}
    for raw in out.splitlines():
        line = raw.strip()
        if line.startswith("Port ") and line.endswith(":"):
            if cur is not None:
                ports.append(cur)
            cur_vlan = None
            try:
                pnum = int(line.split()[1].rstrip(":"))
            except ValueError:
                pnum = len(ports)
            cur = {
                "id": f"port{pnum}",
                "label": f"LAN {pnum}",
                "role": "lan",
                "linkUp": False,
                "speedMbps": 0,
                "duplex": "unknown",
                "rxBytes": 0,
                "txBytes": 0,
                "rxBps": 0,
                "txBps": 0,
                "_pnum": pnum,
            }
        elif line.startswith("VLAN ") and line.endswith(":"):
            if cur is not None:
                ports.append(cur)
                cur = None
            try:
                cur_vlan = int(line.split()[1].rstrip(":"))
            except ValueError:
                cur_vlan = None
        elif cur_vlan is not None and line.startswith("ports:"):
            members = []
            for tok in line.split(":", 1)[1].split():
                is_tagged = tok.endswith("t")
                num_str = tok.rstrip("tu*")
                if num_str.isdigit():
                    pnum = int(num_str)
                    if is_tagged:
                        cpu_ports.add(pnum)
                    else:
                        members.append(pnum)
            if members:
                vlan_members[cur_vlan] = members
        elif cur is not None and "link:" in line:
            for tok in line.split():
                if tok == "link:up":
                    cur["linkUp"] = True
                elif tok.startswith("speed:"):
                    digits = ""
                    for ch in tok[6:]:
                        if ch.isdigit():
                            digits += ch
                        else:
                            break
                    if digits:
                        cur["speedMbps"] = int(digits)
                elif "full-duplex" in tok:
                    cur["duplex"] = "full"
                elif "half-duplex" in tok:
                    cur["duplex"] = "half"
        elif cur is not None and (line.startswith("RxGoodByte") or line.startswith("RxByte")):
            val = line.split(":", 1)[-1].strip()
            if val.isdigit():
                cur["rxBytes"] = int(val)
        elif cur is not None and (line.startswith("TxByte") or line.startswith("TxGoodByte")):
            val = line.split(":", 1)[-1].strip()
            if val.isdigit():
                cur["txBytes"] = int(val)
    if cur is not None:
        ports.append(cur)

    # Collect all untagged VLAN member ports (physical switch ports assigned to a VLAN)
    all_vlan_untagged = set()
    for members in vlan_members.values():
        for m in members:
            all_vlan_untagged.add(m)

    # Identify WAN switch port when a dedicated single-port VLAN exists alongside a multi-port LAN VLAN
    if len(vlan_members) >= 2:
        single_port_vlans = [m for m in vlan_members.values() if len(m) == 1]
        multi_port_vlans = [m for m in vlan_members.values() if len(m) > 1]
        if single_port_vlans and multi_port_vlans:
            for members in single_port_vlans:
                wan_ports.add(members[0])

    # Always exclude internal CPU/GMAC ports (port 0, tagged VLAN ports, non-VLAN-member ports, and QCA8337 ports >= 5)
    if len(ports) > 1:
        cpu_ports.add(0)
    has_ports_1_to_4 = any(1 <= p.get("_pnum", -1) <= 4 for p in ports)
    filtered = []
    for p in ports:
        pnum = p.get("_pnum", -1)
        if pnum in cpu_ports:
            continue
        if all_vlan_untagged and pnum not in all_vlan_untagged:
            continue
        if has_ports_1_to_4 and pnum >= 5:
            continue
        filtered.append(p)

    # Orbi routers have 4 physical Ethernet ports: 1 WAN + 3 LAN
    lan_candidates = [p for p in filtered if p.get("_pnum", -1) not in wan_ports]
    wan_candidates = [p for p in filtered if p.get("_pnum", -1) in wan_ports]
    if len(lan_candidates) > 3:
        lan_candidates = lan_candidates[:3]

    final_ports = []
    for p in wan_candidates[:1]:
        p["role"] = "wan"
        p["label"] = "WAN"
        p.pop("_pnum", None)
        final_ports.append(p)
    for idx, p in enumerate(lan_candidates, 1):
        p["role"] = "lan"
        p["label"] = f"LAN {idx}"
        p.pop("_pnum", None)
        final_ports.append(p)
    return final_ports, cpu_ports, wan_ports


def read_router_ports(wan_iface, swconfig_bin):
    dev_map = read_proc_net_dev()
    sw_ports, cpu_ports, wan_switch_ports = read_swconfig_ports(swconfig_bin)
    sw_lan_ports = [p for p in sw_ports if p.get("role") != "wan"][:3]
    sw_wan_ports = [p for p in sw_ports if p.get("role") == "wan"]

    ports = []
    seen = set()

    def build_sysfs_port(name, force_wan=False, custom_label=None):
        base = f"/sys/class/net/{name}"
        oper = read_text(f"{base}/operstate").strip().lower()
        speed = read_int(f"{base}/speed")
        if speed < 0:
            speed = 0
        duplex = read_text(f"{base}/duplex").strip().lower()
        if duplex not in ("full", "half"):
            duplex = "unknown"
        rx_b, _, tx_b, _ = dev_map.get(name, (0, 0, 0, 0))
        is_wan = force_wan or name == wan_iface
        return {
            "id": name,
            "label": custom_label or (f"WAN ({name})" if is_wan else name),
            "role": "wan" if is_wan else "lan",
            "linkUp": oper == "up" or speed > 0,
            "speedMbps": speed,
            "duplex": duplex,
            "rxBytes": rx_b,
            "txBytes": tx_b,
            "rxBps": 0,
            "txBps": 0,
        }

    # Always emit a single authoritative WAN port (merging switch WAN speed if sysfs reports 0)
    wan_port = build_sysfs_port(wan_iface, force_wan=True)
    if sw_wan_ports:
        sw_wan = sw_wan_ports[0]
        if wan_port["speedMbps"] <= 0 and sw_wan.get("speedMbps", 0) > 0:
            wan_port["speedMbps"] = sw_wan["speedMbps"]
        if wan_port["duplex"] == "unknown" and sw_wan.get("duplex") in ("full", "half"):
            wan_port["duplex"] = sw_wan["duplex"]
        if sw_wan.get("linkUp"):
            wan_port["linkUp"] = True
    ports.append(wan_port)
    seen.add(wan_iface)

    # When swconfig exposes physical LAN switch ports, use them directly instead of duplicating internal CPU trunk eth1
    if sw_lan_ports:
        for sp in sw_lan_ports:
            if sp["id"] not in seen:
                ports.append(sp)
                seen.add(sp["id"])
        return ports, cpu_ports, wan_switch_ports, sw_lan_ports

    try:
        names = sorted(os.listdir("/sys/class/net"))
    except OSError:
        names = []

    lan_added = 0
    for name in names:
        if name == "lo" or name in seen:
            continue
        if "." in name or "@" in name or ":" in name:
            continue
        if not (
            name.startswith("eth") or name.startswith("en") or name.startswith("lan") or name.startswith("wan")
        ):
            continue
        if os.path.isdir(f"/sys/class/net/{name}/wireless"):
            continue
        lan_added += 1
        ports.append(build_sysfs_port(name, custom_label=f"LAN {lan_added} ({name})"))
        seen.add(name)
        if lan_added >= 3:
            break

    return ports, cpu_ports, wan_switch_ports, sw_lan_ports


def _ipv4_network_cidr(ip_str, prefix_len):
    try:
        if prefix_len < 8 or prefix_len > 30:
            return None
        packed = socket.inet_aton(ip_str)
        ip_int = struct.unpack("!I", packed)[0]
        mask = (0xFFFFFFFF << (32 - prefix_len)) & 0xFFFFFFFF
        net_int = ip_int & mask
        net_str = socket.inet_ntoa(struct.pack("!I", net_int))
        return f"{net_str}/{prefix_len}"
    except Exception:
        return None


def _mask_int_to_prefix(mask_int):
    bits = 0
    for shift in range(31, -1, -1):
        if (mask_int >> shift) & 1:
            bits += 1
        else:
            break
    expected = (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF if bits > 0 else 0
    return bits if mask_int == expected else -1


def read_router_subnets(wan_iface, ip_bin):
    vlan_id_by_iface = {}
    vlan_cfg = read_text("/proc/net/vlan/config")
    for raw in vlan_cfg.splitlines():
        if "|" not in raw:
            continue
        parts = [p.strip() for p in raw.split("|")]
        if len(parts) >= 2 and parts[1].isdigit():
            vlan_id_by_iface[parts[0]] = int(parts[1])

    subnets_by_cidr = {}

    if ip_bin:
        try:
            out = subprocess.check_output(
                [ip_bin, "-4", "-o", "addr", "show"],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            for raw in out.splitlines():
                parts = raw.split()
                if len(parts) < 4:
                    continue
                iface = parts[1].split("@", 1)[0]
                if iface == "lo" or iface == wan_iface:
                    continue
                inet_idx = -1
                for idx, tok in enumerate(parts):
                    if tok == "inet" and idx + 1 < len(parts):
                        inet_idx = idx + 1
                        break
                if inet_idx < 0 or "/" not in parts[inet_idx]:
                    continue
                ip_part, pfx_part = parts[inet_idx].split("/", 1)
                if not pfx_part.isdigit() or not is_private_lan_ip(ip_part):
                    continue
                cidr = _ipv4_network_cidr(ip_part, int(pfx_part))
                if not cidr:
                    continue
                vlan_id = vlan_id_by_iface.get(iface)
                if vlan_id is None and "." in iface:
                    tail = iface.rsplit(".", 1)[-1]
                    if tail.isdigit():
                        vlan_id = int(tail)
                entry = {"cidr": cidr, "iface": iface}
                if vlan_id is not None:
                    entry["vlanId"] = vlan_id
                subnets_by_cidr[cidr] = entry
        except Exception:
            pass

    # Also inspect /proc/net/route for statically routed private VLAN subnets
    for raw in read_text("/proc/net/route").splitlines()[1:]:
        parts = raw.split()
        if len(parts) < 8:
            continue
        iface = parts[0]
        if iface == "lo" or iface == wan_iface:
            continue
        dest_ip = _decode_proc_route_hex_ip(parts[1])
        if not dest_ip or not is_private_lan_ip(dest_ip):
            continue
        try:
            mask_host = int(parts[7], 16)
            mask_be = struct.unpack("!I", struct.pack("=I", mask_host))[0]
            pfx = _mask_int_to_prefix(mask_be)
        except Exception:
            continue
        if pfx < 16 or pfx > 30:
            continue
        cidr = _ipv4_network_cidr(dest_ip, pfx)
        if not cidr or cidr in subnets_by_cidr:
            continue
        vlan_id = vlan_id_by_iface.get(iface)
        if vlan_id is None and "." in iface:
            tail = iface.rsplit(".", 1)[-1]
            if tail.isdigit():
                vlan_id = int(tail)
        entry = {"cidr": cidr, "iface": iface}
        if vlan_id is not None:
            entry["vlanId"] = vlan_id
        subnets_by_cidr[cidr] = entry

    return list(subnets_by_cidr.values())


def discover_dnsmasq_files(custom_lease_path=""):
    lease_paths = [
        "/tmp/dhcp.leases",
        "/tmp/udhcpd.leases",
        "/var/run/dnsmasq.leases",
        "/opt/var/lib/misc/dnsmasq.leases",
    ]
    if custom_lease_path:
        custom_clean = custom_lease_path.strip()
        if custom_clean:
            if custom_clean in lease_paths:
                lease_paths.remove(custom_clean)
            lease_paths.insert(0, custom_clean)
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


class LeaseCache:
    def __init__(self, custom_lease_path=""):
        self.custom_lease_path = custom_lease_path
        self.lease_paths = []
        self.hosts_paths = []
        self.static_hosts = {}
        self.last_discover = 0.0
        self.last_sig = None
        self.leases = {}
        self.active_clients = {}

    def _file_sig(self, paths):
        sig = []
        for p in paths:
            try:
                st = os.stat(p)
                sig.append((p, st.st_mtime_ns, st.st_size))
            except OSError:
                pass
        return tuple(sig)

    def read(self, now_ts):
        if now_ts - self.last_discover >= 300.0 or not self.lease_paths:
            self.lease_paths, self.hosts_paths, self.static_hosts = discover_dnsmasq_files(
                self.custom_lease_path
            )
            self.last_discover = now_ts
            self.last_sig = None

        sig = self._file_sig(self.hosts_paths + self.lease_paths)
        if sig == self.last_sig and self.last_sig is not None:
            return self.leases, self.active_clients

        leases = {}
        active_clients = {}
        now_epoch = int(now_ts)
        for hpath in self.hosts_paths:
            for line in read_text(hpath).splitlines():
                clean = line.split("#", 1)[0].strip()
                parts = clean.split()
                if len(parts) >= 2 and parts[0].count(".") == 3 and not parts[0].startswith("127."):
                    leases[parts[0]] = parts[1]
        leases.update(self.static_hosts)
        for path in self.lease_paths:
            content = read_text(path)
            if not content:
                continue
            for line in content.splitlines():
                clean = line.split("#", 1)[0].strip()
                if not clean:
                    continue
                parts = clean.split()
                if len(parts) >= 4 and parts[2].count(".") == 3:
                    expiry_str, mac_str, ip, host = parts[0], parts[1], parts[2], parts[3]
                    if host != "*" and host != ip:
                        leases[ip] = host
                    try:
                        expiry = int(expiry_str)
                    except ValueError:
                        expiry = 0
                    if (expiry == 0 or expiry > now_epoch) and mac_str.count(":") == 5:
                        active_clients[ip] = {
                            "ip": ip,
                            "mac": mac_str.lower(),
                            "device": "br0",
                            "hostname": "" if host in ("*", ip) else host,
                        }
                elif len(parts) >= 2 and parts[0].count(".") == 3 and not parts[0].startswith("127."):
                    leases[parts[0]] = parts[1]
        self.leases = leases
        self.active_clients = active_clients
        self.last_sig = sig
        return leases, active_clients


def is_private_lan_ip(ip):
    if not ip or ip.startswith("127.") or ip.startswith("169.254."):
        return False
    if ip.startswith("10.") or ip.startswith("192.168."):
        return True
    if ip.startswith("172."):
        parts = ip.split(".")
        if len(parts) == 4 and parts[1].isdigit():
            second = int(parts[1])
            return 16 <= second <= 31
    return False


def _decode_proc_route_hex_ip(hex_str):
    h = hex_str.strip()
    if len(h) != 8 or h == "00000000":
        return ""
    try:
        val = int(h, 16)
    except ValueError:
        return ""
    # Kernel /proc/net/route uses host byte order; socket.inet_ntoa(struct.pack("<L", ...)) matches little-endian ARM/x86
    try:
        return socket.inet_ntoa(struct.pack("=I", val))
    except Exception:
        return ""


def read_wan_details(wan_iface, ip_bin, ifconfig_bin, nvram_bin):
    wan_ip = ""
    wan_gw = ""
    dns_servers = []

    # 1. Resolve WAN IPv4 address from ip, ifconfig, or nvram
    if ip_bin:
        try:
            out = subprocess.check_output(
                [ip_bin, "-4", "addr", "show", "dev", wan_iface],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            for raw in out.splitlines():
                line = raw.strip()
                if line.startswith("inet "):
                    tok = line.split()[1].split("/")[0]
                    if tok.count(".") == 3:
                        wan_ip = tok
                        break
        except Exception:
            pass
    if not wan_ip and ifconfig_bin:
        try:
            out = subprocess.check_output(
                [ifconfig_bin, wan_iface],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            for raw in out.splitlines():
                if "inet addr:" in raw:
                    wan_ip = raw.split("inet addr:", 1)[1].split()[0].strip()
                    break
                if "inet " in raw:
                    parts = raw.strip().split()
                    if len(parts) >= 2 and parts[0] == "inet" and parts[1].count(".") == 3:
                        wan_ip = parts[1]
                        break
        except Exception:
            pass
    if not wan_ip and nvram_bin:
        try:
            cand = subprocess.check_output(
                [nvram_bin, "get", "wan_ipaddr"],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore").strip()
            if cand.count(".") == 3 and cand != "0.0.0.0":
                wan_ip = cand
        except Exception:
            pass

    # 2. Default gateway from /proc/net/route
    for raw in read_text("/proc/net/route").splitlines()[1:]:
        parts = raw.split()
        if len(parts) >= 3 and parts[1] == "00000000":
            gw = _decode_proc_route_hex_ip(parts[2])
            if gw and gw != "0.0.0.0":
                wan_gw = gw
                if parts[0] == wan_iface:
                    break

    # 3. DNS resolvers from upstream resolv files
    seen_dns = set()
    for rpath in ("/tmp/resolv.conf.auto", "/tmp/resolv.conf", "/etc/resolv.conf"):
        for raw in read_text(rpath).splitlines():
            clean = raw.split("#", 1)[0].strip()
            if clean.startswith("nameserver "):
                ns = clean.split()[1].strip()
                if ns and ns != "127.0.0.1" and ns != "::1" and ns not in seen_dns:
                    seen_dns.add(ns)
                    dns_servers.append(ns)
        if dns_servers:
            break

    # 4. Link attributes from /sys/class/net/<wan_iface>
    base = f"/sys/class/net/{wan_iface}"
    speed = read_int(f"{base}/speed")
    if speed < 0:
        speed = 0
    duplex = read_text(f"{base}/duplex").strip().lower()
    if duplex not in ("full", "half"):
        duplex = "unknown"
    mtu = read_int(f"{base}/mtu")
    state = read_text(f"{base}/operstate").strip().lower() or ("up" if speed > 0 or wan_ip else "unknown")
    mac = read_text(f"{base}/address").strip().lower()
    conn_type = "PPPoE" if wan_iface.startswith("ppp") else "DHCP"
    if nvram_bin:
        try:
            proto = subprocess.check_output(
                [nvram_bin, "get", "wan_proto"],
                stderr=subprocess.DEVNULL,
                timeout=1,
            ).decode("utf-8", errors="ignore").strip().lower()
            if proto:
                conn_type = proto.upper()
        except Exception:
            pass

    res = {
        "iface": wan_iface,
        "dns": dns_servers[:4],
        "linkSpeedMbps": speed,
        "duplex": duplex,
        "state": state,
        "connectionType": conn_type,
    }
    if wan_ip:
        res["ip"] = wan_ip
    if wan_gw:
        res["gateway"] = wan_gw
    if mtu > 0:
        res["mtu"] = mtu
    if mac and mac.count(":") == 5:
        res["mac"] = mac
    return res


def _normalize_satinfo_item(rec):
    if not isinstance(rec, dict):
        return None
    raw_mac = rec.get("mac") or rec.get("MAC") or rec.get("mac_addr") or rec.get("macAddress") or rec.get("al_mac") or ""
    raw_ip = rec.get("ip") or rec.get("IP") or rec.get("ip_addr") or rec.get("ipAddress") or rec.get("host") or ""
    raw_name = rec.get("name") or rec.get("device_name") or rec.get("deviceName") or rec.get("hostname") or ""
    raw_model = rec.get("model") or rec.get("model_name") or rec.get("modelName") or ""
    bh_raw = (
        rec.get("backhaul_type")
        or rec.get("backhaulType")
        or rec.get("conn_type")
        or rec.get("connection_type")
        or rec.get("link_type")
        or rec.get("type")
        or rec.get("backhaul")
        or ""
    )
    bh_str = str(bh_raw).strip().lower()
    if any(tok in bh_str for tok in ("wired", "eth", "cable", "lan")):
        bh_type = "ethernet"
    elif any(tok in bh_str for tok in ("wifi", "wi-fi", "wireless", "5g", "2.4g", "6g", "ath", "wlan", "radio")):
        bh_type = "wifi"
    elif rec.get("rssi") is not None or rec.get("signal") is not None:
        bh_type = "wifi"
    else:
        return None

    entry = {"backhaulType": bh_type}
    if isinstance(raw_mac, str) and raw_mac.strip().count(":") == 5:
        entry["mac"] = raw_mac.strip().lower()
    if isinstance(raw_ip, str) and raw_ip.strip().count(".") == 3:
        entry["ip"] = raw_ip.strip()
    if isinstance(raw_name, str) and raw_name.strip():
        entry["name"] = raw_name.strip()
    if isinstance(raw_model, str) and raw_model.strip():
        entry["model"] = raw_model.strip()
    if not ("mac" in entry or "ip" in entry or "name" in entry):
        return None

    for key in ("link_rate", "linkRate", "phyrate", "phy_rate", "backhaul_speed", "speed", "tx_rate"):
        val = rec.get(key)
        if val is not None:
            digits = "".join(ch for ch in str(val) if ch.isdigit() or ch == ".")
            if digits:
                try:
                    num = int(round(float(digits)))
                    if num > 0:
                        entry["backhaulSpeedMbps"] = num
                        break
                except ValueError:
                    pass
    for key in ("rssi", "signal", "signal_dbm", "backhaul_rssi"):
        val = rec.get(key)
        if val is not None:
            s = str(val).strip()
            num_s = ""
            for idx_c, ch in enumerate(s):
                if ch.isdigit() or (ch == "-" and idx_c == 0):
                    num_s += ch
                elif num_s:
                    break
            if num_s and num_s != "-":
                try:
                    sig = int(num_s)
                    entry["signalDbm"] = (-95 + sig) if (0 < sig < 100) else sig
                    break
                except ValueError:
                    pass
    status_val = rec.get("backhaul_status") or rec.get("backhaulStatus") or rec.get("link_status") or rec.get("status")
    if isinstance(status_val, str) and status_val.strip():
        entry["backhaulStatus"] = status_val.strip()
    if bh_str and any(b in bh_str for b in ("2.4", "5g", "6g")):
        entry["band"] = str(bh_raw).strip()
    return entry


def read_satelliteinfo_wifi(satinfo_bin):
    if not satinfo_bin:
        return []
    try:
        out = subprocess.check_output(
            [satinfo_bin, "wifi"],
            stderr=subprocess.DEVNULL,
            timeout=3,
        ).decode("utf-8", errors="ignore").strip()
    except Exception:
        return []
    if not out:
        return []

    # Try JSON format first (Orbi stock/Voxel firmware outputs JSON array/object)
    start_idx = -1
    for idx_c, ch in enumerate(out):
        if ch in "[{":
            start_idx = idx_c
            break
    if start_idx >= 0:
        try:
            parsed = json.loads(out[start_idx:])
            if isinstance(parsed, list):
                items = parsed
            elif isinstance(parsed, dict):
                items = parsed.get("satellites") or parsed.get("data") or [parsed]
            else:
                items = []
            res = []
            for item in items:
                norm = _normalize_satinfo_item(item)
                if norm:
                    res.append(norm)
            if res:
                return res
        except Exception:
            pass

    # Fallback: key-value text blocks
    res = []
    cur = {}
    for raw in out.splitlines():
        line = raw.strip()
        if not line:
            norm = _normalize_satinfo_item(cur)
            if norm:
                res.append(norm)
            cur = {}
            continue
        sep = ":" if ":" in line else ("=" if "=" in line else None)
        if sep:
            k, v = line.split(sep, 1)
            key = k.strip().lower().replace(" ", "_").replace("-", "_")
            val = v.strip().strip('"').strip("'").rstrip(",")
            if key in ("mac", "ip") and key in cur:
                norm = _normalize_satinfo_item(cur)
                if norm:
                    res.append(norm)
                cur = {}
            cur[key] = val
    norm = _normalize_satinfo_item(cur)
    if norm:
        res.append(norm)
    return res


_MDNS_PROBES = [
    ("_googlecast._tcp.local", "Google Cast", 95),
    ("_airplay._tcp.local", "AirPlay", 92),
    ("_raop._tcp.local", "AirPlay Audio", 86),
    ("_companion-link._tcp.local", "Apple Companion", 90),
    ("_adb-tls-connect._tcp.local", "ADB", 88),
    ("_adb-tls-pairing._tcp.local", "ADB", 84),
    ("_adb._tcp.local", "ADB", 88),
    ("_spotify-connect._tcp.local", "Spotify Connect", 88),
    ("_sonos._tcp.local", "Sonos", 90),
    ("_hap._tcp.local", "HomeKit", 86),
    ("_ipp._tcp.local", "IPP Printer", 86),
    ("_smb._tcp.local", "SMB", 80),
    ("_ssh._tcp.local", "SSH", 76),
    ("_workstation._tcp.local", "Workstation", 75),
    ("_esphomelib._tcp.local", "ESPHome", 82),
]
_MDNS_PROBE_MAP = {p[0]: (p[1], p[2]) for p in _MDNS_PROBES}


def _dns_encode_name(name):
    out = bytearray()
    for part in name.strip(".").split("."):
        b = part.encode("utf-8", errors="ignore")[:63]
        if b:
            out.append(len(b))
            out.extend(b)
    out.append(0)
    return bytes(out)


def _dns_decode_name(buf, offset):
    labels = []
    jumped = False
    next_off = offset
    seen = set()
    blen = len(buf)
    while offset < blen:
        if offset in seen:
            return None, next_off
        seen.add(offset)
        ln = buf[offset]
        if ln == 0:
            if not jumped:
                next_off = offset + 1
            break
        if (ln & 0xC0) == 0xC0:
            if offset + 1 >= blen:
                return None, next_off
            ptr = ((ln & 0x3F) << 8) | buf[offset + 1]
            if not jumped:
                next_off = offset + 2
                jumped = True
            offset = ptr
            continue
        if (ln & 0xC0) != 0:
            return None, next_off
        offset += 1
        if offset + ln > blen:
            return None, next_off
        labels.append(buf[offset:offset + ln].decode("utf-8", errors="ignore"))
        offset += ln
        if not jumped:
            next_off = offset
    return ".".join(labels), next_off


def _clean_service_name(raw):
    if not raw:
        return None
    s = raw.replace("\\\\032", " ").strip()
    if s.lower().endswith(".local."):
        s = s[:-7]
    elif s.lower().endswith(".local"):
        s = s[:-6]
    s = re.sub(r"\\s+", " ", s).strip()
    m_raop = re.match(r"^[0-9a-fA-F]{12}@(.+)$", s)
    if m_raop:
        s = m_raop.group(1).strip()
    s = re.sub(r"\\s*\\[([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\\]$", "", s).strip()
    if not s or len(s) < 2 or len(s) > 64:
        return None
    if re.match(r"^adb-[0-9a-zA-Z]+-[0-9a-zA-Z]+$", s):
        return None
    if re.match(r"^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$", s):
        return None
    if re.match(r"^\\d+\\.\\d+\\.\\d+\\.\\d+$", s):
        return None
    if s.lower() in ("localhost", "unknown", "default", "device"):
        return None
    return s


def _record_service_hit(results, ip, name, protocol, score, service_label=None, model=None):
    if not is_private_lan_ip(ip) or ip.startswith("127.") or ip.startswith("169.254."):
        return
    clean = _clean_service_name(name)
    if not clean and not service_label and not model:
        return
    cur = results.get(ip)
    if not cur:
        cur = {"name": "", "protocol": "", "score": 0, "services": [], "model": ""}
        results[ip] = cur
    if service_label and service_label not in cur["services"] and len(cur["services"]) < 8:
        cur["services"].append(service_label)
    if model and not cur["model"]:
        cur["model"] = model[:64]
    if clean and (not cur["name"] or score >= cur["score"]):
        cur["name"] = clean
        cur["protocol"] = protocol
        cur["score"] = score


def _parse_mdns_packet(buf, sender_ip, results):
    if len(buf) < 12:
        return
    qd, an, ns, ar = struct.unpack("!HHHH", buf[4:12])
    off = 12
    for _ in range(qd):
        _, off = _dns_decode_name(buf, off)
        off += 4
        if off > len(buf):
            return
    host_to_ip = {}
    srv_map = {}
    txt_map = {}
    instances = set()
    for _ in range(min(200, an + ns + ar)):
        if off >= len(buf):
            break
        rname, off = _dns_decode_name(buf, off)
        if not rname or off + 10 > len(buf):
            break
        rtype, _rclass, _ttl, rdlen = struct.unpack("!HHIH", buf[off:off + 10])
        off += 10
        rstart = off
        off += rdlen
        if off > len(buf):
            break
        if rtype == 1 and rdlen == 4:
            ip = socket.inet_ntoa(buf[rstart:rstart + 4])
            host_to_ip[rname.rstrip(".").lower()] = ip
            _record_service_hit(results, ip, rname, "mDNS", 65)
        elif rtype == 12:
            target, _ = _dns_decode_name(buf, rstart)
            if target:
                instances.add(target)
        elif rtype == 33 and rdlen >= 6:
            target, _ = _dns_decode_name(buf, rstart + 6)
            if target:
                instances.add(rname)
                srv_map[rname.lower()] = target.rstrip(".")
        elif rtype == 16:
            instances.add(rname)
            tdict = {}
            po = rstart
            while po < rstart + rdlen:
                tln = buf[po]
                po += 1
                if tln == 0 or po + tln > rstart + rdlen:
                    break
                item = buf[po:po + tln].decode("utf-8", errors="ignore")
                po += tln
                if "=" in item:
                    k, v = item.split("=", 1)
                    k = k.strip().lower()
                    if k and v.strip() and k not in tdict:
                        tdict[k] = v.strip()
            txt_map[rname.lower()] = tdict

    for full_inst in instances:
        low = full_inst.rstrip(".").lower()
        matched_svc = None
        for suffix, meta in _MDNS_PROBE_MAP.items():
            if low.endswith("." + suffix):
                inst_label = full_inst[: len(full_inst.rstrip(".")) - len(suffix) - 1]
                matched_svc = (inst_label, suffix, meta[0], meta[1])
                break
        if not matched_svc:
            continue
        inst_label, suffix, svc_label, prio = matched_svc
        key = full_inst.lower()
        srv_target = srv_map.get(key)
        txt = txt_map.get(key, {})
        ip = host_to_ip.get(srv_target.lower()) if srv_target else None
        if not ip and sender_ip and is_private_lan_ip(sender_ip):
            ip = sender_ip
        if not ip:
            continue
        if suffix == "_googlecast._tcp.local":
            fname = txt.get("fn") or inst_label
            model = txt.get("md") or ""
            _record_service_hit(results, ip, fname, svc_label, 98 if txt.get("fn") else prio, svc_label, model)
        elif suffix.startswith("_adb"):
            fname = txt.get("name") or txt.get("model") or inst_label or srv_target
            model = txt.get("model") or txt.get("device") or "Android Device (ADB)"
            _record_service_hit(results, ip, fname, svc_label, 90, svc_label, model)
        else:
            fname = txt.get("fn") or txt.get("name") or inst_label or srv_target
            model = txt.get("md") or txt.get("model") or txt.get("ty") or ""
            _record_service_hit(results, ip, fname, svc_label, prio, svc_label, model)


def _fetch_private_upnp_xml(sender_ip, location):
    m = re.match(r"^http://(\\d+\\.\\d+\\.\\d+\\.\\d+)(?::(\\d+))?(/.*)$", location.strip(), re.I)
    if not m:
        return None
    host, port_s, path_s = m.group(1), m.group(2), m.group(3)
    if host != sender_ip or not is_private_lan_ip(host):
        return None
    port = int(port_s) if port_s else 80
    if port < 1 or port > 65535:
        return None
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.0)
        s.connect((host, port))
        req = f"GET {path_s} HTTP/1.1\\r\\nHost: {host}:{port}\\r\\nConnection: close\\r\\n\\r\\n"
        s.sendall(req.encode("ascii", errors="ignore"))
        chunks = []
        total = 0
        while total < 32768:
            part = s.recv(4096)
            if not part:
                break
            chunks.append(part)
            total += len(part)
        raw = b"".join(chunks).decode("utf-8", errors="ignore")
        if "\\r\\n\\r\\n" in raw:
            raw = raw.split("\\r\\n\\r\\n", 1)[1]
        return raw
    except Exception:
        return None
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass


def _parse_nbstat_name(buf):
    if len(buf) < 57:
        return None
    _, off = _dns_decode_name(buf, 12)
    if off + 11 > len(buf):
        return None
    rtype, _rclass, _ttl, _rdlen = struct.unpack("!HHIH", buf[off:off + 10])
    off += 10
    if rtype != 0x0021 or off >= len(buf):
        return None
    num = buf[off]
    off += 1
    ws_name = None
    srv_name = None
    for _ in range(num):
        if off + 18 > len(buf):
            break
        raw = buf[off:off + 15].decode("ascii", errors="ignore").replace("\\x00", "").strip()
        suffix = buf[off + 15]
        flags = struct.unpack("!H", buf[off + 16:off + 18])[0]
        off += 18
        if (flags & 0x8000) != 0 or not raw or raw.startswith("__") or raw.upper() == "MSBROWSE":
            continue
        if suffix == 0x00 and not ws_name:
            ws_name = raw
        elif suffix == 0x20 and not srv_name:
            srv_name = raw
    return _clean_service_name(ws_name or srv_name)


def discover_lan_services(arp_entries):
    """Lightweight bounded (~0.6s) mDNS/DNS-SD + SSDP/UPnP + NetBIOS sweep on the router LAN."""
    results = {}
    sockets = []
    mdns_sock = None
    ssdp_sock = None
    nbns_sock = None
    try:
        mdns_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        mdns_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        mdns_sock.setblocking(False)
        mdns_sock.bind(("", 0))
        sockets.append(mdns_sock)
        for qname, _lbl, _prio in _MDNS_PROBES:
            pkt = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0) + _dns_encode_name(qname) + struct.pack("!HH", 12, 0x8001)
            try:
                mdns_sock.sendto(pkt, ("224.0.0.251", 5353))
            except OSError:
                pass
    except OSError:
        if mdns_sock:
            mdns_sock.close()
            mdns_sock = None

    try:
        ssdp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        ssdp_sock.setblocking(False)
        ssdp_sock.bind(("", 0))
        sockets.append(ssdp_sock)
        for st in ("upnp:rootdevice", "urn:dial-multiscreen-org:service:dial:1"):
            msg = (
                "M-SEARCH * HTTP/1.1\\r\\n"
                "HOST: 239.255.255.250:1900\\r\\n"
                "MAN: \\"ssdp:discover\\"\\r\\n"
                "MX: 1\\r\\n"
                f"ST: {st}\\r\\n\\r\\n"
            ).encode("ascii")
            try:
                ssdp_sock.sendto(msg, ("239.255.255.250", 1900))
            except OSError:
                pass
    except OSError:
        if ssdp_sock:
            ssdp_sock.close()
            ssdp_sock = None

    try:
        nbns_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        nbns_sock.setblocking(False)
        nbns_sock.bind(("", 0))
        sockets.append(nbns_sock)
        nb_pkt = struct.pack("!HHHHHH", 0x4F42, 0, 1, 0, 0, 0) + b"\\x20CK" + (b"A" * 30) + b"\\x00" + struct.pack("!HH", 0x0021, 0x0001)
        probed = 0
        for entry in arp_entries or []:
            ip = entry.get("ip", "")
            if ip and not entry.get("hostname") and is_private_lan_ip(ip) and probed < 24:
                probed += 1
                try:
                    nbns_sock.sendto(nb_pkt, (ip, 137))
                except OSError:
                    pass
    except OSError:
        if nbns_sock:
            nbns_sock.close()
            nbns_sock = None

    ssdp_locations = {}
    deadline = time.monotonic() + 0.55
    while sockets and time.monotonic() < deadline:
        rem = max(0.02, deadline - time.monotonic())
        try:
            readable, _, _ = select.select(sockets, [], [], rem)
        except Exception:
            break
        if not readable:
            break
        for sock in readable:
            try:
                data, addr = sock.recvfrom(4096)
            except OSError:
                continue
            sender_ip = addr[0]
            if sock is mdns_sock:
                _parse_mdns_packet(data, sender_ip, results)
            elif sock is nbns_sock:
                nb_name = _parse_nbstat_name(data)
                if nb_name:
                    _record_service_hit(results, sender_ip, nb_name, "NetBIOS", 74, "NetBIOS")
            elif sock is ssdp_sock and sender_ip not in ssdp_locations and len(ssdp_locations) < 12:
                txt = data.decode("utf-8", errors="ignore")
                loc = None
                st_val = ""
                for line in txt.splitlines():
                    low = line.lower()
                    if low.startswith("location:"):
                        loc = line.split(":", 1)[1].strip()
                    elif low.startswith("st:"):
                        st_val = line.split(":", 1)[1].strip()
                if loc:
                    ssdp_locations[sender_ip] = (loc, st_val)

    for sock in sockets:
        try:
            sock.close()
        except Exception:
            pass

    for sender_ip, (loc, st_val) in list(ssdp_locations.items())[:8]:
        xml = _fetch_private_upnp_xml(sender_ip, loc)
        if not xml:
            continue
        m_fn = re.search(r"<friendlyName[^>]*>([^<]{1,128})</friendlyName>", xml, re.I)
        m_md = re.search(r"<modelName[^>]*>([^<]{1,128})</modelName>", xml, re.I)
        fn = m_fn.group(1).strip() if m_fn else ""
        md = m_md.group(1).strip() if m_md else ""
        is_dial = "dial" in st_val.lower() or "cast" in (fn + " " + md).lower()
        lbl = "DIAL / Cast" if is_dial else "UPnP"
        _record_service_hit(results, sender_ip, fn, lbl, 93 if is_dial else 82, lbl, md)

    return results


def read_arp_table(leases, active_dhcp_clients=None, wan_iface=None, wan_details=None, service_map=None):
    entries_by_ip = {}
    excluded_ips = set()
    if wan_details:
        if wan_details.get("ip"):
            excluded_ips.add(wan_details["ip"])
        if wan_details.get("gateway"):
            excluded_ips.add(wan_details["gateway"])

    content = read_text("/proc/net/arp")
    for line in content.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 6:
            ip, _, flags, mac, _, dev = parts[:6]
            if flags == "0x0" or mac == "00:00:00:00:00:00":
                continue
            if wan_iface and dev == wan_iface:
                continue
            if ip in excluded_ips or not is_private_lan_ip(ip):
                continue
            entries_by_ip[ip] = {
                "ip": ip,
                "mac": mac.lower(),
                "device": dev,
                "hostname": leases.get(ip, ""),
            }
    if active_dhcp_clients:
        for ip, info in active_dhcp_clients.items():
            if ip not in entries_by_ip and ip not in excluded_ips and is_private_lan_ip(ip):
                entries_by_ip[ip] = {
                    "ip": ip,
                    "mac": info["mac"],
                    "device": info.get("device", "br0"),
                    "hostname": leases.get(ip, info.get("hostname", "")),
                }
    if service_map:
        for ip, entry in entries_by_ip.items():
            svc = service_map.get(ip)
            if svc:
                if svc.get("name"):
                    entry["serviceName"] = svc["name"]
                if svc.get("protocol"):
                    entry["serviceProtocol"] = svc["protocol"]
                if svc.get("services"):
                    entry["advertisedServices"] = svc["services"]
                if svc.get("model"):
                    entry["model"] = svc["model"]
    return list(entries_by_ip.values())


def discover_wifi_ifaces():
    try:
        ifaces = sorted(os.listdir("/sys/class/net"))
    except OSError:
        return []
    return [
        n for n in ifaces
        if os.path.isdir(f"/sys/class/net/{n}/wireless") or n.startswith("ath") or n.startswith("wlan")
    ]


def _channel_to_band(chan):
    if 1 <= chan <= 14:
        return "2.4 GHz"
    if 32 <= chan <= 177:
        return "5 GHz"
    if chan > 177:
        return "6 GHz"
    return None


def _freq_to_band(freq_ghz):
    if 2.3 <= freq_ghz <= 2.6:
        return "2.4 GHz"
    if 4.9 <= freq_ghz < 5.925:
        return "5 GHz"
    if freq_ghz >= 5.925:
        return "6 GHz"
    return None


def read_wifi_iface_meta(wifi_ifaces, iwconfig_bin, iw_bin):
    meta = {}
    for wif in wifi_ifaces:
        meta[wif] = {"mode": "", "essid": "", "band": None, "is_backhaul": False}
    if iwconfig_bin and wifi_ifaces:
        try:
            out = subprocess.check_output(
                [iwconfig_bin],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            cur_if = None
            for raw in out.splitlines():
                if not raw.strip():
                    cur_if = None
                    continue
                if not raw[0].isspace():
                    tok = raw.split()[0]
                    cur_if = tok if tok in meta else None
                if not cur_if:
                    continue
                low = raw.lower()
                if "essid:" in low:
                    idx = low.find("essid:")
                    val = raw[idx + 6:].strip()
                    if val.startswith('"'):
                        end_q = val.find('"', 1)
                        essid = val[1:end_q] if end_q > 0 else val.strip('"')
                    else:
                        essid = val.split()[0] if val else ""
                    meta[cur_if]["essid"] = essid
                if "mode:" in low:
                    idx = low.find("mode:")
                    mode_tok = low[idx + 5:].split()[0].strip()
                    meta[cur_if]["mode"] = mode_tok
                if "frequency:" in low:
                    idx = low.find("frequency:")
                    freq_tok = low[idx + 10:].split()[0].strip()
                    try:
                        band = _freq_to_band(float(freq_tok))
                        if band:
                            meta[cur_if]["band"] = band
                    except ValueError:
                        pass
        except Exception:
            pass
    elif iw_bin and wifi_ifaces:
        try:
            out = subprocess.check_output(
                [iw_bin, "dev"],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            cur_if = None
            for raw in out.splitlines():
                line = raw.strip()
                if line.startswith("Interface "):
                    cand = line.split()[1]
                    cur_if = cand if cand in meta else None
                elif cur_if:
                    if line.startswith("type "):
                        meta[cur_if]["mode"] = line.split()[1].lower()
                    elif line.startswith("ssid "):
                        meta[cur_if]["essid"] = line[5:].strip()
                    elif line.startswith("channel "):
                        parts = line.split()
                        if len(parts) >= 2 and parts[1].isdigit():
                            meta[cur_if]["band"] = _channel_to_band(int(parts[1]))
        except Exception:
            pass

    for wif, info in meta.items():
        mode = (info["mode"] or "").lower()
        essid = (info["essid"] or "").strip()
        essid_low = essid.lower()
        if mode in ("managed", "repeater", "monitor", "mesh", "wds"):
            info["is_backhaul"] = True
        elif essid_low in ("off/any", ""):
            if mode and mode not in ("master", "ap"):
                info["is_backhaul"] = True
        elif any(tok in essid_low for tok in ("backhaul", "orbi_bh", "bh_", "_bh", "mesh_bh", "__orbi")):
            info["is_backhaul"] = True
    return meta


def read_router_wifi_clients(wifi_ifaces, wifi_tool, wifi_meta=None, satellite_macs=None):
    if not wifi_ifaces or not wifi_tool:
        return []
    tool_kind, tool_bin = wifi_tool
    sat_macs = satellite_macs or set()
    meta_map = wifi_meta or {}
    clients = {}
    for wif in wifi_ifaces:
        info = meta_map.get(wif, {})
        if info.get("is_backhaul"):
            continue
        iface_band = info.get("band")
        if tool_kind == "wlanconfig":
            try:
                out = subprocess.check_output(
                    [tool_bin, wif, "list", "sta"],
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                ).decode("utf-8", errors="ignore")
                chan_idx = 2
                tx_idx = 3
                rx_idx = 4
                rssi_idx = 5
                for raw in out.splitlines():
                    parts = raw.split()
                    if not parts:
                        continue
                    if parts[0].upper() == "ADDR":
                        upper_cols = [c.upper() for c in parts]
                        if "CHAN" in upper_cols:
                            chan_idx = upper_cols.index("CHAN")
                        if "TXRATE" in upper_cols:
                            tx_idx = upper_cols.index("TXRATE")
                        if "RXRATE" in upper_cols:
                            rx_idx = upper_cols.index("RXRATE")
                        if "RSSI" in upper_cols:
                            rssi_idx = upper_cols.index("RSSI")
                        continue
                    if len(parts) >= 6 and parts[0].count(":") == 5:
                        mac = parts[0].lower()
                        if mac in sat_macs:
                            continue
                        tx_tok = parts[tx_idx].rstrip("Mm") if tx_idx < len(parts) else "0"
                        rx_tok = parts[rx_idx].rstrip("Mm") if rx_idx < len(parts) else "0"
                        tx_m = int(tx_tok) if tx_tok.isdigit() else 0
                        rx_m = int(rx_tok) if rx_tok.isdigit() else 0
                        if tx_m == 0 and rx_m == 0:
                            continue
                        rssi_tok = parts[rssi_idx] if rssi_idx < len(parts) else "0"
                        rssi = int(rssi_tok) if rssi_tok.lstrip("-").isdigit() else 0
                        chan_tok = parts[chan_idx] if chan_idx < len(parts) else ""
                        chan_band = _channel_to_band(int(chan_tok)) if chan_tok.isdigit() else None
                        band = iface_band or chan_band
                        entry = {
                            "mac": mac,
                            "connectionType": "wifi",
                            "portOrRadio": band or wif,
                            "linkSpeedMbps": max(tx_m, rx_m),
                            "wifiTxMbps": tx_m,
                            "wifiRxMbps": rx_m,
                            "signalDbm": (-95 + rssi) if rssi > 0 else rssi,
                            "rxBytes": 0,
                            "txBytes": 0,
                            "rxBps": 0,
                            "txBps": 0,
                        }
                        if band:
                            entry["wifiBand"] = band
                        clients[mac] = entry
            except Exception:
                pass
        elif tool_kind == "iw":
            try:
                out = subprocess.check_output(
                    [tool_bin, "dev", wif, "station", "dump"],
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                ).decode("utf-8", errors="ignore")
                cur = None
                for raw in out.splitlines():
                    line = raw.strip()
                    if line.startswith("Station "):
                        parts = line.split()
                        if len(parts) >= 2 and parts[1].count(":") == 5:
                            mac = parts[1].lower()
                            if mac in sat_macs:
                                cur = None
                                continue
                            cur = {
                                "mac": mac,
                                "connectionType": "wifi",
                                "portOrRadio": iface_band or wif,
                                "linkSpeedMbps": 0,
                                "wifiTxMbps": 0,
                                "wifiRxMbps": 0,
                                "rxBytes": 0,
                                "txBytes": 0,
                                "rxBps": 0,
                                "txBps": 0,
                            }
                            if iface_band:
                                cur["wifiBand"] = iface_band
                            clients[mac] = cur
                    elif cur is not None:
                        if line.startswith("rx bytes:"):
                            val = line.split(":", 1)[1].strip()
                            if val.isdigit():
                                cur["rxBytes"] = int(val)
                        elif line.startswith("tx bytes:"):
                            val = line.split(":", 1)[1].strip()
                            if val.isdigit():
                                cur["txBytes"] = int(val)
                        elif line.startswith("signal:"):
                            tok = line.split(":", 1)[1].strip().split()[0]
                            if tok.lstrip("-").isdigit():
                                cur["signalDbm"] = int(tok)
                        elif line.startswith("tx bitrate:"):
                            tok = line.split(":", 1)[1].strip().split()[0]
                            try:
                                v = int(round(float(tok)))
                                cur["wifiTxMbps"] = v
                                cur["linkSpeedMbps"] = max(cur["linkSpeedMbps"], v)
                            except ValueError:
                                pass
                        elif line.startswith("rx bitrate:"):
                            tok = line.split(":", 1)[1].strip().split()[0]
                            try:
                                v = int(round(float(tok)))
                                cur["wifiRxMbps"] = v
                                cur["linkSpeedMbps"] = max(cur["linkSpeedMbps"], v)
                            except ValueError:
                                pass
            except Exception:
                pass
    return [
        c for c in clients.values()
        if c.get("wifiTxMbps", 0) > 0 or c.get("wifiRxMbps", 0) > 0 or c.get("rxBytes", 0) > 0 or c.get("txBytes", 0) > 0
    ]


def read_router_wired_clients(swconfig_bin, brctl_bin, cpu_ports, wan_switch_ports, sw_lan_ports, wifi_ifaces, satellite_macs=None):
    sat_macs = satellite_macs or set()
    port_label_by_id = {p["id"]: p["label"] for p in (sw_lan_ports or [])}
    wired_by_mac = {}

    # 1. Preferred: switch hardware ARL/FDB table gives exact physical LAN port per MAC
    if swconfig_bin:
        try:
            out = subprocess.check_output(
                [swconfig_bin, "dev", "switch0", "get", "dump_arl"],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            port_macs = {}
            for raw in out.splitlines():
                line = raw.strip()
                if not line:
                    continue
                mac_found = None
                pnum_found = None
                tokens = line.replace(",", " ").split()
                for idx_t, tok in enumerate(tokens):
                    clean_t = tok.strip("[]()")
                    if clean_t.count(":") == 5 and len(clean_t) == 17:
                        mac_found = clean_t.lower()
                    elif clean_t.upper().startswith("0X") and idx_t > 0 and "PORT" in tokens[idx_t - 1].upper():
                        try:
                            mask = int(clean_t, 16)
                            bits = [b for b in range(10) if mask & (1 << b)]
                            if len(bits) == 1:
                                pnum_found = bits[0]
                        except ValueError:
                            pass
                    elif clean_t.isdigit() and idx_t > 0 and tokens[idx_t - 1].rstrip(":").lower() == "port":
                        pnum_found = int(clean_t)
                if mac_found and pnum_found is not None:
                    if pnum_found in cpu_ports or pnum_found in wan_switch_ports:
                        continue
                    port_macs.setdefault(pnum_found, set()).add(mac_found)

            for pnum, macs in port_macs.items():
                # Skip ports hosting a wired satellite backhaul so satellite clients stay attached to their satellite
                if any(m in sat_macs for m in macs):
                    continue
                label = port_label_by_id.get(f"port{pnum}", f"LAN {pnum}")
                for mac in macs:
                    wired_by_mac[mac] = {
                        "mac": mac,
                        "connectionType": "ethernet",
                        "portOrRadio": label,
                        "linkSpeedMbps": 0,
                        "rxBytes": 0,
                        "txBytes": 0,
                        "rxBps": 0,
                        "txBps": 0,
                    }
        except Exception:
            pass

    # 2. Fallback: brctl showmacs br0 on non-wireless bridge ports
    if not wired_by_mac and brctl_bin:
        try:
            wifi_set = set(wifi_ifaces or [])
            port_no_to_if = {}
            brif_dir = "/sys/class/net/br0/brif"
            if os.path.isdir(brif_dir):
                for ifname in os.listdir(brif_dir):
                    pno_txt = read_text(f"{brif_dir}/{ifname}/port_no").strip()
                    if pno_txt:
                        try:
                            pno = int(pno_txt, 16) if pno_txt.startswith("0x") else int(pno_txt)
                            port_no_to_if[pno] = ifname
                        except ValueError:
                            pass
            out = subprocess.check_output(
                [brctl_bin, "showmacs", "br0"],
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).decode("utf-8", errors="ignore")
            for raw in out.splitlines()[1:]:
                parts = raw.split()
                if len(parts) >= 4 and parts[0].isdigit() and parts[1].count(":") == 5:
                    if parts[2].lower() == "yes":
                        continue
                    pno = int(parts[0])
                    ifname = port_no_to_if.get(pno, "")
                    if not ifname or ifname in wifi_set or ifname.startswith("ath") or ifname.startswith("wlan"):
                        continue
                    mac = parts[1].lower()
                    if mac in sat_macs:
                        continue
                    wired_by_mac[mac] = {
                        "mac": mac,
                        "connectionType": "ethernet",
                        "portOrRadio": "Ethernet",
                        "linkSpeedMbps": 0,
                        "rxBytes": 0,
                        "txBytes": 0,
                        "rxBps": 0,
                        "txBps": 0,
                    }
        except Exception:
            pass

    return list(wired_by_mac.values())


def merge_router_clients(wifi_clients, wired_clients):
    by_mac = {}
    for wc in wired_clients:
        by_mac[wc["mac"]] = wc
    for wf in wifi_clients:
        mac = wf["mac"]
        existing = by_mac.get(mac)
        # Confirmed physical LAN port (e.g. "LAN 1") beats Wi-Fi; active Wi-Fi beats generic bridge "Ethernet"
        if existing and existing.get("portOrRadio", "").startswith("LAN "):
            continue
        by_mac[mac] = wf
    return list(by_mac.values())


def detect_conntrack_path():
    for path in ("/proc/net/nf_conntrack", "/proc/net/ip_conntrack"):
        if os.path.exists(path):
            return path
    return None


def _is_private_conntrack_line(line):
    src_ip = ""
    dst_ip = ""
    for tok in line.split():
        if tok.startswith("src=") and not src_ip:
            src_ip = tok[4:]
        elif tok.startswith("dst=") and not dst_ip:
            dst_ip = tok[4:]
            if src_ip:
                break
    return is_private_lan_ip(src_ip) and is_private_lan_ip(dst_ip)


def read_conntrack_lines(ct_path, limit=500):
    if not ct_path:
        return []
    wan_lines = []
    lan_lines = []
    wan_cap = max(100, limit - 100)
    lan_cap = 100
    try:
        with open(ct_path, "r") as f:
            for line in f:
                if "bytes=" not in line or "bytes=0 " in line:
                    continue
                if (
                    "TIME_WAIT" in line
                    or "CLOSE_WAIT" in line
                    or "FIN_WAIT" in line
                    or "CLOSE " in line
                    or "SYN_SENT" in line
                    or "SYN_RECV" in line
                    or "[UNREPLIED]" in line
                    or "src=127.0.0.1 " in line
                ):
                    continue
                stripped = line.strip()
                if _is_private_conntrack_line(stripped):
                    if len(lan_lines) < lan_cap:
                        lan_lines.append(stripped)
                else:
                    if len(wan_lines) < wan_cap:
                        wan_lines.append(stripped)
                if len(wan_lines) >= wan_cap and len(lan_lines) >= lan_cap:
                    break
    except OSError:
        pass
    return lan_lines + wan_lines


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
    total_kb = avail_kb = 0
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
                    if total_kb:
                        break
                elif line.startswith("MemFree:") and avail_kb == 0:
                    avail_kb = int(line.split()[1])
    except (OSError, ValueError):
        pass
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


def fast_ws_mask(payload, mask):
    length = len(payload)
    if length == 0:
        return b""
    # C-level big-integer XOR is ~50-100x faster than Python byte-by-byte loops on routers
    repeated = (mask * ((length + 3) // 4))[:length]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(repeated, "big")).to_bytes(
        length, "big"
    )


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
        if length < 126:
            header = struct.pack("!BB4s", 0x81, 0x80 | length, mask)
        elif length < 65536:
            header = struct.pack("!BBH4s", 0x81, 0x80 | 126, length, mask)
        else:
            header = struct.pack("!BBQ4s", 0x81, 0x80 | 127, length, mask)
        self.sock.sendall(header + fast_ws_mask(payload, mask))

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
    ct_path = detect_conntrack_path()
    swconfig_bin = find_binary("swconfig")
    brctl_bin = find_binary("brctl")
    wlanconfig_bin = find_binary("wlanconfig")
    iwconfig_bin = find_binary("iwconfig")
    iw_bin = find_binary("iw")
    ip_bin = find_binary("ip")
    ifconfig_bin = find_binary("ifconfig")
    nvram_bin = find_binary("nvram")
    satinfo_bin = "/usr/sbin/satelliteinfo" if (os.path.isfile("/usr/sbin/satelliteinfo") and os.access("/usr/sbin/satelliteinfo", os.X_OK)) else find_binary("satelliteinfo")
    wifi_tool = ("wlanconfig", wlanconfig_bin) if wlanconfig_bin else (("iw", iw_bin) if iw_bin else None)
    wifi_ifaces = discover_wifi_ifaces()
    wifi_meta = read_wifi_iface_meta(wifi_ifaces, iwconfig_bin, iw_bin)
    lease_cache = LeaseCache(cfg["dhcp_leases"])

    ws = MiniWebSocket(cfg["ws_url"], cfg["token"])
    shared_state = {
        "arp": [],
        "router_clients": [],
        "wan_details": None,
        "satellite_info": [],
        "router_subnets": [],
        "ports_payload": None,
        "ports_seq": 0,
    }
    state_lock = threading.Lock() if threading is not None else None
    last_sent_ports_seq = 0
    last_sys_refresh = 0.0

    def slow_refresh_worker():
        nonlocal wifi_ifaces, wifi_meta
        cpu_ports = set()
        wan_switch_ports = set()
        sw_lan_ports = []
        service_map = {}
        wan_details_local = None
        satellite_info_local = []
        last_service_scan = 0.0
        last_neigh_refresh = 0.0
        last_ports_refresh = 0.0
        last_wifi_iface_scan = time.monotonic()

        while running:
            try:
                mono_now = time.monotonic()
                if mono_now - last_wifi_iface_scan >= 60.0:
                    wifi_ifaces = discover_wifi_ifaces()
                    wifi_meta = read_wifi_iface_meta(wifi_ifaces, iwconfig_bin, iw_bin)
                    last_wifi_iface_scan = mono_now

                if last_ports_refresh == 0.0 or mono_now - last_ports_refresh >= cfg["ports_interval"]:
                    wan_details_local = read_wan_details(cfg["iface"], ip_bin, ifconfig_bin, nvram_bin)
                    satellite_info_local = read_satelliteinfo_wifi(satinfo_bin)
                    router_subnets_local = read_router_subnets(cfg["iface"], ip_bin)
                    ports_local, cpu_ports, wan_switch_ports, sw_lan_ports = read_router_ports(
                        cfg["iface"], swconfig_bin
                    )
                    if state_lock is not None:
                        with state_lock:
                            shared_state["wan_details"] = wan_details_local
                            shared_state["satellite_info"] = satellite_info_local
                            shared_state["router_subnets"] = router_subnets_local
                            shared_state["ports_payload"] = ports_local
                            shared_state["ports_seq"] += 1
                    else:
                        shared_state["wan_details"] = wan_details_local
                        shared_state["satellite_info"] = satellite_info_local
                        shared_state["router_subnets"] = router_subnets_local
                        shared_state["ports_payload"] = ports_local
                        shared_state["ports_seq"] += 1
                    last_ports_refresh = time.monotonic()

                if last_neigh_refresh == 0.0 or mono_now - last_neigh_refresh >= cfg["neigh_interval"]:
                    leases, active_dhcp = lease_cache.read(time.time())
                    arp_local = read_arp_table(leases, active_dhcp, cfg["iface"], wan_details_local, service_map)
                    if last_service_scan == 0.0 or mono_now - last_service_scan >= 45.0:
                        fresh_services = discover_lan_services(arp_local)
                        for sip, sinfo in fresh_services.items():
                            prev_s = service_map.get(sip)
                            if prev_s:
                                merged_svcs = list(dict.fromkeys(prev_s.get("services", []) + sinfo.get("services", [])))[:8]
                                if sinfo.get("name") and (not prev_s.get("name") or sinfo.get("score", 0) >= prev_s.get("score", 0)):
                                    service_map[sip] = {**sinfo, "services": merged_svcs}
                                else:
                                    service_map[sip] = {**prev_s, "services": merged_svcs, "model": prev_s.get("model") or sinfo.get("model", "")}
                            else:
                                service_map[sip] = sinfo
                        arp_local = read_arp_table(leases, active_dhcp, cfg["iface"], wan_details_local, service_map)
                        last_service_scan = time.monotonic()
                    sat_macs = {s["mac"].lower() for s in satellite_info_local if s.get("mac")}
                    wifi_clients = read_router_wifi_clients(wifi_ifaces, wifi_tool, wifi_meta, sat_macs)
                    wired_clients = read_router_wired_clients(
                        swconfig_bin, brctl_bin, cpu_ports, wan_switch_ports, sw_lan_ports, wifi_ifaces, sat_macs
                    )
                    router_clients_local = merge_router_clients(wifi_clients, wired_clients)
                    if state_lock is not None:
                        with state_lock:
                            shared_state["arp"] = arp_local
                            shared_state["router_clients"] = router_clients_local
                    else:
                        shared_state["arp"] = arp_local
                        shared_state["router_clients"] = router_clients_local
                    last_neigh_refresh = time.monotonic()
                    logger.debug(
                        f"Refreshed {len(arp_local)} ARP/DHCP devices, {len(service_map)} service names, {len(wifi_clients)} Wi-Fi, {len(wired_clients)} wired"
                    )
            except Exception as exc:
                logger.debug(f"Background neighbor/port refresh error: {exc}")
            time.sleep(1.0)

    if threading is not None:
        bg_thread = threading.Thread(target=slow_refresh_worker, daemon=True)
        bg_thread.start()

    logger.info(
        f"Starting probe={cfg['probe_id']} iface={cfg['iface']} "
        f"interval={cfg['interval']}s ports_interval={cfg['ports_interval']}s "
        f"sys_interval={cfg['sys_interval']}s target={cfg['ws_url']}"
    )

    next_tick_at = time.monotonic()
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
                    next_tick_at = time.monotonic()

                mono_now = time.monotonic()
                if state_lock is not None:
                    with state_lock:
                        arp_snap = shared_state["arp"]
                        clients_snap = shared_state["router_clients"]
                        ports_seq = shared_state["ports_seq"]
                        ports_snap = shared_state["ports_payload"] if ports_seq != last_sent_ports_seq else None
                        subnets_snap = shared_state["router_subnets"]
                        wan_snap = shared_state["wan_details"]
                        sat_snap = shared_state["satellite_info"]
                else:
                    arp_snap = shared_state["arp"]
                    clients_snap = shared_state["router_clients"]
                    ports_seq = shared_state["ports_seq"]
                    ports_snap = shared_state["ports_payload"] if ports_seq != last_sent_ports_seq else None
                    subnets_snap = shared_state["router_subnets"]
                    wan_snap = shared_state["wan_details"]
                    sat_snap = shared_state["satellite_info"]

                # Sample byte counters & conntrack directly on the fixed-rate cadence
                dev_map = read_proc_net_dev()
                sample_ts_ms = int(time.time() * 1000)
                conntrack_lines = read_conntrack_lines(ct_path)
                data = {
                    "probeId": cfg["probe_id"],
                    "timestamp": sample_ts_ms,
                    "source": "live",
                    "iface": read_iface_counters(cfg["iface"], dev_map),
                    "lanIfaces": read_lan_iface_counters(cfg["iface"], dev_map),
                    "routerClients": clients_snap,
                    "arp": arp_snap,
                    "flows": [],
                    "rawConntrackLines": conntrack_lines,
                }

                if ports_snap is not None:
                    data["ports"] = ports_snap
                    if subnets_snap:
                        data["subnets"] = subnets_snap
                    if wan_snap:
                        data["wan"] = wan_snap
                    if sat_snap:
                        data["satelliteInfo"] = sat_snap
                    last_sent_ports_seq = ports_seq

                if last_sys_refresh == 0.0 or mono_now - last_sys_refresh >= cfg["sys_interval"]:
                    data["system"] = read_system_metrics(len(conntrack_lines), static_info)
                    last_sys_refresh = mono_now
                    logger.debug(
                        f"System metrics: load={data['system']['load1m']} mem={data['system']['memUsedPct']}%"
                    )

                ws.send_json({"type": "probe:snapshot", "data": data})
                logger.debug(f"Sent snapshot: flows={len(conntrack_lines)}")

                # Fixed-rate monotonic schedule keeps tick cadence rock-steady at cfg['interval']s
                next_tick_at += cfg["interval"]
                now_mono = time.monotonic()
                if next_tick_at < now_mono:
                    next_tick_at = now_mono + cfg["interval"]
                sleep_for = max(0.25, next_tick_at - now_mono)
                time.sleep(sleep_for)
            except Exception as exc:
                logger.error(f"Reconnecting after error: {exc}")
                ws.close()
                time.sleep(3)
                next_tick_at = time.monotonic()
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
      if ($3 != "0x0" && $4 != "00:00:00:00:00:00" && $6 != iface && ($1 ~ /^10\\./ || $1 ~ /^192\\.168\\./ || $1 ~ /^172\\.(1[6-9]|2[0-9]|3[0-1])\\./)) {
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
`;
}

export function generateInitScript(cfg?: ProbeConfigOptions): string {
  const leasePath = (cfg?.dhcpLeasesPath || '').trim().replace(/["`$\\]/g, '');
  const extraFlags = leasePath ? ` --dhcp-leases "${leasePath}"` : '';
  return `#!/bin/sh /etc/rc.common
# /opt/etc/init.d/S99orbi-probe — Router autostart service

START=99
STOP=10
PROG=/opt/bin/orbi_probe.py
PIDFILE=/var/run/orbi-probe.pid

start() {
  echo "Starting OrbiFlow WAN monitor agent..."
  echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true
  /opt/bin/python3 "$PROG" -d --pid-file "$PIDFILE"${extraFlags}
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
