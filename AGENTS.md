# Better GNOME Shell

A GNOME Shell 50 extension that customizes the shell, starting with the top bar and the dock. The UUID is `better-gnome-shell@leonardo`.

The runtime is GJS. There is no package install and no build step. `make install` symlinks this directory into the user extensions folder.

## Current code vs target layout

[`extension.js`](extension.js) is still the GNOME template. It adds a smile indicator to the top bar and destroys that indicator in `disable()`. The indicator is not a feature. Remove it when the first real feature lands. Do not add behavior to it.

When you add a feature, create the modules below. Keep [`extension.js`](extension.js) as the lifecycle owner.

```
extension.js          # construct features, enable in order, disable in reverse
features/topBar.js    # Main.panel changes
features/dock.js      # overview Dash changes
lib/patch.js          # save and restore method replacements
lib/signals.js        # connections disconnected from disable()
stylesheet.css
metadata.json
```

Preferences pages are separate from shell features. Each tab or subpage is its own file under `preferences/`, exported for [`prefs.js`](prefs.js) to add:

```
prefs.js                    # add preferences pages to the window
preferences/generalPage.js  # General preferences tab
preferences/panelPage.js    # Panel preferences tab
preferences/dockPage.js     # Dock preferences tab
```

The rule for the next page or subpage is in [`docs/architecture.md`](docs/architecture.md).

`features/dock.js` customizes the stock overview Dash (`Main.overview.dash`) unless the task explicitly asks for a persistent dock.

## What to read

- Hard rules (Shell 50, GJS, cleanup): [`docs/constraints.md`](docs/constraints.md)
- Where code goes and how enable/disable is wired: [`docs/architecture.md`](docs/architecture.md)
- Style, SOLID, logging, timeouts, gettext: [`docs/coding-practices.md`](docs/coding-practices.md)
- Monkeypatch, signals, actors, CSS: [`docs/patterns.md`](docs/patterns.md)

Cursor also injects short copies of these rules from [`.cursor/rules/`](.cursor/rules). The markdown guides are the full version. Read the guide before implementing a feature.

## Before you implement

1. Read [`docs/constraints.md`](docs/constraints.md) and [`docs/architecture.md`](docs/architecture.md).
2. Put the change in the feature module for that shell surface.
3. Make `disable()` undo everything `enable()` did, including a partial `enable()`.
