import test from "node:test";
import assert from "node:assert/strict";
import { formatTask, parseTask, safeUrl, sortTasks, identicalTask, isReviewPr, renderTaskMarkdown } from "../docs/model.mjs";

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


test("read view renders long Markdown as paragraphs, headings, lists, and code", () => {
  const html = renderTaskMarkdown([
    "## Summary", "",
    "This is **important** and *emphasized*.",
    "",
    "- First",
    "- Second",
    "",
    "> A quoted observation", "",
    "\x60\x60\x60js",
    "const n = 3 < 4;",
    "\x60\x60\x60"
  ].join("\n"));
  assert.match(html, /<h2>Summary<\/h2>/);
  assert.match(html, /<strong>important<\/strong>/);
  assert.match(html, /<em>emphasized<\/em>/);
  assert.match(html, /<ul>\s*<li>First<\/li>\s*<li>Second<\/li>\s*<\/ul>/);
  assert.match(html, /<blockquote><p>A quoted observation<\/p><\/blockquote>/);
  assert.match(html, /<pre><code>const n = 3 &lt; 4;<\/code><\/pre>/);
});

test("read view supports Markdown and bare HTTPS links without permitting unsafe markup", () => {
  const html = renderTaskMarkdown([
    "[Open PR](https://github.com/example/repo/pull/7)",
    "",
    "See https://github.com/example/repo.",
    "",
    "[do not click](javascript:alert(1))",
    "",
    "<img src=x onerror=alert(1)>",
    "",
    "\x60*not italic*\x60"
  ].join("\n"));
  assert.match(html, /href="https:\/\/github.com\/example\/repo\/pull\/7"/);
  assert.match(html, /href="https:\/\/github.com\/example\/repo"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<code>\*not italic\*<\/code>/);
});

test("read view represents empty and unrecognized Markdown harmlessly", () => {
  assert.equal(renderTaskMarkdown(""), "");
  assert.equal(renderTaskMarkdown("Normal text."), "<p>Normal text.</p>");
  assert.match(renderTaskMarkdown("- [x] Complete"), /Checked/);
  assert.match(renderTaskMarkdown("- [ ] Pending"), /Unchecked/);
});
