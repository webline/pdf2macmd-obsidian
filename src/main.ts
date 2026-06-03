/*
 * PDF2MACMD — Obsidian-Plugin-Frontend
 * Copyright (c) 2026 Detlef Beyer / Medienkonzepte GbR
 *
 * Überwacht einen Quell-Ordner im Vault, schickt neue PDFs an das native
 * pdf2macmd-Binary (Apple Vision, on-device) und legt das erzeugte Markdown
 * im Ziel-Ordner ab. Die Original-PDF wandert in den Archiv-Ordner; die Notiz
 * verlinkt per `quelle`-Property auf diese archivierte PDF.
 *
 * Das Binary wird NICHT mitgeliefert — es kommt über die separate .pkg
 * (notarisiert, installiert nach /usr/local/bin). Dieses Plugin ruft es nur auf.
 */

import {
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";

import { LOGO_DATA_URI } from "./logo";

import { execFile } from "child_process";
import { promisify } from "util";
import { rename, readFile, unlink, stat, mkdir, writeFile, chmod } from "fs/promises";
import { tmpdir } from "os";
import { homedir } from "os";
import { join as pathJoin, dirname } from "path";

const execFileAsync = promisify(execFile);

/**
 * Direkter Download des signierten Standalone-Binaries vom jeweils neuesten
 * Release (stabiler Asset-Name `pdf2macmd`). Das Plugin lädt es in seinen
 * eigenen Ordner — kein Installer, kein Admin, kein GitHub-Browsing.
 */
const BINARY_DOWNLOAD_URL =
  "https://github.com/webline/pdf2macmd-obsidian/releases/latest/download/pdf2macmd";

/** Fallback: Release-Seite mit der .pkg, falls der Auto-Download scheitert. */
const PKG_DOWNLOAD_URL =
  "https://github.com/webline/pdf2macmd-obsidian/releases/latest";

/** Kandidaten-Pfade, wenn der Nutzer keinen expliziten Binary-Pfad gesetzt hat. */
const BINARY_CANDIDATES = [
  "/usr/local/bin/pdf2macmd",
  pathJoin(homedir(), ".local/bin/pdf2macmd"),
];

interface Pdf2macmdSettings {
  /** Quell-Ordner für neue PDFs (vault-relativ). */
  sourceFolder: string;
  /** Ziel-Ordner für erzeugte Markdown-Notizen (vault-relativ). */
  targetFolder: string;
  /** Archiv-Ordner für bereits verarbeitete PDFs (vault-relativ, MUSS im Vault liegen). */
  processedFolder: string;
  /** Expliziter Pfad zum pdf2macmd-Binary. Leer = Auto-Erkennung. */
  binaryPath: string;
  /** Automatische Überwachung des Quell-Ordners aktiv. */
  watchEnabled: boolean;
  /** `--ocr-all`: immer die Vision Document API nutzen. */
  ocrAll: boolean;
  /** Render-Auflösung für OCR-Seiten; leer = Binary-Default (300). */
  dpi: string;
}

const DEFAULT_SETTINGS: Pdf2macmdSettings = {
  sourceFolder: "07 Anhänge/PDFs/zu-verarbeiten",
  targetFolder: "01 Inbox",
  processedFolder: "07 Anhänge/PDFs/verarbeitet",
  binaryPath: "",
  watchEnabled: true,
  ocrAll: false,
  dpi: "",
};

export default class Pdf2macmdPlugin extends Plugin {
  declare settings: Pdf2macmdSettings;

  /** Gerade in Verarbeitung befindliche absolute PDF-Pfade — verhindert Doppelläufe. */
  private inFlight = new Set<string>();

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new Pdf2macmdSettingTab(this.app, this));

    this.addRibbonIcon("file-scan", "PDF2MACMD: Quell-Ordner scannen", () => {
      void this.scanSourceFolder();
    });

    this.addCommand({
      id: "scan-source-folder",
      name: "Quell-Ordner jetzt scannen",
      callback: () => void this.scanSourceFolder(),
    });

    // Erst nach dem Vault-Aufbau registrieren — sonst feuert 'create' beim
    // Start für jede bestehende Datei.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) void this.handleCreate(file);
        }),
      );
      void this.checkBinary();
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Binary-Auflösung ─────────────────────────────────────────────

  /** Vom Plugin selbst verwalteter Binary-Pfad (Auto-Download landet hier). */
  managedBinaryPath(): string {
    return pathJoin(this.vaultBase(), this.manifest.dir ?? "", "bin", "pdf2macmd");
  }

  /** Liefert den zu nutzenden Binary-Pfad oder null, wenn keiner existiert. */
  async resolveBinary(): Promise<string | null> {
    const explicit = this.settings.binaryPath.trim();
    const candidates = explicit
      ? [explicit.replace(/^~(?=$|\/)/, homedir())]
      : [this.managedBinaryPath(), ...BINARY_CANDIDATES];
    for (const candidate of candidates) {
      try {
        await stat(candidate);
        return candidate;
      } catch {
        /* nächster Kandidat */
      }
    }
    return null;
  }

  /**
   * Lädt das signierte Binary vom neuesten Release in den Plugin-Ordner,
   * macht es ausführbar und gibt true zurück. Kein Installer, kein Admin —
   * weil das Plugin die Datei schreibt, wird sie nicht in Quarantäne gestellt.
   */
  async downloadBinary(): Promise<boolean> {
    const dest = this.managedBinaryPath();
    const notice = new Notice("PDF2MACMD: Binary wird geladen …", 0);
    try {
      const res = await requestUrl({ url: BINARY_DOWNLOAD_URL, method: "GET", throw: false });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const bytes = res.arrayBuffer;
      if (!bytes || bytes.byteLength < 1024) throw new Error("Leere oder zu kleine Datei");

      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(bytes));
      await chmod(dest, 0o755);

      notice.hide();
      new Notice(`PDF2MACMD: Binary installiert (${Math.round(bytes.byteLength / 1024)} KB).`);
      return true;
    } catch (err) {
      notice.hide();
      console.error("PDF2MACMD: Binary-Download fehlgeschlagen", err);
      new Notice(
        `PDF2MACMD: Download fehlgeschlagen — ${err instanceof Error ? err.message : String(err)}. ` +
          "Du kannst die .pkg auch manuell installieren.",
        10000,
      );
      return false;
    }
  }

  private async checkBinary() {
    if (!(await this.resolveBinary())) {
      new Notice(
        "PDF2MACMD: Binary nicht gefunden. In den Plugin-Einstellungen lässt es sich " +
          "mit einem Klick automatisch installieren.",
        10000,
      );
    }
  }

  // ── Pfad-Helfer ──────────────────────────────────────────────────

  private vaultBase(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("PDF2MACMD braucht einen Datei­system-Vault (Desktop).");
  }

  private absPath(vaultRelative: string): string {
    return pathJoin(this.vaultBase(), vaultRelative);
  }

  /** Ermittelt einen Basisnamen, der weder als .md im Ziel noch als .pdf im Archiv kollidiert. */
  private async uniqueBase(base: string): Promise<string> {
    const taken = async (b: string) =>
      (await this.app.vault.adapter.exists(
        normalizePath(`${this.settings.targetFolder}/${b}.md`),
      )) ||
      (await this.app.vault.adapter.exists(
        normalizePath(`${this.settings.processedFolder}/${b}.pdf`),
      ));

    let candidate = base;
    let i = 1;
    while (await taken(candidate)) candidate = `${base}-${i++}`;
    return candidate;
  }

  private async ensureFolder(vaultRelative: string) {
    const path = normalizePath(vaultRelative);
    if (!(await this.app.vault.adapter.exists(path))) {
      await this.app.vault.createFolder(path);
    }
  }

  // ── Auslöser ─────────────────────────────────────────────────────

  private async handleCreate(file: TFile) {
    if (!this.settings.watchEnabled) return;
    if (file.extension.toLowerCase() !== "pdf") return;
    // Nur PDFs direkt im Quell-Ordner — nicht im Archiv (sonst Endlosschleife).
    if (file.parent?.path !== normalizePath(this.settings.sourceFolder)) return;
    await this.process(file);
  }

  /** Verarbeitet alle PDFs, die aktuell im Quell-Ordner liegen (Altbestand). */
  async scanSourceFolder() {
    const source = normalizePath(this.settings.sourceFolder);
    const pdfs = this.app.vault
      .getFiles()
      .filter((f) => f.extension.toLowerCase() === "pdf" && f.parent?.path === source);

    if (pdfs.length === 0) {
      new Notice("PDF2MACMD: Keine PDFs im Quell-Ordner.");
      return;
    }
    new Notice(`PDF2MACMD: ${pdfs.length} PDF(s) werden verarbeitet …`);
    for (const pdf of pdfs) await this.process(pdf);
  }

  // ── Kern-Verarbeitung ────────────────────────────────────────────

  private async process(pdf: TFile) {
    const absSource = this.absPath(pdf.path);
    if (this.inFlight.has(absSource)) return;
    this.inFlight.add(absSource);

    let tmpMd: string | null = null;
    try {
      const binary = await this.resolveBinary();
      if (!binary) {
        new Notice(
          "PDF2MACMD: Binary nicht gefunden — Installer (.pkg) ausführen oder Pfad setzen.",
          8000,
        );
        return;
      }

      // Warten, bis die Datei vollständig kopiert ist (Größe stabil).
      if (!(await this.waitForStable(absSource))) {
        new Notice(`PDF2MACMD: „${pdf.name}" wurde nicht stabil — übersprungen.`, 8000);
        return;
      }

      await this.ensureFolder(this.settings.targetFolder);
      await this.ensureFolder(this.settings.processedFolder);

      const base = await this.uniqueBase(pdf.basename);
      const mdRel = normalizePath(`${this.settings.targetFolder}/${base}.md`);
      const processedRel = normalizePath(`${this.settings.processedFolder}/${base}.pdf`);

      // 1) Binary → Markdown in eine temporäre Datei.
      tmpMd = pathJoin(tmpdir(), `pdf2macmd-${base}-${Date.now()}.md`);
      const args = ["convert", absSource, "--out", tmpMd];
      if (this.settings.ocrAll) args.push("--ocr-all");
      const dpi = this.settings.dpi.trim();
      if (dpi) args.push("--dpi", dpi);

      await execFileAsync(binary, args, { maxBuffer: 64 * 1024 * 1024 });

      const body = await readFile(tmpMd, "utf8");

      // 2) Original-PDF ins Archiv verschieben (vor dem Notiz-Schreiben,
      //    damit die quelle-Property auf den Zielort zeigt).
      await rename(absSource, this.absPath(processedRel));

      // 3) Notiz mit Frontmatter erzeugen.
      const today = new Date().toISOString().slice(0, 10);
      const frontmatter =
        `---\n` +
        `quelle: "[[${processedRel}]]"\n` +
        `erstellt: ${today}\n` +
        `---\n\n`;
      await this.app.vault.create(mdRel, frontmatter + body);

      new Notice(`PDF2MACMD: „${pdf.basename}" → ${mdRel}`);
    } catch (err) {
      console.error("PDF2MACMD: Verarbeitung fehlgeschlagen für", pdf.path, err);
      new Notice(
        `PDF2MACMD: Fehler bei „${pdf.name}" — ${err instanceof Error ? err.message : String(err)}`,
        10000,
      );
    } finally {
      if (tmpMd) await unlink(tmpMd).catch(() => undefined);
      this.inFlight.delete(absSource);
    }
  }

  /**
   * Pollt die Dateigröße, bis sie zweimal in Folge identisch (und > 0) ist —
   * schützt vor noch laufenden Kopiervorgängen großer PDFs.
   */
  private async waitForStable(absFile: string): Promise<boolean> {
    let last = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      let size: number;
      try {
        size = (await stat(absFile)).size;
      } catch {
        return false; // Datei verschwand (z. B. wieder entfernt)
      }
      if (size > 0 && size === last) return true;
      last = size;
      await sleep(500);
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Einstellungen ──────────────────────────────────────────────────

class Pdf2macmdSettingTab extends PluginSettingTab {
  constructor(
    app: import("obsidian").App,
    private plugin: Pdf2macmdPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Kopfbereich: Logo + kurze Funktionsbeschreibung.
    const header = containerEl.createDiv({ cls: "pdf2macmd-header" });
    header.createEl("img", {
      cls: "pdf2macmd-logo",
      attr: { src: LOGO_DATA_URI, alt: "Medienkonzepte – Logo" },
    });
    header.createEl("p", {
      cls: "pdf2macmd-intro",
      text:
        "Wandelt PDFs aus dem Quell-Ordner on-device über Apple Vision in saubere " +
        "Markdown-Notizen um – mit Überschriften, Tabellen, Listen und Fußnoten. " +
        "Die Original-PDF wird archiviert und in der Notiz verlinkt.",
    });

    // Binary-Status oben — Container jetzt platzieren, asynchron füllen.
    const statusEl = containerEl.createDiv();
    void this.renderBinaryStatus(statusEl);

    new Setting(containerEl)
      .setName("Quell-Ordner")
      .setDesc("Neue PDFs hier ablegen (vault-relativer Pfad). Werden automatisch verarbeitet.")
      .addText((t) =>
        t
          .setPlaceholder("07 Anhänge/PDFs/zu-verarbeiten")
          .setValue(this.plugin.settings.sourceFolder)
          .onChange(async (v) => {
            this.plugin.settings.sourceFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Ziel-Ordner (Markdown)")
      .setDesc("Hier landen die erzeugten .md-Notizen.")
      .addText((t) =>
        t
          .setPlaceholder("01 Inbox")
          .setValue(this.plugin.settings.targetFolder)
          .onChange(async (v) => {
            this.plugin.settings.targetFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Archiv-Ordner (PDF)")
      .setDesc(
        "Verarbeitete PDFs werden hierher verschoben. Muss im Vault liegen, " +
          "damit die quelle-Verknüpfung in der Notiz klickbar ist.",
      )
      .addText((t) =>
        t
          .setPlaceholder("07 Anhänge/PDFs/verarbeitet")
          .setValue(this.plugin.settings.processedFolder)
          .onChange(async (v) => {
            this.plugin.settings.processedFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Automatische Überwachung")
      .setDesc("Neue PDFs im Quell-Ordner sofort verarbeiten.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.watchEnabled).onChange(async (v) => {
          this.plugin.settings.watchEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Immer OCR (--ocr-all)")
      .setDesc("Auch bei vorhandener Textebene die Vision Document API erzwingen (Tabellen/Spalten).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.ocrAll).onChange(async (v) => {
          this.plugin.settings.ocrAll = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("OCR-Auflösung (DPI)")
      .setDesc("Optional, 72–600. Leer = Standard (300). Höher hilft kaum — Vision sättigt ~200 dpi.")
      .addText((t) =>
        t
          .setPlaceholder("300")
          .setValue(this.plugin.settings.dpi)
          .onChange(async (v) => {
            this.plugin.settings.dpi = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Binary-Pfad")
      .setDesc("Leer = automatisch suchen (/usr/local/bin, ~/.local/bin).")
      .addText((t) =>
        t
          .setPlaceholder("/usr/local/bin/pdf2macmd")
          .setValue(this.plugin.settings.binaryPath)
          .onChange(async (v) => {
            this.plugin.settings.binaryPath = v.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((b) =>
        b
          .setIcon("refresh-cw")
          .setTooltip("Erneut prüfen")
          .onClick(() => this.display()),
      );

    new Setting(containerEl)
      .setName("Jetzt scannen")
      .setDesc("Alle PDFs verarbeiten, die bereits im Quell-Ordner liegen.")
      .addButton((b) =>
        b
          .setButtonText("Scannen")
          .setCta()
          .onClick(() => void this.plugin.scanSourceFolder()),
      );
  }

  private async renderBinaryStatus(containerEl: HTMLElement) {
    containerEl.empty();
    const binary = await this.plugin.resolveBinary();
    const setting = new Setting(containerEl).setName("pdf2macmd-Binary");

    if (binary) {
      setting.setDesc(`Gefunden: ${binary}`);
      setting.addButton((b) =>
        b
          .setButtonText("Aktualisieren")
          .setTooltip("Neueste Binary-Version laden")
          .onClick(async () => {
            if (await this.plugin.downloadBinary()) this.display();
          }),
      );
      return;
    }

    setting.setDesc(
      "Nicht gefunden. Mit einem Klick lädt das Plugin das benötigte Programm " +
        "direkt herunter — kein Installer, kein Passwort. (Voraussetzung: macOS 26+)",
    );
    setting.addButton((b) =>
      b
        .setButtonText("Binary installieren")
        .setCta()
        .onClick(async () => {
          if (await this.plugin.downloadBinary()) this.display();
        }),
    );
    setting.addExtraButton((b) =>
      b
        .setIcon("download")
        .setTooltip("Stattdessen die .pkg manuell laden")
        .onClick(() => window.open(PKG_DOWNLOAD_URL, "_blank")),
    );
  }
}
