import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { runSubprocess } from "../utils/subprocess";

const RELEASE_API_URL =
  "https://api.github.com/repos/PDFMathTranslate/PDFMathTranslate/releases/latest";
// Kept as a fallback when the GitHub API is unreachable; the API path
// above always prefers the newest release. The published Windows zip
// bundles the pdf2zh v1 engine (embedded Python runtime + fonts +
// layout model), so it works fully offline after extraction.
const FALLBACK_DOWNLOAD_URL =
  "https://github.com/PDFMathTranslate/PDFMathTranslate/releases/download/v1.9.11/pdf2zh-v1.9.11-with-assets-win64.zip";

// Tried in order after a failed direct download; gh-proxy.com measured
// ~3 MB/s from mainland China while direct GitHub gave ~17 KB/s.
const MIRROR_PREFIXES = ["https://gh-proxy.com/", "https://ghproxy.net/"];

// --speed-time/--speed-limit abort a stalled transfer (<10 KB/s for 30s)
// instead of hanging forever.
const CURL_FLAGS = [
  "-fL",
  "--retry",
  "3",
  "--connect-timeout",
  "30",
  "--speed-time",
  "30",
  "--speed-limit",
  "10240",
  "--progress-bar",
];

export interface EngineInfo {
  path: string;
  // "next" = pdf2zh_next.exe (v2, BabelDOC kernel, installed manually e.g.
  // via `uv tool install pdf2zh-next`); "v1" = pdf2zh.exe from the
  // auto-downloaded release zip.
  kind: "next" | "v1";
}

export type DownloadProgress = (pct: number | null, message: string) => void;

export function getEngineDataDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
}

function getEngineUnzipDir(): string {
  return PathUtils.join(getEngineDataDir(), "engine");
}

function getZipPath(): string {
  return PathUtils.join(getEngineDataDir(), "engine.zip");
}

function kindOf(exePath: string): EngineInfo["kind"] {
  return exePath.toLowerCase().endsWith("pdf2zh_next.exe") ? "next" : "v1";
}

async function findExeRecursive(
  dir: string,
  exeName: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await IOUtils.getChildren(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const stat = await IOUtils.stat(entry);
      if (stat.type === "directory") {
        const found = await findExeRecursive(entry, exeName);
        if (found) return found;
      } else if (entry.toLowerCase().endsWith(exeName)) {
        return entry;
      }
    } catch {
      // unreadable entry, keep scanning
    }
  }
  return null;
}

export async function getManualEngineInfo(): Promise<EngineInfo | null> {
  const p = String(getPref("enginePath") || "").trim();
  if (!p) return null;
  try {
    if (!(await IOUtils.exists(p))) return null;
  } catch {
    return null;
  }
  return { path: p, kind: kindOf(p) };
}

export async function findManagedEngine(): Promise<EngineInfo | null> {
  const dir = getEngineUnzipDir();
  // Prefer the v2 engine if the user dropped one into the engine dir.
  const next = await findExeRecursive(dir, "pdf2zh_next.exe");
  if (next) return { path: next, kind: "next" };
  const v1 = await findExeRecursive(dir, "pdf2zh.exe");
  if (v1) return { path: v1, kind: "v1" };
  return null;
}

export async function detectEngine(): Promise<EngineInfo | null> {
  const manual = await getManualEngineInfo();
  if (manual) return manual;
  return findManagedEngine();
}

export async function ensureEngine(
  onProgress?: DownloadProgress,
): Promise<EngineInfo> {
  const found = await detectEngine();
  if (found) return found;
  if (!Zotero.isWin) {
    throw new Error(getString("engine-need-manual"));
  }
  return downloadEngine(onProgress);
}

async function resolveDownloadUrl(): Promise<string> {
  try {
    const rq = await Zotero.HTTP.request("GET", RELEASE_API_URL, {
      responseType: "json",
    });
    const assets: any[] = rq.response?.assets ?? [];
    const asset = assets.find(
      (a) =>
        typeof a?.name === "string" && /with-assets-win64\.zip$/i.test(a.name),
    );
    if (asset?.browser_download_url)
      return asset.browser_download_url as string;
  } catch (e: any) {
    Zotero.logError(e);
  }
  return FALLBACK_DOWNLOAD_URL;
}

