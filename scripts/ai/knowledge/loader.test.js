"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadKnowledgeUnits, KnowledgeLoadError } = require("./loader");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-loader-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeValidUnit(overrides = {}) {
  const base = {
    id: "qa-selector-timeout-vs-flaky",
    category: "GENERAL_QA",
    sourceType: "CURATED_INTERNAL",
    source: null,
    verifiedAt: "2026-08-18",
    tags: ["timed out retrying", "timeout"],
    appliesTo: { browsers: null, frameworks: ["cypress"], projects: null },
    statement: "A 'Timed out retrying' error can indicate a synchronization gap rather than a broken selector.",
    priority: 5,
  };
  return { ...base, ...overrides };
}

function writeUnit(dir, filename, unit) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(unit, null, 2));
}

// --- happy paths -------------------------------------------------------

test("loads one valid unit", () => {
  withTempDir((dir) => {
    const unit = makeValidUnit();
    writeUnit(dir, "a-unit.json", unit);

    const units = loadKnowledgeUnits(dir);
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], unit);
  });
});

test("loads multiple valid units", () => {
  withTempDir((dir) => {
    writeUnit(dir, "unit-a.json", makeValidUnit({ id: "unit-a" }));
    writeUnit(dir, "unit-b.json", makeValidUnit({ id: "unit-b" }));
    writeUnit(dir, "unit-c.json", makeValidUnit({ id: "unit-c" }));

    const units = loadKnowledgeUnits(dir);
    assert.equal(units.length, 3);
    assert.deepEqual(
      units.map((u) => u.id),
      ["unit-a", "unit-b", "unit-c"]
    );
  });
});

test("returns validated unit content unchanged (matches the schema-validated shape)", () => {
  withTempDir((dir) => {
    const unit = makeValidUnit({
      id: "cross-browser-differing-signature-caution",
      category: "CROSS_BROWSER",
      sourceType: "CURATED_EXTERNAL",
      source: "https://docs.cypress.io/guides/core-concepts/retry-ability",
      priority: 8,
    });
    writeUnit(dir, "cross-browser.json", unit);

    const units = loadKnowledgeUnits(dir);
    assert.deepEqual(units[0], unit);
  });
});

// --- deterministic ordering ------------------------------------------------

test("returns units in deterministic filename order, independent of write order", () => {
  withTempDir((dir) => {
    // Written out of alphabetical order on purpose.
    writeUnit(dir, "zeta.json", makeValidUnit({ id: "zeta" }));
    writeUnit(dir, "alpha.json", makeValidUnit({ id: "alpha" }));
    writeUnit(dir, "mid.json", makeValidUnit({ id: "mid" }));

    const units = loadKnowledgeUnits(dir);
    assert.deepEqual(
      units.map((u) => u.id),
      ["alpha", "mid", "zeta"]
    );
  });
});

test("same directory contents produce the same returned order across repeated calls", () => {
  withTempDir((dir) => {
    writeUnit(dir, "b.json", makeValidUnit({ id: "b" }));
    writeUnit(dir, "a.json", makeValidUnit({ id: "a" }));

    const first = loadKnowledgeUnits(dir);
    const second = loadKnowledgeUnits(dir);
    assert.deepEqual(
      first.map((u) => u.id),
      second.map((u) => u.id)
    );
    assert.deepEqual(
      first.map((u) => u.id),
      ["a", "b"]
    );
  });
});

// --- empty directory ---------------------------------------------------

test("empty units directory returns []", () => {
  withTempDir((dir) => {
    const units = loadKnowledgeUnits(dir);
    assert.deepEqual(units, []);
  });
});

test("a units directory that does not exist at all returns [] (not an error)", () => {
  withTempDir((dir) => {
    const missingDir = path.join(dir, "does-not-exist");
    const units = loadKnowledgeUnits(missingDir);
    assert.deepEqual(units, []);
  });
});

// --- failure semantics: fail loud, never silently skip -----------------

test("invalid JSON throws KnowledgeLoadError", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not valid json");

    assert.throws(() => loadKnowledgeUnits(dir), KnowledgeLoadError);
  });
});

test("a schema-invalid unit throws KnowledgeLoadError", () => {
  withTempDir((dir) => {
    writeUnit(dir, "bad.json", makeValidUnit({ category: "NOT_A_REAL_CATEGORY" }));

    assert.throws(() => loadKnowledgeUnits(dir), KnowledgeLoadError);
  });
});

