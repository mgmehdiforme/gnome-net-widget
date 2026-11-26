// Net Widget — the visible widget and its data sources.
// Layouts (right-click to switch): big, slim, pill, status, card.
// Drag with the left button to move it; the position is remembered.
// The 5G/4G badge reads the LAN router's read-only status call
// (ZLT/Tozed-style /cgi-bin/http.cgi, cmd 113, no login). It hides itself
// on networks whose router does not answer that call.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Soup from 'gi://Soup?version=3.0';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    SIGNAL_MAX, PING_COUNT, splitRate, fmtRate, meterFrac, fmtBytes, parseNetDev, counterDelta,
    parseDefaultRoutes, routerIp, routeInfo, parsePing, parseRouterStatus,
} from './lib.js';

const PING_HOST = '1.1.1.1';
const PING_EVERY_S = 6;
const CELL_EVERY_S = 5;
const HISTORY = 60;
const MARGIN_X = 14;
const MARGIN_Y = 4;
const CELL_BACKOFF_S = 300;
const ROUTER_MAX_BYTES = 64 * 1024;

const DOWN = [0.30, 0.78, 1.00];
const UP = [0.80, 0.58, 1.00];
const LEVEL = {
    good: { rgb: [0.29, 0.87, 0.50], word: 'GOOD', title: 'Good' },
    normal: { rgb: [0.98, 0.75, 0.14], word: 'NORMAL', title: 'Normal' },
    bad: { rgb: [0.97, 0.36, 0.36], word: 'BAD', title: 'Bad' },
    offline: { rgb: [0.97, 0.36, 0.36], word: 'OFFLINE', title: 'Offline' },
    wait: { rgb: [0.62, 0.65, 0.70], word: '…', title: 'Checking' },
};
const CELL = {
    '5G': [0.18, 0.92, 0.84],
    '4G+': [0.30, 0.78, 1.00],
    '4G': [0.98, 0.75, 0.14],
    '3G': [0.97, 0.45, 0.30],
    '2G': [0.97, 0.36, 0.36],
    'NO SIGNAL': [0.97, 0.36, 0.36],
};
const LAYOUTS = [
    ['big', 'Big — readable from far'],
    ['slim', 'Slim — thin, readable from far'],
    ['pill', 'Pill — compact'],
    ['status', 'Status only — Good / Normal / Bad'],
    ['card', 'Card — detailed'],
];

