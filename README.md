# Panel & Dock

A [GNOME Shell 50](https://extensions.gnome.org/) extension that puts a top bar on the monitors you choose and a dock on the desktop.

UUID: `panel-dock@pagotto.tech`

## Maintained by AI

This project is fully maintained by AI. Features, bug fixes, preferences, and documentation are written and updated by an AI coding agent. There is no human maintainer reviewing each change before it lands.

Treat releases as unreviewed automation. The shell session can crash if an extension misbehaves. Try it on a session you can log out of.

Copyright (c) 2026 Leonardo Pagotto. Released under the MIT License. See [LICENSE](LICENSE).

## What it does

**Panel.** Each connected monitor can show or hide the top bar. On the monitors that show one, you choose which status buttons appear (clock, system menu, extension indicators, and the rest of the status area). Extra monitors get their own bar. Those bars mirror the primary bar’s indicators, and a click opens the same menu. Turning the extension off puts the stock panel back.

**Dock.** A dock built from the shell Dash sits on the bottom edge of the primary monitor. The overview Dash stays in the overview. While the overview is closed, the dock can hide until you bring it back.

Dock behavior, from the preferences window:

- Autohide on the desktop. The dock stays visible in the overview.
- Pressure to activate: the pointer has to press the bottom edge before the dock appears. With this off, moving into the dock area shows it.
- Optional reveal while a window is fullscreen on the primary monitor.
- Optional reveal when a critical notification arrives, until that notification is dismissed.
- Animation duration, hide delay, and pressure distance.
- Left click and middle click on an app icon: focus or open, open a new window, or close that app’s windows.
- The Show Apps button opens the app grid.

The orientation control is stored and is not applied yet. The dock is at the bottom.

Extra bars are named `panelBox` and the dock actor is named `dash`, so [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/) can style them the same way it styles the stock panel and dash.

## Requirements

- GNOME Shell 50. Older shells are not supported.
- A user session. The extension does not run on the lock screen.

## Install

From this directory:

```sh
make install
make enable
```

`make install` packs the extension and installs it with `gnome-extensions`. Log out and back in if the shell does not pick it up. Wayland does not reload the shell in place.

Open **Extensions** and turn on **Panel & Dock**, or:

```sh
gnome-extensions enable panel-dock@pagotto.tech
```

Preferences are under the extension’s settings: **General**, **Panel**, and **Dock**. General is reserved for options that apply to the whole extension.

Remove it with:

```sh
make disable
make uninstall
```

## Development

Runtime is GJS. Imports come from `gi://` and `resource:///`. Nothing here is built with Node.

```text
extension.js          lifecycle: enable features, disable them in reverse
features/topBar.js    top bar, including one bar per monitor
features/dock.js      desktop dock
services/             settings-backed panel and monitor state
preferences/          one Adwaita page per tab
prefs.js              adds those pages to the preferences window
lib/                  method patches and signal tracking
schemas/              GSettings
stylesheet.css        extension styles
```

`extension.js` only starts and stops features. Each feature applies its changes at runtime and undoes them in `disable()`, including a partial `enable()` and a second `disable()`.

```sh
make schemas    # compile GSettings
make pack       # write panel-dock@pagotto.tech.shell-extension.zip
make enable     # install and enable
make disable
make uninstall
```

Pack output and compiled schemas are gitignored.
