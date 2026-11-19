import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as model from "../docs/model.mjs";

// Exercise the actual app functions with a small DOM stub and controlled network.
// No browser, dependency installation, real token, or live task writes are needed.
const source = (await readFile(new URL("../docs/app.mjs", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?\} from "\.\/model\.mjs";\n/, "")
  .replace(/\ninit\(\);\s*$/, "");
const task = {
  id: "t-example", title: "Example 🌊", project: "test", status: "backlog",
  priority: "P1", url: "", description: "Test only", path: "tasks/t-example.md", sha: "old-sha"
};
const event = { preventDefault() {} };
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data)
});
const tree = { tree: [{ type: "blob", path: task.path, sha: task.sha }] };
const blob = value => ({ encoding: "base64", content: Buffer.from(model.formatTask(value)).toString("base64") });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup(fetch, globals = {}) {
  const elements = new Map();
  let generated = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", disabled: false, open: true, children: [],
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this[key] = value; },
      listeners: {}, dataset: {},
      classList: {
        values: new Set(),
        toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); },
        add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); },
        contains(name) { return this.values.has(name); }
      },
      addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
      fire(type, properties = {}) {
        const event = { target: this, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; }, ...properties };
        for (const handler of this.listeners[type] || []) handler(event);
        if (type === "cancel" && !event.defaultPrevented) this.close();
        return event;
      },
      close() { this.open = false; this.fire("close"); }, reset() {}, focus() {},
      showModal() { this.open = true; }
    });
    return elements.get(id);
  };
  const fields = ["title", "project", "priority", "status", "url", "description"].map(name => element("field-" + name));
  const taskCancel = element("task-cancel"); taskCancel.dataset.close = "task-dialog";
  const authCancel = element("auth-cancel"); authCancel.dataset.close = "auth-dialog";
  const context = vm.createContext({
    ...model, fetch, AbortController, TextEncoder, TextDecoder, atob, btoa,
    setTimeout: () => 0, clearTimeout() {}, ...globals,
    Option: function(text, value) { return { textContent: text, value }; },
    document: { createElement: () => element("generated-" + ++generated), getElementById: element, querySelector: element, querySelectorAll: selector => {
      if (selector === "dialog") return [element("auth-dialog"), element("task-dialog")];
      if (selector === "[data-close]") return [authCancel, taskCancel];
      if (selector === '[data-close="task-dialog"]') return [taskCancel];
      if (selector.startsWith("#task-form input")) return fields;
      return [];
    } }
  });
  vm.runInContext(source + `
    render = renderStats;
    renderConnection = () => {};
    globalThis.app = { state, loadTasks, saveTask, connect, cancelConnection,
      closeDialog, openTask, viewTask, renderTaskView, editViewedTask,
      disconnect, describeError, renderStats, init, togglePublishingAlerts, pollTasks,
      checkPublishingAlerts, stopPublishingAlerts, renderBoard, renderProjects, sendTestAlert };
  `, context);
  return { ...context.app, element };
}

test("the initial shell says work and hides the review limit before JavaScript loads", async () => {
  const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
  assert.match(html, /class="brand-copy"><strong>work<\/strong>/);
  assert.doesNotMatch(html, /brand-slash/);
  assert.match(html, /<span id="review-limit"[^>]*\bhidden\b[^>]*> \/ 3<\/span>/);
});

test("locked and unauthenticated loaded states do not expose review counts or the limit", () => {
  const app = setup(async () => response({ tree: [] }));
  for (const loaded of [false, true]) {
    app.state.loaded = loaded;
    app.state.tasks = Array.from({ length: 3 }, (_, i) => ({
      ...task, id: "t-example-" + i, status: "review", url: "https://github.com/example/repo/pull/" + (i + 1)
    }));
    app.renderStats();
    assert.equal(app.element("review-count").textContent, "—");
    assert.equal(app.element("review-limit").hidden, true);
    assert.equal(app.element("review-metric").classList.contains("over-limit"), false);
  }
});

