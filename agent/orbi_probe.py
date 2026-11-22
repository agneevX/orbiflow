#!/usr/bin/env python3
"""
OrbiFlow Lightweight Router Telemetry Probe
Requires only Python 3 core stdlib (works on Entware python3-light) — zero external packages.

Usage:
  orbi_probe.py [options]

Options:
  -d, --daemonize           Run silently in the background (no console log output unless --log-file is set)
  --pid-file PATH           Write daemon PID to PATH (removed on clean exit)
  --log-level LEVEL         Log verbosity: silent, error, info (default), debug
  -q, --quiet               Disable all log output (same as --log-level silent)
  -v, --verbose             Enable debug logging (same as --log-level debug)
  --log-file PATH           Append timestamped logs to PATH
  -i, --interval SEC        Fast traffic polling interval in seconds (default: 3)
  --sys-interval SEC        Router uptime/load/memory polling interval in seconds (default: 30)
  --ports-interval SEC      Switch/Ethernet port refresh interval in seconds (default: 30)
  --neigh-interval SEC      ARP/DHCP/Wi-Fi neighbor refresh interval in seconds (default: 15)
  --iface NAME              WAN interface name (default: eth0)
  --dhcp-leases PATH        Custom DHCP leases file path (auto-detect if omitted)
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
import subprocess
import sys
import time

WS_URL = os.environ.get("ORBIFLOW_WS_URL", "ws://192.168.1.10:3000/ws/ingest")
AUTH_TOKEN = os.environ.get("ORBIFLOW_PROBE_TOKEN", "")
WAN_IFACE = os.environ.get("ORBIFLOW_WAN_IFACE", "eth0")
PROBE_ID = os.environ.get("ORBIFLOW_PROBE_ID", "router-wan")
INTERVAL_SEC = float(os.environ.get("ORBIFLOW_INTERVAL", "3"))
SYS_INTERVAL_SEC = float(os.environ.get("ORBIFLOW_SYS_INTERVAL", "30"))
PORTS_INTERVAL_SEC = float(os.environ.get("ORBIFLOW_PORTS_INTERVAL", "30"))
NEIGH_INTERVAL_SEC = float(os.environ.get("ORBIFLOW_NEIGH_INTERVAL", "15"))
DHCP_LEASES_PATH = os.environ.get("ORBIFLOW_DHCP_LEASES", "")

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
                    f.write(line + "\n")
            except OSError:
                pass
        else:
            try:
                sys.stderr.write(line + "\n")
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
    sys.stdout.write(__doc__.strip() + "\n")


def parse_args(argv):
    cfg = {
        "ws_url": WS_URL,
        "token": AUTH_TOKEN,
        "iface": WAN_IFACE,
        "probe_id": PROBE_ID,
        "interval": INTERVAL_SEC,
        "sys_interval": SYS_INTERVAL_SEC,
        "ports_interval": PORTS_INTERVAL_SEC,
        "neigh_interval": NEIGH_INTERVAL_SEC,
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
                sys.stderr.write(f"Missing value for {flag}\n")
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
                sys.stderr.write(f"Invalid --log-level: {lvl} (use silent, error, info, debug)\n")
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
            sys.stderr.write(f"Unknown option: {arg} (use --help for usage)\n")
            sys.exit(2)
        i += 1

    # When daemonized with no explicit --log-file, default to silent (no log output)
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
                f.write(f"{os.getpid()}\n")
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
                f.write("1\n")
    except OSError:
        pass


def read_iface_counters(iface):
    # Single-open /proc/net/dev read avoids 4 sysfs opens on every fast tick
    prefix = f"{iface}:"
    try:
        with open("/proc/net/dev", "r") as f:
            for line in f:
                stripped = line.lstrip()
                if stripped.startswith(prefix):
                    fields = stripped[len(prefix):].split()
                    if len(fields) >= 11:
                        return {
                            "iface": iface,
                            "rxBytes": int(fields[0]),
                            "rxErrors": int(fields[2]),
                            "txBytes": int(fields[8]),
                            "txErrors": int(fields[10]),
                        }
                    break
    except (OSError, ValueError):
        pass
    base = f"/sys/class/net/{iface}/statistics"
    return {
        "iface": iface,
        "rxBytes": read_int(f"{base}/rx_bytes"),
        "txBytes": read_int(f"{base}/tx_bytes"),
        "rxErrors": read_int(f"{base}/rx_errors"),
        "txErrors": read_int(f"{base}/tx_errors"),
    }


def read_swconfig_ports(swconfig_bin):
    ports = []
    if not swconfig_bin:
        return ports
    try:
        out = subprocess.check_output(
            [swconfig_bin, "dev", "switch0", "show"],
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode("utf-8", errors="ignore")
    except Exception:
        return ports

    cur = None
    for raw in out.splitlines():
        line = raw.strip()
        if line.startswith("Port ") and line.endswith(":"):
            if cur is not None:
                ports.append(cur)
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

    # Filter out internal switch CPU port 0 when physical ports exist
    if len(ports) > 1:
        ports = [p for p in ports if p.get("_pnum", 1) != 0]
    for p in ports:
        p.pop("_pnum", None)
    return ports


def read_router_ports(wan_iface, swconfig_bin):
    ports = []
    seen = set()
    dev_bytes = {}
    try:
        with open("/proc/net/dev", "r") as f:
            for line in f:
                if ":" not in line:
                    continue
                name_part, rest = line.split(":", 1)
                fields = rest.split()
                if len(fields) >= 9:
                    dev_bytes[name_part.strip()] = (int(fields[0]), int(fields[8]))
    except (OSError, ValueError):
        pass

    try:
        names = sorted(os.listdir("/sys/class/net"))
    except OSError:
        names = [wan_iface]

    for name in names:
        if name == "lo":
            continue
        if name != wan_iface and not (
            name.startswith("eth") or name.startswith("en") or name.startswith("lan") or name.startswith("wan")
        ):
            continue
        base = f"/sys/class/net/{name}"
        if os.path.isdir(f"{base}/wireless"):
            continue
        oper = read_text(f"{base}/operstate").strip().lower()
        speed = read_int(f"{base}/speed")
        if speed < 0:
            speed = 0
        duplex = read_text(f"{base}/duplex").strip().lower()
        if duplex not in ("full", "half"):
            duplex = "unknown"
        rx_b, tx_b = dev_bytes.get(name, (0, 0))
        is_wan = name == wan_iface
        ports.append({
            "id": name,
            "label": f"WAN ({name})" if is_wan else name,
            "role": "wan" if is_wan else "lan",
            "linkUp": oper == "up" or speed > 0,
            "speedMbps": speed,
            "duplex": duplex,
            "rxBytes": rx_b,
            "txBytes": tx_b,
            "rxBps": 0,
            "txBps": 0,
        })
        seen.add(name)

    for sp in read_swconfig_ports(swconfig_bin):
        if sp["id"] not in seen:
            ports.append(sp)
            seen.add(sp["id"])
    return ports


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
    try:
        return socket.inet_ntoa(struct.pack("=I", val))
    except Exception:
        return ""


def read_wan_details(wan_iface, ip_bin, ifconfig_bin, nvram_bin):
    wan_ip = ""
    wan_gw = ""
    dns_servers = []

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

    for raw in read_text("/proc/net/route").splitlines()[1:]:
        parts = raw.split()
        if len(parts) >= 3 and parts[1] == "00000000":
            gw = _decode_proc_route_hex_ip(parts[2])
            if gw and gw != "0.0.0.0":
                wan_gw = gw
                if parts[0] == wan_iface:
                    break

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


def read_arp_table(leases, active_dhcp_clients=None, wan_iface=None, wan_details=None):
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


def read_router_wifi_clients(wifi_ifaces, wifi_tool):
    if not wifi_ifaces or not wifi_tool:
        return []
    tool_kind, tool_bin = wifi_tool
    clients = {}
    for wif in wifi_ifaces:
        if tool_kind == "wlanconfig":
            try:
                out = subprocess.check_output(
                    [tool_bin, wif, "list", "sta"],
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                ).decode("utf-8", errors="ignore")
                for raw in out.splitlines():
                    parts = raw.split()
                    if len(parts) >= 6 and parts[0].count(":") == 5:
                        mac = parts[0].lower()
                        tx_tok = parts[3].rstrip("Mm")
                        rx_tok = parts[4].rstrip("Mm")
                        tx_m = int(tx_tok) if tx_tok.isdigit() else 0
                        rx_m = int(rx_tok) if rx_tok.isdigit() else 0
                        rssi = int(parts[5]) if parts[5].lstrip("-").isdigit() else 0
                        clients[mac] = {
                            "mac": mac,
                            "connectionType": "wifi",
                            "portOrRadio": wif,
                            "linkSpeedMbps": max(tx_m, rx_m),
                            "wifiTxMbps": tx_m,
                            "wifiRxMbps": rx_m,
                            "signalDbm": (-95 + rssi) if rssi > 0 else rssi,
                            "rxBytes": 0,
                            "txBytes": 0,
                            "rxBps": 0,
                            "txBps": 0,
                        }
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
                            cur = {
                                "mac": mac,
                                "connectionType": "wifi",
                                "portOrRadio": wif,
                                "linkSpeedMbps": 0,
                                "wifiTxMbps": 0,
                                "wifiRxMbps": 0,
                                "rxBytes": 0,
                                "txBytes": 0,
                                "rxBps": 0,
                                "txBps": 0,
                            }
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
    return list(clients.values())


def detect_conntrack_path():
    for path in ("/proc/net/nf_conntrack", "/proc/net/ip_conntrack"):
        if os.path.exists(path):
            return path
    return None


def read_conntrack_lines(ct_path, limit=500):
    if not ct_path:
        return []
    lines = []
    append = lines.append
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
                append(line.strip())
                if len(lines) >= limit:
                    break
    except OSError:
        pass
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
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"X-Probe-Token: {self.token}\r\n\r\n"
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
                f.write(f"{os.getpid()}\n")
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
    wlanconfig_bin = find_binary("wlanconfig")
    iw_bin = find_binary("iw")
    ip_bin = find_binary("ip")
    ifconfig_bin = find_binary("ifconfig")
    nvram_bin = find_binary("nvram")
    satinfo_bin = "/usr/sbin/satelliteinfo" if (os.path.isfile("/usr/sbin/satelliteinfo") and os.access("/usr/sbin/satelliteinfo", os.X_OK)) else find_binary("satelliteinfo")
    wifi_tool = ("wlanconfig", wlanconfig_bin) if wlanconfig_bin else (("iw", iw_bin) if iw_bin else None)
    wifi_ifaces = discover_wifi_ifaces()
    lease_cache = LeaseCache(cfg["dhcp_leases"])

    ws = MiniWebSocket(cfg["ws_url"], cfg["token"])
    arp = []
    router_clients = []
    wan_details = None
    satellite_info = []
    last_neigh_refresh = 0.0
    last_ports_refresh = 0.0
    last_sys_refresh = 0.0
    last_wifi_iface_scan = time.time()

    logger.info(
        f"Starting probe={cfg['probe_id']} iface={cfg['iface']} "
        f"interval={cfg['interval']}s ports_interval={cfg['ports_interval']}s "
        f"sys_interval={cfg['sys_interval']}s target={cfg['ws_url']}"
    )

    try:
        while running:
            tick_start = time.monotonic()
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
                if now_ts - last_wifi_iface_scan >= 60.0:
                    wifi_ifaces = discover_wifi_ifaces()
                    last_wifi_iface_scan = now_ts

                if now_ts - last_ports_refresh >= cfg["ports_interval"]:
                    wan_details = read_wan_details(cfg["iface"], ip_bin, ifconfig_bin, nvram_bin)
                    satellite_info = read_satelliteinfo_wifi(satinfo_bin)

                if now_ts - last_neigh_refresh >= cfg["neigh_interval"]:
                    leases, active_dhcp = lease_cache.read(now_ts)
                    arp = read_arp_table(leases, active_dhcp, cfg["iface"], wan_details)
                    router_clients = read_router_wifi_clients(wifi_ifaces, wifi_tool)
                    last_neigh_refresh = now_ts
                    logger.debug(
                        f"Refreshed {len(arp)} ARP/DHCP devices, {len(router_clients)} Wi-Fi clients"
                    )

                conntrack_lines = read_conntrack_lines(ct_path)
                data = {
                    "probeId": cfg["probe_id"],
                    "timestamp": int(now_ts * 1000),
                    "source": "live",
                    "iface": read_iface_counters(cfg["iface"]),
                    "routerClients": router_clients,
                    "arp": arp,
                    "flows": [],
                    "rawConntrackLines": conntrack_lines,
                }

                if now_ts - last_ports_refresh >= cfg["ports_interval"]:
                    data["ports"] = read_router_ports(cfg["iface"], swconfig_bin)
                    if wan_details:
                        data["wan"] = wan_details
                    if satellite_info:
                        data["satelliteInfo"] = satellite_info
                    last_ports_refresh = now_ts

                if now_ts - last_sys_refresh >= cfg["sys_interval"]:
                    data["system"] = read_system_metrics(len(conntrack_lines), static_info)
                    last_sys_refresh = now_ts
                    logger.debug(
                        f"System metrics: load={data['system']['load1m']} mem={data['system']['memUsedPct']}%"
                    )

                ws.send_json({"type": "probe:snapshot", "data": data})
                logger.debug(f"Sent snapshot: flows={len(conntrack_lines)}")
                elapsed = time.monotonic() - tick_start
                sleep_for = cfg["interval"] - elapsed
                if sleep_for > 0.1:
                    time.sleep(sleep_for)
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
