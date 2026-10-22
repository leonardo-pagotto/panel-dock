// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Panel} from 'resource:///org/gnome/shell/ui/panel.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {PatchSet} from '../lib/patch.js';
import {MONITOR_PANELS_KEY, PANEL_ICONS_KEY} from '../lib/settingsKeys.js';
import {SignalTracker} from '../lib/signals.js';
import {MonitorService} from '../services/monitorService.js';

// An extension indicator exists once, on the stock panel. This button shows
// that same icon on another bar and opens its menu from there.
class MirroredIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init(source) {
        super._init(0.0, source.accessible_name, true);

        this._source = source;
        this._clone = null;
        this._sourceWidth = 0;
        this._sourceHeight = 0;
        this._openStateId = 0;
        this._originalSource = null;
        this._restoringMenu = false;

        source.connectObject('destroy', () => this._onSourceDestroyed(), this);
        source.connectObject('child-added', () => this._ensureClone(), this);
        this.connect('destroy', () => this._restoreMenu());

        const gesture = new Clutter.ClickGesture();
        gesture.set_recognize_on_press(true);
        gesture.connect('recognize', () => this._openSourceMenu());
        this.add_action(gesture);

        this._ensureClone();
    }

    _onSourceDestroyed() {
        this.destroy();
    }

    _ensureClone() {
        const content = this._source?.get_first_child();
        if (!content || this._clone?.source === content)
            return;

        this._clone?.destroy();
        this._clone = new Clutter.Clone({
            source: content,
            reactive: false,
        });
        this.add_child(this._clone);
        content.connectObject('notify::allocation', () => this._syncCloneSize(), this);
        this._syncCloneSize();
    }

    _syncCloneSize() {
        const content = this._clone?.source;
        if (!content)
            return;

        if (content.width > 0)
            this._sourceWidth = content.width;
        if (content.height > 0)
            this._sourceHeight = content.height;
        this.queue_relayout();
    }

    vfunc_get_preferred_width(_forHeight) {
        const width = this._sourceWidth || this._clone?.width || 0;
        return [width, width];
    }

    vfunc_get_preferred_height(_forWidth) {
        const height = this._sourceHeight || this._clone?.height || 0;
        return [height, height];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const clone = this._clone;
        if (!clone)
            return;

        const width = this._sourceWidth || clone.width;
        const height = this._sourceHeight || clone.height;
        const availWidth = box.x2 - box.x1;
        const availHeight = box.y2 - box.y1;
        const childBox = new Clutter.ActorBox();
        childBox.x1 = Math.max(0, Math.floor((availWidth - width) / 2));
        childBox.y1 = Math.max(0, Math.floor((availHeight - height) / 2));
        childBox.x2 = childBox.x1 + width;
        childBox.y2 = childBox.y1 + height;
        clone.allocate(childBox);
    }

    _openSourceMenu() {
        const menu = this._source?.menu;
        if (!menu?.open)
            return;

        if (menu.isOpen && menu.sourceActor === this) {
            menu.close();
            return;
        }

        if (menu.isOpen)
            menu.close();

        this._originalSource = menu.sourceActor;
        menu.sourceActor = this;
        this.add_style_pseudo_class('active');
        this._openStateId = menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                return;

            this._restoreMenu();
        });
        menu.open();
    }

    _restoreMenu() {
        if (this._restoringMenu)
            return;

        this._restoringMenu = true;
        const menu = this._source?.menu;
        if (this._openStateId && menu) {
            menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }

        const anchored = menu?.sourceActor === this;
        if (anchored)
            menu.sourceActor = this._originalSource;

        this.remove_style_pseudo_class('active');
        if (anchored && menu.isOpen)
            menu.close();
        this._restoringMenu = false;
    }
}

