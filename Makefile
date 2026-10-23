UUID := better-gnome-shell@pagotto.tech
EXTENSIONS_DIR := $(HOME)/.local/share/gnome-shell/extensions
DEST := $(EXTENSIONS_DIR)/$(UUID)

.PHONY: install uninstall enable disable pack schemas

schemas:
	glib-compile-schemas --strict schemas/

install: schemas
	mkdir -p $(EXTENSIONS_DIR)
	ln -sfn $(CURDIR) $(DEST)

uninstall:
	rm -f $(DEST)

enable: install
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

pack:
	gnome-extensions pack --force --out-dir=. .
	zip -r $(UUID).shell-extension.zip features lib preferences services
