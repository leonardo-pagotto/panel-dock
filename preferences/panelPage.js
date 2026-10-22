// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PANEL_ICONS_KEY} from '../lib/settingsKeys.js';
import {monitorLabel} from './utils/monitorLabel.js';
import {MonitorService} from '../services/monitorService.js';

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
        this._monitorService = new MonitorService(settings);
        this._monitorRows = [];
        this._monitorsChangedId = 0;
        this._panelIconsChangedId = settings.connect(`changed::${PANEL_ICONS_KEY}`, () => {
            this._reloadMonitors();
        });
        this._updating = false;

        this._monitorsGroup = new Adw.PreferencesGroup({
            title: _('Monitors'),
            description: _('Show the top bar on a monitor and choose which buttons it shows.'),
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
        if (this._panelIconsChangedId) {
            this._settings.disconnect(this._panelIconsChangedId);
            this._panelIconsChangedId = 0;
        }

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
        const entry = this._monitorService.entry(connector);
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
            this._monitorService.update(connector, monitorSettings => {
                monitorSettings['panel-enabled'] = enabled;
            });

            if (enabled)
                row.expanded = true;

            for (const iconRow of iconRows)
                iconRow.sensitive = enabled;
        });

        for (const icon of this._panelIcons(this._settings)) {
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

                this._monitorService.update(connector, monitorSettings => {
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

    _panelIcons(settings) {
        const labels = settings.get_value(PANEL_ICONS_KEY).deepUnpack();

        return Object.keys(labels).map(id => ({
            id,
            title: labels[id] || id,
        }));
    }
}
