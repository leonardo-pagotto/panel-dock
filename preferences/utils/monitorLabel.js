// SPDX-License-Identifier: GPL-2.0-or-later

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export function monitorLabel(monitor, index) {
    const description = monitor.get_description();
    const connector = monitor.get_connector();
    const geometry = monitor.get_geometry();

    const title = description || connector || _('Monitor %d').format(index + 1);
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
