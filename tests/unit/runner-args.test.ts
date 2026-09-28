import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installGlobals } from "./helpers";
import {
  buildNextArgs,
  buildV1Args,
  lastMeaningfulLine,
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
