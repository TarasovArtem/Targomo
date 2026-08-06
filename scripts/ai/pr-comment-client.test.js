"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findMarkedComment, upsertPrComment } = require("./pr-comment-client");

function fakeGithub(existingComments, calls) {
  return {
    rest: {
      issues: {
        listComments: async (args) => {
          calls.push(["listComments", args]);
          return { data: existingComments };
        },
        createComment: async (args) => {
          calls.push(["createComment", args]);
          return { data: { id: 999 } };
        },
        updateComment: async (args) => {
          calls.push(["updateComment", args]);
          return { data: { id: args.comment_id } };
        },
      },
    },
  };
}

test("findMarkedComment: returns the comment containing the marker", async () => {
  const github = fakeGithub(
    [
      { id: 1, body: "unrelated comment" },
      { id: 2, body: "some body <!-- qa-agent-report:chrome -->" },
    ],
    []
  );
  const found = await findMarkedComment({ github, owner: "o", repo: "r", issueNumber: 14, marker: "<!-- qa-agent-report:chrome -->" });
  assert.equal(found.id, 2);
});

test("findMarkedComment: returns null when no comment matches", async () => {
  const github = fakeGithub([{ id: 1, body: "unrelated" }], []);
  const found = await findMarkedComment({ github, owner: "o", repo: "r", issueNumber: 14, marker: "<!-- qa-agent-report:chrome -->" });
  assert.equal(found, null);
});

test("upsertPrComment: creates a new comment when none exists yet", async () => {
  const calls = [];
  const github = fakeGithub([], calls);
  const result = await upsertPrComment({ github, owner: "o", repo: "r", issueNumber: 14, marker: "<!-- m -->", body: "hello <!-- m -->" });

  assert.equal(result.action, "created");
  assert.equal(calls[0][0], "listComments");
  assert.equal(calls[1][0], "createComment");
});

test("upsertPrComment: updates the existing marked comment instead of creating a new one (anti-spam)", async () => {
  const calls = [];
  const existing = [{ id: 555, body: "old body <!-- m -->" }];
  const github = fakeGithub(existing, calls);
  const result = await upsertPrComment({ github, owner: "o", repo: "r", issueNumber: 14, marker: "<!-- m -->", body: "new body <!-- m -->" });

  assert.equal(result.action, "updated");
  assert.equal(result.id, 555);
  assert.equal(calls[1][0], "updateComment");
  assert.equal(calls[1][1].comment_id, 555);
  assert.equal(calls.filter((c) => c[0] === "createComment").length, 0, "must never create a second comment when one already matches");
});

test("upsertPrComment: only touches the comment matching this browser's marker among several", async () => {
  const calls = [];
  const existing = [
    { id: 1, body: "chrome body <!-- qa-agent-report:chrome -->" },
    { id: 2, body: "edge body <!-- qa-agent-report:edge -->" },
  ];
  const github = fakeGithub(existing, calls);
  const result = await upsertPrComment({
    github,
    owner: "o",
    repo: "r",
    issueNumber: 14,
    marker: "<!-- qa-agent-report:edge -->",
    body: "updated edge body",
  });

  assert.equal(result.id, 2);
});