test("a schema-invalid unit's error message names the offending file", () => {
  withTempDir((dir) => {
    writeUnit(dir, "bad-unit.json", makeValidUnit({ statement: "" }));

    assert.throws(() => loadKnowledgeUnits(dir), (err) => {
      assert.ok(err instanceof KnowledgeLoadError);
      assert.ok(err.message.includes("bad-unit.json"));
      assert.ok(err.message.includes("statement"));
      return true;
    });
  });
});

test("duplicate knowledge unit id across two files throws KnowledgeLoadError", () => {
  withTempDir((dir) => {
    writeUnit(dir, "first.json", makeValidUnit({ id: "duplicate-id" }));
    writeUnit(dir, "second.json", makeValidUnit({ id: "duplicate-id" }));

    assert.throws(() => loadKnowledgeUnits(dir), (err) => {
      assert.ok(err instanceof KnowledgeLoadError);
      assert.ok(err.message.includes("duplicate-id"));
      assert.ok(err.message.includes("first.json"));
      assert.ok(err.message.includes("second.json"));
      return true;
    });
  });
});

test("a PROJECT_VERIFIED unit with appliesTo.projects: null throws KnowledgeLoadError (Roadmap #19.3B) - cannot silently enter the Knowledge Layer as global", () => {
  withTempDir((dir) => {
    writeUnit(
      dir,
      "unscoped-project-verified.json",
      makeValidUnit({
        id: "unscoped-project-verified",
        sourceType: "PROJECT_VERIFIED",
        appliesTo: { browsers: null, frameworks: ["cypress"], projects: null },
      })
    );

    assert.throws(() => loadKnowledgeUnits(dir), (err) => {
      assert.ok(err instanceof KnowledgeLoadError);
      assert.ok(err.message.includes("appliesTo.projects"));
      assert.ok(err.message.includes("PROJECT_VERIFIED"));
      return true;
    });
  });
});

test("one invalid unit fails the entire load, even alongside otherwise-valid units", () => {
  withTempDir((dir) => {
    writeUnit(dir, "good.json", makeValidUnit({ id: "good" }));
    writeUnit(dir, "bad.json", makeValidUnit({ id: "bad", priority: "not-a-number" }));

    assert.throws(() => loadKnowledgeUnits(dir), KnowledgeLoadError);
  });
});

// --- non-JSON files are ignored (explicit, documented loader rule) -----

test("non-JSON files in the units directory are ignored", () => {
  withTempDir((dir) => {
    writeUnit(dir, "real-unit.json", makeValidUnit({ id: "real-unit" }));
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
    fs.writeFileSync(path.join(dir, "README.md"), "# Knowledge units\n");

    const units = loadKnowledgeUnits(dir);
    assert.equal(units.length, 1);
    assert.equal(units[0].id, "real-unit");
  });
});

// --- offline / no external interaction ----------------------------------

test("loading performs no network or provider interaction (pure filesystem read)", () => {
  withTempDir((dir) => {
    writeUnit(
      dir,
      "external.json",
      makeValidUnit({
        id: "external-example",
        sourceType: "CURATED_EXTERNAL",
        source: "https://example.com/should-never-be-fetched",
      })
    );

    // No fetch/http mocking is required for this test to be meaningful:
    // loadKnowledgeUnits() never references fetch, http, or https at all
    // (see loader.js's own module comment) - this test simply asserts the
    // load succeeds and returns the source string verbatim, unfetched.
    const units = loadKnowledgeUnits(dir);
    assert.equal(units[0].source, "https://example.com/should-never-be-fetched");
  });
});

test("DEFAULT_UNITS_DIR points at scripts/ai/knowledge/units and the real production corpus loads/validates cleanly", () => {
  const { DEFAULT_UNITS_DIR } = require("./loader");
  const units = loadKnowledgeUnits(DEFAULT_UNITS_DIR);
  // Roadmap #15B.2's small curated initial corpus (see units/*.json) -
  // this test exercises the real loader against the real production
  // directory, not a fixture, so a future authoring mistake in a
  // committed unit fails here too, not only via schema.test.js.
  assert.ok(units.length > 0, "expected at least one production knowledge unit to exist");
  const ids = units.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, "production knowledge unit ids must be unique");
});
