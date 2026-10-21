// SPDX-License-Identifier: GPL-2.0-or-later

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DockPage} from './preferences/dockPage.js';
import {GeneralPage} from './preferences/generalPage.js';
import {PanelPage} from './preferences/panelPage.js';

export default class BetterGnomeShellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(new GeneralPage());
        window.add(new PanelPage(settings));
        window.add(new DockPage(settings));
    }
}