const STATE_PATH = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-net-widget', 'state.json']);
const css = ([r, g, b], a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;

const today = () => GLib.DateTime.new_now_local().format('%Y-%m-%d');
function readFile(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    return ok ? new TextDecoder().decode(bytes) : '';
}
function defaultRoutes() {
    try { return parseDefaultRoutes(readFile('/proc/net/route')); } catch (e) { return []; }
}
const defaultRouteIface = () => defaultRoutes()[0]?.iface ?? null;

// Count only interfaces backed by real hardware, so traffic is never counted
// twice through VPN tunnels, PPP, bridges, bonds or VLANs.
const _hw = new Map();
function isHardware(name) {
    if (!_hw.has(name))
        _hw.set(name, GLib.file_test(`/sys/class/net/${name}/device`, GLib.FileTest.EXISTS));
    return _hw.get(name);
}
function validPos(p) {
    if (!p || typeof p !== 'object') return null;
    const ok = Number.isInteger(p.mon) && ['left', 'right'].includes(p.ax) && ['top', 'bottom'].includes(p.ay) &&
        Number.isFinite(p.dx) && Number.isFinite(p.dy);
    return ok ? p : null;
}

const label = (style, props = {}) => new St.Label({ y_align: Clutter.ActorAlign.CENTER, style, ...props });

function drawGraph(area, rx, tx, lw = 1.6) {
    const cr = area.get_context();
    const [w, h] = area.get_surface_size();
    const max = Math.max(64 * 1024, ...rx, ...tx) * 1.15;
    const step = w / (HISTORY - 1);
    const y = v => h - 1 - (v / max) * (h - 3);
    cr.setSourceRGBA(1, 1, 1, 0.07);
    cr.setLineWidth(1);
    for (const f of [0.33, 0.66]) { cr.moveTo(0, Math.round(h * f) + 0.5); cr.lineTo(w, Math.round(h * f) + 0.5); }
    cr.stroke();
    const path = d => {
        cr.moveTo(0, y(d[0]));
        for (let i = 1; i < d.length; i++) {
            const xm = (i - 0.5) * step;
            cr.curveTo(xm, y(d[i - 1]), xm, y(d[i]), i * step, y(d[i]));
        }
    };
    path(rx); cr.lineTo(w, h); cr.lineTo(0, h); cr.closePath();
    const g = new Cairo.LinearGradient(0, 0, 0, h);
    g.addColorStopRGBA(0, ...DOWN, 0.45);
    g.addColorStopRGBA(1, ...DOWN, 0.03);
    cr.setSource(g); cr.fill();
    path(rx); cr.setSourceRGBA(...DOWN, 1); cr.setLineWidth(lw); cr.stroke();
    path(tx); cr.setSourceRGBA(...UP, 1); cr.setLineWidth(lw - 0.2); cr.stroke();
    cr.$dispose();
}

// ------------------------------------------------------------ cellular badge
const CELL_SIZES = {
    big: { font: 15, bar: 4, h: 16, gap: 2, vertical: true, margin: 16 },
    slim: { font: 12, bar: 3, h: 13, gap: 2, vertical: false, margin: 12 },
    small: { font: 10, bar: 3, h: 11, gap: 1, vertical: false, margin: 10 },
};
function cellBadge(size, extraStyle = null) {
    const z = CELL_SIZES[size];
    const actor = new St.BoxLayout({
        orientation: z.vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        y_align: Clutter.ActorAlign.CENTER, style: extraStyle ?? `margin-left: ${z.margin}px;`,
    });
    const text = new St.Label({ y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER });
    const bars = new St.BoxLayout({
        y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER,
        style: z.vertical ? 'margin-top: 3px;' : 'margin-left: 5px;',
    });
    const items = [];
    for (let i = 0; i < SIGNAL_MAX; i++) {
        const b = new St.Widget({ y_align: Clutter.ActorAlign.END });
        items.push(b);
        bars.add_child(b);
    }
    actor.add_child(text);
    actor.add_child(bars);
    actor.visible = false;
    return {
        actor,
        update(s) {
            const c = s.cell;
            actor.visible = !!c;
            if (!c) return;
            const rgb = CELL[c.type];
            text.text = c.type === 'NO SIGNAL' ? 'NO SIG' : c.type;
            text.style = `color: ${css(rgb)}; font-size: ${z.font}pt; font-weight: 900; text-shadow: 0 0 6px ${css(rgb, 0.6)};`;
            items.forEach((b, i) => {
                const h = Math.round(z.h * (i + 1) / SIGNAL_MAX);
                b.style = `width: ${z.bar}px; height: ${h}px; border-radius: 1px;${i ? ` margin-left: ${z.gap}px;` : ''}` +
                    ` background-color: ${i < c.bars ? css(rgb) : 'rgba(255,255,255,0.15)'};`;
            });
        },
    };
}

// ===================================================================== views
// Each view: .actor, update(s), onClick(s), optional setTop(bool), destroy via actor.

class BigView {
    constructor(s) {
        this._detail = !!s.bigDetail;
        this.actor = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, reactive: true });

        this._panel = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style: 'padding: 12px 4px 8px 4px; border-bottom: 1px solid rgba(255,255,255,0.08);' });
        this._graph = new St.DrawingArea({ style: 'height: 72px;', x_expand: true });
        this._graph.connect('repaint', a => drawGraph(a, s.rx, s.tx, 2));
        const info = new St.BoxLayout({ style: 'margin-top: 8px;' });
        this._route = label('color: rgba(255,255,255,0.65); font-size: 10.5pt;');
        this._loss = label('color: rgba(255,255,255,0.65); font-size: 10.5pt;');
        info.add_child(this._route);
        info.add_child(new St.Widget({ x_expand: true }));
        info.add_child(this._loss);
        const todayRow = new St.BoxLayout({ style: 'margin-top: 4px;' });
        todayRow.add_child(label('color: rgba(255,255,255,0.65); font-size: 10.5pt;', { text: 'Today' }));
        todayRow.add_child(new St.Widget({ x_expand: true }));
        this._todayDown = label(`color: ${css(DOWN)}; font-size: 11.5pt; font-weight: bold;`);
        this._todayUp = label(`color: ${css(UP)}; font-size: 11.5pt; font-weight: bold; margin-left: 12px;`);
        todayRow.add_child(this._todayDown);
        todayRow.add_child(this._todayUp);
        this._panel.add_child(this._graph);
        this._panel.add_child(info);
        this._panel.add_child(todayRow);

        this._bar = new St.BoxLayout({ style: 'padding: 5px 0;' });
        const R = 52;
        this._ring = new St.DrawingArea({ style: `width: ${R}px; height: ${R}px;`, y_align: Clutter.ActorAlign.CENTER });
        this._ring.connect('repaint', a => this._drawRing(a, s));
        this._bar.add_child(this._ring);
        this._down = this._speedBlock('↓', DOWN);
        this._up = this._speedBlock('↑', UP);
        this._bar.add_child(this._down.box);
        this._bar.add_child(this._up.box);
        this._cell = cellBadge('big');
        this._bar.add_child(this._cell.actor);

        this.actor.add_child(this._panel);
        this.actor.add_child(this._bar);
        this._panel.visible = this._detail;
    }

    _speedBlock(arrow, color) {
        const W = 96;
        const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, style: `margin-left: 14px; width: ${W}px;` });
        const row = new St.BoxLayout();
        row.add_child(label(`color: ${css(color)}; font-size: 18pt; font-weight: 900; margin-right: 2px;`, { text: arrow }));
        const value = label('color: #ffffff; font-size: 21pt; font-weight: 800; font-feature-settings: "tnum";', { text: '0' });
        const unit = label(`color: ${css(color)}; font-size: 8.5pt; font-weight: bold; margin-left: 4px; margin-top: 8px;`, { text: 'KB/s' });
        row.add_child(value);
        row.add_child(unit);
        const track = new St.Widget({ style: `height: 6px; width: ${W}px; border-radius: 3px; background-color: rgba(255,255,255,0.10); margin-top: 2px;` });
        const fill = new St.Widget({ style: `height: 6px; border-radius: 3px; background-color: ${css(color)};` });
        fill.set_width(0);
        track.add_child(fill);
        box.add_child(row);
        box.add_child(track);
        return { box, value, unit, fill, W };
    }

    _drawRing(area, s) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 4;
        const start = Math.PI * 0.75, sweep = Math.PI * 1.5;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(5);
        cr.setSourceRGBA(1, 1, 1, 0.10);
        cr.arc(cx, cy, r, start, start + sweep);
        cr.stroke();
        let frac = 0.12;
        if (s.level === 'offline') frac = 1;
        else if (s.ms !== null) frac = Math.max(0.08, Math.min(1, 1 - s.ms / 400));
        const L = LEVEL[s.level];
        cr.setSourceRGBA(...L.rgb, 1);
        cr.arc(cx, cy, r, start, start + sweep * frac);
        cr.stroke();
        const text = (str, font, rgba, yc) => {
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(Pango.FontDescription.from_string(font));
            layout.set_text(str, -1);
            const [, log] = layout.get_pixel_extents();
            cr.setSourceRGBA(...rgba);
            cr.moveTo(cx - log.width / 2 - log.x, yc - log.height / 2 - log.y);
            PangoCairo.show_layout(cr, layout);
        };
        const big = s.level === 'offline' ? '✕' : s.ms === null ? '…' : `${Math.round(s.ms)}`;
        text(big, 'Sans Heavy 13.5', [1, 1, 1, 1], cy - 3);
        text(L.word, 'Sans Bold 6', [...L.rgb, 1], cy + 12);
        cr.$dispose();
    }

    _setSpeed(b, bps) {
        const [v, u] = splitRate(bps);
        b.value.text = v;
        b.unit.text = u;
        b.fill.ease({ width: Math.round(b.W * meterFrac(bps)), duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    update(s) {
        const L = LEVEL[s.level];
        this.actor.style = `background-color: rgba(14,16,22,0.93); border: 2px solid ${css(L.rgb, 0.8)};` +
            `border-radius: 20px; box-shadow: 0 0 16px ${css(L.rgb, 0.35)}; padding: 0 18px 0 10px;`;
        this._ring.queue_repaint();
        this._setSpeed(this._down, s.rxs);
        this._setSpeed(this._up, s.txs);
        this._cell.update(s);
        this._route.text = `via ${routeInfo(s.iface).label}` + (s.cell?.operator ? `  ·  ${s.cell.operator}` : '');
        this._loss.text = s.ms === null ? '' : `${Math.round(s.ms)} ms · ${s.loss}% loss`;
        this._todayDown.text = `↓ ${fmtBytes(s.rxToday)}`;
        this._todayUp.text = `↑ ${fmtBytes(s.txToday)}`;
        if (this._detail) this._graph.queue_repaint();
    }

    setTop(top) {
        this.actor.set_child_at_index(this._panel, top ? 1 : 0);
    }

    onClick(s) {
        this._detail = !this._detail;
        s.bigDetail = this._detail;
        this._panel.visible = this._detail;
        this.update(s);
    }
}

class SlimView {
    constructor() {
        this.actor = new St.BoxLayout({ reactive: true, y_align: Clutter.ActorAlign.CENTER });
        this._chip = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this._chipText = label('');
        this._chip.add_child(this._chipText);
        this.actor.add_child(this._chip);
        this._down = this._block('↓', DOWN);
        this._up = this._block('↑', UP);
        this.actor.add_child(this._down.box);
        this.actor.add_child(this._up.box);
        this._cell = cellBadge('slim');
        this.actor.add_child(this._cell.actor);
    }

    _block(arrow, color) {
        const W = 84;
        const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, style: `margin-left: 12px; width: ${W}px;` });
        const row = new St.BoxLayout();
        row.add_child(label(`color: ${css(color)}; font-size: 14pt; font-weight: 900; margin-right: 2px;`, { text: arrow }));
        const value = label('color: #fff; font-size: 15pt; font-weight: 800; font-feature-settings: "tnum";', { text: '0' });
        const unit = label(`color: ${css(color)}; font-size: 7.5pt; font-weight: bold; margin-left: 3px; margin-top: 5px;`, { text: 'KB/s' });
        row.add_child(value);
        row.add_child(unit);
        const track = new St.Widget({ style: `height: 3px; width: ${W}px; border-radius: 2px; background-color: rgba(255,255,255,0.10);` });
        const fill = new St.Widget({ style: `height: 3px; border-radius: 2px; background-color: ${css(color)};` });
        fill.set_width(0);
        track.add_child(fill);
        box.add_child(row);
        box.add_child(track);
        return { box, value, unit, fill, W };
    }

    update(s) {
        const L = LEVEL[s.level];
        this.actor.style = `background-color: rgba(14,16,22,0.93); border: 2px solid ${css(L.rgb, 0.8)};` +
            `border-radius: 999px; box-shadow: 0 0 14px ${css(L.rgb, 0.35)}; padding: 4px 16px 4px 4px;`;
        this._chip.style = `background-color: ${css(L.rgb)}; border-radius: 999px; padding: 4px 12px;`;
        this._chipText.style = 'color: #0b0d12; font-size: 12pt; font-weight: 900; font-feature-settings: "tnum";';
        this._chipText.text = s.level === 'offline' ? 'OFFLINE' : s.ms === null ? '…' : `${Math.round(s.ms)} ms`;
        this._cell.update(s);
        for (const [b, bps] of [[this._down, s.rxs], [this._up, s.txs]]) {
            [b.value.text, b.unit.text] = splitRate(bps);
            b.fill.ease({ width: Math.round(b.W * meterFrac(bps)), duration: 500, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        }
    }

    onClick() {}
}

const PANEL_STYLE = 'background-color: rgba(17,19,26,0.86); border: 1px solid rgba(255,255,255,0.09);' +
    'border-radius: 18px; box-shadow: 0 6px 22px rgba(0,0,0,0.45);';

function statusPill() {
    const pill = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
    const dot = new St.Widget({ y_align: Clutter.ActorAlign.CENTER });
    const text = label('');
    pill.add_child(dot);
    pill.add_child(text);
    return {
        actor: pill,
        update(s, { big = false, showMs = true } = {}) {
            const L = LEVEL[s.level];
            const col = css(L.rgb);
            const d = big ? 10 : 8;
            dot.style = `width: ${d}px; height: ${d}px; border-radius: ${d / 2}px; background-color: ${col}; margin-right: ${big ? 8 : 7}px; box-shadow: 0 0 ${big ? 8 : 6}px ${col};`;
            pill.style = `background-color: ${css(L.rgb, big ? 0.16 : 0.14)}; border-radius: 999px; padding: ${big ? '4px 14px 4px 10px' : '3px 10px 3px 8px'};`;
            text.style = `color: ${col}; font-size: ${big ? 11 : 9.5}pt; font-weight: bold;`;
            text.text = showMs && s.ms !== null ? `${L.title}  ·  ${Math.round(s.ms)} ms` : L.title;
        },
    };
}

class PillView {
    constructor() {
        this.actor = new St.BoxLayout({ reactive: true, y_align: Clutter.ActorAlign.CENTER, style: `${PANEL_STYLE} padding: 7px 12px;` });
        this._pill = statusPill();
        this._down = label(`color: ${css(DOWN)}; font-size: 10pt; font-weight: bold; margin-left: 10px; font-feature-settings: "tnum";`);
        this._up = label(`color: ${css(UP)}; font-size: 10pt; font-weight: bold; margin-left: 10px; font-feature-settings: "tnum";`);
        this._cell = cellBadge('small');
        this.actor.add_child(this._pill.actor);
        this.actor.add_child(this._down);
        this.actor.add_child(this._up);
        this.actor.add_child(this._cell.actor);
    }

    update(s) {
        this._pill.update(s);
        this._down.text = `↓ ${fmtRate(s.rxs)}`;
        this._up.text = `↑ ${fmtRate(s.txs)}`;
        this._cell.update(s);
    }

    onClick() {}
}

class StatusView {
    constructor() {
        this.actor = new St.BoxLayout({ reactive: true, y_align: Clutter.ActorAlign.CENTER, style: `${PANEL_STYLE} padding: 6px;` });
        this._pill = statusPill();
        this.actor.add_child(this._pill.actor);
        // activity lights: blink when data is moving, dim when idle
        const act = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: 'margin-left: 8px; margin-right: 6px;' });
        this._rxIcon = label('', { text: '↓' });
        this._txIcon = label('', { text: '↑' });
        act.add_child(this._rxIcon);
        act.add_child(this._txIcon);
        this.actor.add_child(act);
        this._cell = cellBadge('small', 'margin-left: 2px; margin-right: 8px;');
        this.actor.add_child(this._cell.actor);
        this._lastSeq = -1;
        this._activity(this._rxIcon, 0, DOWN, -1);
        this._activity(this._txIcon, 0, UP, 1);
    }

    _activity(icon, bps, rgb, dir) {
        const base = `font-size: 15pt; font-weight: 900;${dir > 0 ? ' margin-left: 2px;' : ''}`;
        icon.remove_all_transitions();
        if (bps < 2048) {
            icon.style = `color: rgba(255,255,255,0.22); ${base}`;
            icon.opacity = 255;
            icon.translation_y = 0;
            return;
        }
        icon.style = `color: ${css(rgb)}; text-shadow: 0 0 8px ${css(rgb, 0.9)}; ${base}`;
        // blink + nudge in the direction of travel; busier = brighter resting glow
        icon.opacity = 255;
        icon.translation_y = 3 * dir;
        icon.ease({ translation_y: 0, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_BACK });
        icon.ease({ opacity: Math.round(120 + 120 * meterFrac(bps)), duration: 850, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    update(s) {
        this._pill.update(s, { big: true, showMs: false });
        this._cell.update(s);
        if (s.seq !== this._lastSeq) {
            this._lastSeq = s.seq;
            const off = s.level === 'offline';
            this._activity(this._rxIcon, off ? 0 : s.rxs, DOWN, -1);
            this._activity(this._txIcon, off ? 0 : s.txs, UP, 1);
        }
    }

    onClick() {}
}

class CardView {
    constructor(s) {
        const CARD_W = 248;
        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, reactive: true,
            style: `${PANEL_STYLE} padding: 12px 14px 11px 14px;`,
        });
        const header = new St.BoxLayout();
        this._pill = statusPill();
        header.add_child(this._pill.actor);
        header.add_child(new St.Widget({ x_expand: true }));
        this._cell = cellBadge('small', 'margin-right: 10px;');
        header.add_child(this._cell.actor);
        this._routeIcon = new St.Icon({ icon_size: 13, y_align: Clutter.ActorAlign.CENTER, style: 'color: rgba(255,255,255,0.55);' });
        this._routeLabel = label('color: rgba(255,255,255,0.55); font-size: 9pt; margin-left: 5px;');
        header.add_child(this._routeIcon);
        header.add_child(this._routeLabel);

        const speeds = new St.BoxLayout({ style: 'margin-top: 10px;' });
        const col = (cap, arrow, color) => {
            const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, style: `width: ${CARD_W / 2}px;` });
            const c = new St.BoxLayout();
            c.add_child(label(`color: ${css(color)}; font-size: 9pt; font-weight: bold;`, { text: arrow }));
            c.add_child(label('color: rgba(255,255,255,0.45); font-size: 7pt; font-weight: bold; margin-left: 4px;', { text: cap }));
            const row = new St.BoxLayout();
            const value = label('color: #fff; font-size: 19pt; font-weight: 800; font-feature-settings: "tnum";', { text: '–' });
            const unit = new St.Label({ y_align: Clutter.ActorAlign.END, style: 'color: rgba(255,255,255,0.5); font-size: 8.5pt; margin-left: 4px; margin-bottom: 4px;' });
            row.add_child(value);
            row.add_child(unit);
            box.add_child(c);
            box.add_child(row);
            speeds.add_child(box);
            return { value, unit };
        };
        this._d = col('DOWNLOAD', '↓', DOWN);
        this._u = col('UPLOAD', '↑', UP);

        this._graph = new St.DrawingArea({ style: `width: ${CARD_W}px; height: 44px; margin-top: 8px;` });
        this._graph.connect('repaint', a => drawGraph(a, s.rx, s.tx));

        const footer = new St.BoxLayout({ style: 'margin-top: 8px;' });
        footer.add_child(label('color: rgba(255,255,255,0.45); font-size: 8.5pt;', { text: 'Today' }));
        footer.add_child(new St.Widget({ x_expand: true }));
        this._tD = label(`color: ${css(DOWN)}; font-size: 8.5pt;`);
        this._tU = label(`color: ${css(UP)}; font-size: 8.5pt; margin-left: 10px;`);
        footer.add_child(this._tD);
        footer.add_child(this._tU);

        this.actor.add_child(header);
        this.actor.add_child(speeds);
        this.actor.add_child(this._graph);
        this.actor.add_child(footer);
    }

    update(s) {
        this._pill.update(s);
        const r = routeInfo(s.iface);
        this._routeIcon.icon_name = r.icon;
        this._routeLabel.text = r.label;
        this._cell.update(s);
        [this._d.value.text, this._d.unit.text] = splitRate(s.rxs);
        [this._u.value.text, this._u.unit.text] = splitRate(s.txs);
        this._tD.text = `↓ ${fmtBytes(s.rxToday)}`;
        this._tU.text = `↑ ${fmtBytes(s.txToday)}`;
        this._graph.queue_repaint();
    }

    onClick() {}
}