test("review counts remain hidden until all authenticated task loading completes", async () => {
  const pending = deferred();
  const reviewTask = { ...task, status: "review", url: "https://github.com/example/repo/pull/1" };
  const app = setup(async url => url.includes("/trees/") ? response(tree) : pending.promise);
  app.element("token-input").value = "fake-token";
  const connecting = app.connect(event);
  await new Promise(setImmediate);
  assert.equal(app.state.loading, true);
  assert.equal(app.element("review-count").textContent, "—");
  assert.equal(app.element("review-limit").hidden, true);
  pending.resolve(response(blob(reviewTask)));
  await connecting;
  assert.equal(app.element("review-count").textContent, "1");
  assert.equal(app.element("review-limit").hidden, false);
});

test("an authenticated empty board shows zero and the limit after hydration", async () => {
  const app = setup(async () => response({ tree: [] }));
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  assert.equal(app.element("review-count").textContent, "0");
  assert.equal(app.element("review-limit").hidden, false);
  assert.equal(app.element("review-metric").classList.contains("over-limit"), false);
});

test("refresh hides stale review counts and restores the loaded result", async () => {
  const pending = deferred();
  const app = setup(async () => pending.promise);
  app.state.token = "fake-token";
  app.state.loaded = true;
  app.state.tasks = Array.from({ length: 3 }, (_, i) => ({
    ...task, id: "t-example-" + i, status: "review", url: "https://github.com/example/repo/pull/" + (i + 1)
  }));
  app.renderStats();
  assert.equal(app.element("review-count").textContent, "3");
  assert.equal(app.element("review-limit").hidden, false);
  assert.equal(app.element("review-metric").classList.contains("over-limit"), true);
  const refresh = app.loadTasks();
  assert.equal(app.element("review-count").textContent, "—");
  assert.equal(app.element("review-limit").hidden, true);
  assert.equal(app.element("review-metric").classList.contains("over-limit"), false);
  pending.resolve(response({ tree: [] }));
  await refresh;
  assert.equal(app.element("review-count").textContent, "0");
  assert.equal(app.element("review-limit").hidden, false);
  app.disconnect();
  assert.equal(app.element("review-count").textContent, "—");
  assert.equal(app.element("review-limit").hidden, true);
});

test("failed or canceled authentication never reveals the review limit", async () => {
  const failed = setup(async () => response({ message: "Bad credentials" }, 401));
  failed.element("token-input").value = "fake-token";
  await failed.connect(event);
  assert.equal(failed.element("review-limit").hidden, true);
  const pending = deferred();
  const canceled = setup(async () => pending.promise);
  canceled.element("token-input").value = "fake-token";
  const connecting = canceled.connect(event);
  canceled.cancelConnection();
  pending.resolve(response({ tree: [] }));
  await connecting;
  assert.equal(canceled.element("review-count").textContent, "—");
  assert.equal(canceled.element("review-limit").hidden, true);
});

test("connect publishes the token only after success and clears the input", async () => {
  const pending = deferred();
  const calls = [];
  const app = setup(async (url, options) => {
    calls.push({ url, options });
    return url.includes("/trees/") ? pending.promise : response(blob(task));
  });
  app.element("token-input").value = "fake-token";
  const connected = app.connect(event);
  assert.equal(app.state.token, "");
  assert.equal(app.element("token-input").value, "");
  pending.resolve(response(tree));
  await connected;
  assert.equal(app.state.token, "fake-token");
  assert.equal(app.state.tasks[0].title, task.title);
  assert.equal(app.element("auth-dialog").open, false);
  assert.ok(calls.every(call => call.url.startsWith("https://api.github.com/repos/gqgs/work/")));
  assert.ok(calls.every(call => call.options.headers.Authorization === "Bearer fake-token"));
});

