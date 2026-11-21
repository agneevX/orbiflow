import type {
  ArpEntry,
  EthernetPortMetrics,
  ProbeSnapshot,
  RawConntrackFlow,
  SatelliteClientLink,
  SatelliteTelemetry,
} from '../src/types/telemetry';

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
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.84',
    dst: '34.117.59.81',
    sport: 44199,
    dport: 443,
    rxWeight: 0,
    txWeight: 0,
  },
  // LAN-to-LAN local network flows
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.24',
    dst: '192.168.1.38',
    sport: 57210,
    dport: 445,
    rxWeight: 1_240_000,
    txWeight: 480_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.52',
    dst: '192.168.1.10',
    sport: 58904,
    dport: 32400,
    rxWeight: 1_920_000,
    txWeight: 45_000,
  },
  {
    proto: 'tcp',
    state: 'ESTABLISHED',
    src: '192.168.1.105',
    dst: '192.168.1.38',
    sport: 60114,
    dport: 445,
    rxWeight: 620_000,
    txWeight: 140_000,
  },
];

export class OrbiProbeSimulator {
  private flows: SimFlowState[];
  private ifaceRxBytes = 84_291_400_120;
  private ifaceTxBytes = 19_482_110_440;
  private satLivingRxBytes = 38_420_000_000;
  private satLivingTxBytes = 4_110_000_000;
  private satOfficeRxBytes = 29_150_000_000;
  private satOfficeTxBytes = 6_840_000_000;
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

