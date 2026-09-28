import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installGlobals } from "./helpers";
import {
  buildNextArgs,
  buildV1Args,
  lastMeaningfulLine,
  parseProgress,
  pickOutputs,
} from "../../src/modules/runner";

// Modules under test only touch Zotero globals at call time, so
// installing them at the top of the module body is sufficient.
installGlobals();

describe("lastMeaningfulLine", function () {
  it("returns the last non-empty line", function () {
    assert.equal(lastMeaningfulLine("a\n\nb\nc"), "c");
  });

  it("normalizes CRLF and CR", function () {
    assert.equal(lastMeaningfulLine("a\r\nb\rc"), "c");
  });

  it("strips ANSI escape sequences from the line", function () {
    const out = lastMeaningfulLine("\x1b[2Kprogress 50%\n\x1b[1Kdone");
    assert.equal(out, "done");
  });

  it("returns empty string for blank input", function () {
    assert.equal(lastMeaningfulLine("\n  \r\n"), "");
  });
});

describe("buildNextArgs (v2 pdf2zh_next)", function () {
  it("defaults: dual output + side layout keeps the mono PDF and adds --openai", function () {
    const args = buildNextArgs("in.pdf", "out");
    assert.ok(args.includes("--openai"));
    assert.ok(!args.includes("--no-mono"));
    assert.ok(!args.includes("--no-dual"));
    assert.equal(args[0], "in.pdf");
    assert.equal(args[args.indexOf("--output") + 1], "out");
  });

  it("dual + stacked suppresses mono", function () {
    installGlobals({ output: "dual", bilingualLayout: "stacked" });
    const args = buildNextArgs("in.pdf", "out");
    assert.ok(args.includes("--no-mono"));
    assert.ok(!args.includes("--no-dual"));
  });

  it("mono output suppresses dual", function () {
    installGlobals({ output: "mono", bilingualLayout: "side" });
    const args = buildNextArgs("in.pdf", "out");
    assert.ok(args.includes("--no-dual"));
    assert.ok(!args.includes("--no-mono"));
  });

  it("passes optional flags through", function () {
    installGlobals({
      output: "dual",
      bilingualLayout: "side",
      pages: "1-5, 8",
      customSystemPrompt: "translate well",
      glossaryFile: "g.csv",
      ocrWorkaround: "auto",
      noAutoExtractGlossary: true,
      watermark: true,
      qps: 3,
      poolMaxWorkers: 7,
      langIn: "auto",
      langOut: "de",
    });
    const args = buildNextArgs("in.pdf", "out");
    assert.deepEqual(
      args.slice(args.indexOf("--pages"), args.indexOf("--pages") + 2),
      ["--pages", "1-5, 8"],
    );
    assert.ok(args.includes("--custom-system-prompt"));
    assert.ok(args.includes("translate well"));
    assert.ok(args.includes("--glossaries"));
    assert.ok(args.includes("g.csv"));
    assert.ok(args.includes("--auto-enable-ocr-workaround"));
    assert.ok(args.includes("--no-auto-extract-glossary"));
    assert.ok(args.includes("--watermark-output-mode"));
    assert.equal(
      args[args.indexOf("--watermark-output-mode") + 1],
      "watermarked",
    );
    assert.deepEqual(
      args.slice(args.indexOf("--qps"), args.indexOf("--qps") + 2),
      ["--qps", "3"],
    );
    assert.deepEqual(
      args.slice(
        args.indexOf("--pool-max-workers"),
        args.indexOf("--pool-max-workers") + 2,
      ),
      ["--pool-max-workers", "7"],
    );
    assert.deepEqual(
      args.slice(args.indexOf("--lang-in"), args.indexOf("--lang-in") + 2),
      ["--lang-in", "auto"],
    );
    assert.deepEqual(
      args.slice(args.indexOf("--lang-out"), args.indexOf("--lang-out") + 2),
      ["--lang-out", "de"],
    );
  });

  it("ocr=on forces the workaround; invalid qps falls back to 4", function () {
    installGlobals({ output: "dual", ocrWorkaround: "on", qps: 0 });
    const args = buildNextArgs("in.pdf", "out");
    assert.ok(args.includes("--ocr-workaround"));
    assert.ok(!args.includes("--auto-enable-ocr-workaround"));
    assert.equal(args[args.indexOf("--qps") + 1], "4");
  });

  it("secrets never appear on the command line", function () {
    installGlobals({ output: "dual" });
    const args = buildNextArgs("in.pdf", "out").join(" ");
    assert.ok(!args.includes("sk-"));
    assert.ok(!args.includes("API_KEY"));
  });
});

