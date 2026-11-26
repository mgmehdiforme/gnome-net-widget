// Pure helpers for Net Widget. No GNOME imports here, so they run (and are
// tested) in plain Node.js as well as inside GNOME Shell.

// Name-based fallback for virtual interfaces (loopback, VPN, containers, bridges,
// PPP, bonds, VLANs). Inside GNOME the widget prefers a stronger test: only
// interfaces backed by real hardware (/sys/class/net/<if>/device) are counted,
// so no byte is counted twice (e.g. once on eth0 and again on ppp0/tun0/br0).
export const SKIP_IFACE = /^(lo|tun|tap|wg|docker|br|veth|virbr|vnet|zt|tailscale|ppp|bond|team|vlan|macvlan|ipvlan|dummy|ifb|gre|sit|ip6tnl)|\./;
export const VPN_IFACE = /^(tun|tap|wg|tailscale|zt)/;
export const SIGNAL_MAX = 5;

/** Bytes per second → [value, unit], e.g. [ '1.4', 'MB/s' ]. */
export function splitRate(bps) {
    const k = Math.max(0, bps) / 1024;
    if (k < 1000) return [k < 10 ? k.toFixed(1) : k.toFixed(0), 'KB/s'];
    const m = k / 1024;
    return [m < 100 ? m.toFixed(1) : m.toFixed(0), 'MB/s'];
}

export const fmtRate = bps => splitRate(bps).join(' ');

/** Log-scale meter fill: 1 KB/s → 0, 50 MB/s → 1. */
export function meterFrac(bps) {
    const v = Math.log10(Math.max(bps, 1024) / 1024) / Math.log10(50 * 1024);
    return Math.max(0, Math.min(1, v));
}

export function fmtBytes(b) {
    return b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(0)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Parse /proc/net/dev → { iface: { rx, tx } }.
 * `keep(name)` decides which interfaces count (default: not a known virtual name).
 */
export function parseNetDev(text, keep = name => !SKIP_IFACE.test(name)) {
    const out = {};
    for (const line of String(text).split('\n').slice(2)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        if (!name || !keep(name)) continue;
        const f = line.slice(i + 1).trim().split(/\s+/);
        if (f.length < 9) continue;
        out[name] = { rx: Number(f[0]), tx: Number(f[8]) };
    }
    return out;
}

/** Sum of counter increases between two parseNetDev() snapshots (resets ignored). */
export function counterDelta(prev, cur) {
    let rx = 0, tx = 0;
    for (const [n, c] of Object.entries(cur)) {
        const p = prev[n];
        if (!p) continue;
        if (c.rx >= p.rx) rx += c.rx - p.rx;
        if (c.tx >= p.tx) tx += c.tx - p.tx;
    }
    return { rx, tx };
}

/** Parse /proc/net/route → default routes sorted by metric: [{ iface, metric, gw }]. */
export function parseDefaultRoutes(text) {
    const out = [];
    for (const line of String(text).split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 8 || f[1] !== '00000000') continue;
        const g = parseInt(f[2], 16) >>> 0;
        out.push({
            iface: f[0],
            metric: Number(f[6]),
            gw: [g & 255, (g >>> 8) & 255, (g >>> 16) & 255, (g >>> 24) & 255].join('.'),
        });
    }
    return out.sort((a, b) => a.metric - b.metric);
}

/** The LAN router: gateway of the best default route that is not a VPN/virtual link. */
export function routerIp(routes) {
    const r = routes.find(x => !SKIP_IFACE.test(x.iface) && x.gw !== '0.0.0.0');
    return r ? r.gw : null;
}

export function routeInfo(iface) {
    if (!iface) return { label: 'No route', icon: 'network-offline-symbolic' };
    if (VPN_IFACE.test(iface)) return { label: 'VPN', icon: 'network-vpn-symbolic' };
    if (/^wl/.test(iface)) return { label: 'Wi-Fi', icon: 'network-wireless-symbolic' };
    if (/^(ww|usb|rmnet)/.test(iface)) return { label: 'Mobile', icon: 'network-cellular-symbolic' };
    return { label: 'Ethernet', icon: 'network-wired-symbolic' };
}

export const PING_COUNT = 8; // 1 lost packet = 12.5 % (Normal), 2+ = 25 %+ (Bad)

/**
 * Parse `ping -q` output and grade the connection. "Jitter" is ping's mdev.
 * good:   no loss, avg < 150 ms, jitter < 40 ms
 * normal: some loss (under 25 %), or avg 150-300 ms, or jitter 40-100 ms
 * bad:    loss >= 25 %, avg >= 300 ms or jitter >= 100 ms
 * offline: no reply at all
 */
export function parsePing(out) {
    const lossMatch = String(out).match(/([\d.]+)% packet loss/);
    const loss = lossMatch ? Number(lossMatch[1]) : 100;
    const m = String(out).match(/= [\d.]+\/([\d.]+)\/[\d.]+\/([\d.]+)/);
    if (!m || loss >= 100) return { level: 'offline', ms: null, jitter: null, loss: 100 };
    const ms = Number(m[1]), jitter = Number(m[2]);
    let level = 'good';
    if (loss >= 25 || ms >= 300 || jitter >= 100) level = 'bad';
    else if (loss > 0 || ms >= 150 || jitter >= 40) level = 'normal';
    return { level, ms, jitter, loss: Math.round(loss) };
}

/** Normalise a 4G/5G router's network type string to 5G / 4G+ / 4G / 3G / 2G / NO SIGNAL. */
export function cellType(networkTypeStr, simReady = true) {
    const raw = String(networkTypeStr || '');
    if (!simReady) return 'NO SIGNAL';
    if (/5G|\bNR\b/i.test(raw)) return '5G';
    if (/4G\+|LTE[-_ ]?A|LTE\+|\bCA\b/i.test(raw)) return '4G+';
    if (/4G|LTE/i.test(raw)) return '4G';
    if (/3G|WCDMA|HSPA|UMTS|TD-?SCDMA/i.test(raw)) return '3G';
    if (/2G|GSM|EDGE|GPRS/i.test(raw)) return '2G';
    return 'NO SIGNAL';
}

/**
 * Read the status JSON of ZLT / Tozed-style 4G/5G routers
 * (POST /cgi-bin/http.cgi {"cmd":113,"method":"GET"}) → { type, raw, bars, operator } or null.
 */
export function parseRouterStatus(json) {
    if (!json || json.success !== true || json.network_type_str === undefined) return null;
    const simReady = json.sim_status === undefined || String(json.sim_status) === '1';
    const type = cellType(json.network_type_str, simReady);
    const bars = type === 'NO SIGNAL' ? 0 : Math.max(0, Math.min(SIGNAL_MAX, Number(json.signal_lvl) || 0));
    return { type, raw: String(json.network_type_str), bars, operator: String(json.network_operator || '').trim() };
}