test("canceling connection aborts requests and ignores their late result", async () => {
  const pending = deferred();
  let signal;
  const app = setup(async (url, options) => {
    signal = options.signal;
    return url.includes("/trees/") ? pending.promise : response(blob(task));
  });
  app.element("token-input").value = "fake-token";
  const connected = app.connect(event);
  app.closeDialog(app.element("auth-dialog"));
  assert.ok(signal.aborted);
  pending.resolve(response(tree));
  await connected;
  assert.equal(app.state.token, "");
  assert.equal(app.state.tasks.length, 0);
  assert.equal(app.element("auth-submit").disabled, false);
  assert.match(app.element("notice").textContent, /canceled/);
});

test("a canceled login cannot clear a newer login", async () => {
  const old = deferred();
  const app = setup(async (url, options) => {
    if (url.includes("/trees/")) return options.headers.Authorization === "Bearer old-token" ? old.promise : response(tree);
    return response(blob(task));
  });
  app.element("token-input").value = "old-token";
  const first = app.connect(event);
  app.cancelConnection();
  app.element("token-input").value = "new-token";
  await app.connect(event);
  old.resolve(response({ message: "Bad credentials" }, 401));
  await first;
  assert.equal(app.state.token, "new-token");
  assert.equal(app.state.tasks.length, 1);
});

test("invalid token errors are not mistaken for an unconnected private repo", async () => {
  const app = setup(async () => response({ message: "Bad credentials" }, 401));
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  assert.match(app.element("auth-error").textContent, /Invalid token/);
  assert.equal(app.state.token, "");
});

test("a late refresh cannot repopulate the board after disconnect", async () => {
  const pending = deferred();
  const app = setup(async url => url.includes("/trees/") ? pending.promise : response(blob(task)));
  app.state.token = "fake-token";
  app.state.tasks = [task];
  const refresh = app.loadTasks();
  app.disconnect();
  pending.resolve(response(tree));
  assert.equal(await refresh, false);
  assert.equal(app.state.tasks.length, 0);
  assert.equal(app.state.loaded, false);
  assert.match(app.element("notice").textContent, /Disconnected/);
});

test("newer refresh results win over older results", async () => {
  const old = deferred();
  let reads = 0;
  const app = setup(async url => {
    if (url.includes("/trees/")) return ++reads === 1 ? old.promise : response({ tree: [] });
    return response(blob(task));
  });
  const first = app.loadTasks();
  await app.loadTasks();
  old.resolve(response(tree));
  await first;
  assert.equal(app.state.tasks.length, 0);
  assert.equal(app.state.loaded, true);
});

test("save creates one main commit with a conflict SHA and ignores an older refresh", async () => {
  const old = deferred();
  const writes = [];
  const app = setup(async (url, options) => {
    if (options.method === "PUT") {
      writes.push(JSON.parse(options.body));
      return response({ content: { sha: "new-sha" } });
    }
    return url.includes("/trees/") ? old.promise : response(blob(task));
  });
  app.state.token = "fake-token";
  app.state.tasks = [task];
  const refresh = app.loadTasks();
  await app.saveTask({ ...task, status: "done" }, task);
  old.resolve(response(tree));
  await refresh;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].branch, "main");
  assert.equal(writes[0].sha, "old-sha");
  assert.match(writes[0].message, /move t-example to done/);
  assert.match(Buffer.from(writes[0].content, "base64").toString(), /Example 🌊/);
  assert.equal(app.state.tasks[0].status, "done");
  assert.equal(app.state.tasks[0].sha, "new-sha");
  assert.equal(app.element("notice").textContent, "");
});

