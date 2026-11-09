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
function setup(fetch) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", disabled: false, open: true,
      listeners: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
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
    setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: element, querySelectorAll: selector => {
      if (selector === "dialog") return [element("auth-dialog"), element("task-dialog")];
      if (selector === "[data-close]") return [authCancel, taskCancel];
      if (selector === '[data-close="task-dialog"]') return [taskCancel];
      if (selector.startsWith("#task-form input")) return fields;
      return [];
    } }
  });
  vm.runInContext(source + `
    render = () => {};
    renderConnection = () => {};
    globalThis.app = { state, loadTasks, saveTask, connect, cancelConnection,
      closeDialog, openTask, disconnect, describeError, init };
  `, context);
  return { ...context.app, element };
}

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

