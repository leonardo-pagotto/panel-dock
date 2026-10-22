// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {PatchSet} from '../lib/patch.js';
import {
    DOCK_ANIMATION_DURATION_KEY,
    DOCK_AUTOHIDE_IN_FULLSCREEN_KEY,
    DOCK_AUTOHIDE_KEY,
    DOCK_AUTOHIDE_URGENT_KEY,
    DOCK_HIDE_TIMEOUT_KEY,
    DOCK_PRESSURE_THRESHOLD_KEY,
    DOCK_PRESSURE_TO_ACTIVATE_KEY,
} from '../lib/settingsKeys.js';
import {SignalTracker} from '../lib/signals.js';

// Fixed until the animation preference exists.
const LABEL_SLACK = 48;
const EDGE_PX = 3;
const PRESSURE_TIMEOUT_MS = 1000;

export class Dock {
    constructor(extension, settings) {
        this._logger = extension.getLogger();
        this._settings = settings;
        this._signals = null;
        this._patches = null;
        this._dash = null;
        this._slot = null;
        this._edge = null;
        this._overviewParent = null;
        this._overviewIndex = 0;
        this._dashVisible = true;
        this._slotWidth = 0;
        this._slotHeight = 0;
        this._slotSizeId = 0;
        this._pointerWatchId = 0;
        this._outsideSince = 0;
        this._openingApps = false;
        this._unredirectInhibited = false;
        this._urgent = new Set();
        this._pressureEvents = [];
        this._lastPressureY = null;
        this._revealed = false;
        this._motionFailed = false;
    }

