import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SKIP_IFACE, PING_COUNT, splitRate, fmtRate, meterFrac, fmtBytes, parseNetDev, counterDelta, parseDefaultRoutes,
    routerIp, routeInfo, parsePing, cellType, parseRouterStatus,
} from '../src/lib.js';

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
enp2s0: 5000000 4000 0 0 0 0 0 0 700000 3000 0 0 0 0 0 0
  tun0: 4000000 3000 0 0 0 0 0 0 600000 2000 0 0 0 0 0 0
docker0: 99 1 0 0 0 0 0 0 99 1 0 0 0 0 0 0
wlp3s0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0`;

const ROUTES = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
tun0	00000000	0100080A	0003	0	0	50	00000000	0	0	0
enp2s0	00000000	0101A8C0	0003	0	0	100	00000000	0	0	0
enp2s0	0001A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0`;

const PING_OK = `--- 1.1.1.1 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 754ms
rtt min/avg/max/mdev = 41.200/45.875/52.000/3.900 ms`;

test('splitRate picks KB/s or MB/s with sensible precision', () => {
    assert.deepEqual(splitRate(0), ['0.0', 'KB/s']);
    assert.deepEqual(splitRate(5 * 1024), ['5.0', 'KB/s']);
    assert.deepEqual(splitRate(500 * 1024), ['500', 'KB/s']);
    assert.deepEqual(splitRate(1.5 * 1024 ** 2), ['1.5', 'MB/s']);
    assert.deepEqual(splitRate(250 * 1024 ** 2), ['250', 'MB/s']);
    assert.equal(fmtRate(2048), '2.0 KB/s');
    assert.deepEqual(splitRate(-5), ['0.0', 'KB/s']);
});

test('meterFrac is a clamped log scale', () => {
    assert.equal(meterFrac(0), 0);
    assert.equal(meterFrac(1024), 0);
    assert.equal(meterFrac(50 * 1024 ** 2), 1);
    assert.equal(meterFrac(10 * 1024 ** 3), 1);
    const mid = meterFrac(1024 ** 2);
    assert.ok(mid > 0.5 && mid < 0.8, `got ${mid}`);
});

test('fmtBytes', () => {
    assert.equal(fmtBytes(300 * 1024 ** 2), '300 MB');
    assert.equal(fmtBytes(2.5 * 1024 ** 3), '2.50 GB');
});

test('parseNetDev keeps physical interfaces and skips lo, VPN and Docker', () => {
    const c = parseNetDev(NET_DEV);
    assert.deepEqual(Object.keys(c).sort(), ['enp2s0', 'wlp3s0']);
    assert.deepEqual(c.enp2s0, { rx: 5000000, tx: 700000 });
});

test('the name fallback skips PPP, bonds, bridges and VLAN sub-interfaces', () => {
    for (const n of ['ppp0', 'bond0', 'team0', 'br0', 'br-1a2b', 'eth0.10', 'enp2s0.100', 'wg0', 'tailscale0'])
        assert.ok(SKIP_IFACE.test(n), n);
    for (const n of ['eth0', 'enp2s0', 'wlp3s0', 'wlan0', 'wwan0', 'usb0', 'enx001122334455'])
        assert.ok(!SKIP_IFACE.test(n), n);
});

test('parseNetDev accepts a custom keep() (hardware-only filter in GNOME)', () => {
    const c = parseNetDev(NET_DEV, n => n === 'enp2s0');
    assert.deepEqual(Object.keys(c), ['enp2s0']);
});

test('counterDelta sums increases and ignores counter resets and new interfaces', () => {
    const prev = { a: { rx: 100, tx: 50 }, b: { rx: 1000, tx: 1000 } };
    const cur = { a: { rx: 300, tx: 80 }, b: { rx: 10, tx: 1500 }, c: { rx: 9e9, tx: 9e9 } };
    assert.deepEqual(counterDelta(prev, cur), { rx: 200, tx: 530 });
});

