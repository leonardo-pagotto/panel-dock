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
    DOCK_ORIENTATION_KEY,
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
        this._lastPressureX = null;
        this._lastPressureY = null;
        this._slotX = 0;
        this._slotY = 0;
        this._itemWatchId = 0;
        this._itemCount = -1;
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
        this._signals.connect(this._settings, `changed::${DOCK_ORIENTATION_KEY}`, refresh);
        this._watchNotifications();
        this._startItemWatch();
        this._signals.connect(Main.overview, 'showing', () => this._returnDashToOverview());
        this._signals.connect(Main.overview, 'hidden', () => {
            this._revealed = false;
            this._sync();
        });
        this._signals.connect(global.display, 'in-fullscreen-changed', refresh);
        this._signals.connect(Main.layoutManager, 'monitors-changed', refresh);
        this._signals.connect(global.stage, 'captured-event', (_actor, event) => {
            return this._onCapturedEvent(event);
        });

        this._sync();
    }

    disable() {
        this._clearSlotSize();
        this._clearItemWatch();
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
        const toward = this._towardEdge(x, y);
        const inZone = this._inPressureZone(x, y, monitor);
        this._pressureEvents = this._pressureEvents.filter(([time]) =>
            now - time < PRESSURE_TIMEOUT_MS);

        if (!inZone)
            return;

        const atEdge = this._atScreenEdge(x, y, monitor);
        this._pressureEvents.push([now, Math.max(toward, atEdge ? 1 : 0)]);
        const total = this._pressureEvents.reduce((sum, [, distance]) => sum + distance, 0);
        if (total < this._pressureThreshold())
            return;

        this._pressureEvents = [];
        this._show();
    }

    _towardEdge(x, y) {
        const lastX = this._lastPressureX;
        const lastY = this._lastPressureY;
        this._lastPressureX = x;
        this._lastPressureY = y;
        if (lastX == null)
            return 0;
        switch (this._orientation()) {
        case 'left':
            return Math.max(0, lastX - x);
        case 'right':
            return Math.max(0, x - lastX);
        default:
            return Math.max(0, y - lastY);
        }
    }

    _inPressureZone(x, y, monitor) {
        const zone = this._pressureZone();
        switch (this._orientation()) {
        case 'left':
            return y >= monitor.y && y < monitor.y + monitor.height && x <= monitor.x + zone;
        case 'right':
            return y >= monitor.y && y < monitor.y + monitor.height &&
                x >= monitor.x + monitor.width - zone;
        default:
            return x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y + monitor.height - zone;
        }
    }

    _atScreenEdge(x, y, monitor) {
        switch (this._orientation()) {
        case 'left':
            return x <= monitor.x + EDGE_PX;
        case 'right':
            return x >= monitor.x + monitor.width - EDGE_PX;
        default:
            return y >= monitor.y + monitor.height - EDGE_PX;
        }
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

    _orientation() {
        const value = this._settings?.get_string(DOCK_ORIENTATION_KEY);
        if (value === 'left' || value === 'right')
            return value;
        return 'bottom';
    }

    _vertical() {
        return this._orientation() !== 'bottom';
    }

    _startItemWatch() {
        this._itemWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!this._dash)
                return GLib.SOURCE_REMOVE;
            try {
                if (this._dash.get_parent() !== this._slot)
                    return GLib.SOURCE_CONTINUE;
                const count = this._dash._box?.get_n_children() ?? 0;
                if (count === this._itemCount)
                    return GLib.SOURCE_CONTINUE;
                this._itemCount = count;
                this._applySlotSize();
            } catch (e) {
                // The dash can be mid-update. Keep the timer alive.
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearItemWatch() {
        if (!this._itemWatchId)
            return;
        GLib.source_remove(this._itemWatchId);
        this._itemWatchId = 0;
    }

    _stackHeight(dash, thickness) {
        const children = [
            ...(dash._box?.get_children() ?? []),
            dash._showAppsIcon,
        ].filter(Boolean);
        let height = 0;
        const limit = Math.max(thickness, 1);
        for (const child of children) {
            let nat = 0;
            try {
                [, nat] = child.get_preferred_height(limit);
            } catch (e) {
                nat = limit;
            }
            nat = Math.ceil(nat);
            if (nat <= 0 || nat > limit * 1.5)
                nat = limit;
            height += nat;
        }
        return height + Math.round(limit * 0.6);
    }

    _applyDashOrientation(vertical) {
        const dash = this._dash;
        if (!dash?._box?.layout_manager || !dash._dashContainer)
            return;
        try {
            const orientation = vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL;
            if (dash._box.layout_manager.orientation !== orientation)
                dash._box.layout_manager.orientation = orientation;
            if (dash._dashContainer.orientation !== orientation)
                dash._dashContainer.orientation = orientation;
            if (dash._background) {
                dash._background.x_expand = vertical;
                dash._background.y_expand = vertical;
            }
            this._syncSeparator(vertical);
            this._placeRunningDots(vertical);
        } catch (e) {
            this._logger?.warn(`Could not orient the dock: ${e.message}`);
        }
    }

    _syncSeparator(vertical) {
        const separator = this._dash?._separator;
        if (!separator)
            return;
        if (!vertical) {
            separator.height = this._dash.iconSize || 64;
            separator.width = 1;
            separator.margin_top = 0;
            separator.margin_bottom = 0;
            return;
        }
        separator.width = Math.round(this._iconPixels() * 0.55);
        separator.height = 1;
        separator.margin_top = 8;
        separator.margin_bottom = 8;
        separator.margin_left = 0;
        separator.margin_right = 0;
        separator.x_align = Clutter.ActorAlign.CENTER;
    }

    _placeRunningDots(vertical) {
        const items = this._dash?._box?.get_children() ?? [];
        const side = this._orientation();
        for (const item of items) {
            const dot = item.child?._dot;
            if (!dot)
                continue;
            if (!vertical) {
                dot.translation_x = 0;
                dot.translation_y = 0;
                continue;
            }
            dot.translation_y = 0;
            dot.translation_x = side === 'left' ? -10 : 10;
        }
    }

    _iconPixels() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        return 64 * scale;
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
            this._applyDashOrientation(false);
            dash.remove_all_transitions();
            dash.translation_x = 0;
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

        this._applyDashOrientation(this._vertical());
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

        const orientation = this._orientation();
        const vertical = orientation !== 'bottom';
        let [, prefWidth] = dash.get_preferred_width(-1);
        let [, prefHeight] = dash.get_preferred_height(Math.max(prefWidth, 1));
        prefWidth = Math.ceil(prefWidth);
        prefHeight = Math.ceil(prefHeight);
        const long = Math.max(prefWidth, prefHeight);
        const short = Math.min(prefWidth, prefHeight) || this._iconPixels();
        let dashWidth = vertical ? short : long;
        let dashHeight = vertical ? this._stackHeight(dash, dashWidth) : short;
        dashWidth = Math.min(Math.max(dashWidth, 1), vertical ? Math.round(monitor.width * 0.2) : monitor.width);
        dashHeight = Math.min(Math.max(dashHeight, 1), monitor.height);
        if (dashWidth <= 0 || dashHeight <= 0)
            return;

        let slotX = monitor.x;
        let slotY = monitor.y + Math.floor((monitor.height - dashHeight) / 2);
        if (orientation === 'right')
            slotX = monitor.x + monitor.width - dashWidth;
        if (orientation === 'bottom') {
            slotX = monitor.x;
            slotY = monitor.y + monitor.height - dashHeight;
        }

        this._slotX = slotX;
        this._slotY = slotY;
        this._slotWidth = dashWidth;
        this._slotHeight = dashHeight;
        slot.set_position(slotX, slotY);
        slot.set_size(dashWidth, dashHeight);
        dash.set_position(0, 0);
        dash.set_size(dashWidth, dashHeight);
        if (this._revealed) {
            dash.translation_x = 0;
            dash.translation_y = 0;
        }
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
        const hidden = this._hiddenOffset();
        dash.translation_x = hidden.x;
        dash.translation_y = hidden.y;
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

        const orientation = this._orientation();
        const thickness = EDGE_PX;
        if (orientation === 'left') {
            edge.set_position(monitor.x, monitor.y);
            edge.set_size(thickness, monitor.height);
        } else if (orientation === 'right') {
            edge.set_position(monitor.x + monitor.width - thickness, monitor.y);
            edge.set_size(thickness, monitor.height);
        } else {
            edge.set_position(monitor.x, monitor.y + monitor.height - thickness);
            edge.set_size(monitor.width, thickness);
        }
        edge.show();
    }

    _hiddenOffset() {
        const orientation = this._orientation();
        if (orientation === 'left')
            return {x: -Math.max(this._slotWidth, 1), y: 0};
        if (orientation === 'right')
            return {x: Math.max(this._slotWidth, 1), y: 0};
        return {x: 0, y: Math.max(this._slotHeight, 1)};
    }

    _show() {
        if (!this._dash || !this._slot || !this._autohide() || Main.overview.visible)
            return;
        if (this._fullscreenBlocks() || this._revealed)
            return;

        this._parkOnDesktop();
        const hidden = this._hiddenOffset();
        this._dash.remove_all_transitions();
        this._dash.translation_x = hidden.x;
        this._dash.translation_y = hidden.y;
        this._slot.show();
        this._revealed = true;
        this._setUnredirectInhibited(true);
        this._dash.ease({
            translation_x: 0,
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
        const hidden = this._hiddenOffset();
        this._dash.ease({
            translation_x: hidden.x,
            translation_y: hidden.y,
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
        if (this._slotWidth <= 0 || this._slotHeight <= 0)
            return null;

        return {
            x: this._slotX,
            y: this._slotY,
            width: this._slotWidth,
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

        const padded = {x: box.x, y: box.y, width: box.width, height: box.height};
        if (this._orientation() === 'left')
            padded.width += LABEL_SLACK;
        else if (this._orientation() === 'right') {
            padded.x -= LABEL_SLACK;
            padded.width += LABEL_SLACK;
        } else {
            padded.y -= LABEL_SLACK;
            padded.height += LABEL_SLACK;
        }
        return this._boxContains(padded, x, y);
    }

    _boxContains(box, x, y) {
        return x >= box.x && x < box.x + box.width &&
            y >= box.y && y < box.y + box.height;
    }
}
