# OrbiFlow

Lightweight, real-time internet traffic monitor and connection inspector built for **Netgear Orbi RBK50** routers running **Voxel firmware**. OrbiFlow streams live kernel connection tracking (`nf_conntrack`) and WAN interface counters from your router to a self-hosted Docker server with an interactive, multi-theme web dashboard.

![OrbiFlow Network Summary — Desktop Dark (Tokyo Night)](docs/screenshots/desktop-overview-dark.png)

## Features

- **Real-Time Bandwidth & Interactive Chart Inspection**: Live download and upload throughput graphs across `1m`, `5m`, `15m`, `1h`, `6h`, and `24h` windows. Time spans without recorded telemetry are explicitly marked as *No data*. Drag horizontally across any graph to inspect Average, Peak, and Estimated Transfer breakdowns for Download and Upload or zoom directly into the range.
- **Connection & Local Device Visibility**: Inspect active TCP/UDP/ICMP connections, resolve local LAN devices via dedicated LAN reverse DNS (targeting your separate LAN DNS server or custom router `dnsmasq`) + ARP/DHCP tables, detect IEEE 802.3 randomized (Private) MAC addresses with passive traffic hints, assign persistent custom device aliases, and visualize live traffic paths between devices and internet services.
- **Offline MaxMind GeoIP2 / GeoLite2 Integration**: Drop `GeoLite2-City.mmdb` (or `GeoLite2-Country.mmdb`) and `GeoLite2-ASN.mmdb` into `/config/geoip` or upload `.mmdb` files directly from Server Settings for offline city, country, and ASN/organization enrichment with zero external API calls.
- **Zero-Noise Reverse DNS**: Built-in offline service matching for popular cloud, streaming, and CDN networks. Live DNS PTR lookups are disabled by default and configurable with an in-memory TTL cache when enabled.
- **Persistent `/config` Volume**: Stores user settings and alert rules in `/config/config.json`, optional disk history cache in `/config/cache` (configurable), and MaxMind databases in `/config/geoip`.
- **Appearance & Theme System**: Split **Auto / Dark / Light** appearance selector paired with curated dark palettes (*Obsidian Night*, *Catppuccin Mocha*, *Dracula Pro*, *Nord*, *Tokyo Night*) and light palettes (*Daylight Slate*, *Catppuccin Latte*, *Nord Snow*).
- **Multi-Arch Docker Server Image**: Automated GitHub Actions workflow publishing `linux/amd64`, `linux/arm64`, and `linux/arm/v7` images to GitHub Container Registry (`ghcr.io`).

---

## Screenshots

### Desktop — Active Connections & Inspector Drawer (Dark)
![OrbiFlow Active Connections & Inspector Drawer](docs/screenshots/desktop-connections-dark.png)

### Desktop — Server Settings & MaxMind MMDB Configuration (Light)
![OrbiFlow Server Settings — Daylight Slate](docs/screenshots/desktop-settings-light.png)

### Mobile — Responsive 2×2 Summary & Bandwidth History
<p align="center">
  <img src="docs/screenshots/mobile-overview-dark.png" alt="OrbiFlow Mobile Network Summary" width="360" />
</p>

---

## Architecture

```text
┌──────────────────────────────┐        WebSocket / HTTP JSON (5s poll)        ┌─────────────────────────────────┐
│  Netgear Orbi RBK50 (Voxel)  │ ────────────────────────────────────────────► │      OrbiFlow Docker Server     │
│  /proc/net/nf_conntrack      │                                               │  Express + WS + TelemetryEngine │
│  /sys/class/net/eth0/stats   │                                               │  MaxMind MMDB + Optional rDNS   │
│  /proc/net/arp + DHCP leases │                                               │  /config persistent volume      │
└──────────────────────────────┘                                               └────────────────┬────────────────┘
                                                                                                │ WebSocket + REST
                                                                                                ▼
                                                                               ┌─────────────────────────────────┐
                                                                               │   Web Dashboard (Desktop/Mobile)│
                                                                               └─────────────────────────────────┘
```