test("pending saves prevent duplicate writes, dismissal, and disconnect", async () => {
  const pending = deferred();
  let writes = 0;
  const app = setup(async () => { writes++; return pending.promise; });
  app.state.token = "fake-token";
  app.state.tasks = [task];
  const saving = app.saveTask({ ...task, status: "active" }, task);
  assert.equal(app.element("connect-btn").disabled, true);
  assert.equal(app.element("field-title").disabled, true);
  assert.equal(app.element("field-status").disabled, true);
  assert.equal(app.element("field-description").disabled, true);
  app.closeDialog(app.element("task-dialog"));
  assert.equal(app.element("task-dialog").open, true);
  app.disconnect();
  assert.equal(app.state.token, "fake-token");
  await assert.rejects(app.saveTask({ ...task, status: "done" }, task), /already being saved/);
  pending.resolve(response({ content: { sha: "new-sha" } }));
  await saving;
  assert.equal(writes, 1);
  assert.equal(app.element("connect-btn").disabled, false);
  assert.equal(app.element("field-title").disabled, false);
  assert.equal(app.element("field-status").disabled, false);
  assert.equal(app.element("field-description").disabled, false);
  app.closeDialog(app.element("task-dialog"));
  assert.equal(app.element("task-dialog").open, false);
});

test("conflicts leave the local task unchanged and no-op edits do not write", async () => {
  let writes = 0;
  const app = setup(async () => { writes++; return response({ message: "Conflict" }, 409); });
  app.state.token = "fake-token";
  app.state.tasks = [task];
  assert.equal(await app.saveTask(task, task), false);
  assert.equal(writes, 0);
  await assert.rejects(app.saveTask({ ...task, status: "done" }, task), /Conflict/);
  assert.equal(app.state.tasks[0], task);
  assert.equal(app.state.saving, false);
  assert.equal(writes, 1);
});

test("wired auth Cancel, Escape, and backdrop events cancel pending login", async () => {
  for (const dismiss of ["button", "escape", "backdrop"]) {
    const pending = deferred();
    const app = setup(async (_url, options) => options.headers.Authorization ? pending.promise : response({ tree: [] }));
    app.init();
    await new Promise(setImmediate);
    app.element("token-input").value = "fake-token";
    app.element("auth-form").fire("submit");
    if (dismiss === "button") app.element("auth-cancel").fire("click");
    if (dismiss === "escape") app.element("auth-dialog").fire("cancel");
    if (dismiss === "backdrop") app.element("auth-dialog").fire("click");
    pending.resolve(response({ tree: [] }));
    await new Promise(setImmediate);
    assert.equal(app.state.token, "", dismiss);
    assert.equal(app.element("auth-dialog").open, false, dismiss);
    assert.equal(app.element("token-input").value, "", dismiss);
    assert.match(app.element("notice").textContent, /canceled/, dismiss);
  }
});

test("wired task Escape and backdrop events cannot dismiss an in-flight save", async () => {
  const pending = deferred();
  const app = setup(async (_url, options) => options.method === "PUT" ? pending.promise : response({ tree: [] }));
  app.init();
  await new Promise(setImmediate);
  app.state.token = "fake-token";
  app.state.tasks = [task];
  const saving = app.saveTask({ ...task, status: "active" }, task);
  assert.equal(app.element("task-dialog").fire("cancel").defaultPrevented, true);
  app.element("task-dialog").fire("click");
  assert.equal(app.element("task-dialog").open, true);
  pending.resolve(response({ content: { sha: "new-sha" } }));
  await saving;
  app.element("task-dialog").fire("cancel");
  assert.equal(app.element("task-dialog").open, false);
});


