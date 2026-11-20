import type { ArpEntry, ProbeSnapshot, RawConntrackFlow } from '../src/types/telemetry';

interface SimFlowState {
  id: string;
  proto: 'tcp' | 'udp' | 'icmp';
  state?: string;
  src: string;
  dst: string;
  sport: number;
  dport: number;
  txBytes: number;
  rxBytes: number;
  rxWeight: number;
  txWeight: number;
  ttl: number;
}

const LAN_DEVICES: ArpEntry[] = [
  {
    ip: '192.168.1.10',
    mac: 'e4:5f:01:8a:22:14',
    device: 'br0',
    hostname: 'homelab-docker',
    vendor: 'Intel NUC / Linux',
  },
  {
    ip: '192.168.1.24',
    mac: 'f0:18:98:4b:91:c0',
    device: 'br0',
    hostname: 'macbook-pro',
    vendor: 'Apple Inc.',
  },
  {
    ip: '192.168.1.38',
    mac: '00:11:32:9e:44:7b',
    device: 'br0',
    hostname: 'synology-nas',
    vendor: 'Synology',
  },
  {
    ip: '192.168.1.52',
    mac: 'b4:fb:e4:12:77:09',
    device: 'br0',
    hostname: 'livingroom-atv',
    vendor: 'Apple TV 4K',
  },
  {
    ip: '192.168.1.67',
    mac: '7c:d9:5c:31:aa:02',
    device: 'br0',
    hostname: 'pixel-9-pro',
    vendor: 'Google',
  },
  {
    ip: '192.168.1.84',
    mac: '18:b4:30:c9:55:1e',
    device: 'br0',
    hostname: 'ecobee-thermostat',
    vendor: 'Ecobee IoT',
  },
  {
    ip: '192.168.1.105',
    mac: 'd8:bb:c1:62:08:f4',
    device: 'br0',
    hostname: 'gaming-rig',
    vendor: 'Realtek LAN',
  },
  {
    ip: '192.168.1.91',
    mac: 'da:a1:19:4c:82:10',
    device: 'br0',
  },
];

const FLOW_TEMPLATES: Array<{
  proto: 'tcp' | 'udp' | 'icmp';
  state?: string;
  src: string;
  dst: string;
  sport: number;
  dport: number;
  rxWeight: number;
  txWeight: number;
}> = [
  {
    proto: 'udp',
    src: '192.168.1.52',
    dst: '142.250.190.78',
    sport: 58120,
    dport: 443,
    rxWeight: 1_850_000,
    txWeight: 72_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.52',
    dst: '23.246.18.145',
    sport: 49812,
    dport: 443,
    rxWeight: 2_350_000,
    txWeight: 64_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.24',
    dst: '17.253.144.10',
    sport: 51402,
    dport: 443,
    rxWeight: 780_000,
    txWeight: 320_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.24',
    dst: '140.82.114.4',
    sport: 54210,
    dport: 443,
    rxWeight: 420_000,
    txWeight: 185_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.91',
    dst: '17.57.144.84',
    sport: 53410,
    dport: 5223,
    rxWeight: 18_000,
    txWeight: 9_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.91',
    dst: '17.253.144.10',
    sport: 53418,
    dport: 443,
    rxWeight: 340_000,
    txWeight: 48_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.38',
    dst: '52.94.236.248',
    sport: 48912,
    dport: 443,
    rxWeight: 190_000,
    txWeight: 1_450_000,
  },
  {
    proto: 'udp',
    src: '192.168.1.10',
    dst: '162.159.192.1',
    sport: 51820,
    dport: 51820,
    rxWeight: 310_000,
    txWeight: 290_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.105',
    dst: '155.133.248.50',
    sport: 61204,
    dport: 27015,
    rxWeight: 980_000,
    txWeight: 110_000,
  },
  {
    proto: 'udp',
    src: '192.168.1.24',
    dst: '1.1.1.1',
    sport: 43211,
    dport: 53,
    rxWeight: 2_400,
    txWeight: 1_100,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.10',
    dst: '185.199.108.133',
    sport: 45190,
    dport: 443,
    rxWeight: 540_000,
    txWeight: 42_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.10',
    dst: '104.16.132.229',
    sport: 39482,
    dport: 22,
    rxWeight: 28_000,
    txWeight: 19_000,
  },
  {
    proto: 'udp',
    src: '192.168.1.67',
    dst: '172.217.14.202',
    sport: 55102,
    dport: 443,
    rxWeight: 320_000,
    txWeight: 48_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.67',
    dst: '17.57.144.84',
    sport: 51920,
    dport: 5223,
    rxWeight: 45_000,
    txWeight: 18_000,
  },
  {
    proto: 'tcp',
    state: 'TIME_WAIT',
    src: '192.168.1.24',
    dst: '151.101.65.140',
    sport: 59011,
    dport: 443,
    rxWeight: 12_000,
    txWeight: 3_200,
  },
  {
    proto: 'udp',
    src: '192.168.1.84',
    dst: '8.8.8.8',
    sport: 38910,
    dport: 53,
    rxWeight: 450,
    txWeight: 280,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.84',
    dst: '54.239.28.85',
    sport: 44120,
    dport: 8883,
    rxWeight: 1_200,
    txWeight: 1_400,
  },
  {
    proto: 'udp',
    src: '192.168.1.105',
    dst: '162.159.130.233',
    sport: 50004,
    dport: 19302,
    rxWeight: 165_000,
    txWeight: 158_000,
  },
  {
    proto: 'icmp',
    src: '192.168.1.10',
    dst: '1.1.1.1',
    sport: 0,
    dport: 0,
    rxWeight: 128,
    txWeight: 128,
  },
];

