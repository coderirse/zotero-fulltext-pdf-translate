import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { runSubprocess, spawnSubprocess } from "../utils/subprocess";
import { getActiveProfile } from "./profiles";
import { getBundledRuntime, type EngineInfo } from "./engine";

export interface TranslationOutputs {
  monoPath?: string;
  dualPath?: string;
  // doc2x-style side-by-side merge of the original and the mono PDF
  sidePath?: string;
  workDir: string;
  logPath: string;
}

// eslint-disable-next-line no-control-regex -- strips ANSI escape codes from engine output
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function tail(text: string, length: number): string {
  return text.slice(-length);
}

function lastMeaningfulLine(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  return (lines[lines.length - 1] ?? "").slice(-120);
}

// pdf2zh_next (v2) CLI flags. Secrets travel via PDF2ZH_* env vars only,
// never the command line.
function buildNextArgs(inputFile: string, outDir: string): string[] {
  const args: string[] = [inputFile, "--output", outDir];
  args.push("--lang-in", String(getPref("langIn") || "en"));
  args.push("--lang-out", String(getPref("langOut") || "zh"));
  args.push(
    "--watermark-output-mode",
    getPref("watermark") ? "watermarked" : "no_watermark",
  );
  const output = String(getPref("output") || "dual");
  const layout = String(getPref("bilingualLayout") || "side");
  // the side-by-side layout needs the mono PDF, so never suppress it
  if (output === "dual" && layout !== "side") args.push("--no-mono");
  else if (output === "mono") args.push("--no-dual");
  args.push("--qps", String(Math.max(1, Number(getPref("qps")) || 4)));
  args.push(
    "--pool-max-workers",
    String(Math.max(1, Number(getPref("poolMaxWorkers")) || 4)),
  );
  if (getPref("noAutoExtractGlossary")) args.push("--no-auto-extract-glossary");
  const ocr = String(getPref("ocrWorkaround") || "off");
  if (ocr === "on") args.push("--ocr-workaround");
  else if (ocr === "auto") args.push("--auto-enable-ocr-workaround");
  const pages = String(getPref("pages") || "").trim();
  if (pages) args.push("--pages", pages);
  const prompt = String(getPref("customSystemPrompt") || "").trim();
  if (prompt) args.push("--custom-system-prompt", prompt);
  const glossary = String(getPref("glossaryFile") || "").trim();
  if (glossary) args.push("--glossaries", glossary);
  args.push("--openai");
  return args;
}

// pdf2zh v1 CLI flags (the engine inside the auto-downloaded release zip).
// The classic pipeline is used (no --babeldoc) so output carries no
// watermark; v1 has no glossary/mono-only/OCR options, so those
// preferences are ignored for this engine kind.
async function buildV1Args(
  inputFile: string,
  outDir: string,
  workDir: string,
): Promise<string[]> {
  const args: string[] = [
    inputFile,
    "--output",
    outDir,
    "--lang-in",
    String(getPref("langIn") || "en"),
    "--lang-out",
    String(getPref("langOut") || "zh"),
    "--service",
    "openailiked",
    "--thread",
    String(Math.max(1, Number(getPref("qps")) || 4)),
  ];
  const pages = String(getPref("pages") || "").trim();
  if (pages) args.push("--pages", pages);
  const prompt = String(getPref("customSystemPrompt") || "").trim();
  if (prompt) {
    // v1 only accepts the custom prompt as a file
    const promptFile = PathUtils.join(workDir, "prompt.txt");
    await IOUtils.writeUTF8(promptFile, prompt);
    args.push("--prompt", promptFile);
  }
  return args;
}

