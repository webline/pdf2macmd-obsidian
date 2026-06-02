# PDF2MACMD — Obsidian-Plugin

Frontend für das native `pdf2macmd`-Binary. Überwacht einen Quell-Ordner im Vault, schickt neue PDFs an das Binary (Apple Vision, on-device) und legt das erzeugte Markdown im Ziel-Ordner ab. Die Original-PDF wandert ins Archiv; die Notiz verlinkt per `quelle`-Property darauf.

> [!important]
> **macOS-only.** Das Plugin ruft ein natives macOS-Binary auf (Apple Vision Document API, macOS 26+). `isDesktopOnly: true` — auf Mobile nicht verfügbar.

## Voraussetzung: das Binary

Das Plugin liefert **kein** Binary mit. Zwei getrennte Artefakte, zwei Kanäle:

1. **Binary** — über die notarisierte `.pkg` (installiert nach `/usr/local/bin/pdf2macmd`).
2. **Plugin** — dieser Ordner.

Fehlt das Binary, zeigt das Plugin in den Einstellungen einen Download-Button und beim Start einen Hinweis.

## Ablauf pro PDF

1. PDF erscheint im **Quell-Ordner** → Stabilitäts-Check (Größe konstant).
2. `pdf2macmd convert <pdf> --out <temp.md>` (+ optional `--ocr-all`, `--dpi`).
3. Original-PDF → **Archiv-Ordner**.
4. Notiz mit Frontmatter (`quelle`, `erstellt`) → **Ziel-Ordner**.

Namens­kollisionen werden mit `-1`, `-2` … umgangen, nie überschrieben.

## Installation (ohne Community-Katalog)

Aus dem Repo-Wurzelverzeichnis:

```bash
./plugin-install.sh "/Users/<du>/Documents/Obsidian/<Vault>"
```

Das Skript baut das Plugin und kopiert `manifest.json`, `main.js`, `styles.css` nach `<Vault>/.obsidian/plugins/pdf2macmd/`. Danach in Obsidian unter *Einstellungen → Community-Plugins* den eingeschränkten Modus aus und **PDF2MACMD** aktivieren.

Alternativ über [BRAT](https://github.com/TfTHacker/obsidian42-brat) direkt aus dem GitHub-Repo (inkl. Auto-Updates).

## Entwicklung

```bash
npm install
npm run dev     # esbuild watch → main.js
npm run build   # Typecheck + Produktions-Build
```

## Einstellungen

| Feld | Default |
|---|---|
| Quell-Ordner | `07 Anhänge/PDFs/zu-verarbeiten` |
| Ziel-Ordner (MD) | `01 Inbox` |
| Archiv-Ordner (PDF) | `07 Anhänge/PDFs/verarbeitet` |
| Binary-Pfad | leer = Auto (`/usr/local/bin`, `~/.local/bin`) |
| Automatische Überwachung | an |
| Immer OCR (`--ocr-all`) | aus |
| OCR-Auflösung (DPI) | leer = 300 |

> [!note]
> Wenn dieses Plugin den Ordner überwacht, darf der alte **LaunchAgent** nicht denselben Ordner greifen — sonst Doppelverarbeitung. `plugin-install.sh` entlädt ihn.
