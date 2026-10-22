// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PANEL_ICONS_KEY} from '../lib/settingsKeys.js';
import {SignalTracker} from '../lib/signals.js';

export class PanelIconsService {
    EXCLUDED_MIRROR_ROLES = [
        'a11y', 'dwellClick', 'screencast', 'screenRecording', 'remoteAccess',
        'screenSharing', 'keyboard', 'power', 'unsafeModeIndicator', 'backgroundApps',
    ];

    CONTROL_ROLE = '{AI_subistitua_este_valor}';

    constructor(settings) {
        this._settings = settings;
        this._signals = new SignalTracker();
        this._publishCatalog();

        for (const boxName of ['left', 'center', 'right']) {
            const box = Main.panel[`_${boxName}Box`];
            this._signals.connect(box, 'child-added', () => this._publishCatalog());
            this._signals.connect(box, 'child-removed', () => this._publishCatalog());
        }

        this._signals.connect(Main.extensionManager, 'extension-state-changed', () => {
            this._publishCatalog();
        });
    }

    disable() {
        this._signals?.disconnectAll();
        this._signals = null;
        this._settings = null;
    }

    _publishCatalog() {
        if (!this._settings)
            return;

        const labels = {};

        for (const role of this.rules())
            labels[role] = this.label(role);

        if (this._sameCatalog(labels))
            return;

        this._settings.set_value(PANEL_ICONS_KEY, new GLib.Variant('a{ss}', labels));
    }

    _sameCatalog(labels) {
        const current = this._settings.get_value(PANEL_ICONS_KEY).deepUnpack();
        const currentRoles = Object.keys(current);
        const nextRoles = Object.keys(labels);

        if (currentRoles.length !== nextRoles.length)
            return false;

        return nextRoles.every(role => current[role] === labels[role]);
    }

    rules() {
        return Object.keys(Main.panel.statusArea)
                     .filter(role => Main.panel.statusArea[role] &&
                                     role !== this.CONTROL_ROLE &&
                                     !this.EXCLUDED_MIRROR_ROLES.includes(role));
    }

    label(role) {
        const indicator = Main.panel.statusArea[role];
        const name = indicator?.accessible_name;
        return name ? `${name} (${role})` : role;
    }
}
