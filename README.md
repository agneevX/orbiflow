# OrbiFlow

Lightweight, real-time internet traffic monitor, connection inspector, and mesh topology dashboard for Linux routers. OrbiFlow streams live kernel connection tracking (`nf_conntrack`) and interface counters from your router to a self-hosted, non-root Docker server with push alerts and low-overhead delta WebSocket updates.

![OrbiFlow Overview — Desktop Dark](docs/screenshots/desktop-overview-dark.png)

## Features

- **Real-Time Bandwidth & Live Flows**: Smooth download/upload graphs across `5m`, `15m`, `1h`, `3h`, and `6h` windows (3-second live cadence, 6-hour retention) with drag-to-inspect ranges, ISP capacity tracking, and a live device-to-service flow diagram.
- **Connections & Smart Device Discovery**: Inspect active TCP/UDP/ICMP flows and identify LAN devices via custom aliases, LAN reverse DNS (PTR), advertised services (mDNS/DNS-SD for Google Cast, ADB, AirPlay, HomeKit, Sonos, SMB, SSH, SSDP/UPnP, NetBIOS), DHCP leases, and randomized MAC hints.
- **Network Map & Mesh Satellites**: Visualize router Ethernet ports, mesh satellites (polled over SSH for Ethernet/Wi-Fi backhaul and connected clients), VLANs/subnets, and per-device throughput.
- **Alerts & Push Notifications**: Configurable rules for WAN/device bandwidth, connection spikes, new LAN devices, router load/memory, and offline agents with server-side **ntfy** and **Telegram** notifications.
- **Efficient Streaming**: Incremental, compressed WebSocket deltas stream only new data points and active-tab views, automatically throttling hidden browser tabs.
- **Self-Hosted & Non-Root**: Single `/config` volume, auto-generated shared agent token (`of_...`), and **Auto / Dark / Light** appearance (*Obsidian*, *Catppuccin Mocha*, *Dracula Pro*, *Nord*, *Tokyo Night*, and *Daylight Slate*).

---

## Quick Start (Docker)

```yaml
services:
  orbiflow:
    image: ghcr.io/agneevx/orbiflow:latest
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

```bash
docker compose up -d
```

Open `http://<server-ip>:3000` in your browser. To build locally instead of pulling from GHCR, run `docker compose up -d --build` from this repository.

---

## Router Agent

Open the **Agent** tab in the dashboard to copy a pre-configured agent script filled with your server address and shared token (`X-Probe-Token`):

1. **Python 3 WebSocket (`orbi_probe.py`)** — Uses only Python 3 core modules (compatible with Entware `python3-light`, no `pip` dependencies).
2. **BusyBox Shell (`orbi-probe.sh`)** — Uses `awk` + `curl` with no extra packages.
3. **Native C (`orbi-wan-probe.c`)** — Minimal-footprint compiled probe (<1.2 MB RSS).

Enable Netfilter per-flow byte accounting on the router before running the agent:

```sh
echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct
```

---

## Configuration & Storage

Only container user and timezone variables are configured via environment; all app settings (agent token, ISP speeds, LAN DNS, VLANs, satellites, device aliases, alert rules, and notification channels) are managed in the web UI and persisted under `/config`.

| Variable | Default | Description |
| --- | --- | --- |
| `PUID` | `1000` | Non-root user ID for the server process and `/config` ownership |
| `PGID` | `1000` | Non-root group ID for the server process and `/config` ownership |
| `TZ` | `UTC` | Container timezone (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`) |

```text
/config/
├── config.json          # Agent token, settings, aliases, rules & notification channels
└── cache/               # Optional disk persistence (traffic-state.json + snapshots)
```

---

## Local Development

```bash
npm install
npm run dev
```

Run tests, type checks, and production build:

```bash
npx tsx --test src/lib/*.test.ts
npm run lint
npm run build
```
