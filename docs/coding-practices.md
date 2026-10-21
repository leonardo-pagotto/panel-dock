# Coding practices

Match the style already in [`extension.js`](../extension.js): ES modules, single quotes, semicolons, 4-space indent, trailing commas in multiline literals.

## Imports

Group `gi://` imports first, then `resource:///` imports, with a blank line between the groups. Use the extension's own modules after that.

```javascript
// Bad
const Main = imports.ui.main;
import GLib from 'gi://GLib';

// Good
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TopBar} from './features/topBar.js';
```

Use `const` and `let`. Do not use `var`.

## Privacy and names

Prefix methods and fields used only inside the class with `_`. File names in `features/` are `camelCase.js` (`topBar.js`, `dock.js`). Class names are `PascalCase` (`TopBar`, `Dock`).

Export feature classes and preferences pages as named exports. The default exports are the `Extension` subclass in [`extension.js`](../extension.js) and the `ExtensionPreferences` subclass in [`prefs.js`](../prefs.js).

## Control flow

Return early from a guard. The main path stays at the top level of the function.

Use a large `if` only when both branches are the work. A large `if` whose only job is to skip the rest of the function is a guard written inside out. A single-line `if` is fine for a guard or a one-step side effect.

```javascript
// Bad
_moveClock() {
    if (this._clock) {
        const parent = this._clock.get_parent();

        if (parent) {
            parent.remove_child(this._clock);
            this._destination.insert_child_at_index(this._clock, 0);
        }
    }
}

// Good
_moveClock() {
    if (!this._clock)
        return;

    const parent = this._clock.get_parent();
    if (!parent)
        return;

    parent.remove_child(this._clock);
    this._destination.insert_child_at_index(this._clock, 0);
}
```

Keep the `if` when code after it must still run, such as clearing fields at the end of `disable()`.

## SOLID

Apply these five principles to new code. Single responsibility comes first: it decides where the code lives.

### Single responsibility

A class has one reason to change. A JS file has one reason to change too.

`features/topBar.js` changes when the top bar changes. `features/dock.js` changes when the dock changes. `preferences/generalPage.js` changes when the General tab changes. `preferences/panelPage.js` changes when the Panel tab changes. `preferences/dockPage.js` changes when the Dock tab changes. `lib/patch.js` only saves and restores methods. `lib/signals.js` only tracks signal ids. [`extension.js`](../extension.js) only constructs features and calls `enable()` and `disable()`. [`prefs.js`](../prefs.js) only adds preferences pages. The layout is defined in [`architecture.md`](architecture.md).

A private actor used by one feature stays in that feature's file. When a second feature needs the same actor or helper, move it to its own file under `lib/` or `features/`. [`stylesheet.css`](../stylesheet.css) stays the single stylesheet.

```javascript
// Bad: one file changes for both the panel and the dash
export class Shell {
    enable() {
        this._moveClock();
        this._resizeDash();
    }
}

// Good: features/topBar.js
export class TopBar {
    enable() {
        this._moveClock();
    }
}

// Good: features/dock.js
export class Dock {
    enable() {
        this._resizeDash();
    }
}
```

`TopBar` decides what happens to the panel. It does not implement a patch stack. It uses `PatchSet` for that.

### Open/closed

Add a feature, or add code to the feature that owns that surface. Leave `PatchSet` and `SignalTracker` generic. A top-bar special case inside `lib/patch.js` means every future patch change risks the top bar.

### Liskov substitution

An actor subclass must still work wherever the parent actor works. Call `super._init(...)`, and keep the behavior callers of the parent type rely on.

Feature classes share `enable()` and `disable()` but are not a subclass tree. Do not add a base class of empty methods for each feature to stub.

### Interface segregation

The feature surface is `constructor(extension)`, `enable()`, and `disable()`. `PatchSet` does not track signals. `SignalTracker` does not restore methods. A feature that never patches does not grow patch methods of its own.

### Dependency inversion

Pass collaborators in. A feature receives the `Extension` and uses `lib/` helpers. It does not import another feature. It does not call `getSettings()` itself. When a task adds settings, [`extension.js`](../extension.js) passes the `Gio.Settings` object into the feature.

## Actors and controllers

A widget that enters the shell scene graph is a `GObject` subclass. Register it the way `Indicator` does today.

```javascript
// Bad: a plain class used as an St actor
class ClockButton {
    constructor() {
        this.actor = new St.Button();
    }
}

// Good
class ClockButton extends St.Button {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init({
            style_class: 'better-gnome-shell-clock',
            label: _('Clock'),
        });
    }
}
```

Feature controllers (`TopBar`, `Dock`, `PatchSet`, `SignalTracker`) stay plain classes. Do not register them with `GObject`.

Call the actor initializer `_init`, not `constructor`, and call `super._init(...)`.

## Logging

Log through the extension logger. `getLogger()` tags the journal line with this extension's UUID. Do not call the global `log()` or `console.log` for extension messages.

```javascript
// Bad
log('Could not find the dash');

// Good
this._logger = extension.getLogger();
this._logger.warn('Could not find the dash');
```

Use `debug` for noise, `log` for normal steps, `warn` for a skipped customization, and `error` when a feature cannot finish `enable()`.

## Timeouts

Schedule delayed work with `GLib.timeout_add`. Store the source id and remove it in `disable()`. Do not use `setTimeout` or `setInterval`.

Clear the id inside the callback when the source removes itself, so `disable()` does not remove an id that already fired.

```javascript
// Bad
this._handle = setInterval(() => this._refresh(), 200);

// Good
this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
    this._timeoutId = 0;
    this._refresh();
    return GLib.SOURCE_REMOVE;
});

// in disable()
if (this._timeoutId) {
    GLib.source_remove(this._timeoutId);
    this._timeoutId = 0;
}
```

Return `GLib.SOURCE_REMOVE` from a one-shot callback and `GLib.SOURCE_CONTINUE` from a callback that must run again. A repeating source is still removed in `disable()`.

## Strings

Wrap user-visible strings in `gettext`, imported as `_` from `resource:///org/gnome/shell/extensions/extension.js`. The domain is `better-gnome-shell`, already set in [`metadata.json`](../metadata.json).

Leave journal messages and code identifiers untranslated.

## Errors

Let `enable()` throw when a feature cannot safely change the shell. Register the feature on `this._features` before `enable()`, as in [`architecture.md`](architecture.md), so `disable()` still runs.

Catch only when the feature can skip that one change and leave the shell as it was. Log the skip with `warn`. Do not swallow an error and continue with a half-applied patch.

## Comments

Do not comment what the next line does. Comment a shell-internal constraint a reader cannot see from the code, such as why a stock method must be called before the custom work.
