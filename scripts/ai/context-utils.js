/**
 * Roadmap #19.6B - tiny, dependency-free, framework-neutral path utility.
 *
 * normalizeSpecPath() is needed on both sides of the collector/adapter
 * boundary introduced by Roadmap #19.6B: collect-context.js's own
 * generic file-safety code (isPathAllowed(), buildRelevantFiles()) and
 * cypress-adapter.js's Mochawesome/screenshot parsing (extractFailedTests(),
 * summarizeTestResults(), resolveScreenshotPath()) all call it. Neither
 * file may require the other (collect-context.js requires
 * adapters/cypress-adapter.js; the reverse would be circular), so this one
 * generic primitive - unchanged from its pre-#19.6B implementation - lives
 * here instead, dependency-free and with no Cypress-specific knowledge.
 */

"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function normalizeSpecPath(rawFile) {
  if (!rawFile) return null;
  let p = rawFile.replace(/\\/g, "/");
  if (p.startsWith(ROOT.replace(/\\/g, "/"))) {
    p = p.slice(ROOT.replace(/\\/g, "/").length);
  }
  p = p.replace(/^\/+/, "");
  return p || null;
}

module.exports = { normalizeSpecPath };
