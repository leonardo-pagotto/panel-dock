// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export class GeneralPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
            name: 'general',
        });

        this.add(new Adw.PreferencesGroup({
            title: _('General'),
            description: _('Options that apply to the whole extension will appear here.'),
        }));
    }
}
