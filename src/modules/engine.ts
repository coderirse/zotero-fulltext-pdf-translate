import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
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

// File name alone is unreliable (users rename executables), so "auto"
// also checks for the runtime/ directory that only the v1 release zip
// places next to pdf2zh.exe. An explicit engineKind pref overrides both.
async function detectKind(exePath: string): Promise<EngineInfo["kind"]> {
  const override = String(getPref("engineKind") || "auto");
  if (override === "v1" || override === "next") return override;
  if (exePath.toLowerCase().endsWith("pdf2zh_next.exe")) return "next";
  const buildDir = exePath.replace(/[\\/][^\\/]+$/, "");
  try {
    if (await IOUtils.exists(PathUtils.join(buildDir, "runtime"))) {
      return "v1";
    }
  } catch {
    // unreadable dir: fall through to the v1 default
  }
  return "v1";
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
  return { path: p, kind: await detectKind(p) };
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

// Detection scans the whole engine dir (thousands of files inside
// site-packages) and would otherwise run twice per task. The result is
// cached until something known to change it happens: browsing/resetting
// the manual path, changing the engineKind pref, or downloading.
let engineCache: EngineInfo | null | undefined;

export function invalidateEngineCache(): void {
  engineCache = undefined;
}

export async function detectEngine(): Promise<EngineInfo | null> {
  if (engineCache !== undefined) return engineCache;
  const manual = await getManualEngineInfo();
  const found = manual ?? (await findManagedEngine());
  engineCache = found;
  return found;
}

// The auto-downloaded v1 engine bundles a private Python runtime with
// PyMuPDF, which the side-by-side bilingual merger reuses.
export function getBundledRuntime(
  engine: EngineInfo,
): { pythonExe: string; sitePackages: string } | null {
  if (engine.kind !== "v1") return null;
  const buildDir = engine.path.replace(/[\\/][^\\/]+$/, "");
  return {
    pythonExe: PathUtils.join(buildDir, "runtime", "python.exe"),
    sitePackages: PathUtils.join(buildDir, "site-packages"),
  };
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

interface ResolvedAsset {
  url: string;
  // "sha256:<hex>" as published by the GitHub release API. Used to verify
  // the downloaded zip — essential for mirror downloads, where a hostile
  // or hijacked mirror would otherwise get arbitrary code execution plus
  // the user's API key. Null when the API is unreachable (fallback URL,
  // direct TLS to GitHub).
  digest: string | null;
}

async function resolveDownloadUrl(): Promise<ResolvedAsset> {
  try {
    const rq = await Zotero.HTTP.request("GET", RELEASE_API_URL, {
      responseType: "json",
    });
    const assets: any[] = rq.response?.assets ?? [];
    const asset = assets.find(
      (a) =>
        typeof a?.name === "string" && /with-assets-win64\.zip$/i.test(a.name),
    );
    if (asset?.browser_download_url) {
      return {
        url: asset.browser_download_url as string,
        digest:
          typeof asset.digest === "string" && asset.digest.startsWith("sha256:")
            ? asset.digest
            : null,
      };
    }
  } catch (e: any) {
    Zotero.logError(e);
  }
  return { url: FALLBACK_DOWNLOAD_URL, digest: null };
}

async function verifyZipDigest(zipPath: string, digest: string): Promise<void> {
  const expected = digest.replace(/^sha256:/, "").toLowerCase();
  const data = await IOUtils.read(zipPath);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex !== expected) {
    throw new Error(
      `engine zip sha256 mismatch: expected ${expected}, got ${hex}`,
    );
  }
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

// Single-flight: the prefs button and per-task ensureEngine() can both
// reach for a download at the same time; they share one download instead
// of writing two 521 MB streams to the same zip path. Later callers do
// not get progress updates (the first caller's callback wins).
let downloadInflight: Promise<EngineInfo> | null = null;

export function downloadEngine(
  onProgress?: DownloadProgress,
): Promise<EngineInfo> {
  if (!downloadInflight) {
    downloadInflight = doDownloadEngine(onProgress).finally(() => {
      downloadInflight = null;
    });
  }
  return downloadInflight;
}

async function doDownloadEngine(
  onProgress?: DownloadProgress,
): Promise<EngineInfo> {
  if (!Zotero.isWin) {
    throw new Error(getString("engine-need-manual"));
  }
  onProgress?.(null, getString("engine-resolving"));
  const resolved = await resolveDownloadUrl();
  const manual = String(getPref("downloadURLPrefix") || "")
    .trim()
    .replace(/\/+$/, "");
  const candidates: string[] = [];
  if (manual) candidates.push(`${manual}/${resolved.url}`);
  candidates.push(resolved.url);
  for (const mirror of MIRROR_PREFIXES) {
    candidates.push(`${mirror.replace(/\/+$/, "")}/${resolved.url}`);
  }

  await IOUtils.makeDirectory(getEngineDataDir(), { createAncestors: true });
  const zipPath = getZipPath();
  let lastError: any = null;
  for (const url of candidates) {
    try {
      await downloadZip(url, zipPath, onProgress);
      if (resolved.digest) {
        onProgress?.(99, getString("engine-verifying"));
        await verifyZipDigest(zipPath, resolved.digest);
      } else {
        // Fallback path when the release API is unreachable: direct TLS
        // to GitHub, so the mirror tampering risk does not apply, but
        // make the skipped check visible in the debug log.
        Zotero.debug(
          "[fullpdf] no sha256 digest from release API; skipping zip integrity check",
        );
      }
      lastError = null;
      break;
    } catch (e: any) {
      lastError = e;
      Zotero.logError(e);
      // A corrupt/tampered zip must not survive into the next candidate
      // or the extraction step.
      try {
        await IOUtils.remove(zipPath);
      } catch {
        // nothing to clean
      }
    }
  }
  if (lastError) throw lastError;

  onProgress?.(null, getString("engine-extracting"));
  const unzipDir = getEngineUnzipDir();
  await IOUtils.makeDirectory(unzipDir, { createAncestors: true });
  let extract: Awaited<ReturnType<typeof runSubprocess>> | null = null;
  try {
    extract = await runSubprocess({
      command: "C:\\Windows\\System32\\tar.exe",
      arguments: ["-xf", zipPath, "-C", unzipDir],
    });
  } catch (e: any) {
    // tar.exe missing (stripped-down Windows): runSubprocess rejects
    // instead of returning a non-zero exit, so the fallback must be
    // reachable from here too.
    Zotero.logError(e);
  }
  if (!extract || extract.exitCode !== 0) {
    // Paths travel via env vars instead of being interpolated into the
    // command string: PowerShell joins everything after -Command into one
    // command line, so $args[0]-style positional passing does not work
    // and quoted paths would be an injection surface.
    extract = await runSubprocess({
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      arguments: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:FULLPDF_ZIP -DestinationPath $env:FULLPDF_DEST -Force",
      ],
      environment: { FULLPDF_ZIP: zipPath, FULLPDF_DEST: unzipDir },
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

  invalidateEngineCache();
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
    // only the .label attribute exists for this message; requesting the
    // bare value would return the literal key name
    getString("pref-engine-browse", "label"),
    "pdf2zh.exe / pdf2zh_next.exe",
    "*.exe",
  );
}

export function browseForGlossary(win: Window): Promise<string | null> {
  return pickFile(win, getString("pref-glossary"), "CSV", "*.csv; *.txt");
}