test("task cards open a readable detail view before explicit editing", () => {
  const app = setup(async () => response({ tree: [] }));
  app.state.tasks = [{ ...task, description: "## Details\n\n**All** the information, without textarea clipping." }];
  const selected = app.state.tasks[0];
  const editor = app.element("task-dialog");
  const viewer = app.element("view-dialog");
  editor.open = false;
  viewer.open = false;

  app.viewTask(selected);
  assert.equal(viewer.open, true);
  assert.equal(editor.open, false);
  assert.equal(app.state.editing, null);
  assert.equal(app.element("view-title").textContent, selected.title);
  assert.equal(app.element("view-project").textContent, selected.project);
  assert.match(app.element("view-description").innerHTML, /<h2>Details<\/h2>/);
  assert.match(app.element("view-description").innerHTML, /<strong>All<\/strong>/);
  assert.equal(app.element("view-edit-btn").hidden, true);

  // Only the explicitly authorized Edit action should open a form.
  app.editViewedTask();
  assert.equal(editor.open, false);

  app.state.token = "fake-token";
  app.renderTaskView(selected);
  assert.equal(app.element("view-edit-btn").hidden, false);
  const form = app.element("task-form");
  const fields = new Map(["title", "project", "priority", "status", "url", "description"]
    .map(name => [name, { value: "", focus() {} }]));
  form.elements = { namedItem: name => fields.get(name) };
  app.editViewedTask();
  assert.equal(viewer.open, false);
  assert.equal(editor.open, true);
  assert.equal(app.state.editing.id, selected.id);
  assert.equal(fields.get("description").value, selected.description);
  assert.equal(app.element("task-cancel-btn").textContent, "Back to details");
});

test("the detail view keeps long task text and related issue links intact", () => {
  const app = setup(async () => response({ tree: [] }));
  const description = Array.from({ length: 30 }, (_, i) => "Paragraph " + i).join("\n\n");
  const selected = { ...task, description, url: "https://github.com/example/repo/pull/17" };
  app.viewTask(selected);
  const content = app.element("view-description").innerHTML;
  assert.match(content, /Paragraph 0/);
  assert.match(content, /Paragraph 29/);
  assert.equal(app.element("view-related").hidden, false);
  assert.equal(app.element("view-related-link").href, selected.url);
  assert.equal(app.element("view-reference").textContent, selected.id);
});