export class TopBar {
    constructor(extension, settings) {
        this._settings = settings;
        this._signals = new SignalTracker();
        this._patches = new PatchSet();
        this._monitorService = new MonitorService(settings);
        this._replicas = [];
        this._pendingReplicaRemovals = [];
        this._replicaRemovalId = 0;
        this._stockSaved = false;
        this._panelMonitors = new WeakMap();
        this._shellVisible = new WeakMap();
    }

    enable() {
        if (!Main.panel || !Main.layoutManager.panelBox)
            throw new Error('GNOME Shell panel is not ready');

        this._saveStockPanel();
        this._installPatches();
        this._signals.connect(this._settings, `changed::${MONITOR_PANELS_KEY}`, () => {
            this._sync();
        });
        this._signals.connect(this._settings, `changed::${PANEL_ICONS_KEY}`, () => {
            this._applyAllIcons();
        });
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => {
            this._sync();
        });
        this._sync();
    }

    disable() {
        this._signals?.disconnectAll();
        this._patches?.restoreAll();
        this._restoreIndicators();
        this._restoreStockPanel();
        this._flushReplicaRemovals();
        this._destroyReplicas();
        this._signals = null;
        this._patches = null;
        this._monitorService = null;
        this._panelMonitors = null;
        this._shellVisible = null;
        this._settings = null;
    }

    _installPatches() {
        // Each panel lays out the clock and then points notifications at it.
        // Only the stock panel should win that.
        const feature = this;
        const originalUpdate = this._patches.add(Panel.prototype, '_updatePanel', function (...args) {
            feature._showShellIcons(this);

            let result;
            if (this === Main.panel) {
                result = originalUpdate.apply(this, args);
            } else {
                const tray = Main.messageTray;
                const alignment = tray?.bannerAlignment;
                result = originalUpdate.apply(this, args);
                if (tray)
                    tray.bannerAlignment = alignment;
            }

            feature._applyIcons(this, true);
            return result;
        });

        const originalAdd = this._patches.add(Panel.prototype, 'addToStatusArea', function (...args) {
            const indicator = originalAdd.apply(this, args);
            if (this === Main.panel)
                feature._syncExtensionIcons();
            feature._applyIcons(this, false);
            return indicator;
        });

        // The stock method only drags a vertically maximized window on the
        // primary monitor, using the pointer's x. Use the monitor this bar is on.
        const originalDrag = this._patches.add(
            Panel.prototype,
            '_getDraggableWindowForPosition',
            function (stageX) {
                const monitor = Main.layoutManager.findMonitorForActor(this);
                if (!monitor)
                    return originalDrag.call(this, stageX);

                const workspaceManager = global.workspace_manager;
                const windows = workspaceManager.get_active_workspace().list_windows();
                const stacked = global.display.sort_windows_by_stacking(windows).reverse();

                return stacked.find(metaWindow => {
                    const rect = metaWindow.get_frame_rect();
                    return metaWindow.get_monitor() === monitor.index &&
                           metaWindow.showing_on_its_workspace() &&
                           metaWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
                           metaWindow.maximized_vertically &&
                           stageX > rect.x && stageX < rect.x + rect.width;
                });
            });
    }

    _saveStockPanel() {
        if (this._stockSaved)
            return;

        const panel = Main.panel;
        this._savedPanelXExpand = panel.x_expand;
        this._savedPanelXAlign = panel.x_align;
        this._savedPanelVisible = panel.visible;
        this._stockSaved = true;
    }

    _restoreStockPanel() {
        if (!this._stockSaved)
            return;

        const panel = Main.panel;
        const layout = Main.layoutManager;
        const primary = layout?.primaryMonitor;
        this._stockSaved = false;

        if (panel) {
            panel.x_expand = this._savedPanelXExpand;
            panel.x_align = this._savedPanelXAlign;
            panel.visible = this._savedPanelVisible;
        }

        if (primary && layout.panelBox) {
            layout.panelBox.set_position(primary.x, primary.y);
            layout.panelBox.set_size(primary.width, -1);
        }
    }

    _restoreIndicators() {
        const panel = Main.panel;
        const saved = panel ? this._shellVisible?.get(panel) : null;

        if (panel && saved) {
            for (const [role, visible] of saved) {
                const container = panel.statusArea[role]?.container;
                if (container)
                    container.visible = visible;
            }
        }

        try {
            panel?._updatePanel();
        } catch (e) {
            // The session may already be tearing the panel down.
        }
    }

    _sync() {
        const enabled = Main.layoutManager.monitors.filter(monitor =>
            this._panelEnabled(monitor));
        const primary = Main.layoutManager.primaryMonitor;
        const host = enabled.find(monitor => monitor === primary) ?? enabled[0] ?? null;
        const mirrors = enabled.filter(monitor => monitor !== host);

        this._placeStockPanel(host);
        this._syncReplicas(mirrors);
        this._applyAllIcons();
    }

    _panelIconRoles() {
        const labels = this._settings.get_value(PANEL_ICONS_KEY).deepUnpack();
        return Object.keys(labels);
    }

    _applyAllIcons() {
        this._syncExtensionIcons();
        this._applyIcons(Main.panel, false);

        for (const replica of this._replicas ?? [])
            this._applyIcons(replica.panel, false);
    }

    _syncExtensionIcons() {
        const roles = new Set(this._panelIconRoles());

        for (const replica of this._replicas ?? [])
            this._syncReplicaIcons(replica.panel, roles);
    }

    _syncReplicaIcons(panel, roles) {
        if (!panel)
            return;

        for (const boxName of ['left', 'center', 'right']) {
            const children = Main.panel[`_${boxName}Box`]?.get_children() ?? [];

            for (let index = 0; index < children.length; index++) {
                const role = this._roleForContainer(children[index]);
                if (!role || !roles.has(role) || panel.statusArea[role])
                    continue;

                const source = Main.panel.statusArea[role];
                if (!source)
                    continue;

                const mirror = new MirroredIndicator(source);
                try {
                    panel.addToStatusArea(role, mirror, index, boxName);
                } catch (e) {
                    mirror.destroy();
                }
            }
        }

        for (const [role, indicator] of Object.entries(panel.statusArea)) {
            if (!(indicator instanceof MirroredIndicator))
                continue;
            if (roles.has(role) && Main.panel.statusArea[role])
                continue;

            indicator.destroy();
        }
    }

    _roleForContainer(container) {
        const area = Main.panel.statusArea;

        for (const role of Object.keys(area)) {
            if (area[role]?.container === container)
                return role;
        }

        return null;
    }

    _showShellIcons(panel) {
        const saved = this._shellVisible?.get(panel);
        if (!saved)
            return;

        for (const role of this._panelIconRoles()) {
            if (!saved.has(role))
                continue;

            const container = panel.statusArea[role]?.container;
            if (container)
                container.visible = saved.get(role);
        }
    }

    _iconEnabled(monitor, role) {
        return this._connectors(monitor).every(connector =>
            this._monitorService.entry(connector).icons[role] !== false);
    }

    _applyIcons(panel, fromShellUpdate) {
        const monitor = this._panelMonitors?.get(panel);
        if (!panel || !monitor)
            return;

        let saved = this._shellVisible.get(panel);
        if (!saved) {
            saved = new Map();
            this._shellVisible.set(panel, saved);
        }

        for (const role of this._panelIconRoles()) {
            const indicator = panel.statusArea[role];
            const container = indicator?.container;
            if (!container)
                continue;

            if (fromShellUpdate || !saved.has(role))
                saved.set(role, container.visible);

            const show = this._iconEnabled(monitor, role) && saved.get(role);
            if (container.visible === show)
                continue;

            container.visible = show;
            if (!show && indicator.menu?.isOpen)
                indicator.menu.close();
        }
    }

    _panelEnabled(monitor) {
        return this._connectors(monitor).every(connector =>
            this._monitorService.entry(connector)['panel-enabled']);
    }

    _connectors(monitor) {
        const logicals = global.backend.get_monitor_manager().get_logical_monitors() ?? [];
        const logical = [...logicals].find(item => item.get_number() === monitor.index);
        const outputs = logical ? [...logical.get_monitors()] : [];
        const connectors = outputs
            .map(output => output.get_connector())
            .filter(connector => connector);

        if (connectors.length === 0)
            return [`monitor-${monitor.index}`];

        return connectors;
    }

    _placeStockPanel(monitor) {
        const panel = Main.panel;
        const panelBox = Main.layoutManager.panelBox;

        // The panel's natural width is the primary monitor. Expand so a
        // wider host still fills, and shrink with the box when it is narrower.
        panel.x_expand = true;
        panel.x_align = Clutter.ActorAlign.FILL;

        if (!monitor) {
            panel.hide();
            panelBox.set_size(panelBox.width, 0);
            this._panelMonitors.delete(panel);
            return;
        }

        panel.visible = this._savedPanelVisible;
        panelBox.set_position(monitor.x, monitor.y);
        panelBox.set_size(monitor.width, -1);
        this._panelMonitors.set(panel, monitor);
    }

    _syncReplicas(monitors) {
        const wanted = new Set(monitors.map(monitor => monitor.index));
        const kept = [];

        for (const replica of this._replicas) {
            if (wanted.has(replica.index))
                kept.push(replica);
            else
                this._queueReplicaRemoval(replica.box);
        }

        this._replicas = kept;

        for (const monitor of monitors) {
            let replica = this._replicas.find(item => item.index === monitor.index);

            if (!replica) {
                const created = this._createPanelBox();
                replica = {index: monitor.index, ...created};
                this._replicas.push(replica);
            }

            this._panelMonitors.set(replica.panel, monitor);
            this._placePanelBox(replica.box, monitor);
        }
    }

    _createPanelBox() {
        // Panel._init parents itself to the primary panelBox.
        const panel = new Panel();
        panel.get_parent()?.remove_child(panel);
        panel.x_expand = true;
        panel.x_align = Clutter.ActorAlign.FILL;

        // Blur my Shell only styles extra bars that live in a box named panelBox.
        const box = new St.BoxLayout({
            name: 'panelBox',
            orientation: Clutter.Orientation.VERTICAL,
        });
        box.add_child(panel);
        return {box, panel};
    }

    _placePanelBox(box, monitor) {
        box.set_position(monitor.x, monitor.y);
        box.set_size(monitor.width, -1);

        if (box.get_parent())
            return;

        Main.layoutManager.addChrome(box, {
            affectsStruts: true,
            trackFullscreen: true,
        });
    }

    _destroyReplicas() {
        const replicas = this._replicas ?? [];
        this._replicas = [];

        for (const replica of replicas)
            this._destroyReplicaBox(replica.box);
    }

    // Blur My Shell clears its panel list in the same monitors pass that
    // removes a bar. Unparenting in that pass runs its parent-set handler
    // after the list is gone.
    _queueReplicaRemoval(box) {
        this._pendingReplicaRemovals.push(box);
        if (this._replicaRemovalId)
            return;

        this._replicaRemovalId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._replicaRemovalId = 0;
            this._flushReplicaRemovals();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushReplicaRemovals() {
        if (this._replicaRemovalId) {
            GLib.source_remove(this._replicaRemovalId);
            this._replicaRemovalId = 0;
        }

        const boxes = this._pendingReplicaRemovals ?? [];
        this._pendingReplicaRemovals = [];
        for (const box of boxes)
            this._destroyReplicaBox(box);
    }

    _destroyReplicaBox(box) {
        try {
            if (box.get_parent())
                Main.layoutManager.removeChrome(box);
        } catch (e) {
            // The shell may already be tearing the chrome down.
        }

        box.destroy();
    }
}