describe("buildV1Args (v1 pdf2zh)", function () {
  it("uses the openailiked service and maps qps to --thread", async function () {
    installGlobals({ qps: 6 });
    const args = await buildV1Args("in.pdf", "out", "C:\\work");
    const s = args.join(" ");
    assert.ok(s.includes("--service openailiked"));
    assert.deepEqual(
      args.slice(args.indexOf("--thread"), args.indexOf("--thread") + 2),
      ["--thread", "6"],
    );
  });

  it("writes a custom prompt to a file (v1 only accepts --prompt FILE)", async function () {
    installGlobals({ customSystemPrompt: "be careful" });
    const args = await buildV1Args("in.pdf", "out", "C:\\work");
    const i = args.indexOf("--prompt");
    assert.ok(i >= 0);
    assert.match(args[i + 1], /prompt\.txt$/);
  });

  it("no prompt: no --prompt flag", async function () {
    installGlobals({});
    const args = await buildV1Args("in.pdf", "out", "C:\\work");
    assert.ok(!args.includes("--prompt"));
  });
});

describe("parseProgress", function () {
  it("parses percent form (v1)", function () {
    assert.equal(parseProgress("Progress: 42%"), 42);
    assert.equal(parseProgress("7.5%"), 8);
    assert.equal(parseProgress("100%"), 99);
  });

  it("parses fraction form (v2 BabelDOC rich lines)", function () {
    assert.equal(parseProgress("Generate instructions 12/45"), 27);
    assert.equal(parseProgress("Working: 3/10 pages"), 30);
  });

  it("ignores timestamp dates like 09/28/26", function () {
    assert.equal(parseProgress("[09/28/26 21:26:07] starting"), null);
    assert.equal(parseProgress("[09/28/26] then real progress 3/10"), 30);
  });

  it("returns null without plausible signals", function () {
    assert.equal(parseProgress("no progress here"), null);
    assert.equal(parseProgress("Generate drawing instructions (1/1)"), null);
    assert.equal(parseProgress(""), null);
  });
});

describe("pickOutputs", function () {
  it("recognizes v1 naming", function () {
    const out = pickOutputs([
      "C:/w/out/input-dual.pdf",
      "C:/w/out/input-mono.pdf",
      "C:/w/out/engine.log",
    ]);
    assert.equal(out.mono, "C:/w/out/input-mono.pdf");
    assert.equal(out.dual, "C:/w/out/input-dual.pdf");
  });

  it("recognizes v2 naming (watermark mode + lang in the name)", function () {
    const out = pickOutputs([
      "C:/w/out/input.no_watermark.zh.dual.pdf",
      "C:/w/out/input.no_watermark.zh.mono.pdf",
      "C:/w/out/input.no_watermark.zh.glossary.csv",
    ]);
    assert.equal(out.mono, "C:/w/out/input.no_watermark.zh.mono.pdf");
    assert.equal(out.dual, "C:/w/out/input.no_watermark.zh.dual.pdf");
  });

  it("returns empty for unrelated files", function () {
    assert.deepEqual(pickOutputs(["engine.log", "input.pdf"]), {});
  });
});
