# InventTasks

Project and task management inside [Obsidian](https://obsidian.md) — boards,
lists, custom fields, dependencies and an optional self-hosted sync server.
Everything lives in your vault as plain Markdown files.

**Website and documentation: https://inventtasks.solidinvent.pl**

This repository exists to distribute the plugin. **InventTasks is not open
source** — the source lives in a private repository, and only the built plugin
is published here, under the [EULA](LICENSE). The same files are also available
directly from the website.

## Install

### Manual

1. Download `inventtasks.zip` from the [latest release](https://github.com/solidinvent-dev/inventtasks/releases/latest).
2. Unzip it into `<vault>/.obsidian/plugins/` — the archive contains the
   `inventtasks/` folder.
3. Restart Obsidian, then enable **InventTasks** under
   Settings → Community plugins.

Installing on mobile? `INSTALL.md` inside the zip covers it.

### With BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs the plugin from
this repository and keeps it updated automatically:

1. Install BRAT from Obsidian's community plugins.
2. *Add beta plugin* → `solidinvent-dev/inventtasks`.

Each release also carries `main.js`, `manifest.json` and `styles.css` as loose
files, which is what BRAT reads.

## Versions

Every release is tagged and stays available, so you can roll back. The
[latest release](https://github.com/solidinvent-dev/inventtasks/releases/latest)
is always the current version.

## Free and paid

The plugin is fully functional for free with capacity limits — see the website
for what those are and what a license lifts. A license is a one-time purchase,
not a subscription.

## Support

Open an issue here, or write to contact@solidinvent.pl.
