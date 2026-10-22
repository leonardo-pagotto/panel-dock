// SPDX-License-Identifier: GPL-2.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TopBar} from './features/topBar.js';
import {PanelIconsService} from './services/panelIconsService.js';

export default class BetterGnomeShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._features = [];

        for (const Feature of [TopBar]) {
            const feature = new Feature(this, this._settings);
            this._features.push(feature);
            feature.enable();
        }

        this._panelIconsService = new PanelIconsService(this._settings);
    }

    disable() {
        const features = this._features ?? [];

        for (let i = features.length - 1; i >= 0; i--)
            features[i].disable();

        this._features = null;
        this._panelIconsService?.disable();
        this._panelIconsService = null;
        this._settings = null;
    }
}