test('parseDefaultRoutes decodes gateways and sorts by metric', () => {
    const r = parseDefaultRoutes(ROUTES);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { iface: 'tun0', metric: 50, gw: '10.8.0.1' });
    assert.deepEqual(r[1], { iface: 'enp2s0', metric: 100, gw: '192.168.1.1' });
});

test('routerIp ignores the VPN route and returns the LAN gateway', () => {
    assert.equal(routerIp(parseDefaultRoutes(ROUTES)), '192.168.1.1');
    assert.equal(routerIp([]), null);
    assert.equal(routerIp([{ iface: 'tun0', metric: 1, gw: '10.0.0.1' }]), null);
});

test('routeInfo labels the connection', () => {
    assert.equal(routeInfo('tun0').label, 'VPN');
    assert.equal(routeInfo('wg0').label, 'VPN');
    assert.equal(routeInfo('wlp3s0').label, 'Wi-Fi');
    assert.equal(routeInfo('enp2s0').label, 'Ethernet');
    assert.equal(routeInfo('wwan0').label, 'Mobile');
    assert.equal(routeInfo(null).label, 'No route');
});

test('PING_COUNT makes a single lost packet "Normal", not "Bad"', () => {
    assert.ok(100 / PING_COUNT < 25);
});

test('parsePing grades good / normal / bad / offline', () => {
    assert.deepEqual(parsePing(PING_OK), { level: 'good', ms: 45.875, jitter: 3.9, loss: 0 });
    const slow = PING_OK.replace('41.200/45.875/52.000/3.900', '150.0/180.0/210.0/10.0');
    assert.equal(parsePing(slow).level, 'normal');
    const lossy = PING_OK.replace('4 received, 0%', '3 received, 25%');
    assert.equal(parsePing(lossy).level, 'bad');
    const someLoss = PING_OK.replace('0% packet loss', '12.5% packet loss');
    assert.equal(parsePing(someLoss).level, 'normal');
    const jittery = PING_OK.replace('/3.900 ms', '/120.0 ms');
    assert.equal(parsePing(jittery).level, 'bad');
    assert.equal(parsePing('4 packets transmitted, 0 received, 100% packet loss').level, 'offline');
    assert.equal(parsePing('ping: connect: Network is unreachable').level, 'offline');
});

test('cellType normalises router network names', () => {
    assert.equal(cellType('5G(NSA)'), '5G');
    assert.equal(cellType('5G SA'), '5G');
    assert.equal(cellType('NR'), '5G');
    assert.equal(cellType('4G+'), '4G+');
    assert.equal(cellType('LTE-A'), '4G+');
    assert.equal(cellType('LTE'), '4G');
    assert.equal(cellType('4G'), '4G');
    assert.equal(cellType('WCDMA'), '3G');
    assert.equal(cellType('GSM'), '2G');
    assert.equal(cellType(''), 'NO SIGNAL');
    assert.equal(cellType('5G(NSA)', false), 'NO SIGNAL');
});

test('parseRouterStatus reads the cmd 113 status reply', () => {
    const reply = { success: true, cmd: 113, network_type_str: '5G(NSA)', signal_lvl: '4', sim_status: '1', network_operator: ' Example Mobile ' };
    assert.deepEqual(parseRouterStatus(reply), { type: '5G', raw: '5G(NSA)', bars: 4, operator: 'Example Mobile' });
    assert.equal(parseRouterStatus({ ...reply, signal_lvl: '9' }).bars, 5);
    assert.deepEqual(parseRouterStatus({ ...reply, sim_status: '0' }), { type: 'NO SIGNAL', raw: '5G(NSA)', bars: 0, operator: 'Example Mobile' });
    assert.equal(parseRouterStatus({ success: false }), null);
    assert.equal(parseRouterStatus(null), null);
    assert.equal(parseRouterStatus({ success: true }), null);
});