function notificationHarness(permission = "default") {
  const sent = [];
  let requests = 0;
  class Notification {
    static permission = permission;
    static async requestPermission() { requests++; this.permission = "granted"; return "granted"; }
    constructor(title, options) { this.title = title; this.options = options; sent.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  return { Notification, sent, requests: () => requests, isSecureContext: true };
}
const publication = (state = "ready", due = "") => ({ ...task, description:
  "```work-publish\n" + JSON.stringify({ version: 1, channel: "example", state, due }) + "\n```" });

test("alerts are opt-in, generic and deduplicated across refresh and pause/resume", async () => {
  const alerts = notificationHarness();
  const app = setup(async url => response(url.includes("/trees/") ? tree : blob(publication("ready", "2000-01-01T00:00:00Z"))), alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  assert.equal(alerts.requests(), 0);
  assert.equal(alerts.sent.length, 0);
  await app.togglePublishingAlerts();
  assert.equal(alerts.requests(), 1);
  assert.equal(alerts.sent.length, 1);
  assert.match(alerts.sent[0].options.body, /1 overdue/);
  assert.doesNotMatch(JSON.stringify(alerts.sent), /Example|fake-token|t-example|2000/);
  await app.loadTasks();
  await app.togglePublishingAlerts(); // pause
  await app.togglePublishingAlerts(); // resume without duplicates
  assert.equal(alerts.sent.length, 1);
  app.disconnect();
  assert.equal(alerts.sent[0].closed, true);
  assert.equal(app.element("notifications-btn").disabled, true);
});

test("ready transition alerts only after successful refresh, not stale save or failed refresh", async () => {
  const alerts = notificationHarness("granted");
  let current = publication("draft"), sha = "one", failed = false;
  const app = setup(async (url, options) => {
    if (options.method === "PUT") return response({ content: { sha: "local-change" } });
    if (failed) return response({ message: "Offline" }, 503);
    return response(url.includes("/trees/") ? { tree: [{ type: "blob", path: task.path, sha }] } : blob(current));
  }, alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  await app.togglePublishingAlerts();
  assert.equal(alerts.sent.length, 0);
  current = publication("ready"); sha = "two";
  failed = true;
  await assert.rejects(app.loadTasks(), /Offline/);
  assert.equal(alerts.sent.length, 0);
  failed = false;
  await app.loadTasks();
  assert.equal(alerts.sent.length, 1);
  assert.match(alerts.sent[0].options.body, /newly ready/);
  await app.saveTask({ ...app.state.tasks[0], title: "Unrelated edit" }, app.state.tasks[0]);
  assert.equal(alerts.sent.length, 1);
});

test("pending permission cannot enable alerts after disconnect", async () => {
  const pending = deferred();
  const alerts = notificationHarness();
  alerts.Notification.requestPermission = () => pending.promise;
  const app = setup(async () => response({ tree: [] }), alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  const enabling = app.togglePublishingAlerts();
  app.disconnect();
  alerts.Notification.permission = "granted";
  pending.resolve("granted");
  await enabling;
  assert.equal(app.element("notifications-btn").textContent, "Enable tab alerts");
  assert.equal(app.element("notifications-btn").disabled, true);
  assert.equal(alerts.sent.length, 0);
});

test("denied or missing notification API leaves publishing usable without prompts", async () => {
  const alerts = notificationHarness("denied");
  const app = setup(async () => response({ tree: [] }), alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  await app.togglePublishingAlerts();
  assert.equal(alerts.requests(), 0);
  assert.equal(alerts.sent.length, 0);
  assert.equal(app.state.loaded, true);
});

test("polling skips disconnected and editing tabs, caches unchanged private blobs only in memory", async () => {
  let reads = 0;
  const app = setup(async url => { reads++; return response(url.includes("/trees/") ? tree : blob(task)); });
  await app.pollTasks();
  assert.equal(reads, 0);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  assert.equal(reads, 2);
  await app.loadTasks();
  assert.equal(reads, 3); // tree only; blob SHA unchanged
  app.element("task-dialog").open = true;
  await app.pollTasks();
  assert.equal(reads, 3);
  app.element("task-dialog").open = false;
  await app.pollTasks();
  assert.equal(reads, 4);
  app.disconnect();
  await app.pollTasks();
  assert.equal(reads, 4);
  assert.deepEqual([...app.state.tasks], []);
});

test("actual publishing card rendering filters channels and exposes safe receipts and date labels", () => {
  const app = setup(async () => response({ tree: [] }));
  const receipt = { ...task, id: "t-receipt", description: '```work-publish\n{"version":1,"channel":"second","state":"published","published_url":"https://example.com/post"}\n```' };
  app.state.token = "fake-token";
  app.state.tasks = [task, publication("ready", "2099-01-03T13:00:00-03:00"), receipt];
  app.element("publishing-filter").value = "all";
  app.renderBoard();
  assert.equal(app.element("board").children.length, 2);
  const flatten = element => [element, ...(element.children || []).flatMap(flatten)];
  const nodes = flatten(app.element("board"));
  assert.ok(nodes.some(node => node.textContent.includes("Brasília")));
  assert.ok(nodes.some(node => node.href === "https://example.com/post" && node.rel === "noopener noreferrer"));
  app.element("channel-filter").value = "second";
  app.renderBoard();
  assert.equal(flatten(app.element("board")).filter(node => node.className === "task-card").length, 1);
  app.element("publishing-filter").value = "ready";
  app.renderBoard();
  assert.ok(flatten(app.element("board")).some(node => node.textContent === "No matching items"));
  app.state.tasks = [];
  app.renderProjects();
  app.renderBoard();
  assert.equal(app.element("channel-filter").value, "");
});

test("derived publishing lanes place each card once, highlight overdue ready, and preserve engineering lanes", () => {
  const app = setup(async () => { throw new Error("Rendering must not write"); });
  const make = (id, state, due) => ({ ...publication(state, due), id });
  app.state.token = "fake-token";
  app.state.tasks = [make("t-ready", "ready", "2099-01-01T00:00:00Z"), make("t-late-ready", "ready", "2000-01-01T00:00:00Z"),
    make("t-late-draft", "draft", "2000-01-01T00:00:00Z"), make("t-verify", "scheduled", "2000-01-01T00:00:00Z")];
  const before = JSON.stringify(app.state.tasks);
  app.element("publishing-filter").value = "all";
  app.renderBoard();
  const columns = app.element("board").children;
  assert.equal(columns[0].dataset.publishing, "upload-ready");
  assert.equal(columns[0].classList.contains("upload-ready"), true);
  const flatten = element => [element, ...(element.children || []).flatMap(flatten)];
  const cards = column => flatten(column).filter(node => node.className === "task-card");
  assert.equal(cards(columns[0]).length, 2);
  assert.equal(cards(app.element("board")).length, 4);
  assert.ok(flatten(cards(columns[0])[0]).some(node => node.textContent === "example · Overdue"));
  assert.ok(cards(app.element("board")).every(node => !node.draggable));
  assert.ok(columns.every(node => !node.listeners.drop));
  app.state.tasks[0] = { ...make("t-ready", "scheduled", "2099-01-01T00:00:00Z") };
  app.renderBoard();
  assert.equal(cards(app.element("board").children[0]).length, 1);
  assert.equal(cards(app.element("board")).length, 4);
  app.state.tasks = JSON.parse(before);
  app.element("publishing-filter").value = "";
  app.renderBoard();
  assert.deepEqual(app.element("board").children.map(node => node.dataset.status), ["backlog", "active", "review", "done"]);
  assert.equal(JSON.stringify(app.state.tasks), before);
});

test("Send test alert is explicit, generic and leaves task data and automatic dedup untouched", async () => {
  const alerts = notificationHarness();
  const app = setup(async url => response(url.includes("/trees/") ? tree : blob(publication("ready", "2000-01-01T00:00:00Z"))), alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  app.sendTestAlert();
  assert.equal(alerts.requests(), 0);
  assert.match(app.element("test-alert-result").textContent, /Enable tab alerts first/);
  await app.togglePublishingAlerts();
  assert.equal(alerts.sent.length, 1); // actual overdue baseline
  const before = JSON.stringify(app.state.tasks);
  app.sendTestAlert();
  assert.equal(alerts.sent.length, 2);
  assert.equal(alerts.sent[1].title, "Work test alert");
  assert.equal(alerts.sent[1].options.tag, "work-publishing-test");
  assert.doesNotMatch(JSON.stringify(alerts.sent[1]), /fake-token|t-example|Example|2000/);
  assert.match(app.element("test-alert-result").textContent, /Browser accepted.*does not confirm it was displayed/);
  assert.equal(JSON.stringify(app.state.tasks), before);
  await app.loadTasks();
  assert.equal(alerts.sent.length, 2); // test did not clear or change overdue dedup
  alerts.sent[1].onerror();
  assert.match(app.element("test-alert-result").textContent, /could not be displayed/);
  app.disconnect();
  assert.equal(app.element("test-alert-result").textContent, "");
});

test("Send test alert explains locked, unsupported, denied and constructor failures", async () => {
  const unsupported = setup(async () => response({ tree: [] }));
  unsupported.sendTestAlert();
  assert.match(unsupported.element("test-alert-result").textContent, /Connect GitHub first/);
  unsupported.state.token = "fake-token"; unsupported.state.loaded = true;
  unsupported.sendTestAlert();
  assert.match(unsupported.element("test-alert-result").textContent, /unavailable/);
  const denied = notificationHarness("denied");
  const blocked = setup(async () => response({ tree: [] }), denied);
  blocked.state.token = "fake-token"; blocked.state.loaded = true;
  blocked.sendTestAlert();
  assert.equal(denied.requests(), 0);
  assert.match(blocked.element("test-alert-result").textContent, /blocked for this site/);
  class BrokenNotification { static permission = "granted"; constructor() { throw new Error("Unsupported"); } }
  const broken = setup(async () => response({ tree: [] }), { Notification: BrokenNotification, isSecureContext: true });
  broken.element("token-input").value = "fake-token";
  await broken.connect(event); await broken.togglePublishingAlerts(); broken.sendTestAlert();
  assert.match(broken.element("test-alert-result").textContent, /could not create.*No tasks were changed/);
});

test("publishing mobile layout stacks lanes with Upload Ready first and no horizontal board margin", async () => {
  const css = await readFile(new URL("../docs/styles.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\) \{ \.board\.publishing-view \{ grid-template-columns: minmax\(0,1fr\); margin-right: 0; padding-right: 0;/);
  assert.match(css, /\.publishing-column\.upload-ready \{[^}]*border: 2px solid/);
});

test("repeated test alerts ignore late failure from the replaced test", async () => {
  const alerts = notificationHarness("granted");
  const app = setup(async () => response({ tree: [] }), alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event); await app.togglePublishingAlerts();
  app.sendTestAlert(); app.sendTestAlert();
  assert.equal(alerts.sent.length, 2);
  assert.equal(alerts.sent[0].closed, true);
  alerts.sent[0].onerror();
  assert.match(app.element("test-alert-result").textContent, /Browser accepted/);
  alerts.sent[1].onerror();
  assert.match(app.element("test-alert-result").textContent, /could not be displayed/);
});

test("real and test alerts share a local icon without additional requests or task changes", async () => {
  const alerts = notificationHarness("granted");
  let reads = 0;
  const app = setup(async url => {
    reads++;
    return response(url.includes("/trees/") ? tree : blob(publication("ready", "2000-01-01T00:00:00Z")));
  }, alerts);
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  const before = JSON.stringify(app.state.tasks), baselineReads = reads;
  await app.togglePublishingAlerts();
  app.sendTestAlert();
  assert.equal(alerts.sent.length, 2);
  for (const notification of alerts.sent) {
    assert.equal(notification.options.icon, "./assets/eigendynamics-icon.png");
    assert.equal(notification.options.silent, true);
    assert.doesNotMatch(JSON.stringify(notification), /fake-token|t-example|Example|2000/);
  }
  assert.equal(reads, baselineReads + 1); // Enable refreshes the tree; the icon/test adds no request.
  assert.equal(alerts.requests(), 0);
  assert.equal(JSON.stringify(app.state.tasks), before);
});

test("an unavailable optional icon falls back once for both alert types", async () => {
  const alerts = notificationHarness("granted");
  let attempts = 0;
  class IconUnavailable extends alerts.Notification {
    constructor(title, options) {
      attempts++;
      if (options.icon) throw new Error("Optional icon unavailable");
      super(title, options);
    }
  }
  const app = setup(async url => response(url.includes("/trees/") ? tree : blob(publication("ready", "2000-01-01T00:00:00Z"))),
    { ...alerts, Notification: IconUnavailable });
  app.element("token-input").value = "fake-token";
  await app.connect(event);
  const before = JSON.stringify(app.state.tasks);
  await app.togglePublishingAlerts();
  app.sendTestAlert();
  assert.equal(attempts, 4);
  assert.equal(alerts.sent.length, 2);
  assert.deepEqual(alerts.sent.map(alert => alert.title), ["Work publishing check", "Work test alert"]);
  assert.ok(alerts.sent.every(alert => !Object.hasOwn(alert.options, "icon")));
  assert.match(app.element("test-alert-result").textContent, /Browser accepted/);
  await app.loadTasks(); // the optional fallback did not reset real-alert dedup
  assert.equal(attempts, 4);
  assert.equal(alerts.requests(), 0);
  assert.equal(JSON.stringify(app.state.tasks), before);
});
