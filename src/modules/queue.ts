import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { attachTranslation } from "./attach";
import { ensureEngine, type DownloadProgress } from "./engine";
import {
  collectPdfSourcesFromCollection,
  collectPdfSourcesFromItems,
  type PdfSource,
} from "./items";
import { cleanupWorkDir, preserveFailureLog, runTranslation } from "./runner";

interface QueueTask {
  sourceId: number;
  parentId: number;
  title: string;
  filePath: string;
}

class TranslateQueue {
  private tasks: QueueTask[] = [];
  private queued = new Set<number>();
  private running = false;

  async addFromItems(items: Zotero.Item[]): Promise<void> {
    const sources = await collectPdfSourcesFromItems(items);
    await this.enqueue(sources);
  }

  async addFromCollection(collection: Zotero.Collection): Promise<void> {
    const sources = await collectPdfSourcesFromCollection(collection);
    await this.enqueue(sources);
  }

  // Clears pending tasks and kills the running engine process. Idempotent:
  // called from the cancel menu, onShutdown, and (via hooks.stopTranslations)
  // from bootstrap.js on app quit.
  stop(): void {
    this.tasks = [];
    this.queued.clear();
    try {
      addon.data.currentProc?.kill();
    } catch {
      // nothing running
    }
  }

  cancel(): void {
    const wasBusy = this.isBusy();
    this.stop();
    if (wasBusy) this.flash(getString("queue-cancelled"));
  }

  isBusy(): boolean {
    return this.running || this.tasks.length > 0;
  }

  private flash(text: string): void {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text, type: "default" })
      .show();
  }

  private async enqueue(sources: PdfSource[]): Promise<void> {
    if (!addon.data.alive) return;
    if (!sources.length) {
      this.flash(getString("no-pdf"));
      return;
    }
    let added = 0;
    for (const { source, parent } of sources) {
      if (this.queued.has(source.id)) continue;
      let filePath: string | false = false;
      try {
        filePath = await source.getFilePathAsync();
      } catch {
        filePath = false;
      }
      if (!filePath) continue;
      this.queued.add(source.id);
      this.tasks.push({
        sourceId: source.id,
        parentId: parent.id,
        title: parent.getDisplayTitle() || "PDF",
        filePath,
      });
      added++;
    }
    if (added) this.flash(getString("queued", { args: { count: added } }));
    void this.pump();
  }

  // One translation at a time: the engine parallelizes pages internally.
  private async pump(): Promise<void> {
    if (this.running || !addon.data.alive) return;
    this.running = true;
    try {
      // Re-check alive on every iteration: after stop()/shutdown the loop
      // must not spawn any further engine processes.
      while (this.tasks.length && addon.data.alive) {
        const task = this.tasks.shift()!;
        try {
          await this.runTask(task);
        } finally {
          // The dedup marker must survive the whole run: removing it at
          // shift time let a re-click queue the same PDF twice while it
          // was still translating.
          this.queued.delete(task.sourceId);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: QueueTask): Promise<void> {
    const pw = new ztoolkit.ProgressWindow(config.addonName, {
      closeOnClick: false,
      closeTime: -1,
    });
    let created = false;
    const base = getString("task-running", { args: { title: task.title } });
    const line = (
      text: string,
      progress?: number,
      type?: "success" | "fail" | "default",
    ) => {
      if (!created) {
        pw.createLine({
          text,
          progress: progress ?? 0,
          type: type ?? "default",
        }).show();
        created = true;
      } else {
        pw.changeLine({ text, progress, type });
      }
    };
    const onProgress: DownloadProgress = (pct, message) =>
      line(message, pct ?? 40);

    let workDir: string | null = null;
    try {
      const engine = await ensureEngine(onProgress);
      line(getString("task-start", { args: { title: task.title } }), 15);
      const outputs = await runTranslation({
        engine,
        filePath: task.filePath,
        onStatus: (status, pct) =>
          line(status ? `${base} — ${status}` : base, pct ?? 55),
      });
      workDir = outputs.workDir;

      const langOut = String(getPref("langOut") || "zh");
      const output = String(getPref("output") || "dual");
      let firstNewId: number | null = null;
      // side-by-side (doc2x style) replaces the stacked dual PDF as the
      // bilingual attachment when available
      if (outputs.sidePath && output !== "mono") {
        const att = await attachTranslation({
          parentItemID: task.parentId,
          filePath: outputs.sidePath,
          title: getString("attach-bilingual", { args: { title: task.title } }),
          fileBaseName: `${task.title}.${langOut}.bilingual`,
        });
        firstNewId = firstNewId ?? att.id;
      } else if (outputs.dualPath && output !== "mono") {
        const att = await attachTranslation({
          parentItemID: task.parentId,
          filePath: outputs.dualPath,
          title: getString("attach-bilingual", { args: { title: task.title } }),
          fileBaseName: `${task.title}.${langOut}.bilingual`,
        });
        firstNewId = firstNewId ?? att.id;
      }
      if (outputs.monoPath && (output === "mono" || output === "both")) {
        const att = await attachTranslation({
          parentItemID: task.parentId,
          filePath: outputs.monoPath,
          title: getString("attach-mono", { args: { title: task.title } }),
          fileBaseName: `${task.title}.${langOut}.mono`,
        });
        firstNewId = firstNewId ?? att.id;
      }

      line(
        getString("task-done", { args: { title: task.title } }),
        100,
        "success",
      );
      pw.startCloseTimer(6000);
      if (getPref("autoOpen") && firstNewId) {
        try {
          Zotero.getActiveZoteroPane().viewAttachment(firstNewId);
        } catch {
          // auto-open is best effort
        }
      }
    } catch (e: any) {
      Zotero.logError(e);
      // The work dir gets reclaimed below; keep the engine log so the
      // failure stays diagnosable without Debug Output Logging.
      if (workDir) await preserveFailureLog(workDir);
      // After stop()/shutdown there is no point showing a failure window:
      // the task did not fail on its own, it was cancelled.
      if (!addon.data.alive) return;
      line(
        getString("task-failed", { args: { title: task.title } }),
        100,
        "fail",
      );
      pw.startCloseTimer(12000);
    } finally {
      if (workDir) void cleanupWorkDir(workDir);
    }
  }
}

export const translateQueue = new TranslateQueue();
