# Constraints

These rules are easy to violate and hard to recover from. Follow them on every change.

## Shell version

Target GNOME Shell 50 only. [`metadata.json`](../metadata.json) lists `"shell-version": ["50"]`.

Do not add compatibility shims, version branches, or imports that exist only on older shells unless the task asks for them.

## Runtime

The extension runs inside GJS, the GNOME JavaScript runtime. It is not a Node project.

- Import libraries from `gi://` and shell modules from `resource:///`.
- Do not add `package.json`, npm, a bundler, TypeScript, `require()`, or Node built-ins (`fs`, `path`, `process`).

```javascript
// Bad
const GLib = require('gi://GLib');

// Good
import GLib from 'gi://GLib';
```

## Do not patch the installed shell

Never edit files under `/usr/share/gnome-shell` or any other system copy of the shell.

Apply every visual or behavioral change at runtime from this extension. Reverse that change in `disable()`.

## enable() and disable()

`enable()` may change the shell. `disable()` restores it.

GNOME Shell calls `disable()` after `enable()`, and also when `enable()` throws. Write `disable()` so it is safe when `enable()` stopped halfway.

`disable()` must:

- Remove timeouts and idle sources.
- Disconnect signals.
- Restore every replaced method to the original function.
- Restore stock widgets that were hidden, moved, or restyled (visibility and position).
- Destroy actors this extension created.
- Set the fields that held those objects to `null`.

`disable()` must not throw. A throw there leaves the session with a half-reverted shell. It must also be safe to call twice.

```javascript
// Bad: leaks the actor and the signal if enable() fails later
enable() {
    this._button = new Indicator();
    Main.panel.addToStatusArea(this.uuid, this._button);
    this._panel.connect('scroll-event', this._onScroll);
}

disable() {
    this._button.destroy();
}

// Good: disable() undoes whatever enable() finished
disable() {
    if (this._timeoutId) {
        GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    this._signals?.disconnectAll();
    this._patches?.restoreAll();

    this._button?.destroy();
    this._button = null;
}
```

Cleanup order inside `disable()`:

1. Remove timeouts and idle sources.
2. Disconnect signals.
3. Restore patched methods.
4. Restore stock widgets.
5. Destroy actors this feature created.
6. Null the fields.

## Where code goes

[`extension.js`](../extension.js) constructs features, calls `enable()` in order, and calls `disable()` in reverse order. UI, patches, and signal handlers live in feature modules. See [`architecture.md`](architecture.md).

## Template indicator

The smile indicator in [`extension.js`](../extension.js) is the upstream template, not a product feature. Remove it when the first real feature lands. Do not attach new behavior to it.

## License header

Start every new JS file with:

```javascript
// SPDX-License-Identifier: GPL-2.0-or-later
```

## User preferences

Do not add a GSettings schema or `prefs.js` until a task needs a user preference. When that happens, follow [`architecture.md`](architecture.md).
