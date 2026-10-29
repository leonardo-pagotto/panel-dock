UUID := panel-dock@pagotto.tech
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions
DEST := $(EXTENSIONS_DIR)/$(UUID)
BUNDLE := $(UUID).shell-extension.zip

.PHONY: install uninstall enable disable pack schemas

schemas:
	glib-compile-schemas --strict schemas/

install: pack
	if [ -L "$(DEST)" ]; then rm "$(DEST)"; fi
	gnome-extensions install --force "$(BUNDLE)"

uninstall:
	rm -rf "$(DEST)"

enable: install
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

pack:
	gnome-extensions pack --force --out-dir=. .
	zip -r $(UUID).shell-extension.zip features lib preferences services schemas