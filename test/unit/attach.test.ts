import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFileBaseName } from "../../src/modules/attach";

describe("sanitizeFileBaseName", function () {
  it("replaces filesystem-illegal characters", function () {
    assert.equal(
      sanitizeFileBaseName('a<b>c:d"e/f\\g|h?i*j'),
      "a b c d e f g h i j",
    );
  });

  it("strips control characters", function () {
    assert.equal(sanitizeFileBaseName("a\x00b\x1fc"), "a b c");
  });

  it("collapses whitespace and trims", function () {
    assert.equal(sanitizeFileBaseName("  a \t b  "), "a b");
  });

  it("truncates to 120 characters", function () {
    const out = sanitizeFileBaseName("x".repeat(300));
    assert.equal(out.length, 120);
  });

  it("falls back to a placeholder for empty results", function () {
    assert.equal(sanitizeFileBaseName(""), "document");
    assert.equal(sanitizeFileBaseName("///"), "document");
    assert.equal(sanitizeFileBaseName("   "), "document");
  });

  it("keeps ordinary titles untouched", function () {
    assert.equal(
      sanitizeFileBaseName("A Study of Jets 2024"),
      "A Study of Jets 2024",
    );
  });
});