    enable() {
        this._signals = new SignalTracker();
        this._dash = Main.overview.dash;
        this._overviewParent = this._dash.get_parent();
        this._overviewIndex = this._overviewParent.get_children().indexOf(this._dash);
        this._dashVisible = this._dash.visible;
        this._settingMaxSize = false;
        this._holdOverviewLayout();

        // The overview actor is hidden on the desktop, so the dash has to
        // leave it before it can appear there. The slot clips the slide.
        this._slot = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
        });
        this._slot.hide();

        // A window owns the bottom of the screen, so the stage never sees the
        // pointer there. This strip stays above the window and can open the dock.
        this._edge = new St.Widget({
            reactive: true,
        });
        this._edge.hide();
        Main.layoutManager.addTopChrome(this._edge);
        Main.layoutManager.addTopChrome(this._slot);
        this._signals.connect(this._edge, 'enter-event', () => this._onEdgeContact());
        this._signals.connect(this._edge, 'motion-event', () => this._onEdgeContact());
        this._signals.connect(this._dash.showAppsButton, 'notify::checked', () => {
            this._onShowAppsToggled();
        });

        const refresh = () => this._sync();
        this._signals.connect(this._settings, `changed::${DOCK_AUTOHIDE_KEY}`, refresh);
        this._signals.connect(this._settings, `changed::${DOCK_PRESSURE_TO_ACTIVATE_KEY}`, refresh);
        this._signals.connect(this._settings, `changed::${DOCK_AUTOHIDE_IN_FULLSCREEN_KEY}`, refresh);
        this._signals.connect(this._settings, `changed::${DOCK_AUTOHIDE_URGENT_KEY}`, refresh);
        this._signals.connect(this._settings, `changed::${DOCK_PRESSURE_THRESHOLD_KEY}`, refresh);
        this._watchNotifications();
        this._signals.connect(Main.overview, 'showing', () => this._returnDashToOverview());
        this._signals.connect(Main.overview, 'hidden', () => {
            this._revealed = false;
            this._sync();
        });
        this._signals.connect(global.display, 'in-fullscreen-changed', refresh);
        this._signals.connect(Main.layoutManager, 'monitors-changed', refresh);
        this._signals.connect(this._dash, 'icon-size-changed', () => this._layoutSlot());
        this._signals.connect(global.stage, 'captured-event', (_actor, event) => {
            return this._onCapturedEvent(event);
        });

        this._sync();
    }

    disable() {
        this._clearSlotSize();
        this._clearPointerWatch();
        this._urgent?.clear();
        this._setUnredirectInhibited(false);

        this._signals?.disconnectAll();
        this._signals = null;
        this._patches?.restoreAll();
        this._patches = null;

        try {
            this._returnDashToOverview();
        } catch (e) {
            // The overview can already be tearing down with the shell.
        }

        const slot = this._slot;
        const edge = this._edge;
        this._slot = null;
        this._edge = null;
        this._dash = null;
        this._overviewParent = null;
        this._revealed = false;
        this._settings = null;
        this._logger = null;

        this._removeChrome(edge);
        this._removeChrome(slot);
    }

    _removeChrome(actor) {
        if (!actor)
            return;

        try {
            Main.layoutManager.removeChrome(actor);
        } catch (e) {
            // The chrome tracker can already have dropped the actor.
        }
        actor.destroy();
    }

    _holdOverviewLayout() {
        this._patches = new PatchSet();
        const dock = this;

        // The controls layout allocates the dash in overview coordinates on
        // every pass. Inside the desktop slot that box clips the icons.
        const originalAllocate = this._patches.add(this._dash, 'allocate', function (box) {
            if (this.get_parent() === dock._slot)
                return undefined;
            return originalAllocate.call(this, box);
        });

        const originalSetMaxSize = this._patches.add(this._dash, 'setMaxSize', function (maxWidth, maxHeight) {
            if (this.get_parent() === dock._slot && !dock._settingMaxSize)
                return undefined;
            return originalSetMaxSize.call(this, maxWidth, maxHeight);
        });
    }

    _clearSlotSize() {
        if (!this._slotSizeId)
            return;

        GLib.source_remove(this._slotSizeId);
        this._slotSizeId = 0;
    }

    _clearPointerWatch() {
        if (!this._pointerWatchId)
            return;

        GLib.source_remove(this._pointerWatchId);
        this._pointerWatchId = 0;
        this._outsideSince = 0;
    }

    _onShowAppsToggled() {
        if (this._openingApps || Main.overview.visible)
            return;
        if (this._dash?.get_parent() !== this._slot)
            return;

        // The shell only slides the overview state. While the overview is
        // closed that slide never opens the app grid.
        this._openingApps = true;
        this._dash.showAppsButton.checked = true;
        Main.overview.show(ControlsState.APP_GRID);
        this._openingApps = false;
    }

    _watchNotifications() {
        const tray = Main.messageTray;
        for (const source of tray.getSources())
            this._watchNotificationSource(source);

        this._signals.connect(tray, 'source-added', (_tray, source) => {
            this._watchNotificationSource(source);
        });
    }

    _watchNotificationSource(source) {
        this._signals.connect(source, 'notification-added', (_source, notification) => {
            this._onUrgentNotification(notification);
        });
    }

    _urgentEnabled() {
        return this._settings?.get_boolean(DOCK_AUTOHIDE_URGENT_KEY) ?? false;
    }

    _onUrgentNotification(notification) {
        if (!this._urgentEnabled() || notification.urgency < Urgency.CRITICAL)
            return;
        if (this._urgent.has(notification))
            return;

        this._urgent.add(notification);
        // These die with the notification. Disconnecting them from disable()
        // frees the closure twice and crashes the shell.
        notification.connect('destroy', () => this._releaseUrgent(notification));
        notification.connect('notify::acknowledged', () => {
            if (notification.acknowledged)
                this._releaseUrgent(notification);
        });
        this._show();
    }

    _releaseUrgent(notification) {
        this._urgent.delete(notification);
    }

    _animationDuration() {
        return this._settings?.get_int(DOCK_ANIMATION_DURATION_KEY) ?? 200;
    }

    _hideTimeout() {
        return this._settings?.get_int(DOCK_HIDE_TIMEOUT_KEY) ?? 400;
    }

    _pressureThreshold() {
        return this._settings?.get_int(DOCK_PRESSURE_THRESHOLD_KEY) ?? 100;
    }

    _onEdgeContact() {
        const [x, y] = global.get_pointer();
        if (this._pressureOn()) {
            this._notePressure(x, y);
            return;
        }

        this._show();
    }

    _pressureZone() {
        return Math.max(EDGE_PX, Math.min(this._pressureThreshold() || EDGE_PX, 160));
    }

    _notePressure(x, y) {
        if (!this._pressureOn() || this._revealed || this._fullscreenBlocks())
            return;
        if (Main.overview.visible)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const zoneTop = monitor.y + monitor.height - this._pressureZone();
        const inZone = x >= monitor.x && x < monitor.x + monitor.width && y >= zoneTop;
        const downward = this._lastPressureY == null
            ? 0
            : Math.max(0, y - this._lastPressureY);
        this._lastPressureY = y;
        this._pressureEvents = this._pressureEvents.filter(([time]) =>
            now - time < PRESSURE_TIMEOUT_MS);

        if (!inZone)
            return;

        const atEdge = y >= monitor.y + monitor.height - EDGE_PX;
        this._pressureEvents.push([now, Math.max(downward, atEdge ? 1 : 0)]);
        const total = this._pressureEvents.reduce((sum, [, distance]) => sum + distance, 0);
        if (total < this._pressureThreshold())
            return;

        this._pressureEvents = [];
        this._show();
    }

    _setUnredirectInhibited(inhibit) {
        if (inhibit === this._unredirectInhibited)
            return;

        // A maximized window can cover the monitor and Mutter then scans it
        // out directly, skipping shell chrome. The dock is still mapped, so
        // the window paints over it. The compositor refcounts this hold.
        try {
            if (inhibit)
                global.compositor.disable_unredirect();
            else
                global.compositor.enable_unredirect();
            this._unredirectInhibited = inhibit;
        } catch (e) {
            this._logger?.warn(`Could not update unredirect: ${e.message}`);
        }
    }

    _autohide() {
        return this._settings?.get_boolean(DOCK_AUTOHIDE_KEY) ?? false;
    }

    _pressureOn() {
        return this._settings?.get_boolean(DOCK_PRESSURE_TO_ACTIVATE_KEY) ?? false;
    }

    _fullscreenBlocks() {
        if (!this._settings)
            return true;
        if (this._settings.get_boolean(DOCK_AUTOHIDE_IN_FULLSCREEN_KEY))
            return false;

        return Main.layoutManager.primaryMonitor?.inFullscreen ?? false;
    }

    _sync() {
        if (!this._dash)
            return;

        if (!this._autohide() || Main.overview.visible) {
            this._returnDashToOverview();
            return;
        }

        this._parkOnDesktop();
        if (this._fullscreenBlocks() || !this._revealed)
            this._placeHidden();
        else
            this._layoutSlot();
    }

    _returnDashToOverview() {
        const dash = this._dash;
        const parent = this._overviewParent;
        this._clearPointerWatch();
        this._setUnredirectInhibited(false);
        this._revealed = false;

        if (dash) {
            dash.remove_all_transitions();
            dash.translation_y = 0;
            dash.visible = this._dashVisible;

            if (parent && dash.get_parent() !== parent) {
                dash.get_parent()?.remove_child(dash);
                const index = Math.min(this._overviewIndex, parent.get_n_children());
                parent.insert_child_at_index(dash, index);
            }
        }

        this._slot?.hide();
        this._updateEdge();
    }

    _parkOnDesktop() {
        const dash = this._dash;
        const slot = this._slot;
        if (!dash || !slot)
            return;

        if (dash.get_parent() !== slot) {
            dash.get_parent()?.remove_child(dash);
            slot.add_child(dash);
        }

        this._layoutSlot();
    }

    _layoutSlot() {
        const monitor = Main.layoutManager.primaryMonitor;
        const dash = this._dash;
        const slot = this._slot;
        if (!monitor || !dash || !slot || dash.get_parent() !== slot)
            return;

        const width = monitor.width;
        // A hidden overview can leave this at 0, and the dash then
        // collapses its icons to the smallest size.
        const maxHeight = Math.max(Math.round(monitor.height * 0.16), 1);
        this._settingMaxSize = true;
        dash.setMaxSize(width, maxHeight);
        this._settingMaxSize = false;
        this._applySlotSize();
        this._queueSlotSize();
    }

    _queueSlotSize() {
        if (this._slotSizeId)
            return;

        this._slotSizeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._slotSizeId = 0;
            this._applySlotSize();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applySlotSize() {
        const monitor = Main.layoutManager.primaryMonitor;
        const dash = this._dash;
        const slot = this._slot;
        if (!monitor || !dash || !slot || dash.get_parent() !== slot)
            return;

        // Same width the overview gives the dash. A tighter width clips the
        // background, because the pill is centered inside the full allocation.
        const dashWidth = monitor.width;
        let [, dashHeight] = dash.get_preferred_height(dashWidth);
        dashHeight = Math.ceil(dashHeight);
        if (dashHeight <= 0)
            return;

        const slotHeight = dashHeight + dash.margin_bottom;
        this._slotWidth = dashWidth;
        this._slotHeight = slotHeight;
        slot.set_position(monitor.x, monitor.y + monitor.height - slotHeight);
        slot.set_size(dashWidth, slotHeight);
        dash.set_position(0, 0);
        dash.set_size(dashWidth, dashHeight);
        this._updateEdge();
    }

    _placeHidden() {
        const dash = this._dash;
        if (!dash)
            return;

        this._parkOnDesktop();
        this._clearPointerWatch();
        this._setUnredirectInhibited(false);
        dash.remove_all_transitions();
        dash.translation_y = this._hiddenOffset();
        this._revealed = false;
        this._slot?.hide();
        this._updateEdge();
    }

    _updateEdge() {
        const edge = this._edge;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!edge || !monitor)
            return;

        if (!this._autohide() || Main.overview.visible || this._fullscreenBlocks()) {
            edge.hide();
            return;
        }

        const thickness = this._pressureOn()
            ? this._pressureZone()
            : Math.max(this._slotHeight, EDGE_PX);
        edge.set_position(monitor.x, monitor.y + monitor.height - thickness);
        edge.set_size(monitor.width, thickness);
        edge.show();
    }

    _hiddenOffset() {
        if (this._slotHeight > 0)
            return this._slotHeight;

        const dash = this._dash;
        if (!dash)
            return 0;

        return dash.height + dash.margin_bottom;
    }

    _show() {
        if (!this._dash || !this._slot || !this._autohide() || Main.overview.visible)
            return;
        if (this._fullscreenBlocks() || this._revealed)
            return;

        this._parkOnDesktop();
        this._dash.remove_all_transitions();
        this._dash.translation_y = this._hiddenOffset();
        this._slot.show();
        this._revealed = true;
        this._setUnredirectInhibited(true);
        this._dash.ease({
            translation_y: 0,
            duration: this._animationDuration(),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._watchPointer();
        this._pressureEvents = [];
    }

    _watchPointer() {
        if (this._pointerWatchId)
            return;

        this._outsideSince = 0;
        this._pointerWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._revealed || Main.overview.visible) {
                this._pointerWatchId = 0;
                this._outsideSince = 0;
                return GLib.SOURCE_REMOVE;
            }

            const [x, y] = global.get_pointer();
            if (this._urgent.size > 0 || this._pointerKeepsDockShown(x, y)) {
                this._outsideSince = 0;
                return GLib.SOURCE_CONTINUE;
            }

            const now = GLib.get_monotonic_time();
            if (!this._outsideSince)
                this._outsideSince = now;

            if (now - this._outsideSince < this._hideTimeout() * 1000)
                return GLib.SOURCE_CONTINUE;

            this._pointerWatchId = 0;
            this._outsideSince = 0;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hide() {
        if (!this._dash || !this._revealed)
            return;

        this._clearPointerWatch();
        this._revealed = false;
        this._dash.remove_all_transitions();
        this._dash.ease({
            translation_y: this._hiddenOffset(),
            duration: this._animationDuration(),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._revealed || Main.overview.visible)
                    return;
                this._slot?.hide();
                this._setUnredirectInhibited(false);
            },
        });
    }

    _onCapturedEvent(event) {
        try {
            return this._handleMotion(event);
        } catch (e) {
            if (!this._motionFailed) {
                this._motionFailed = true;
                this._logger?.warn(`Dock pointer tracking stopped: ${e.message}`);
            }
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _handleMotion(event) {
        if (event.type() !== Clutter.EventType.MOTION)
            return Clutter.EVENT_PROPAGATE;
        if (!this._autohide() || Main.overview.visible || this._fullscreenBlocks())
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        if (this._revealed)
            return Clutter.EVENT_PROPAGATE;

        if (this._pressureOn()) {
            this._notePressure(x, y);
            return Clutter.EVENT_PROPAGATE;
        }

        if (this._pointerInDockArea(x, y))
            this._show();

        return Clutter.EVENT_PROPAGATE;
    }

    _dockArea() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._slotWidth <= 0 || this._slotHeight <= 0)
            return null;

        return {
            x: monitor.x,
            y: monitor.y + monitor.height - this._slotHeight,
            width: monitor.width,
            height: this._slotHeight,
        };
    }

    _pointerInDockArea(x, y) {
        const box = this._dockArea();
        if (!box)
            return false;

        return this._boxContains(box, x, y);
    }

    _pointerKeepsDockShown(x, y) {
        const box = this._dockArea();
        if (!box)
            return false;

        return this._boxContains({
            x: box.x,
            y: box.y - LABEL_SLACK,
            width: box.width,
            height: box.height + LABEL_SLACK,
        }, x, y);
    }

    _boxContains(box, x, y) {
        return x >= box.x && x < box.x + box.width &&
            y >= box.y && y < box.y + box.height;
    }
}