  public nextSnapshot(timestamp = Date.now(), stepSeconds = 3): ProbeSnapshot {
    this.tickCount += 1;
    const wave =
      0.78 + 0.36 * Math.sin(this.tickCount * 0.17) + 0.14 * Math.cos(this.tickCount * 0.43);

    let tickRx = 0;
    let tickTx = 0;
    const hostTickRates = new Map<string, { rxBps: number; txBps: number; rxBytes: number; txBytes: number }>();

    const rawFlows: RawConntrackFlow[] = this.flows.map((f, idx) => {
      const jitter = 0.75 + ((this.tickCount * 17 + idx * 31) % 50) / 100;
      const burst = idx <= 1 && this.tickCount % 25 > 18 ? 1.85 : 1;
      const dRx = Math.round(f.rxWeight * wave * jitter * burst * stepSeconds);
      const dTx = Math.round(f.txWeight * wave * jitter * stepSeconds);

      f.rxBytes += dRx;
      f.txBytes += dTx;

      tickRx += dRx;
      tickTx += dTx;

      const cur = hostTickRates.get(f.src) || { rxBps: 0, txBps: 0, rxBytes: 0, txBytes: 0 };
      cur.rxBps += Math.round(dRx / stepSeconds);
      cur.txBps += Math.round(dTx / stepSeconds);
      cur.rxBytes += f.rxBytes;
      cur.txBytes += f.txBytes;
      hostTickRates.set(f.src, cur);

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

    const getRate = (ip: string) =>
      hostTickRates.get(ip) || { rxBps: 0, txBps: 0, rxBytes: 0, txBytes: 0 };

    const atv = getRate('192.168.1.52');
    const pixel = getRate('192.168.1.67');
    const ecobee = getRate('192.168.1.84');
    const macbook = getRate('192.168.1.24');
    const gaming = getRate('192.168.1.105');
    const privApple = getRate('192.168.1.91');
    const homelab = getRate('192.168.1.10');
    const synology = getRate('192.168.1.38');

    // Include slight intra-LAN overhead on satellite backhauls
    const satLivingRxBps = atv.rxBps + pixel.rxBps + ecobee.rxBps + 42_000;
    const satLivingTxBps = atv.txBps + pixel.txBps + ecobee.txBps + 18_500;
    const satOfficeRxBps = macbook.rxBps + gaming.rxBps + privApple.rxBps + 85_000;
    const satOfficeTxBps = macbook.txBps + gaming.txBps + privApple.txBps + 64_000;

    this.satLivingRxBytes += satLivingRxBps * stepSeconds;
    this.satLivingTxBytes += satLivingTxBps * stepSeconds;
    this.satOfficeRxBytes += satOfficeRxBps * stepSeconds;
    this.satOfficeTxBytes += satOfficeTxBps * stepSeconds;

    const routerPorts: EthernetPortMetrics[] = [
      {
        id: 'eth0',
        label: 'WAN (eth0)',
        role: 'wan',
        linkUp: true,
        speedMbps: 2500,
        duplex: 'full',
        rxBytes: this.ifaceRxBytes,
        txBytes: this.ifaceTxBytes,
        rxBps: Math.round(tickRx / stepSeconds),
        txBps: Math.round(tickTx / stepSeconds),
      },
      {
        id: 'lan1',
        label: 'LAN 1 · Living Room',
        role: 'backhaul',
        linkUp: true,
        speedMbps: 1000,
        duplex: 'full',
        rxBytes: this.satLivingTxBytes,
        txBytes: this.satLivingRxBytes,
        rxBps: satLivingTxBps,
        txBps: satLivingRxBps,
      },
      {
        id: 'lan2',
        label: 'LAN 2 · Office',
        role: 'backhaul',
        linkUp: true,
        speedMbps: 2500,
        duplex: 'full',
        rxBytes: this.satOfficeTxBytes,
        txBytes: this.satOfficeRxBytes,
        rxBps: satOfficeTxBps,
        txBps: satOfficeRxBps,
      },
      {
        id: 'lan3',
        label: 'LAN 3 · Synology NAS',
        role: 'lan',
        linkUp: true,
        speedMbps: 1000,
        duplex: 'full',
        rxBytes: synology.txBytes,
        txBytes: synology.rxBytes,
        rxBps: synology.txBps,
        txBps: synology.rxBps,
      },
      {
        id: 'lan4',
        label: 'LAN 4 · Homelab',
        role: 'lan',
        linkUp: true,
        speedMbps: 1000,
        duplex: 'full',
        rxBytes: homelab.txBytes,
        txBytes: homelab.rxBytes,
        rxBps: homelab.txBps,
        txBps: homelab.rxBps,
      },
    ];

    const routerClients: SatelliteClientLink[] = [
      {
        mac: '00:11:32:9e:44:7b',
        ip: '192.168.1.38',
        connectionType: 'ethernet',
        portOrRadio: 'LAN 3',
        linkSpeedMbps: 0,
        rxBytes: synology.rxBytes,
        txBytes: synology.txBytes,
        rxBps: synology.rxBps,
        txBps: synology.txBps,
      },
      {
        mac: 'e4:5f:01:8a:22:14',
        ip: '192.168.1.10',
        connectionType: 'ethernet',
        portOrRadio: 'LAN 4',
        linkSpeedMbps: 0,
        rxBytes: homelab.rxBytes,
        txBytes: homelab.txBytes,
        rxBps: homelab.rxBps,
        txBps: homelab.txBps,
      },
    ];

    const satellites: SatelliteTelemetry[] = [
      {
        id: 'sim-sat-living',
        name: 'Living Room Satellite',
        host: '192.168.1.2',
        model: 'Orbi Satellite',
        connected: true,
        source: 'simulator',
        lastSeen: timestamp,
        uptimeSec: 912_400 + this.tickCount * stepSeconds,
        backhaulType: 'ethernet',
        backhaulIface: 'eth0',
        backhaulSpeedMbps: 1000,
        rxBps: satLivingRxBps,
        txBps: satLivingTxBps,
        rxBytes: this.satLivingRxBytes,
        txBytes: this.satLivingTxBytes,
        ports: [
          {
            id: 'port1',
            label: 'Backhaul (Port 1)',
            role: 'backhaul',
            linkUp: true,
            speedMbps: 1000,
            duplex: 'full',
            rxBytes: this.satLivingRxBytes,
            txBytes: this.satLivingTxBytes,
            rxBps: satLivingRxBps,
            txBps: satLivingTxBps,
          },
          {
            id: 'port2',
            label: 'LAN 2 · Apple TV',
            role: 'lan',
            linkUp: true,
            speedMbps: 1000,
            duplex: 'full',
            rxBytes: atv.txBytes,
            txBytes: atv.rxBytes,
            rxBps: atv.txBps,
            txBps: atv.rxBps,
          },
          {
            id: 'port3',
            label: 'LAN 3',
            role: 'lan',
            linkUp: false,
            speedMbps: 0,
            duplex: 'unknown',
            rxBytes: 0,
            txBytes: 0,
            rxBps: 0,
            txBps: 0,
          },
          {
            id: 'port4',
            label: 'LAN 4',
            role: 'lan',
            linkUp: false,
            speedMbps: 0,
            duplex: 'unknown',
            rxBytes: 0,
            txBytes: 0,
            rxBps: 0,
            txBps: 0,
          },
        ],
        clients: [
          {
            mac: 'b4:fb:e4:12:77:09',
            ip: '192.168.1.52',
            connectionType: 'ethernet',
            portOrRadio: 'LAN 2',
            linkSpeedMbps: 0,
            rxBytes: atv.rxBytes,
            txBytes: atv.txBytes,
            rxBps: atv.rxBps,
            txBps: atv.txBps,
          },
          {
            mac: '7c:d9:5c:31:aa:02',
            ip: '192.168.1.67',
            connectionType: 'wifi',
            portOrRadio: '5 GHz',
            linkSpeedMbps: 866,
            wifiRxMbps: 780,
            wifiTxMbps: 866,
            signalDbm: -52,
            rxBytes: pixel.rxBytes,
            txBytes: pixel.txBytes,
            rxBps: pixel.rxBps,
            txBps: pixel.txBps,
          },
          {
            mac: '18:b4:30:c9:55:1e',
            ip: '192.168.1.84',
            connectionType: 'wifi',
            portOrRadio: '2.4 GHz',
            linkSpeedMbps: 144,
            wifiRxMbps: 130,
            wifiTxMbps: 144,
            signalDbm: -61,
            rxBytes: ecobee.rxBytes,
            txBytes: ecobee.txBytes,
            rxBps: ecobee.rxBps,
            txBps: ecobee.txBps,
          },
        ],
      },
      {
        id: 'sim-sat-office',
        name: 'Office Satellite',
        host: '192.168.1.3',
        model: 'Orbi Satellite',
        connected: true,
        source: 'simulator',
        lastSeen: timestamp,
        uptimeSec: 654_120 + this.tickCount * stepSeconds,
        backhaulType: 'ethernet',
        backhaulIface: 'eth0',
        backhaulSpeedMbps: 2500,
        rxBps: satOfficeRxBps,
        txBps: satOfficeTxBps,
        rxBytes: this.satOfficeRxBytes,
        txBytes: this.satOfficeTxBytes,
        ports: [
          {
            id: 'port1',
            label: 'Backhaul (Port 1)',
            role: 'backhaul',
            linkUp: true,
            speedMbps: 2500,
            duplex: 'full',
            rxBytes: this.satOfficeRxBytes,
            txBytes: this.satOfficeTxBytes,
            rxBps: satOfficeRxBps,
            txBps: satOfficeTxBps,
          },
          {
            id: 'port2',
            label: 'LAN 2 · Gaming Rig',
            role: 'lan',
            linkUp: true,
            speedMbps: 1000,
            duplex: 'full',
            rxBytes: gaming.txBytes,
            txBytes: gaming.rxBytes,
            rxBps: gaming.txBps,
            txBps: gaming.rxBps,
          },
          {
            id: 'port3',
            label: 'LAN 3 · Dock',
            role: 'lan',
            linkUp: true,
            speedMbps: 100,
            duplex: 'full',
            rxBytes: 12_400_000,
            txBytes: 8_200_000,
            rxBps: 0,
            txBps: 0,
          },
        ],
        clients: [
          {
            mac: 'd8:bb:c1:62:08:f4',
            ip: '192.168.1.105',
            connectionType: 'ethernet',
            portOrRadio: 'LAN 2',
            linkSpeedMbps: 0,
            rxBytes: gaming.rxBytes,
            txBytes: gaming.txBytes,
            rxBps: gaming.rxBps,
            txBps: gaming.txBps,
          },
          {
            mac: 'f0:18:98:4b:91:c0',
            ip: '192.168.1.24',
            connectionType: 'wifi',
            portOrRadio: '5 GHz',
            linkSpeedMbps: 1200,
            wifiRxMbps: 1080,
            wifiTxMbps: 1200,
            signalDbm: -46,
            rxBytes: macbook.rxBytes,
            txBytes: macbook.txBytes,
            rxBps: macbook.rxBps,
            txBps: macbook.txBps,
          },
          {
            mac: 'da:a1:19:4c:82:10',
            ip: '192.168.1.91',
            connectionType: 'wifi',
            portOrRadio: '5 GHz',
            linkSpeedMbps: 866,
            wifiRxMbps: 780,
            wifiTxMbps: 866,
            signalDbm: -55,
            rxBytes: privApple.rxBytes,
            txBytes: privApple.txBytes,
            rxBps: privApple.rxBps,
            txBps: privApple.txBps,
          },
        ],
      },
    ];

    const includeSystem = this.tickCount === 1 || this.tickCount % 10 === 0;

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
      ports: routerPorts,
      routerClients,
      satellites,
      ...(includeSystem
        ? {
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
          }
        : {}),
    };
  }
}
