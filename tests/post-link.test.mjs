import test from "node:test";
import assert from "node:assert/strict";
import { validatePostLink, canAddPostLink, addPostLink, publishingInfo, publishingGroup, publishingMatches, publishingAlerts, createPublishingTracker, displayDescription, applyQuickAction } from "../docs/model.mjs";

const card = (metadata = {}, extra = {}) => ({
  id: "t-synthetic", title: "Synthetic clip", project: "example", status: "done", priority: "P1", url: "https://github.com/example/repo/issues/1",
  description: "Keep this context.\n\n```work-publish\n" + JSON.stringify({ version: 1, channel: "instagram", state: "ready", due: "2030-01-01T00:00:00Z", ...metadata }) + "\n```\n\nKeep this checklist.\n- [x] Test", ...extra
});

test("supported public post URL shapes canonicalize without tracking", () => {
  const cases = [
    ["x", "https://twitter.com/example/status/123456789?s=20#foo", "https://x.com/example/status/123456789"],
    ["twitter", "https://x.com/i/web/status/123456789", "https://x.com/i/web/status/123456789"],
    ["instagram", "https://instagram.com/reel/AbCdEf123_/?igsh=tracking", "https://www.instagram.com/reel/AbCdEf123_/"],
    ["ig", "https://www.instagram.com/p/AbCdEf123_/", "https://www.instagram.com/p/AbCdEf123_/"],
    ["instagram", "https://instagram.com/tv/AbCdEf123_/", "https://www.instagram.com/tv/AbCdEf123_/"],
    ["youtube", "https://youtu.be/AbCdEf123_-?si=tracking", "https://www.youtube.com/watch?v=AbCdEf123_-"],
    ["youtube", "https://www.youtube.com/watch?v=AbCdEf123_-&t=20&list=tracking", "https://www.youtube.com/watch?v=AbCdEf123_-"],
    ["yt", "https://m.youtube.com/shorts/AbCdEf123_-?feature=share", "https://www.youtube.com/shorts/AbCdEf123_-"],
    ["youtube-shorts", "https://youtube.com/live/AbCdEf123_-", "https://www.youtube.com/live/AbCdEf123_-"],
    ["tiktok", "https://www.tiktok.com/@example/video/123456789?is_from_webapp=1", "https://www.tiktok.com/@example/video/123456789"]
  ];
  for (const [channel, raw, expected] of cases) assert.equal(validatePostLink(raw, channel), expected);
});

test("wrong platforms, profiles, dashboards, credentials, redirectors and ambiguous URLs are rejected", () => {
  const bad = [
    ["instagram", "http://instagram.com/reel/AbCdEf123_/"],
    ["instagram", "https://user:secret@instagram.com/reel/AbCdEf123_/"],
    ["instagram", "https://instagram.com:444/reel/AbCdEf123_/"],
    ["instagram", "https://instagram.com.example.org/reel/AbCdEf123_/"],
    ["instagram", "https://instagram.com/example/"],
    ["instagram", "https://instagram.com/accounts/edit/"],
    ["instagram", "https://www.instagram.com/direct/inbox/"],
    ["instagram", "https://youtube.com/shorts/AbCdEf123_-"],
    ["youtube", "https://studio.youtube.com/video/AbCdEf123_-/edit"],
    ["youtube", "https://www.youtube.com/@example"],
    ["youtube", "https://www.youtube.com/watch?v=AbCdEf123_-&v=ZbCdEf123_-"],
    ["youtube", "https://www.youtube.com/watch?v=short"],
    ["youtube", "https://www.youtube.com/redirect?q=https://example.com"],
    ["x", "https://x.com/example"], ["x", "https://x.com/messages"],
    ["x", "https://t.co/example"], ["x", "https://x.com/example/status/not-a-number"],
    ["tiktok", "https://www.tiktok.com/@example"], ["tiktok", "https://vm.tiktok.com/example/"],
    ["tiktok", "https://www.tiktok.com/t/example/"], ["tiktok", "https://www.tiktok.com/creator-center/"],
    ["example", "https://example.com/post"], ["constructor", "https://example.com/post"],
    ["x", "javascript:alert(1)"], ["x", ""], ["x", "https://x.co\nm/example/status/123"],
    ["x", "https://x.com/\\example/status/123"]
  ];
  for (const [channel, raw] of bad) assert.throws(() => validatePostLink(raw, channel), undefined, raw);
});

test("receipt attachment updates one existing block, preserves task status/source/due/body and never overwrites", () => {
  const original = card();
  const before = JSON.stringify(original);
  assert.equal(canAddPostLink(original), true);
  const next = addPostLink(original, "https://instagram.com/reel/AbCdEf123_/?igsh=tracking");
  assert.equal(next.status, "done");
  assert.equal(next.url, original.url);
  assert.equal(publishingInfo(next).declaredState, "published");
  assert.equal(publishingInfo(next).due, publishingInfo(original).due);
  assert.equal(publishingInfo(next).publishedUrl, "https://www.instagram.com/reel/AbCdEf123_/");
  assert.equal(displayDescription(next), displayDescription(original));
  assert.equal(JSON.stringify(original), before);
  assert.equal(canAddPostLink(next), false);
  assert.throws(() => addPostLink(next, "https://instagram.com/p/Different123_/"), /not be overwritten/);
  assert.throws(() => addPostLink(card({}, { status: "active" }), "https://instagram.com/reel/AbCdEf123_/"), /complete/);
  assert.equal(canAddPostLink(card({ channel: "constructor" })), false);
  assert.equal(canAddPostLink(card({ version: 99 })), false);
  assert.equal(canAddPostLink(card({ published_url: "https://example.com/old-receipt" })), false);
});

test("one completion lane and one derived status, with legacy data and reminders unchanged", () => {
  const done = card();
  const published = addPostLink(done, "https://instagram.com/p/AbCdEf123_/");
  const legacy = card({ state: "published", published_url: "https://example.com/old-post" }, { status: "active" });
  const recorded = card({ state: "ready", published_url: "https://example.com/existing" });
  assert.equal(publishingInfo(done).label, "Done");
  for (const item of [published, legacy, recorded]) assert.equal(publishingInfo(item).label, "Published");
  for (const item of [done, published, legacy, recorded]) {
    assert.equal(publishingGroup(item), "completed");
    assert.equal(publishingMatches(item, "completed"), true);
    assert.deepEqual(publishingAlerts([item], createPublishingTracker()), []);
  }
  assert.equal(publishingGroup(card({ state: "hold" }, { status: "active" })), "hold");
  const ready = card({}, { status: "active" });
  const complete = applyQuickAction(ready, "complete");
  assert.equal(complete.description, ready.description);
  assert.equal(publishingInfo(complete).label, "Done");
});

test("read views omit only live metadata; saved Markdown and nested examples survive", () => {
  const nested = '````markdown\n```work-publish\n{"version":99}\n```\n````\n';
  const original = card();
  original.description = nested + original.description.replaceAll("\n", "\r\n");
  const view = displayDescription(original);
  assert.ok(view.startsWith(nested));
  assert.match(view, /Keep this context/);
  assert.match(view, /Keep this checklist/);
  assert.doesNotMatch(view, /"state":"ready"/);
  const added = addPostLink(original, "https://instagram.com/reel/AbCdEf123_/");
  assert.equal(displayDescription(added), view);
  assert.ok(added.description.startsWith(nested));
  assert.match(added.description, /\r\n```\r\n\r\nKeep this checklist/);
});
