// Net Widget — GNOME Shell extension entry point.
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { NetWidget } from './widget.js';

export default class NetWidgetExtension extends Extension {
    enable() {
        this._widget = new NetWidget();
    }

    disable() {
        this._widget?.destroy();
        this._widget = null;
    }
}
