# PDF2MACMD — Obsidian-Plugin

**Wandelt PDFs direkt in deinem Vault in saubere Markdown-Notizen um** — on-device über **Apple Vision**, in bemerkenswert hoher Qualität. Erkannt werden Überschriften, Absätze, Listen, **echte Tabellen**, Fett/Kursiv und Fußnoten — mit deutschem Sprachmodell, De-Hyphenation und automatischer Wahl zwischen Textebene und OCR. Keine Cloud, keine externen Dienste, alles bleibt auf dem Mac.

Der Ablauf aus deiner Sicht: PDF in den Quell-Ordner legen → das Plugin erzeugt die Notiz im Ziel-Ordner, archiviert die Original-PDF und verlinkt sie per `quelle`-Property. Die eigentliche Umwandlung erledigt das native `pdf2macmd`-Binary; das Plugin steuert Überwachung, Aufruf und Ablage.

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

## Verteilung: zwei Repos

Der Swift-Quellcode des Binaries bleibt **privat**; Plugin und (kompilierte) `.pkg` werden **öffentlich** verteilt. Das erzwingt zwei getrennte Repos:

| Repo | Sichtbarkeit | Inhalt |
|---|---|---|
| `webline/pdf2macmd` | **privat** | Swift-Quelle + `release.sh` → baut die notarisierte `.pkg` |
| `webline/pdf2macmd-obsidian` | **öffentlich** | dieser Plugin-Quellcode; BRAT-Ziel |

Jeder **GitHub-Release** im öffentlichen Repo trägt vier Assets: `manifest.json`, `main.js`, `styles.css` (Plugin, für BRAT) und `pdf2macmd-<ver>.pkg` (Binär — kein Quellcode). Eine hochgeladene `.pkg` legt nichts vom Swift-Code offen.

## Installation für Nutzer

**Plugin (empfohlen, mit Auto-Update):** In [BRAT](https://github.com/TfTHacker/obsidian42-brat) *Add beta plugin* → `webline/pdf2macmd-obsidian`.

**Binary (empfohlen):** In den Plugin-Einstellungen auf **„Binary installieren"** klicken — das Plugin lädt das signierte Programm direkt in seinen Ordner. Kein Installer, kein Admin-Passwort. Danach ist es sofort einsatzbereit. **Voraussetzung: macOS 26+** (Apple Vision Document API).

**Binary (manueller Fallback):** Die `.pkg` aus dem neuesten Release doppelklicken (notarisiert, installiert nach `/usr/local/bin`). Anschließend in den Plugin-Einstellungen auf **„Erneut prüfen"** klicken — oder **Obsidian neu starten**, damit das Plugin das Binary erkennt.

**Manuell ohne GitHub** (für eigene Macs): aus dem privaten Repo-Root
```bash
./plugin-install.sh "/Users/<du>/Documents/Obsidian/<Vault>"
```
kopiert die gebauten Plugin-Dateien direkt ins Vault.

## Öffentliche API (für andere Plugins)

Andere Plugins können die Bild-OCR mitnutzen — z. B. [Booxidian](https://github.com/webline/ObsidianBoox), das seine gerenderten Handschrift-Seiten hierüber on-device transkribiert. Das Plugin legt dazu eine kleine, versionierte API auf seiner Instanz ab:

```ts
interface Pdf2macmdApi {
  readonly version: number;                    // Vertragsversion (aktuell 1)
  isAvailable(): Promise<boolean>;             // Binary vorhanden UND ocr-fähig (≥ 0.2.0)
  ocrImage(                                     // Einzelbild → reiner Text (Apple Vision)
    image: Uint8Array | ArrayBuffer | string,  // Bytes oder absoluter Dateipfad
    options?: { languages?: string[] },        // Standard: ["de-DE", "en-US"]
  ): Promise<string>;
}
```

Zugriff aus einem anderen Plugin:

```ts
const api = (this.app as any).plugins?.plugins?.["pdf2macmd"]?.api;
if (api && (await api.isAvailable())) {
  const text = await api.ocrImage(pngBytes);
}
```

`isAvailable()` prüft echt gegen `pdf2macmd version` — ist nur ein altes Binary (< 0.2.0, ohne `ocr`-Befehl) installiert, liefert es `false`, statt den Aufruf später scheitern zu lassen. Die API ist rein additiv; der PDF→Markdown-Ablauf bleibt davon unberührt.

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
