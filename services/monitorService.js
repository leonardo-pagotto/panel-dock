// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {MONITOR_PANELS_KEY} from '../lib/settingsKeys.js';

export class MonitorService {
    constructor(settings) {
        this._settings = settings;
    }

    entry(connector) {
        const stored = this._readPanels()[connector] ?? {};

        return {
            'panel-enabled': stored['panel-enabled'] !== false,
            icons: {...(stored.icons ?? {})},
        };
    }

    update(connector, mutate) {
        const panels = this._readPanels();
        const entry = this.entry(connector);
        mutate(entry);
        panels[connector] = entry;
        this._writePanels(panels);
    }

    _readPanels() {
        return this._settings.get_value(MONITOR_PANELS_KEY).recursiveUnpack();
    }

    _packEntry(entry) {
        const packedIcons = {};
        const fields = {
            'panel-enabled': GLib.Variant.new('b', entry['panel-enabled'] !== false),
        };

        for (const [id, enabled] of Object.entries(entry.icons ?? {})) {
            if (typeof enabled === 'boolean')
                packedIcons[id] = enabled;
        }

        if (Object.keys(packedIcons).length > 0)
            fields.icons = GLib.Variant.new('a{sb}', packedIcons);

        // a{sa{sv}} wants a plain dictionary here. A nested Variant is packed twice.
        return fields;
    }

    _writePanels(panels) {
        const packed = {};

        for (const [connector, entry] of Object.entries(panels))
            packed[connector] = this._packEntry(entry);

        this._settings.set_value(MONITOR_PANELS_KEY, GLib.Variant.new('a{sa{sv}}', packed));
    }
}
