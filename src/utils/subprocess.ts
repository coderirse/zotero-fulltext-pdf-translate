// Thin wrapper around Gecko's Subprocess module (Zotero 7 / Firefox 115).
// command must be an absolute path; arguments are passed as an array so
// Windows quoting is handled by the platform layer.

export interface SpawnOptions {
  command: string;
  arguments: string[];
  environment?: Record<string, string>;
  workdir?: string;
  onStdout?: (chunk: string) => void;
}

export interface SubprocessResult {
  exitCode: number;
  stdout: string;
}

export interface SubprocessHandle {
  completion: Promise<SubprocessResult>;
  kill(): void;
}

type AnyProc = any;

// Engine output can reach hundreds of MB for long documents, so only the
// last MAX_CAPTURE_CHARS are kept in memory for error reporting. Callers
// that need the full output should stream it out via onStdout.
const MAX_CAPTURE_CHARS = 1 << 20;

function loadSubprocess(): AnyProc {
  const ChromeUtils = (globalThis as AnyProc).ChromeUtils;
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")
    .Subprocess;
}

export async function spawnSubprocess(
  opts: SpawnOptions,
): Promise<SubprocessHandle> {
  const Subprocess = loadSubprocess();
  const proc = await Subprocess.call({
    command: opts.command,
    arguments: opts.arguments,
    environment: opts.environment ?? {},
    environmentAppend: true,
    workdir: opts.workdir,
    stderr: "stdout",
  });
  let stdout = "";
  const reading = (async () => {
    // readString() resolves with "" at EOF
    for (;;) {
      const chunk: string = await proc.stdout.readString();
      if (!chunk) break;
      opts.onStdout?.(chunk);
      stdout += chunk;
      if (stdout.length > MAX_CAPTURE_CHARS) {
        stdout = stdout.slice(-MAX_CAPTURE_CHARS);
      }
    }
  })();
  const completion = (async (): Promise<SubprocessResult> => {
    let exitCode = -1;
    try {
      const [res] = await Promise.all([proc.wait(), reading]);
      exitCode = res.exitCode;
    } catch (e: any) {
      Zotero.logError(e);
    }
    return { exitCode, stdout };
  })();
  return {
    completion,
    kill() {
      try {
        proc.kill();
      } catch (e: any) {
        Zotero.logError(e);
      }
    },
  };
}

export function runSubprocess(opts: SpawnOptions): Promise<SubprocessResult> {
  return spawnSubprocess(opts).then((h) => h.completion);
}
