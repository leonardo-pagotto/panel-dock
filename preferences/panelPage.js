// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MONITOR_PANELS_KEY = 'monitor-panels';

function panelIcons() {
    return [
        {id: 'activities', title: _('Activities')},
        {id: 'dateMenu', title: _('Clock')},
        {id: 'quickSettings', title: _('Quick Settings')},
    ];
}

function monitorLabel(monitor, index) {
    const description = monitor.get_description();
    const connector = monitor.get_connector();
    const title = description || connector || _('Monitor %d').format(index + 1);

    const geometry = monitor.get_geometry();
    const parts = [];

    if (connector && connector !== title)
        parts.push(connector);

    parts.push(`${geometry.width}×${geometry.height}`);

    const refresh = Math.round(monitor.get_refresh_rate() / 1000);
    if (refresh > 0)
        parts.push(_('%d Hz').format(refresh));

    const scalePercent = Math.round(monitor.get_scale() * 100);
    if (scalePercent !== 100)
        parts.push(_('%d%%').format(scalePercent));

    return {
        title,
        subtitle: parts.join(' · '),
        connector: connector || `monitor-${index}`,
    };
}

function readMonitorPanels(settings) {
    return settings.get_value(MONITOR_PANELS_KEY).recursiveUnpack();
}

function packMonitorEntry(entry) {
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

function writeMonitorPanels(settings, panels) {
    const packed = {};

    for (const [connector, entry] of Object.entries(panels))
        packed[connector] = packMonitorEntry(entry);

    settings.set_value(MONITOR_PANELS_KEY, GLib.Variant.new('a{sa{sv}}', packed));
}

function monitorEntry(settings, connector) {
    const stored = readMonitorPanels(settings)[connector] ?? {};

    return {
        'panel-enabled': stored['panel-enabled'] !== false,
        icons: {...(stored.icons ?? {})},
    };
}

function updateMonitor(settings, connector, mutate) {
    const panels = readMonitorPanels(settings);
    const entry = monitorEntry(settings, connector);
    mutate(entry);
    panels[connector] = entry;
    writeMonitorPanels(settings, panels);
}

export class PanelPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    _init(settings) {
        super._init({
            title: _('Panel'),
            icon_name: 'preferences-desktop-display-symbolic',
            name: 'panel',
        });

        this._settings = settings;
        this._monitorRows = [];
        this._monitorsChangedId = 0;
        this._updating = false;

        this._monitorsGroup = new Adw.PreferencesGroup({
            title: _('Monitors'),
            description: _('The panel switch and icon settings are stored per monitor for a future version.'),
        });
        this.add(this._monitorsGroup);

        const display = Gdk.Display.get_default();
        this._monitors = display?.get_monitors() ?? null;

        if (this._monitors) {
            this._monitorsChangedId = this._monitors.connect('items-changed', () => {
                this._reloadMonitors();
            });
        }

        // Drop the monitor watch when the page leaves the window. A dispose
        // vfunc runs too late: GJS refuses it during garbage collection.
        this.connect('notify::root', () => {
            if (!this.get_root())
                this._disconnectMonitors();
        });

        this._reloadMonitors();
    }

    _disconnectMonitors() {
        if (!this._monitorsChangedId)
            return;

        this._monitors.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;
    }

    _reloadMonitors() {
        this._updating = true;

        for (const row of this._monitorRows)
            this._monitorsGroup.remove(row);

        this._monitorRows = [];

        const count = this._monitors?.get_n_items() ?? 0;
        if (count === 0) {
            this._addMonitorRow(new Adw.ActionRow({
                title: _('No monitors found'),
                activatable: false,
            }));
            this._updating = false;
            return;
        }

        for (let i = 0; i < count; i++)
            this._addMonitor(this._monitors.get_item(i), i);

        this._updating = false;
    }

    _addMonitor(monitor, index) {
        const {title, subtitle, connector} = monitorLabel(monitor, index);
        const entry = monitorEntry(this._settings, connector);
        const row = new Adw.ExpanderRow({
            title,
            subtitle,
            icon_name: 'video-display-symbolic',
            show_enable_switch: true,
            enable_expansion: entry['panel-enabled'],
            expanded: entry['panel-enabled'],
        });

        const iconRows = [];

        row.connect('notify::enable-expansion', () => {
            if (this._updating)
                return;

            const enabled = row.enable_expansion;
            updateMonitor(this._settings, connector, monitorSettings => {
                monitorSettings['panel-enabled'] = enabled;
            });

            if (enabled)
                row.expanded = true;

            for (const iconRow of iconRows)
                iconRow.sensitive = enabled;
        });

        for (const icon of panelIcons()) {
            const check = new Gtk.CheckButton({
                active: entry.icons[icon.id] !== false,
                valign: Gtk.Align.CENTER,
            });
            const iconRow = new Adw.ActionRow({
                title: icon.title,
                activatable_widget: check,
                sensitive: entry['panel-enabled'],
            });
            check.connect('notify::active', () => {
                if (this._updating)
                    return;

                updateMonitor(this._settings, connector, monitorSettings => {
                    monitorSettings.icons[icon.id] = check.active;
                });
            });
            iconRow.add_suffix(check);
            row.add_row(iconRow);
            iconRows.push(iconRow);
        }

        this._addMonitorRow(row);
    }

    _addMonitorRow(row) {
        this._monitorsGroup.add(row);
        this._monitorRows.push(row);
    }
}