const VIEWS = { big: BigView, slim: SlimView, pill: PillView, status: StatusView, card: CardView };

// ==================================================================== widget
export class NetWidget {
    constructor() {
        try {
            this._init();
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _init() {
        this._cancellable = new Gio.Cancellable();
        this.s = {
            rx: new Array(HISTORY).fill(0), tx: new Array(HISTORY).fill(0),
            rxs: 0, txs: 0, seq: 0, level: 'wait', ms: null, loss: 0,
            iface: defaultRouteIface(), cell: null,
        };
        this._loadState();
        this._monId = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._setLayout(this.s.layout);

        this._http = new Soup.Session({ timeout: 4 });
        this._tick();
        this._ping();
        this._pollCell();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => { this._tick(); return GLib.SOURCE_CONTINUE; });
        this._pingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PING_EVERY_S, () => { this._ping(); return GLib.SOURCE_CONTINUE; });
        this._cellId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CELL_EVERY_S, () => { this._pollCell(); return GLib.SOURCE_CONTINUE; });
        this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => { this._saveState(); return GLib.SOURCE_CONTINUE; });
    }

    // ---------------- layout, menu, dragging ----------------
    _setLayout(name) {
        if (!VIEWS[name]) name = 'big';
        this._destroyView();
        this.s.layout = name;
        this.view = new VIEWS[name](this.s);
        const a = this.view.actor;
        Main.layoutManager.addChrome(a, { trackFullscreen: true });
        this._sizeId = a.connect('notify::size', () => this._reposition());

        a.connect('button-press-event', (_a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            const [px, py] = ev.get_coords();
            this._drag = { px, py, ax: a.x, ay: a.y, moved: false, grab: global.stage.grab(a) };
            return Clutter.EVENT_STOP;
        });
        a.connect('motion-event', (_a, ev) => {
            const d = this._drag;
            if (!d) return Clutter.EVENT_PROPAGATE;
            const [px, py] = ev.get_coords();
            const dx = px - d.px, dy = py - d.py;
            if (!d.moved && Math.hypot(dx, dy) < 5) return Clutter.EVENT_STOP;
            d.moved = true;
            const sw = global.stage.width, sh = global.stage.height;
            a.set_position(Math.round(Math.max(0, Math.min(sw - a.width, d.ax + dx))),
                Math.round(Math.max(0, Math.min(sh - a.height, d.ay + dy))));
            return Clutter.EVENT_STOP;
        });
        a.connect('button-release-event', (_a, ev) => {
            if (ev.get_button() === Clutter.BUTTON_SECONDARY) {
                this._menu.toggle();
                return Clutter.EVENT_STOP;
            }
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY || !this._drag) return Clutter.EVENT_PROPAGATE;
            const d = this._drag;
            this._drag = null;
            d?.grab?.dismiss();
            if (d?.moved) this._storePosition();
            else this.view.onClick(this.s);
            this._saveState();
            this._reposition();
            return Clutter.EVENT_STOP;
        });

        this._menu = new PopupMenu.PopupMenu(a, 0.5, St.Side.BOTTOM);
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        this._menuMgr = new PopupMenu.PopupMenuManager(a);
        this._menuMgr.addMenu(this._menu);
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Layout'));
        for (const [key, title] of LAYOUTS) {
            const item = new PopupMenu.PopupMenuItem(title);
            item.setOrnament(key === name ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                if (this._switchId) GLib.source_remove(this._switchId);
                this._switchId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._switchId = null;
                    if (this.view) { this._setLayout(key); this._saveState(); }
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._menu.addMenuItem(item);
        }
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const reset = new PopupMenu.PopupMenuItem('Move back to corner');
        reset.connect('activate', () => { this.s.pos = null; this._saveState(); this._reposition(); });
        this._menu.addMenuItem(reset);
        this._menu.addMenuItem(new PopupMenu.PopupMenuItem('Tip: drag to move, right-click for this menu', { reactive: false }));

        this.view.update(this.s);
        this._reposition();
    }

    _destroyView() {
        this._drag?.grab?.dismiss();
        this._drag = null;
        if (this._menu) { this._menu.destroy(); this._menu = null; this._menuMgr = null; }
        if (this.view) {
            const a = this.view.actor;
            a.disconnect(this._sizeId);
            Main.layoutManager.removeChrome(a);
            a.destroy();
            this.view = null;
        }
    }

    _monitorAt(x, y) {
        const mons = Main.layoutManager.monitors;
        for (let i = 0; i < mons.length; i++) {
            const m = mons[i];
            if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) return i;
        }
        return Main.layoutManager.primaryIndex;
    }

    _storePosition() {
        const a = this.view.actor;
        const [w, h] = a.get_size();
        const cx = a.x + w / 2, cy = a.y + h / 2;
        const mi = this._monitorAt(cx, cy);
        const m = Main.layoutManager.monitors[mi];
        const left = cx < m.x + m.width / 2, top = cy < m.y + m.height / 2;
        this.s.pos = {
            mon: mi, ax: left ? 'left' : 'right', ay: top ? 'top' : 'bottom',
            dx: Math.round(left ? a.x - m.x : m.x + m.width - (a.x + w)),
            dy: Math.round(top ? a.y - m.y : m.y + m.height - (a.y + h)),
        };
    }

    _reposition() {
        const a = this.view?.actor;
        if (!a || this._drag) return;
        const p = this.s.pos;
        const mon = (p && Main.layoutManager.monitors[p.mon]) || Main.layoutManager.primaryMonitor;
        if (!mon) return;
        const [w, h] = a.get_size();
        const ax = p?.ax ?? 'right', ay = p?.ay ?? 'bottom';
        const dx = Math.max(0, p?.dx ?? MARGIN_X), dy = Math.max(0, p?.dy ?? MARGIN_Y);
        let x = ax === 'left' ? mon.x + dx : mon.x + mon.width - w - dx;
        let y = ay === 'top' ? mon.y + dy : mon.y + mon.height - h - dy;
        x = Math.max(mon.x, Math.min(mon.x + mon.width - w, x));
        y = Math.max(mon.y, Math.min(mon.y + mon.height - h, y));
        this.view.setTop?.(ay === 'top');
        a.set_position(Math.round(x), Math.round(y));
    }

    // ---------------- data ----------------
    _tick() {
        const s = this.s;
        const now = GLib.get_monotonic_time() / 1e6;
        let cur = {};
        try { cur = parseNetDev(readFile('/proc/net/dev'), isHardware); } catch (e) { console.error(`net-widget: ${e}`); }
        if (this._prev) {
            const { rx: drx, tx: dtx } = counterDelta(this._prev, cur);
            const dt = Math.max(now - this._prevTime, 0.001);
            s.rxs = drx / dt; s.txs = dtx / dt;
            const d = today();
            if (d !== s.day) { s.day = d; s.rxToday = 0; s.txToday = 0; }
            s.rxToday += drx; s.txToday += dtx;
            s.seq++;
            s.rx.push(s.rxs); s.rx.shift();
            s.tx.push(s.txs); s.tx.shift();
            this.view?.update(s);
        }
        this._prev = cur;
        this._prevTime = now;
    }

    _ping() {
        if (this._pinging || !this._cancellable) return;
        const s = this.s;
        s.iface = defaultRouteIface();
        this._pinging = true;
        let proc;
        try {
            proc = Gio.Subprocess.new(['ping', '-n', '-q', '-c', String(PING_COUNT), '-i', '0.2', '-W', '2', PING_HOST],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            this._pinging = false;
            s.level = 'offline'; s.ms = null;
            return;
        }
        this._pingProc = proc;
        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            this._pinging = false;
            this._pingProc = null;
            let out = '';
            try { [, out] = p.communicate_utf8_finish(res); } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
            }
            if (!this.view) return;
            const r = parsePing(out);
            s.level = r.level; s.ms = r.ms; s.loss = r.loss;
            this.view.update(s);
        });
    }

    _pollCell() {
        if (this._cellBusy || !this._http) return;
        const now = GLib.get_monotonic_time() / 1e6;
        const ip = routerIp(defaultRoutes());
        if (ip !== this._cellIp) { this._cellIp = ip; this._cellRetryAt = 0; }
        if (!ip) { this.s.cell = null; return; }
        if (now < (this._cellRetryAt || 0)) return;
        let msg;
        try { msg = Soup.Message.new('POST', `http://${ip}/cgi-bin/http.cgi`); } catch (e) { return; }
        const body = JSON.stringify({ cmd: 113, method: 'GET', language: 'EN', sessionId: '' });
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(body)));
        // LAN only: never follow a redirect (captive portals) to another host.
        msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
        this._cellBusy = true;
        this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable, (sess, res) => {
            this._cellBusy = false;
            let cell = null;
            try {
                const bytes = sess.send_and_read_finish(res);
                if (msg.get_status() === 200 && bytes.get_size() <= ROUTER_MAX_BYTES) {
                    cell = parseRouterStatus(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                }
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
            }
            if (!this.view) return;
            // Not a supported router (or unreachable): ask again only every few minutes.
            this._cellRetryAt = cell ? 0 : GLib.get_monotonic_time() / 1e6 + CELL_BACKOFF_S;
            this.s.cell = cell;
            this.view.update(this.s);
        });
    }

    _loadState() {
        const s = this.s;
        s.day = today(); s.rxToday = 0; s.txToday = 0; s.layout = 'big'; s.bigDetail = false; s.pos = null;
        try {
            const j = JSON.parse(readFile(STATE_PATH));
            if (j.layout) s.layout = j.layout;
            s.bigDetail = !!j.bigDetail;
            s.pos = validPos(j.pos);
            if (j.day === s.day) { s.rxToday = j.rx || 0; s.txToday = j.tx || 0; }
        } catch (e) { /* first run */ }
    }

    _saveState() {
        const s = this.s;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_PATH), 0o755);
            GLib.file_set_contents(STATE_PATH, JSON.stringify({
                day: s.day, rx: s.rxToday, tx: s.txToday, layout: s.layout, bigDetail: s.bigDetail, pos: s.pos,
            }));
        } catch (e) { console.error(`net-widget: ${e}`); }
    }

    destroy() {
        for (const id of [this._tickId, this._pingId, this._saveId, this._cellId, this._switchId]) if (id) GLib.source_remove(id);
        this._tickId = this._pingId = this._saveId = this._cellId = this._switchId = null;
        try { this._pingProc?.force_exit(); } catch (e) { /* already gone */ }
        this._pingProc = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._http?.abort();
        this._http = null;
        if (this._monId) Main.layoutManager.disconnect(this._monId);
        this._monId = null;
        this._saveState();
        this._destroyView();
    }
}

