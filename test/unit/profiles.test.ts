import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installGlobals } from "./helpers";
import {
  getActiveProfile,
  getProfiles,
  saveProfiles,
  type ServiceProfile,
} from "../../src/modules/profiles";

installGlobals();

const profile = (over: Partial<ServiceProfile>): ServiceProfile => ({
  id: "p1",
  name: "Test",
  preset: "custom",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  ...over,
});

describe("getProfiles", function () {
  it("parses a valid JSON array", function () {
    installGlobals({
      profiles: JSON.stringify([profile({ id: "a", name: "A" })]),
    });
    assert.equal(getProfiles().length, 1);
    assert.equal(getProfiles()[0].name, "A");
  });

  it("returns [] for missing, corrupt, or non-array data", function () {
    installGlobals({});
    assert.deepEqual(getProfiles(), []);
    installGlobals({ profiles: "not json" });
    assert.deepEqual(getProfiles(), []);
    installGlobals({ profiles: JSON.stringify({ id: "a" }) });
    assert.deepEqual(getProfiles(), []);
  });

  it("rejects entries with non-string baseUrl/apiKey/model", function () {
    installGlobals({
      profiles: JSON.stringify([
        profile({ id: "good", name: "G" }),
        profile({ id: "bad", name: "B", baseUrl: 42 }),
        profile({ id: "bad2", name: "B2", apiKey: null }),
        profile({ id: "bad3", name: "B3", model: {} }),
      ]),
    });
    const out = getProfiles();
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "good");
  });
});

describe("saveProfiles / getProfiles roundtrip", function () {
  it("persists profiles through the pref store", function () {
    const g = installGlobals({});
    const list = [profile({ id: "x", name: "X" })];
    saveProfiles(list);
    assert.equal(g.getPref("profiles"), JSON.stringify(list));
    assert.equal(getProfiles()[0].name, "X");
  });
});

describe("getActiveProfile", function () {
  it("returns the active profile by id", function () {
    installGlobals({
      profiles: JSON.stringify([
        profile({ id: "a", name: "A" }),
        profile({ id: "b", name: "B" }),
      ]),
      activeProfileId: "b",
    });
    assert.equal(getActiveProfile()?.id, "b");
  });

  it("falls back to the first profile and logs when the id is stale", function () {
    const g = installGlobals({
      profiles: JSON.stringify([profile({ id: "a", name: "A" })]),
      activeProfileId: "deleted",
    });
    assert.equal(getActiveProfile()?.id, "a");
    assert.ok(g.debugCalls.some((c) => c.includes('active profile "deleted"')));
  });

  it("returns null when no profiles exist", function () {
    installGlobals({});
    assert.equal(getActiveProfile(), null);
  });
});
