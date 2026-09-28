# Full PDF Translate

English | [简体中文](README.md)

[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-red?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/License-AGPL--3.0-blue?style=flat-square)](LICENSE)

Translate whole PDFs into **layout/formula/table-preserving bilingual PDFs** inside Zotero with one click, using **your own LLM API keys** (any OpenAI-compatible endpoint). The translation engine runs locally — no paid cloud service involved.

Positioning: an open-source, self-hosted alternative to doc2x / Immersive Translate Pro.

![layout](doc/layout-demo.png)

## Features

- **Right-click to translate**: select items (or a PDF attachment) → right-click → "Translate whole PDF"; right-click a collection for batch translation, with a sequential queue, progress notifications, retries — and a "Cancel translation tasks" entry while running
- **doc2x-style side-by-side layout** (on by default): original on the left, translation on the right, merged onto one wide page; switchable back to the engine's stacked layout (supported on both v1 and v2 engines)
- **Bilingual + translated PDFs**: produced locally by [pdf2zh](https://github.com/PDFMathTranslate/PDFMathTranslate) — layout, formulas and tables preserved, **no watermark by default**
- **Bring your own key, multiple service profiles**: built-in presets for Zhipu GLM / DeepSeek / Alibaba Qwen / Kimi / SiliconFlow / Xiaomi MiMo / OpenAI / Gemini / Ollama, plus any custom OpenAI-compatible endpoint; switch profiles anytime, with a connection test; API keys travel via environment variables, never the command line
- **Preset modes (out of the box)**: ⚡ quick preview / 📖 careful reading (auto glossary) / 🗂 scanned PDFs (OCR workaround) / ⚙ custom
- **Highly customizable**: source/target language, page range, output (bilingual / translated / both), QPS & concurrency, custom system prompt, glossary CSV, watermark toggle, auto-open on finish
- **Auto re-attach**: results are attached back under the original item, named `Title.zh.bilingual`
- **Two engines, fully managed**: the portable v1 engine (~520 MB, no Python needed) is downloaded automatically on first use, with sha256 integrity verification and automatic mirror fallback; a v2 engine installed via `uv tool install pdf2zh_next` is picked up automatically once you select "pdf2zh_next" as the engine kind in settings; any engine path can also be set manually

## Installation

1. Install [Zotero 7](https://www.zotero.org/) or later (verified on Zotero 10)
2. Download `full-pdf-translate.xpi` from [Releases](https://github.com/coderirse/zotero-fulltext-pdf-translate/releases)
3. Zotero → Tools → Plugins → gear icon → Install Plugin From File… → pick the xpi
4. Edit → Settings → "Full PDF Translate" in the left sidebar:
   - **API Services**: create a profile (e.g. Zhipu GLM), fill in the API key and model, click "Test", save
   - **Engine**: click "Download engine" (first time only; if the direct GitHub download fails, mirrors are tried automatically)
5. Right-click an item → "Translate whole PDF (bilingual)"

> Tip: if the engine fails to start, you are most likely missing the VC++ runtime: https://aka.ms/vs/17/release/vc_redist.x64.exe
> On macOS / Linux, install the engine yourself with `uv tool install pdf2zh-next` and point the plugin to the executable in settings.

## How it works

A Zotero 7+ plugin (TypeScript) starts the local translation engine as a subprocess via `Subprocess` (API keys go through environment variables, never the command line), producing mono/dual PDFs. With the side-by-side layout enabled, the engine's bundled Python + PyMuPDF merges original and translated pages onto one wide page. Results are attached to the item with `Zotero.Attachments.importFromFile`.

```
src/
  hooks.ts               lifecycle + self-diagnostics
  modules/
    engine.ts            engine detection / download (curl+tar, stall detection + mirror fallback) / manual path
    runner.ts            builds the engine command line, runs it, side-by-side merge, collects outputs
    queue.ts             translation queue (sequential, progress notifications)
    profiles.ts          service profiles, provider presets, connection test
    presets.ts           preset-mode parameter packs
    items.ts             collects PDF attachments from items/collections
    attach.ts            result attachment & naming
    menus.ts             right-click menus
    prefsUI.ts           preferences UI
addon/                   manifest / prefs / preferences pane / merge script / locales
```

## Development

```bash
npm install
npm run build     # build the XPI into .scaffold/build/
npm start         # dev mode (copy .env.example to .env and point it at Zotero)
```

Self-diagnostics: set the advanced pref `extensions.zotero.fullpdf.debugProbe` to `true` and restart — the plugin writes a full report of the settings-pane loading pipeline to `fullpdf-diagnostics.json` in the data directory. Attach it when filing an issue.

## Verified

Since v0.2.2 the full pipeline has been verified end-to-end in a real environment: Zotero 10.0.3 + Windows 11 + DeepSeek API — a 45-page paper translated into a side-by-side bilingual PDF, and batch collection translation working as expected.

v0.2.4: verified with the v2 engine (BabelDOC kernel) + Xiaomi MiMo — on a formula-dense page, the inline-formula/translated-text overlap seen with v1 disappears under v2, and the translation reads more naturally; the side-by-side layout works on v2 as well.

## Troubleshooting

| Symptom                                       | Fix                                                                                                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine fails to start                         | Install the [VC++ runtime](https://aka.ms/vs/17/release/vc_redist.x64.exe)                                                                                                                                                    |
| Engine download slow / stuck                  | Mirrors are tried automatically; you can also set a mirror prefix in settings (e.g. `https://gh-proxy.com/`)                                                                                                                  |
| Settings pane won't open                      | Set the advanced pref `extensions.zotero.fullpdf.debugProbe` to `true` and restart; `fullpdf-diagnostics.json` appears in the data directory — attach it to the issue                                                         |
| Lots of SSE connection errors in Debug Output | Comes from other plugins (e.g. doc2x-parse reconnecting to its desktop client), unrelated to this one — disable that plugin                                                                                                   |
| Result is still stacked                       | Make sure you are on v0.2.2+ and have **fully restarted Zotero** — without a restart the old code keeps running                                                                                                               |
| Formulas collide with translated text         | A layout limitation of the v1 classic pipeline. Install the v2 engine (`uv tool install pdf2zh_next`), then pick "pdf2zh_next" as the engine kind in settings — it is detected automatically and the layout improves markedly |

## Known limitations

- Out of the box on Windows (portable engine); other systems need a manually installed engine
- Scanned PDFs only get the OCR-workaround fallback — complex scans are worse than doc2x's cloud OCR
- No Word/Markdown export yet (a MinerU-based pipeline may be evaluated later)
- A page costs a few thousand tokens; try a small page range before batch-translating
- The auto-downloaded engine is the pdf2zh v1 classic pipeline (no watermark, no glossary); for better formula layout switch to the v2 engine: `uv tool install pdf2zh_next`, then select "pdf2zh_next" as the engine kind in settings (since v0.2.4 the side-by-side layout works on v2 as well)

## License

AGPL-3.0-or-later (same as the bundled engine's license). This plugin does not distribute engine binaries; it only points to the official release downloads.

Credits: [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) · [BabelDOC](https://github.com/funstory-ai/BabelDOC) · [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) (this plugin is built on it) · reference implementations [UB-Mannheim/zotero-ocr](https://github.com/UB-Mannheim/zotero-ocr) and [guaguastandup/zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh).