---

## Quick Start (Docker Compose)

Run the OrbiFlow server as a non-root container with a single persistent `/config` volume. The container only uses `PUID`, `PGID`, and `TZ` environment variables—all application settings (shared router token, storage mode, LAN DNS, MaxMind databases, device aliases, and alert rules) are configured in **Server Settings** and stored in `/config/config.json`:

```yaml
services:
  orbiflow-server:
    image: ghcr.io/<your-github-username>/orbiflow:latest
    container_name: orbiflow-server
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=UTC
    volumes:
      - ./config:/config
```

Start the container:

```bash
docker compose up -d
```

Then open `http://<server-ip>:3000` in your browser.

### Building Locally

```bash
docker build -t orbiflow-server .
docker run -d --name orbiflow-server \
  -p 3000:3000 \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=UTC \
  -v $(pwd)/config:/config \
  orbiflow-server
```

You can also start the container directly with `--user 1000:1000` (already non-root); the entrypoint detects non-root execution and launches the server directly without privilege escalation.

---

## Persistent `/config` Volume Layout

All user state and server settings live inside `/config` so container upgrades never lose settings, history, or GeoIP databases:

```text
/config/
├── config.json          # Shared agent token, storage mode/path, LAN DNS, rDNS, MaxMind, device aliases & alert rules
├── cache/               # Optional disk traffic cache (JSONL + state snapshot)
│   ├── traffic-state.json
│   └── traffic-snapshots.jsonl
└── geoip/               # Optional offline MaxMind MMDB databases
    ├── GeoLite2-City.mmdb
    └── GeoLite2-ASN.mmdb
```

---

## MaxMind GeoLite2 Setup (Optional)

OrbiFlow supports offline IP geolocation and ASN/organization lookups using official MaxMind `.mmdb` databases:

1. Create a free [MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) account and download:
   - `GeoLite2-City.mmdb` (or `GeoLite2-Country.mmdb`)
   - `GeoLite2-ASN.mmdb`
2. Either copy the `.mmdb` files into your mounted `./config/geoip/` folder and click **Reload Databases** in **Server Settings**, or upload them directly using **Upload .mmdb File** in the UI.
3. Once loaded, active connections and the **Connection Details** drawer automatically display each remote endpoint's city/country and network operator (`ASxxxxx · Organization`), and the Connections search bar matches location and ASN fields.

---

## Netgear Orbi RBK50 (Voxel Firmware) Router Agent

Open the **Router Agent** tab inside the web dashboard to generate pre-configured scripts with your Docker server IP and shared token. Three lightweight agents are provided:

1. **Python 3 WebSocket (`orbi_probe.py`)** — Recommended when Entware is installed (`opkg install python3-light`). Uses Python stdlib only with built-in RFC 6455 WebSocket framing and 5s polling.
2. **BusyBox Ash (`orbi-probe.sh`)** — Zero extra packages required on stock Voxel firmware (`awk` + `curl`).
3. **Native C (`orbi-wan-probe.c`)** — Minimal-footprint `armv7l` binary for IPQ4019 (<1.2 MB RSS).

Enable Netfilter per-flow byte accounting on the router before starting the agent:

```sh
ssh root@192.168.1.1
echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct
```

---

## Environment Variables

OrbiFlow intentionally uses only standard container user/timezone variables. The Node.js server always drops privileges to run as non-root (`PUID:PGID`, refusing UID `0`) and reads all application configuration from `/config/config.json` (editable in the **Server Settings** tab).

| Variable | Default | Description |
| --- | --- | --- |
| `PUID` | `1000` | Non-root numeric user ID used to run the server and own `/config` files |
| `PGID` | `1000` | Non-root numeric group ID used to run the server and own `/config` files |
| `TZ` | `UTC` | Container timezone (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`) |

---

## Local Development

```bash
npm install
npm run dev
```

Run unit tests and type checks:

```bash
npx tsx --test src/lib/*.test.ts
npm run lint
npm run build
```
