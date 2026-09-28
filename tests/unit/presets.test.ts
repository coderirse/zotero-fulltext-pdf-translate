import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installGlobals } from "./helpers";
import { MODE_PRESETS, applyModePreset } from "../../src/modules/presets";

installGlobals();

describe("MODE_PRESETS", function () {
  it("covers exactly fast/precise/scan", function () {
    assert.deepEqual(Object.keys(MODE_PRESETS).sort(), [
      "fast",
      "precise",
      "scan",
    ]);
  });

  it("every preset has sane values", function () {
    for (const [name, p] of Object.entries(MODE_PRESETS)) {
      assert.ok(p.qps >= 1, `${name}.qps`);
      assert.ok(p.poolMaxWorkers >= 1, `${name}.poolMaxWorkers`);
      assert.ok(
        ["off", "auto", "on"].includes(p.ocrWorkaround),
        `${name}.ocrWorkaround`,
      );
      assert.equal(typeof p.noAutoExtractGlossary, "boolean");
    }
  });

  it("scan is the only preset with OCR workaround enabled", function () {
    assert.equal(MODE_PRESETS.scan.ocrWorkaround, "auto");
    assert.equal(MODE_PRESETS.fast.ocrWorkaround, "off");
    assert.equal(MODE_PRESETS.precise.ocrWorkaround, "off");
  });
});

describe("applyModePreset", function () {
  it("writes the preset values into prefs", function () {
    const g = installGlobals();
    applyModePreset("precise");
    assert.equal(g.getPref("qps"), MODE_PRESETS.precise.qps);
    assert.equal(
      g.getPref("poolMaxWorkers"),
      MODE_PRESETS.precise.poolMaxWorkers,
    );
    assert.equal(
      g.getPref("noAutoExtractGlossary"),
      MODE_PRESETS.precise.noAutoExtractGlossary,
    );
    assert.equal(g.getPref("ocrWorkaround"), "off");
  });

  it("keeps existing configuration for the custom mode", function () {
    const g = installGlobals({ qps: 5 });
    applyModePreset("custom");
    assert.equal(g.getPref("qps"), 5);
  });
});
