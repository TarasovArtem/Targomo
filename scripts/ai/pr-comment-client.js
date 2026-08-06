/**
 * Shared "find by marker, then create or update" logic for PR comments,
 * used by both the failure-analysis step and the resolved-state step in
 * .github/workflows/cypress.yml. Takes an injected `github` (the Octokit
 * instance actions/github-script provides) so it can be unit-tested with a
 * fake client, with no network access.
 */

"use strict";

async function findMarkedComment({ github, owner, repo, issueNumber, marker }) {
  const { data: comments } = await github.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  return comments.find((c) => c.body && c.body.includes(marker)) || null;
}

// Creates a comment containing `body`, or updates the existing one already
// carrying `marker` if one exists - this is the anti-spam mechanism: a
// retry or a later resolved-state update edits the same comment instead of
// piling up new ones.
async function upsertPrComment({ github, owner, repo, issueNumber, marker, body }) {
  const existing = await findMarkedComment({ github, owner, repo, issueNumber, marker });

  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    return { action: "updated", id: existing.id };
  }

  const { data: created } = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return { action: "created", id: created.id };
}

module.exports = { findMarkedComment, upsertPrComment };
