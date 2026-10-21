// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DOCK_ORIENTATION_KEY = 'dock-orientation';

function dockOrientations() {
    return [
        {id: 'top', title: _('Top')},
        {id: 'bottom', title: _('Bottom')},
    ];
}

export class DockPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    _init(settings) {
        super._init({
            title: _('Dock'),
            icon_name: 'view-app-grid-symbolic',
            name: 'dock',
        });

        this._settings = settings;

        const group = new Adw.PreferencesGroup({
            title: _('Dock'),
            description: _('Orientation is stored for a future version.'),
        });
        this.add(group);

        const orientations = dockOrientations();
        const selected = this._selectedOrientation(orientations);
        this._orientationRow = new Adw.ComboRow({
            title: _('Orientation'),
            model: Gtk.StringList.new(orientations.map(item => item.title)),
            selected,
        });
        this._orientationRow.connect('notify::selected', () => {
            this._saveOrientation(orientations);
        });
        group.add(this._orientationRow);
    }

    _selectedOrientation(orientations) {
        const value = this._settings.get_string(DOCK_ORIENTATION_KEY);
        const index = orientations.findIndex(item => item.id === value);

        if (index >= 0)
            return index;

        return orientations.findIndex(item => item.id === 'bottom');
    }

    _saveOrientation(orientations) {
        const item = orientations[this._orientationRow.selected];
        if (!item)
            return;

        if (this._settings.get_string(DOCK_ORIENTATION_KEY) === item.id)
            return;

        this._settings.set_string(DOCK_ORIENTATION_KEY, item.id);
    }
}
