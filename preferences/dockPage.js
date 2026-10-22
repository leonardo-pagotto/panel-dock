// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    DOCK_ANIMATION_DURATION_KEY,
    DOCK_AUTOHIDE_IN_FULLSCREEN_KEY,
    DOCK_AUTOHIDE_KEY,
    DOCK_AUTOHIDE_URGENT_KEY,
    DOCK_HIDE_TIMEOUT_KEY,
    DOCK_ORIENTATION_KEY,
    DOCK_PRESSURE_THRESHOLD_KEY,
    DOCK_PRESSURE_TO_ACTIVATE_KEY,
} from '../lib/settingsKeys.js';

function dockOrientations() {
    return [
        {id: 'bottom', title: _('Bottom')},
        {id: 'left', title: _('Left')},
        {id: 'right', title: _('Right')},
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

        const autohide = new Adw.PreferencesGroup({
            title: _('Autohide'),
            description: _('Hide the dock on the desktop. It stays open in the overview.'),
        });
        this.add(autohide);

        const autohideRow = this._switchRow(DOCK_AUTOHIDE_KEY, _('Autohide'), null);
        const pressureRow = this._switchRow(
            DOCK_PRESSURE_TO_ACTIVATE_KEY,
            _('Pressure to activate'),
            _('Press the pointer against the bottom edge. Moving into the dock area shows it when this is off.'));
        const urgentRow = this._switchRow(
            DOCK_AUTOHIDE_URGENT_KEY,
            _('Show on urgent notification'),
            _('Reveal the dock when a critical notification arrives.'));
        const fullscreenRow = this._switchRow(
            DOCK_AUTOHIDE_IN_FULLSCREEN_KEY,
            _('Enable in fullscreen mode'),
            _('Reveal the dock while a window is fullscreen.'));

        const animation = new Adw.PreferencesGroup({
            title: _('Animation'),
        });
        this.add(animation);

        const durationRow = this._spinRow(
            DOCK_ANIMATION_DURATION_KEY,
            _('Animation duration (ms)'),
            _('How long the dock takes to show and hide, in milliseconds.'),
            0, 2000, 10);
        const hideRow = this._spinRow(
            DOCK_HIDE_TIMEOUT_KEY,
            _('Hide timeout (ms)'),
            _('How long the pointer must stay away before the dock hides, in milliseconds.'),
            0, 5000, 10);
        const thresholdRow = this._spinRow(
            DOCK_PRESSURE_THRESHOLD_KEY,
            _('Pressure threshold (px)'),
            _('How far the pointer must press against the edge, in pixels.'),
            0, 500, 10);

        const followAutohide = () => {
            const enabled = autohideRow.active;
            pressureRow.sensitive = enabled;
            urgentRow.sensitive = enabled;
            fullscreenRow.sensitive = enabled;
            durationRow.sensitive = enabled;
            hideRow.sensitive = enabled;
            thresholdRow.sensitive = enabled && pressureRow.active;
        };
        followAutohide();
        autohideRow.connect('notify::active', followAutohide);
        pressureRow.connect('notify::active', followAutohide);

        autohide.add(autohideRow);
        autohide.add(pressureRow);
        autohide.add(urgentRow);
        autohide.add(fullscreenRow);
        animation.add(durationRow);
        animation.add(hideRow);
        animation.add(thresholdRow);
    }

    _spinRow(key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 5,
                value: this._settings.get_int(key),
            }),
        });
        row.adjustment.connect('value-changed', () => {
            const next = Math.round(row.adjustment.value);
            if (this._settings.get_int(key) !== next)
                this._settings.set_int(key, next);
        });
        return row;
    }

    _switchRow(key, title, subtitle) {
        const row = new Adw.SwitchRow({title});
        if (subtitle)
            row.subtitle = subtitle;

        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
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