export class OrbiProbeSimulator {
  private flows: SimFlowState[];
  private ifaceRxBytes = 84_291_400_120;
  private ifaceTxBytes = 19_482_110_440;
  private tickCount = 0;

  constructor() {
    this.flows = FLOW_TEMPLATES.map((tpl, idx) => ({
      id: `${tpl.proto}:${tpl.src}:${tpl.sport}->${tpl.dst}:${tpl.dport}`,
      ...tpl,
      txBytes: Math.round(tpl.txWeight * (4 + idx * 0.7)),
      rxBytes: Math.round(tpl.rxWeight * (5 + idx * 0.9)),
      ttl: tpl.proto === 'tcp' ? 431980 : 175,
    }));
  }

  public nextSnapshot(timestamp = Date.now(), stepSeconds = 1): ProbeSnapshot {
    this.tickCount += 1;
    const wave =
      0.78 + 0.36 * Math.sin(this.tickCount * 0.17) + 0.14 * Math.cos(this.tickCount * 0.43);

    let tickRx = 0;
    let tickTx = 0;

    const rawFlows: RawConntrackFlow[] = this.flows.map((f, idx) => {
      const jitter = 0.75 + ((this.tickCount * 17 + idx * 31) % 50) / 100;
      const burst = idx <= 1 && this.tickCount % 25 > 18 ? 1.85 : 1;
      const dRx = Math.round(f.rxWeight * wave * jitter * burst * stepSeconds);
      const dTx = Math.round(f.txWeight * wave * jitter * stepSeconds);

      f.rxBytes += dRx;
      f.txBytes += dTx;

      tickRx += dRx;
      tickTx += dTx;

      return {
        id: f.id,
        proto: f.proto,
        state: f.state,
        ttl: f.ttl,
        src: f.src,
        dst: f.dst,
        sport: f.sport,
        dport: f.dport,
        txBytes: f.txBytes,
        rxBytes: f.rxBytes,
        assured: f.state !== 'TIME_WAIT',
      };
    });

    this.ifaceRxBytes += tickRx;
    this.ifaceTxBytes += tickTx;

    return {
      probeId: 'router-dev-sim',
      timestamp,
      source: 'simulator',
      iface: {
        iface: 'eth0',
        rxBytes: this.ifaceRxBytes,
        txBytes: this.ifaceTxBytes,
        rxErrors: 0,
        txErrors: 0,
      },
      arp: LAN_DEVICES,
      flows: rawFlows,
      system: {
        hostname: 'router-gateway',
        kernel: 'Linux 6.6',
        arch: 'linux',
        uptimeSec: 1_248_900 + this.tickCount * stepSeconds,
        load1m: Number((0.28 + 0.1 * Math.abs(Math.sin(this.tickCount * 0.1))).toFixed(2)),
        memUsedPct: 36.2,
        conntrackCount: rawFlows.length + 142,
        conntrackMax: 32768,
      },
    };
  }
}
