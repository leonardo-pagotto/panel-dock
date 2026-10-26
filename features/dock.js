// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Dash, DashIcon} from 'resource:///org/gnome/shell/ui/dash.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {PatchSet} from '../lib/patch.js';
import {
    DOCK_ANIMATION_DURATION_KEY,
    DOCK_AUTOHIDE_IN_FULLSCREEN_KEY,
    DOCK_AUTOHIDE_KEY,
    DOCK_AUTOHIDE_URGENT_KEY,
    DOCK_CLICK_LEFT_KEY,
    DOCK_CLICK_MIDDLE_KEY,
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
        this._barrier = null;
        this._pressureBarrier = null;
        this._pressureTriggerId = 0;
        this._triggerKey = null;
        this._barrierFailed = false;
        this._clickFailed = false;
    }

    enable() {
        this._signals = new SignalTracker();
        this._patches = new PatchSet();
        this._patchDashClicks();

        // Blur My Shell styles a dock it finds by name, the same way it
        // styles a box named panelBox. This actor is that dock. The
        // overview dash stays where the shell allocated it.
        this._slot = new St.Widget({
            name: 'dash',
            clip_to_allocation: true,
            reactive: false,
            x_expand: false,
            y_expand: false,
            layout_manager: new Clutter.BinLayout(),
        });
        this._dash = new Dash();
        this._dash.x_expand = true;
        this._dash.x_align = Clutter.ActorAlign.FILL;
        this._dash.y_expand = false;
        this._dash.y_align = Clutter.ActorAlign.START;
        this._slot._background = this._dash._background;
        this._slot.add_child(this._dash);
        this._slot.hide();

        // A window owns the bottom of the screen, so the stage never sees the
        // pointer there. This strip is only the screen edge; a taller one
        // keeps clicks from the windows underneath.
        this._edge = new St.Widget({
            reactive: true,
            x_expand: false,
            y_expand: false,
            height: EDGE_PX,
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
        // The pill reads the icon row's width during allocation. Adding or
        // removing an app is the only later pass that used to run it again.
        this._signals.connect(this._dash._box, 'child-added', () => this._queueSlotSize());
        this._signals.connect(this._dash._box, 'child-removed', () => this._queueSlotSize());
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

        this._destroyPressureBarrier();

        const slot = this._slot;
        const edge = this._edge;
        this._slot = null;
        this._edge = null;
        this._dash = null;
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

    _patchDashClicks() {
        const dock = this;
        // Dash icons are the dock. The app grid uses AppIcon, so this
        // leaves those clicks on the stock path.
        this._patches.add(DashIcon.prototype, 'activate', function (button) {
            dock._applyClick(this, button);
        });
    }

    _clickKey(button) {
        if (button === Clutter.BUTTON_MIDDLE)
            return DOCK_CLICK_MIDDLE_KEY;

        return DOCK_CLICK_LEFT_KEY;
    }

    _applyClick(icon, button) {
        const app = icon?.app;
        if (!app || !this._settings)
            return;

        try {
            const action = this._settings.get_string(this._clickKey(button));
            if (action === 'new-window')
                this._openNewWindow(icon);
            else if (action === 'close-windows')
                this._closeWindows(app);
            else
                this._focusOrOpen(icon);
        } catch (e) {
            if (!this._clickFailed) {
                this._clickFailed = true;
                this._logger?.warn(`Dock click action failed: ${e.message}`);
            }
        }
    }

    _focusOrOpen(icon) {
        const {app} = icon;
        if (app.state === Shell.AppState.STOPPED)
            icon.animateLaunch();

        app.activate();
        Main.overview.hide();
    }

    _openNewWindow(icon) {
        const {app} = icon;
        if (app.state === Shell.AppState.STOPPED || app.can_open_new_window())
            icon.animateLaunch();

        app.open_new_window(-1);
        Main.overview.hide();
    }

    _closeWindows(app) {
        const windows = app.get_windows();
        if (!windows.length)
            return;

        const time = global.get_current_time();
        let closed = false;
        for (const window of windows) {
            if (!window.can_close())
                continue;

            window.delete(time);
            closed = true;
        }

        if (closed)
            Main.overview.hide();
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

    _actorAlive(actor) {
        if (!actor)
            return false;

        try {
            // A disposed actor throws on any property read.
            return actor.get_parent() !== undefined;
        } catch (e) {
            return false;
        }
    }

    _sync() {
        if (!this._actorAlive(this._dash))
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
        this._clearPointerWatch();
        this._setUnredirectInhibited(false);
        this._revealed = false;

        if (this._actorAlive(dash))
            dash.translation_y = 0;
        this._slot?.remove_all_transitions();
        if (this._slot)
            this._slot.translation_y = 0;

        this._slot?.hide();
        this._updateEdge();
    }

    _parkOnDesktop() {
        const dash = this._dash;
        const slot = this._slot;
        if (!this._actorAlive(dash) || !slot || dash.get_parent() !== slot)
            return;

        this._layoutSlot();
    }

    _layoutSlot() {
        const monitor = Main.layoutManager.primaryMonitor;
        const dash = this._dash;
        const slot = this._slot;
        if (!monitor || !this._actorAlive(dash) || !slot || dash.get_parent() !== slot)
            return;

        const width = monitor.width;
        // A hidden overview can leave this at 0, and the dash then
        // collapses its icons to the smallest size.
        const maxHeight = Math.max(Math.round(monitor.height * 0.16), 1);
        dash.setMaxSize(width, maxHeight);
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
        if (!monitor || !this._actorAlive(dash) || !slot || dash.get_parent() !== slot)
            return;

        // Same width the overview gives the dash. A tighter width clips the
        // background, because the pill is centered inside the full allocation.
        const dashWidth = monitor.width;
        const maxHeight = Math.max(Math.round(monitor.height * 0.16), 1);
        let [, dashHeight] = dash.get_preferred_height(dashWidth);
        const [, iconHeight] = dash._box.get_preferred_height(dashWidth);
        const padding = dash._background.get_theme_node().get_vertical_padding()
            + dash.get_theme_node().get_vertical_padding();
        dashHeight = Math.ceil(Math.max(dashHeight, iconHeight + padding));
        dashHeight = Math.min(Math.max(dashHeight, 1), maxHeight);

        // The slot's layout was keeping the dash at its minimum width, so the
        // icon row was squeezed. Give it the same box the overview uses.
        const slotHeight = dashHeight + dash.margin_bottom;
        this._slotWidth = dashWidth;
        this._slotHeight = slotHeight;
        slot.set_position(monitor.x, monitor.y + monitor.height - slotHeight);
        slot.set_size(dashWidth, slotHeight);
        dash.set_position(0, 0);
        const box = new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: dashWidth,
            y2: dashHeight,
        });
        // The pill is allocated before the icon row, so it keeps the previous
        // width. A second pass sees the row and follows it.
        dash.allocate(box);
        dash.allocate(box);
        this._updateEdge();
    }

    _placeHidden() {
        const dash = this._dash;
        if (!this._actorAlive(dash))
            return;

        this._parkOnDesktop();
        this._clearPointerWatch();
        this._setUnredirectInhibited(false);
        dash.translation_y = 0;
        this._slot?.remove_all_transitions();
        if (this._slot)
            this._slot.translation_y = this._hiddenOffset();
        this._revealed = false;
        this._slot?.hide();
        this._updateEdge();
    }

    _updateEdge() {
        this._updatePressureBarrier();

        const edge = this._edge;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!edge || !monitor)
            return;

        // The open dock is the click target. The hotspot is only the
        // screen edge, and only while the dock is hidden.
        if (!this._autohide() || this._revealed || Main.overview.visible || this._fullscreenBlocks()) {
            edge.hide();
            return;
        }

        edge.set_position(monitor.x, monitor.y + monitor.height - EDGE_PX);
        edge.set_size(monitor.width, EDGE_PX);
        edge.show();
    }

    _pressureBarrierKey() {
        if (!this._pressureOn() || !this._autohide() || this._revealed)
            return null;
        if (Main.overview.visible || this._fullscreenBlocks())
            return null;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || monitor.width <= 2)
            return null;

        return `${monitor.x}:${monitor.y}:${monitor.width}:${monitor.height}:${this._pressureThreshold()}`;
    }

    _updatePressureBarrier() {
        const key = this._pressureBarrierKey();
        if (key === this._triggerKey)
            return;

        this._destroyPressureBarrier();
        this._triggerKey = key;
        if (!key)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        const threshold = Math.max(this._pressureThreshold(), 1);

        try {
            // The barrier watches a push against the screen edge. It does
            // not take a band of the window's input the way a tall actor does.
            const barrier = new Meta.Barrier({
                backend: global.backend,
                x1: monitor.x + 1,
                x2: monitor.x + monitor.width - 1,
                y1: monitor.y + monitor.height,
                y2: monitor.y + monitor.height,
                directions: Meta.BarrierDirection.NEGATIVE_Y,
            });
            const pressure = new Layout.PressureBarrier(
                threshold,
                PRESSURE_TIMEOUT_MS,
                Shell.ActionMode.NORMAL);
            const id = pressure.connect('trigger', () => this._show());
            pressure.addBarrier(barrier);
            this._barrier = barrier;
            this._pressureBarrier = pressure;
            this._pressureTriggerId = id;
        } catch (e) {
            if (!this._barrierFailed) {
                this._barrierFailed = true;
                this._logger?.warn(`Could not watch the dock edge: ${e.message}`);
            }
            this._destroyPressureBarrier();
            this._triggerKey = key;
        }
    }

    _destroyPressureBarrier() {
        const pressure = this._pressureBarrier;
        const barrier = this._barrier;
        const id = this._pressureTriggerId;
        this._pressureBarrier = null;
        this._barrier = null;
        this._pressureTriggerId = 0;
        this._triggerKey = null;

        try {
            if (pressure && id)
                pressure.disconnect(id);
        } catch (e) {
            // The barrier can already be gone during session shutdown.
        }

        try {
            pressure?.destroy();
        } catch (e) {
            // Already destroyed with the shell.
        }

        try {
            barrier?.destroy();
        } catch (e) {
            // Already destroyed with the shell.
        }
    }

    _hiddenOffset() {
        if (this._slotHeight > 0)
            return this._slotHeight;

        const dash = this._dash;
        if (!this._actorAlive(dash))
            return 0;

        return dash.height + dash.margin_bottom;
    }

    _show() {
        if (!this._actorAlive(this._dash) || !this._slot || !this._autohide() || Main.overview.visible)
            return;
        if (this._fullscreenBlocks() || this._revealed)
            return;

        this._parkOnDesktop();
        this._dash.translation_y = 0;
        this._slot.remove_all_transitions();
        this._slot.translation_y = this._hiddenOffset();
        this._slot.show();
        this._revealed = true;
        this._updateEdge();
        this._setUnredirectInhibited(true);
        this._slot.ease({
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
            if (!this._actorAlive(this._dash) || !this._revealed || Main.overview.visible) {
                this._pointerWatchId = 0;
                this._outsideSince = 0;
                return GLib.SOURCE_REMOVE;
            }

            const [x, y] = global.get_pointer();
            if (this._urgent.size > 0 || this._dashMenuOpen() || this._pointerKeepsDockShown(x, y)) {
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
        if (!this._actorAlive(this._dash) || !this._revealed)
            return;

        this._clearPointerWatch();
        this._revealed = false;
        this._dash.translation_y = 0;
        this._slot.remove_all_transitions();
        this._slot.ease({
            translation_y: this._hiddenOffset(),
            duration: this._animationDuration(),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (!this._actorAlive(this._dash) || this._revealed || Main.overview.visible)
                    return;
                this._slot?.hide();
                this._setUnredirectInhibited(false);
                this._updateEdge();
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

    _dashMenuOpen() {
        const children = this._dash?._box?.get_children() ?? [];
        // The app menu is outside the dock, above the icon. The pointer
        // leaves the dock on the way there, which used to hide it.
        return children.some(item => item.child?._menu?.isOpen);
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