export async function runTranslation(opts: {
  engine: EngineInfo;
  filePath: string;
  onStatus?: (status: string) => void;
}): Promise<TranslationOutputs> {
  const { engine, filePath } = opts;
  const profile = getActiveProfile();
  if (!profile) throw new Error(getString("no-profile"));

  const taskId = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  // Task work dirs must NOT live under the system temp directory: the
  // bundled pdf2zh v1 engine deletes input files located inside
  // tempfile.gettempdir() after translating (high_level.py temp-file
  // cleanup), which silently broke the side-by-side merge.
  const workDir = PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "tmp",
    taskId,
  );
  await IOUtils.makeDirectory(workDir, { createAncestors: true });
  const inputFile = PathUtils.join(workDir, "input.pdf");
  await IOUtils.copy(filePath, inputFile);
  const outDir = PathUtils.join(workDir, "out");
  await IOUtils.makeDirectory(outDir, { createAncestors: true });

  const args =
    engine.kind === "next"
      ? buildNextArgs(inputFile, outDir)
      : await buildV1Args(inputFile, outDir, workDir);
  // v1's openailiked service reads OPENAILIKED_* from the process
  // environment; v2 reads PDF2ZH_*.
  const env: Record<string, string> =
    engine.kind === "next"
      ? {
          PDF2ZH_OPENAI: "1",
          PDF2ZH_OPENAI_BASE_URL: profile.baseUrl.replace(/\/+$/, ""),
          PDF2ZH_OPENAI_API_KEY: profile.apiKey,
          PDF2ZH_OPENAI_MODEL: profile.model,
        }
      : {
          OPENAILIKED_BASE_URL: profile.baseUrl.replace(/\/+$/, ""),
          OPENAILIKED_API_KEY: profile.apiKey,
          OPENAILIKED_MODEL: profile.model,
        };
  Zotero.debug(
    `[fullpdf] spawn (${engine.kind}): ${engine.path} ${args.join(" ")}`,
  );

  const engineDir = engine.path.replace(/[\\/][^\\/]+$/, "");
  let handle;
  try {
    handle = await spawnSubprocess({
      command: engine.path,
      arguments: args,
      environment: env,
      workdir: engineDir,
      onStdout: (chunk) => {
        opts.onStatus?.(lastMeaningfulLine(chunk.replace(ANSI_RE, "")));
      },
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/0xc0000135|dll|找不到指定的模块/i.test(msg)) {
      throw new Error(`${msg}\n${getString("engine-vc-redist")}`);
    }
    throw e;
  }
  addon.data.currentProc = handle;

  const outputs: TranslationOutputs = { workDir, logPath: "" };
  let logTail = "";
  const result = await handle.completion;
  addon.data.currentProc = null;
  // Keep a bounded tail for error reporting; full log goes to disk.
  try {
    const logPath = PathUtils.join(workDir, "engine.log");
    await IOUtils.writeUTF8(logPath, result.stdout);
    outputs.logPath = logPath;
    logTail = tail(result.stdout.replace(ANSI_RE, ""), 600);
  } catch (e: any) {
    Zotero.logError(e);
  }

  Zotero.debug(`[fullpdf] engine exit ${result.exitCode}`);
  if (result.exitCode !== 0) {
    throw new Error(`engine exit ${result.exitCode}\n${logTail}`);
  }

  const monoPath = PathUtils.join(outDir, "input-mono.pdf");
  const dualPath = PathUtils.join(outDir, "input-dual.pdf");
  try {
    if (await IOUtils.exists(monoPath)) outputs.monoPath = monoPath;
    if (await IOUtils.exists(dualPath)) outputs.dualPath = dualPath;
  } catch (e: any) {
    Zotero.logError(e);
  }
  if (!outputs.monoPath && !outputs.dualPath) {
    throw new Error(`no output produced\n${logTail}`);
  }

  // doc2x-style side-by-side layout: original page left, translated
  // page right, merged with the engine's bundled PyMuPDF. Falls back
  // to the stacked dual PDF when unavailable (e.g. v2 engine).
  const layout = String(getPref("bilingualLayout") || "side");
  if (layout === "side" && outputs.monoPath) {
    try {
      const sidePath = await mergeSideBySide(
        engine,
        inputFile,
        outputs.monoPath,
        outDir,
        workDir,
      );
      if (sidePath) outputs.sidePath = sidePath;
      else {
        Zotero.debug(
          "[fullpdf] side-by-side merge unavailable, falling back to stacked dual",
        );
      }
    } catch (e: any) {
      Zotero.logError(e);
    }
  }
  return outputs;
}

async function mergeSideBySide(
  engine: EngineInfo,
  originalPdf: string,
  monoPdf: string,
  outDir: string,
  workDir: string,
): Promise<string | null> {
  const runtime = getBundledRuntime(engine);
  if (!runtime) return null;
  try {
    if (!(await IOUtils.exists(runtime.pythonExe))) return null;
  } catch {
    return null;
  }
  // The plugin may be installed as a packed XPI (jar: rootURI), so the
  // script has no disk path: read it through Zotero's URL loader and
  // materialize it in the task temp dir for the bundled Python.
  let scriptContent: string;
  try {
    scriptContent = Zotero.File.getContentsFromURL(
      rootURI + "content/side_by_side.py",
    );
  } catch (e: any) {
    Zotero.logError(e);
    return null;
  }
  const scriptPath = PathUtils.join(workDir, "side_by_side.py");
  await IOUtils.writeUTF8(scriptPath, scriptContent);
  const outPath = PathUtils.join(outDir, "input-side.pdf");
  const res = await runSubprocess({
    command: runtime.pythonExe,
    arguments: [
      scriptPath,
      originalPdf,
      monoPdf,
      outPath,
      runtime.sitePackages,
    ],
    workdir: outDir,
  });
  let produced = false;
  try {
    produced = res.exitCode === 0 && (await IOUtils.exists(outPath));
  } catch {
    produced = false;
  }
  if (!produced) {
    Zotero.logError(
      new Error(
        `side-by-side merge failed (exit ${res.exitCode}): ${tail(res.stdout, 300)}`,
      ),
    );
    return null;
  }
  return outPath;
}

export async function cleanupWorkDir(workDir: string): Promise<void> {
  try {
    await IOUtils.remove(workDir, { recursive: true });
  } catch (e: any) {
    Zotero.logError(e);
  }
}

// Removes leftover task work dirs from previous sessions. Only runs at
// startup, before any task can exist.
export async function cleanupStaleWorkDirs(): Promise<void> {
  const base = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef, "tmp");
  try {
    if (await IOUtils.exists(base)) {
      await IOUtils.remove(base, { recursive: true });
    }
  } catch (e: any) {
    Zotero.logError(e);
  }
}
