import test from "node:test";
import assert from "node:assert/strict";
import { formatTask, parseTask, safeUrl, sortTasks, identicalTask, isReviewPr } from "../docs/model.mjs";

const base = {
  id: "t-test123", title: 'Fix: "strange" 🌊', project: "example-project",
  status: "review", priority: "P0",
  url: "https://github.com/example/example-project/pull/12",
  description: "First line\n---\nAnother line: true"
};

test("round-trips Unicode, quotes, colons and Markdown body", () => {
  const parsed = parseTask(formatTask(base), "tasks/t-test123.md");
  assert.deepEqual(Object.fromEntries(Object.keys(base).map(k => [k, parsed[k]])), base);
});

test("rejects mismatched paths and unsafe links", () => {
  assert.throws(() => parseTask(formatTask(base), "tasks/other.md"), /identifier/);
  assert.throws(() => safeUrl("javascript:alert(1)"), /HTTPS/);
  assert.throws(() => safeUrl("https://user:secret@github.com/x"), /credentials/);
});

test("rejects unsupported fields, duplicate fields and invalid values", () => {
  const raw = formatTask(base);
  assert.throws(() => parseTask(raw.replace('id: "t-test123"', 'id: "t-test123"\nid: "bad"')), /duplicate/);
  assert.throws(() => parseTask(raw.replace('status: "review"', 'status: "unknown"')), /status/);
});

test("prioritizes globally without modifying the input", () => {
  const data = [{ ...base, priority: "P2", title: "B" }, { ...base, priority: "P0", title: "A" }];
  assert.equal(sortTasks(data)[0].title, "A");
  assert.equal(data[0].title, "B");
});

test("counts only linked PRs in review", () => {
  assert.ok(isReviewPr(base));
  assert.equal(isReviewPr({ ...base, status: "done" }), false);
  assert.equal(isReviewPr({ ...base, url: "https://github.com/example/example-project/issues/12" }), false);
  assert.ok(identicalTask(base, { ...base }));
  assert.equal(identicalTask(base, { ...base, status: "done" }), false);
});

