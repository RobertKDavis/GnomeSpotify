UUID := gnome-spotify@gumbawumba
PACKAGE := dist/$(UUID).shell-extension.zip

.PHONY: all check package install clean
all: package

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.gnome-spotify.gschema.xml
	glib-compile-schemas --strict schemas

check:
	bash -n instal.sh unintstal.sh
	glib-compile-schemas --strict --dry-run schemas
	@for file in *.js; do node --input-type=module --check < "$$file" || exit 1; done
	dbus-run-session -- gjs -m tests/mpris.test.js
	gjs -m tests/artwork.test.js
	gjs -m tests/soloist.test.js

package: schemas/gschemas.compiled
	python3 scripts/package.py

install: package
	gnome-extensions install --force $(PACKAGE)

clean:
	rm -f schemas/gschemas.compiled $(PACKAGE)