async function downloadZip(
  url: string,
  zipPath: string,
  onProgress?: DownloadProgress,
): Promise<void> {
  try {
    await IOUtils.remove(zipPath);
  } catch {
    // nothing to clean
  }
  onProgress?.(0, getString("engine-downloading"));
  let lastPct = 0;
  const download = await runSubprocess({
    command: "C:\\Windows\\System32\\curl.exe",
    arguments: [...CURL_FLAGS, "-o", zipPath, url],
    workdir: getEngineDataDir(),
    onStdout: (chunk) => {
      const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)%/g)];
      const m = matches[matches.length - 1];
      if (!m) return;
      const pct = Math.min(99, Math.floor(parseFloat(m[1])));
      if (pct > lastPct) {
        lastPct = pct;
        onProgress?.(pct, getString("engine-downloading"));
      }
    },
  });
  if (download.exitCode !== 0) {
    throw new Error(
      `${getString("engine-download-failed")} (curl exit ${download.exitCode}) ${url.slice(0, 100)}\n${download.stdout.slice(-300)}`,
    );
  }
}

export async function downloadEngine(
  onProgress?: DownloadProgress,
): Promise<EngineInfo> {
  if (!Zotero.isWin) {
    throw new Error(getString("engine-need-manual"));
  }
  onProgress?.(null, getString("engine-resolving"));
  const origin = await resolveDownloadUrl();
  const manual = String(getPref("downloadURLPrefix") || "")
    .trim()
    .replace(/\/+$/, "");
  const candidates: string[] = [];
  if (manual) candidates.push(`${manual}/${origin}`);
  candidates.push(origin);
  for (const mirror of MIRROR_PREFIXES) {
    candidates.push(`${mirror.replace(/\/+$/, "")}/${origin}`);
  }

  await IOUtils.makeDirectory(getEngineDataDir(), { createAncestors: true });
  const zipPath = getZipPath();
  let lastError: any = null;
  for (const url of candidates) {
    try {
      await downloadZip(url, zipPath, onProgress);
      lastError = null;
      break;
    } catch (e: any) {
      lastError = e;
      Zotero.logError(e);
    }
  }
  if (lastError) throw lastError;

  onProgress?.(null, getString("engine-extracting"));
  const unzipDir = getEngineUnzipDir();
  await IOUtils.makeDirectory(unzipDir, { createAncestors: true });
  let extract = await runSubprocess({
    command: "C:\\Windows\\System32\\tar.exe",
    arguments: ["-xf", zipPath, "-C", unzipDir],
  });
  if (extract.exitCode !== 0) {
    // bsdtar missing/failed: fall back to PowerShell Expand-Archive
    extract = await runSubprocess({
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      arguments: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${unzipDir}' -Force`,
      ],
    });
  }
  if (extract.exitCode !== 0) {
    throw new Error(getString("engine-extract-failed"));
  }
  try {
    await IOUtils.remove(zipPath);
  } catch {
    // cleanup is best-effort
  }

  const exe = await findManagedEngine();
  if (!exe) throw new Error(getString("engine-exe-not-found"));
  onProgress?.(100, getString("engine-ready"));
  return exe;
}

function pickFile(
  win: Window,
  title: string,
  filterName: string,
  filterPattern: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const ComponentsAny: any = (globalThis as any).Components;
      const fp = ComponentsAny.classes[
        "@mozilla.org/filepicker;1"
      ].createInstance(ComponentsAny.interfaces.nsIFilePicker);
      fp.init(win, title, fp.modeOpen);
      fp.appendFilter(filterName, filterPattern);
      fp.appendFilters(fp.filterAll);
      fp.open((rv: number) => {
        resolve(rv === fp.returnOK ? fp.file.path : null);
      });
    } catch (e: any) {
      Zotero.logError(e);
      resolve(null);
    }
  });
}

export function browseForEngine(win: Window): Promise<string | null> {
  return pickFile(
    win,
    getString("pref-engine-browse"),
    "pdf2zh.exe / pdf2zh_next.exe",
    "*.exe",
  );
}

export function browseForGlossary(win: Window): Promise<string | null> {
  return pickFile(win, getString("pref-glossary"), "CSV", "*.csv; *.txt");
}
