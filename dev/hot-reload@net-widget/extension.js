// Hot-reload loader for GNOME Shell extension development (Wayland-friendly). The visible widget lives in widget-<N>.js; the loader
// imports the highest N and hot-swaps it when a new file appears, so the
// design can change without logging out (Wayland caches ES modules).
// Touching ~/.cache/hot-reload/snap-request saves a screenshot of the corner
// to ~/.cache/hot-reload/snap.png.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'hot-reload']);

export default class HotReloadLoader extends Extension {
    enable() {
        this._alive = true;
        this._widget = null;
        this._loadedName = null;
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);

        this._dirMon = this.dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._dirMonId = this._dirMon.connect('changed', (_m, file) => {
            if (/^widget-\d+\.js$/.test(file.get_basename())) this._scheduleReload();
        });
        this._cacheMon = Gio.File.new_for_path(CACHE_DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._cacheMonId = this._cacheMon.connect('changed', (_m, file, _o, ev) => {
            if (file.get_basename() === 'snap-request' && ev === Gio.FileMonitorEvent.CREATED) {
                try { file.delete(null); } catch (e) {}
                this._snap();
            }
        });
        this._reload();
    }

    disable() {
        this._alive = false;
        if (this._reloadId) GLib.source_remove(this._reloadId);
        this._reloadId = null;
        this._dirMon?.disconnect(this._dirMonId);
        this._dirMon?.cancel();
        this._cacheMon?.disconnect(this._cacheMonId);
        this._cacheMon?.cancel();
        this._dirMon = this._cacheMon = null;
        this._destroyWidget();
    }

    _scheduleReload() {
        if (this._reloadId) GLib.source_remove(this._reloadId);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._reloadId = null;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _newestWidgetFile() {
        let best = null, bestN = -1;
        const en = this.dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            const m = info.get_name().match(/^widget-(\d+)\.js$/);
            if (m && Number(m[1]) > bestN) { bestN = Number(m[1]); best = info.get_name(); }
        }
        en.close(null);
        return best;
    }

    async _reload() {
        const name = this._newestWidgetFile();
        if (!name || name === this._loadedName) return;
        try {
            const mod = await import(this.dir.get_child(name).get_uri());
            if (!this._alive) return;
            // Keep the running widget if the new file is empty or half-written.
            if (typeof mod.createWidget !== 'function') throw new Error(`${name} does not export createWidget()`);
            this._destroyWidget();
            this._widget = mod.createWidget(this);
            this._loadedName = name;
        } catch (e) {
            console.error(`hot-reload: failed to load ${name}: ${e}\n${e.stack}`);
        }
    }

    _destroyWidget() {
        try { this._widget?.destroy(); } catch (e) { console.error(`hot-reload: ${e}`); }
        this._widget = null;
        this._loadedName = null;
    }

    _snap() {
        const mon = Main.layoutManager.primaryMonitor;
        const w = Math.min(700, mon.width), h = Math.min(360, mon.height);
        const path = GLib.build_filenamev([CACHE_DIR, 'snap.png']);
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        const shot = new Shell.Screenshot();
        shot.screenshot_area(mon.x + mon.width - w, mon.y + mon.height - h, w, h, stream, (o, res) => {
            try { o.screenshot_area_finish(res); } catch (e) { console.error(`hot-reload snap: ${e}`); }
            stream.close(null);
        });
    }
}
