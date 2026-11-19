import test from "node:test";
import assert from "node:assert/strict";
import { publishingInfo, publishingMatches, publishingGroup, createPublishingTracker, publishingAlerts, formatTask, parseTask } from "../docs/model.mjs";

const now = Date.parse("2030-01-02T16:00:00Z");
const meta = { version: 1, channel: "example", state: "ready", due: "2030-01-03T13:00:00-03:00" };
const card = (data = meta, rest = {}) => ({
  id: "t-fictional-release", title: "Synthetic clip", project: "example", status: "active", priority: "P1", url: "",
  description: "Only a fixture.\n\n```work-publish\n" + JSON.stringify(data) + "\n```\n", ...rest
});

test("legacy cards and six-field front matter remain unchanged", () => {
  assert.equal(publishingInfo(card(meta, { description: "Ordinary old task" })), null);
  const original = card();
  assert.equal(parseTask(formatTask(original)).description, original.description.trim());
  assert.equal(publishingInfo(parseTask(formatTask(original)), now).state, "ready");
});

test("dates distinguish planned overdue from scheduled needs-verification", () => {
  assert.equal(publishingInfo(card(), now).state, "ready");
  const due = "2030-01-02T13:00:00-03:00";
  for (const state of ["ready", "draft"]) assert.equal(publishingInfo(card({ ...meta, due, state }), now).state, "overdue");
  assert.equal(publishingInfo(card({ ...meta, due, state: "scheduled" }), now).state, "verify");
  assert.equal(publishingInfo(card({ ...meta, state: "scheduled" }), now).state, "scheduled");
});

test("holds, parked and done suppress actionable alerts", () => {
  const overdue = { ...meta, due: "2030-01-01T00:00:00Z" };
  for (const task of [card({ ...overdue, state: "hold" }), card(overdue, { status: "parked" }), card(overdue, { status: "done" })]) {
    assert.deepEqual(publishingAlerts([task], createPublishingTracker(), now), []);
  }
  assert.equal(publishingInfo(card({ ...overdue, state: "published", published_url: "https://example.com/post" }), now).state, "published");
});

test("malformed, duplicate, unsupported and unsafe metadata fail closed without breaking the card", () => {
  const bad = [
    { ...meta, version: 2 }, { ...meta, channel: ["example"] }, { ...meta, state: "approved" },
    { ...meta, extra: true }, { ...meta, due: "2030-01-01" }, { ...meta, due: "2030-01-01T12:00:00" },
    { ...meta, due: "2030-02-30T00:00:00Z" }, { ...meta, due: "2030-01-01T24:00:00Z" },
    { ...meta, due: "invalid" }, { ...meta, due: 100 }, { ...meta, state: "scheduled", due: "" },
    { ...meta, state: "published" }, { ...meta, published_url: "javascript:alert(1)" },
    { ...meta, published_url: "https://user:secret@example.com/" }
  ];
  for (const value of bad) {
    assert.equal(publishingInfo(card(value), now).state, "invalid", JSON.stringify(value));
    assert.deepEqual(publishingAlerts([card(value)], createPublishingTracker(), now), []);
  }
  for (const description of [card().description + card().description, "```work-publish\nnot JSON\n```", "```work-publish\n{}", "```work-publish extra\n{}\n```"])
    assert.equal(publishingInfo(card(meta, { description }), now).state, "invalid");
});

test("channel and readiness filters are independent of free text", () => {
  assert.equal(publishingMatches(card(), "ready", "example", now), true);
  assert.equal(publishingMatches(card(), "overdue", "", now), false);
  assert.equal(publishingMatches(card(), "all", "other", now), false);
  assert.equal(publishingMatches(card(meta, { description: "Old card" }), "all", "", now), false);
});

test("a metadata example nested inside a larger code fence is not a publishing card", () => {
  const nested = "````markdown\n" + card().description + "````\n";
  assert.equal(publishingInfo(card(meta, { description: nested }), now), null);
  assert.deepEqual(publishingAlerts([card(meta, { description: nested })], createPublishingTracker(), now), []);
});

test("ready transitions and overdue are deduplicated, new due dates rearm overdue", () => {
  const tracker = createPublishingTracker();
  assert.deepEqual(publishingAlerts([card()], tracker, now), []); // baseline is not a transition
  publishingAlerts([card({ ...meta, state: "draft" })], tracker, now);
  assert.equal(publishingAlerts([card()], tracker, now)[0].kind, "ready");
  assert.deepEqual(publishingAlerts([card()], tracker, now), []);
  const overdue = card({ ...meta, due: "2030-01-01T00:00:00Z" });
  assert.equal(publishingAlerts([overdue], tracker, now)[0].kind, "overdue");
  assert.deepEqual(publishingAlerts([overdue], tracker, now), []);
  assert.equal(publishingAlerts([card({ ...meta, due: "2030-01-02T00:00:00Z" })], tracker, now).length, 1);
});

test("initial overdue and needs-verification alert once, never mark published automatically", () => {
  const tracker = createPublishingTracker();
  const task = card({ ...meta, state: "scheduled", due: "2030-01-01T00:00:00Z" });
  assert.deepEqual(publishingAlerts([task], tracker, now), [{ id: task.id, kind: "verify" }]);
  assert.deepEqual(publishingAlerts([task], tracker, now), []);
  assert.equal(publishingInfo(task, now).declaredState, "scheduled");
});

test("Upload Ready includes overdue ready but never draft, scheduled, verification, hold or closed", () => {
  const past = "2030-01-01T00:00:00Z";
  const cases = [
    [card(), "upload-ready"], [card({ ...meta, due: past }), "upload-ready"],
    [card({ ...meta, state: "draft", due: past }), "preparing"],
    [card({ ...meta, state: "scheduled" }), "scheduled"],
    [card({ ...meta, state: "scheduled", due: past }), "verify"],
    [card({ ...meta, state: "hold" }), "hold"], [card(meta, { status: "parked" }), "hold"],
    [card(meta, { status: "done" }), "hold"],
    [card({ ...meta, state: "published", published_url: "https://example.com/post" }), "published"]
  ];
  for (const [task, group] of cases) {
    const before = JSON.stringify(task);
    assert.equal(publishingGroup(task, now), group);
    assert.equal(publishingMatches(task, "upload-ready", "", now), group === "upload-ready");
    assert.equal(JSON.stringify(task), before);
  }
});
