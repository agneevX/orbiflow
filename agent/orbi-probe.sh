#!/bin/sh
# OrbiFlow Zero-Dependency BusyBox Ash Collector for Orbi RBK50 (Voxel Firmware)
SERVER_HTTP_URL="${ORBIFLOW_HTTP_URL:-http://192.168.1.10:3000/api/ingest}"
AUTH_TOKEN="${ORBIFLOW_PROBE_TOKEN:-orbi-rbk50-voxel-secret}"
WAN_IFACE="${ORBIFLOW_WAN_IFACE:-eth0}"
PROBE_ID="${ORBIFLOW_PROBE_ID:-orbi-rbk50-eth0}"
INTERVAL_SEC="${ORBIFLOW_INTERVAL:-5}"

echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || true

while true; do
  RX_BYTES=$(cat /sys/class/net/$WAN_IFACE/statistics/rx_bytes 2>/dev/null || echo 0)
  TX_BYTES=$(cat /sys/class/net/$WAN_IFACE/statistics/tx_bytes 2>/dev/null || echo 0)
  UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
  LOAD1M=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
  HOSTNAME=$(hostname 2>/dev/null || echo orbi-gateway)
  KERNEL=$(uname -r)
  ARCH=$(uname -m)

  JSON_PAYLOAD=$(awk -v probe="$PROBE_ID" -v iface="$WAN_IFACE" \
    -v rxb="$RX_BYTES" -v txb="$TX_BYTES" \
    -v up="$UPTIME" -v load="$LOAD1M" -v host="$HOSTNAME" -v kern="$KERNEL" -v arch="$ARCH" '
    BEGIN {
      printf "{\"probeId\":\"%s\",\"source\":\"live\",", probe;
      printf "\"iface\":{\"iface\":\"%s\",\"rxBytes\":%s,\"txBytes\":%s},", iface, rxb, txb;
      printf "\"system\":{\"hostname\":\"%s\",\"kernel\":\"%s\",\"arch\":\"%s\",\"uptimeSec\":%s,\"load1m\":%s,\"memUsedPct\":34,\"conntrackCount\":0,\"conntrackMax\":32768},", host, kern, arch, up, load;
      printf "\"arp\":[";
      arp_first = 1;
    }
    FILENAME == "/proc/net/arp" && FNR > 1 {
      if ($3 != "0x0" && $4 != "00:00:00:00:00:00") {
        if (!arp_first) printf ",";
        printf "{\"ip\":\"%s\",\"mac\":\"%s\",\"device\":\"%s\"}", $1, $4, $6;
        arp_first = 0;
      }
    }
    FILENAME == "/proc/net/nf_conntrack" && /bytes=/ {
      if (ct_count == 0) printf "],\"rawConntrackLines\":[";
      else printf ",";
      gsub(/\\/, "\\\\");
      gsub(/"/, "\\\"");
      printf "\"%s\"", $0;
      ct_count++;
      if (ct_count >= 250) nextfile;
    }
    END {
      if (ct_count == 0) printf "],\"rawConntrackLines\":[";
      printf "],\"flows\":[]}";
    }
  ' /proc/net/arp /proc/net/nf_conntrack)

  curl -fsS -m 4 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Probe-Token: $AUTH_TOKEN" \
    -d "$JSON_PAYLOAD" \
    "$SERVER_HTTP_URL" >/dev/null 2>&1 || true

  sleep "$INTERVAL_SEC"
done
