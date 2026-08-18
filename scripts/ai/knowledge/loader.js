/**
 * Loader for QA Knowledge units (scripts/ai/knowledge/units/*.json).
 *
 * Its responsibility is ONLY: locate knowledge-unit JSON files, parse them,
 * validate each one through schema.js, and return the validated units in a
 * deterministic order. Nothing about selection, relevance scoring, prompt
 * formatting, or provider interaction lives here - see Roadmap #15A's
 * architecture (selection is a separate, later component: selector.js,
 * not part of this task). No network calls, no external knowledge
 * retrieval - purely local filesystem I/O.
 *
 * Failure semantics are deliberately loud, not silent (unlike
 * aggregate-browser-context.js's readBrowserInputs(), which intentionally
 * treats a missing/unparseable *browser* input as "no data for that
 * browser" because a browser job can legitimately never upload one). A
 * curated knowledge unit is different: every file under units/ is
 * something a human deliberately committed, so invalid JSON, a
 * schema-invalid unit, or a duplicate id is a real authoring mistake that
 * must be visible during CI/test execution, not quietly skipped - see
 * Roadmap #15's Phase 7.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { validateKnowledgeUnit } = require("./schema");

const DEFAULT_UNITS_DIR = path.join(__dirname, "units");

class KnowledgeLoadError extends Error {}

// Only files with a .json extension are treated as knowledge units - the
// same convention collect-context.js's own loadReports() already uses for
// reading a directory of report files. This is an explicit, documented
// loader rule: it lets a non-JSON file (e.g. a future README.md or a
// .gitkeep placeholder keeping the otherwise-empty units/ directory
// tracked by git) sit alongside real units without being mistaken for one.
function isKnowledgeUnitFile(filename) {
  return filename.toLowerCase().endsWith(".json");
}

// Sorted alphabetically by filename so the same directory contents always
// produce the same returned order, regardless of the operating system's or
// filesystem's own directory-enumeration order (the same determinism
// concern DEFAULT_BROWSER_PRIORITY/orderByPriority() solve for browsers in
// aggregate-browser-context.js, applied here to files instead).
function listKnowledgeUnitFiles(unitsDir) {
  if (!fs.existsSync(unitsDir)) return [];
  return fs
    .readdirSync(unitsDir)
    .filter(isKnowledgeUnitFile)
    .sort();
}

// Reads every *.json file directly under unitsDir (default:
// scripts/ai/knowledge/units/), validates each one, and returns the
// validated unit objects in deterministic filename order. A missing or
// empty units directory returns [] - not an error, since "no curated
// knowledge exists yet" is an expected, valid state (see Roadmap #15's
// Phase 9: this task deliberately does not ship a production corpus).
// Anything else wrong - unreadable file, invalid JSON, a schema-invalid
// unit, or a duplicate id across two files - throws a KnowledgeLoadError
// immediately rather than skipping the offending file.
function loadKnowledgeUnits(unitsDir = DEFAULT_UNITS_DIR) {
  const filenames = listKnowledgeUnitFiles(unitsDir);
  const units = [];
  const seenIds = new Map(); // id -> filename it was first seen in

  for (const filename of filenames) {
    const fullPath = path.join(unitsDir, filename);

    let raw;
    try {
      raw = fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      throw new KnowledgeLoadError(`Could not read knowledge unit file "${filename}": ${err.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new KnowledgeLoadError(`Knowledge unit file "${filename}" is not valid JSON: ${err.message}`);
    }

    const { valid, errors } = validateKnowledgeUnit(parsed);
    if (!valid) {
      throw new KnowledgeLoadError(
        `Knowledge unit file "${filename}" failed schema validation:\n  - ${errors.join("\n  - ")}`
      );
    }

    if (seenIds.has(parsed.id)) {
      throw new KnowledgeLoadError(
        `Duplicate knowledge unit id "${parsed.id}": defined in both "${seenIds.get(parsed.id)}" and "${filename}"`
      );
    }
    seenIds.set(parsed.id, filename);

    units.push(parsed);
  }

  return units;
}

module.exports = {
  loadKnowledgeUnits,
  KnowledgeLoadError,
  DEFAULT_UNITS_DIR,
};
