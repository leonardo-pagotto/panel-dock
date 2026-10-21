# Patterns

Every pattern below has a matching undo step in `disable()`. Use the helpers in `lib/` once a feature needs them. The cleanup order is listed in [`constraints.md`](constraints.md).

## Monkeypatch

Save the original function, replace it once, and put that same function back in `disable()`.

`lib/patch.js`:

```javascript
export class PatchSet {
    constructor() {
        this._patches = [];
    }

    add(object, methodName, replacement) {
        const already = this._patches.some(patch =>
            patch.object === object && patch.methodName === methodName);

        if (already)
            throw new Error(`Already patched ${methodName}`);

        const original = object[methodName];

        if (original == null)
            throw new Error(`No method ${methodName} to patch`);

        object[methodName] = replacement;
        this._patches.push({object, methodName, original});
        return original;
    }

    restoreAll() {
        while (this._patches.length > 0) {
            const {object, methodName, original} = this._patches.pop();
            object[methodName] = original;
        }
    }
}
```

```javascript
// Bad: the original is lost, and enable() stacks another wrapper every reload
SomeClass.prototype._sync = function () {
    this._custom();
};

// Good
const original = this._patches.add(SomeClass.prototype, '_sync', function (...args) {
    this._custom();
    return original.apply(this, args);
});
```

Call `restoreAll()` from `disable()`. `restoreAll()` on an empty set is a no-op, so a second `disable()` is safe.

Patch a method only when the shell provides no signal or property for that change. Prefer a signal or a child actor over replacing a prototype.

## Signals

Track every `connect()` on an object this feature does not own, and disconnect those ids in `disable()`.

`lib/signals.js`:

```javascript
import GObject from 'gi://GObject';

export class SignalTracker {
    constructor() {
        this._connections = [];
    }

    connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._connections.push({object, id});
        return id;
    }

    disconnectAll() {
        while (this._connections.length > 0) {
            const {object, id} = this._connections.pop();

            try {
                if (id && GObject.signal_handler_is_connected(object, id))
                    object.disconnect(id);
            } catch (e) {
                // The object may already be gone during session shutdown.
            }
        }
    }
}
```

```javascript
// Bad: the handler stays after the extension is disabled
Main.panel.connect('scroll-event', (_actor, event) => this._onScroll(event));

// Good
this._signals.connect(Main.panel, 'scroll-event', (_actor, event) => {
    this._onScroll(event);
});
```

`connectObject(signal, callback, owner)` is only for an owner actor that this feature creates and destroys. Destroying that owner drops the handler. Do not use it for `Main.panel`, `Main.overview`, or any other shell object this feature does not destroy. Those go through `SignalTracker`.

Settings change signals, when a task adds settings, use the same tracker.

## Actors

Record visibility, parent, and index before hiding or moving a stock widget. Restore all three in `disable()`.

```javascript
enable() {
    const clock = Main.panel.statusArea.dateMenu;

    this._clock = clock;
    this._clockParent = clock.get_parent();
    this._clockIndex = this._clockParent.get_children().indexOf(clock);
    this._clockVisible = clock.visible;

    this._clockParent.remove_child(clock);
    this._destination.insert_child_at_index(clock, 0);
}

disable() {
    if (this._clock) {
        const parent = this._clock.get_parent();
        parent?.remove_child(this._clock);
        this._clockParent.insert_child_at_index(this._clock, this._clockIndex);
        this._clock.visible = this._clockVisible;
    }

    this._clock = null;
    this._clockParent = null;
}
```

`this._destination` is the box this feature chose. Remove the child from its current parent before inserting it somewhere else.

Destroy only actors this feature created. Null the field after `destroy()`, and guard with `?.` or `if`, because destroying an actor twice throws.

```javascript
// Bad
this._button.destroy();

// Good
this._button?.destroy();
this._button = null;
```

Add a new status-area indicator with `Main.panel.addToStatusArea(this._extension.uuid, indicator)` only when the feature's job is a status indicator. Pass a unique name if the panel already has an indicator with that id.

## CSS

Put shared look in [`stylesheet.css`](../stylesheet.css). Prefix every class this extension introduces with `better-gnome-shell-`.

```css
/* Bad: restyles the whole shell panel */
.panel {
    background-color: transparent;
}

/* Good */
.better-gnome-shell-clock {
    padding: 0 4px;
}
```

Use a shell class in a selector only to narrow it, and keep the extension class in the selector:

```css
.panel-button.better-gnome-shell-clock {
    padding: 0 4px;
}
```

Set `style_class` in `_init`. Use the inline `style` property only for a value computed at runtime, such as a width read from the monitor. Do not edit the system theme.
