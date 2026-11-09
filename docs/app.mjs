import {
  COLUMNS, createTaskId, formatTask, identicalTask, isReviewPr,
  parseTask, sortTasks, validateTask
} from "./model.mjs";

const REPO = "gqgs/work";
const BRANCH = "main";
const ROOT = "https://api.github.com/repos/" + REPO;
const state = { token: "", tasks: [], loaded: false, loading: false, saving: false, editing: null, dragging: null };
const $ = id => document.getElementById(id);
const H = name => document.createElement(name);
let toastTimeout;
let loadVersion = 0;
let loadController;
let authVersion = 0;
let connecting = false;

function node(name, className, text) {
  const element = H(name);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function github(path, { method = "GET", payload, token = state.token, signal } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers.Authorization = "Bearer " + token;
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(ROOT + path, {
    method, headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: "no-store", signal
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error("GitHub returned an unreadable response."); }
  if (!response.ok) {
    const message = data?.message || response.statusText || "GitHub API request failed";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function decodeBase64(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let position = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (position < items.length) {
      const index = position++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function notice(message, error = false) {
  const element = $("notice");
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle("error", error);
}

function describeError(error, token = state.token) {
  if (!token && (error.status === 404 || error.status === 401)) {
    return "The repository is private. Connect GitHub to load your tasks.";
  }
  if (error.status === 401) return "Invalid token. Check your GitHub access token.";
  if (error.status === 403) return "GitHub denied access. Check repository permissions and API rate limits.";
  if (error.status === 409 || error.status === 422) {
    return "Your task changed elsewhere, or the repository moved. Refresh before retrying.";
  }
  return error.message || "Unexpected error.";
}

function invalidateLoad() {
  loadVersion++;
  loadController?.abort();
  loadController = null;
  state.loading = false;
  updateControls();
}

async function loadTasks({ token = state.token, authenticate = false } = {}) {
  invalidateLoad();
  const version = loadVersion;
  const controller = new AbortController();
  loadController = controller;
  const options = { token, signal: controller.signal };
  state.loading = true;
  updateControls();
  notice("Loading tasks from GitHub…");
  try {
    const tree = await github("/git/trees/" + BRANCH + "?recursive=1", options);
    if (tree.truncated) throw new Error("Repository tree is too large for this board to load safely.");
    const files = (tree.tree || []).filter(entry =>
      entry.type === "blob" && /^tasks\/[A-Za-z0-9_-]+\.md$/.test(entry.path)
    );
    const tasks = await mapLimited(files, 6, async entry => {
      const blob = await github("/git/blobs/" + encodeURIComponent(entry.sha), options);
      if (blob.encoding !== "base64") throw new Error("Unsupported encoding: " + entry.path);
      return { ...parseTask(decodeBase64(blob.content), entry.path), sha: entry.sha };
    });
    if (version !== loadVersion) return false;
    if (authenticate) state.token = token;
    state.tasks = sortTasks(tasks);
    state.loaded = true;
    notice(state.token ? "" : "Read-only mode. Connect GitHub to create or change tasks.");
    render();
    return true;
  } catch (error) {
    if (version !== loadVersion) return false;
    throw error;
  } finally {
    if (version === loadVersion) {
      loadController = null;
      state.loading = false;
      updateControls();
    }
  }
}

function renderConnection() {
  $("connection-indicator").classList.toggle("connected", !!state.token);
  $("connection-label").textContent = state.token ? "Connected" : state.loaded ? "Read-only" : "Not connected";
  $("connect-btn").textContent = state.token ? "Disconnect" : "Connect GitHub";
}

function renderStats() {
  const loaded = state.loaded;
  const active = state.tasks.filter(task => task.status === "active").length;
  const done = state.tasks.filter(task => task.status === "done").length;
  const review = state.tasks.filter(isReviewPr).length;
  $("active-count").textContent = loaded ? String(active) : "—";
  $("done-count").textContent = loaded ? String(done) : "—";
  $("review-count").textContent = loaded ? String(review) : "—";
  $("review-metric").classList.toggle("over-limit", review >= 3);
  $("review-metric").title = "Counts only linked PR tasks in Review on this board, not every open GitHub PR.";
  $("total-count").textContent = loaded ? state.tasks.length + (state.tasks.length === 1 ? " task" : " tasks") : "— tasks";
  const parked = state.tasks.filter(task => task.status === "parked").length;
  document.querySelector(".parked-toggle span").textContent = parked ? "Show parked (" + parked + ")" : "Show parked";
}

function renderProjects() {
  const projects = [...new Set(state.tasks.map(task => task.project))].sort((a, b) => a.localeCompare(b));
  const filter = $("project-filter");
  const selected = filter.value;
  filter.replaceChildren(new Option("All projects", ""), ...projects.map(project => new Option(project, project)));
  filter.value = projects.includes(selected) ? selected : "";
  $("project-suggestions").replaceChildren(...projects.map(project => {
    const option = H("option");
    option.value = project;
    return option;
  }));
}

function createCard(task) {
  const card = node("article", "task-card");
  card.tabIndex = 0;
  card.draggable = !!state.token;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", "Edit " + task.title + ", " + task.status);
  const top = node("div", "card-overline");
  const project = node("span", "project-pill", task.project);
  project.title = task.project;
  const priority = node("span", "priority " + task.priority, task.priority);
  top.append(project, priority);
  card.append(top, node("h4", "card-title", task.title));
  if (task.description) card.append(node("p", "card-description", task.description));
  const footer = node("div", "card-footer");
  footer.append(node("span", "card-id", task.id.slice(-8)));
  if (task.url) {
    const link = node("a", "", "View issue / PR ↗");
    link.href = task.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.addEventListener("click", event => event.stopPropagation());
    footer.append(link);
  } else {
    footer.append(node("span", "", "Open details →"));
  }
  card.append(footer);
  card.addEventListener("click", () => openTask(task));
  card.addEventListener("keydown", event => {
    if (event.target !== card) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTask(task);
    }
  });
  card.addEventListener("dragstart", event => {
    if (!state.token || state.saving) { event.preventDefault(); return; }
    state.dragging = task.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => {
    state.dragging = null;
    card.classList.remove("dragging");
    document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
  });
  return card;
}

function createColumn(column, tasks) {
  const section = node("section", "kanban-column");
  section.dataset.status = column.id;
  section.setAttribute("aria-label", column.label + " (" + tasks.length + " tasks)");
  const heading = node("div", "column-heading");
  const row = node("div", "column-topline");
  row.append(
    node("span", "column-indicator " + column.id),
    node("h3", "", column.label),
    node("span", "column-count", String(tasks.length))
  );
  heading.append(row, node("p", "column-description", column.description));
  const items = node("div", "column-cards");
  if (tasks.length === 0) {
    const empty = node("div", "empty-column");
    empty.append(node("strong", "", "＋"), node("span", "", "Drop a task here"));
    items.append(empty);
  } else {
    sortTasks(tasks).forEach(task => items.append(createCard(task)));
  }
  section.append(heading, items);
  section.addEventListener("dragover", event => {
    if (!state.dragging || state.saving) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    section.classList.add("drag-over");
  });
  section.addEventListener("dragleave", event => {
    if (!section.contains(event.relatedTarget)) section.classList.remove("drag-over");
  });
  section.addEventListener("drop", async event => {
    event.preventDefault();
    section.classList.remove("drag-over");
    const id = state.dragging;
    state.dragging = null;
    const task = state.tasks.find(item => item.id === id);
    if (!task || task.status === column.id || state.saving) return;
    try { await saveTask({ ...task, status: column.id }, task); }
    catch (error) { showToast(describeError(error), true); }
  });
  return section;
}

function renderBoard() {
  const query = $("search-input").value.trim().toLocaleLowerCase();
  const project = $("project-filter").value;
  const showParked = $("show-parked").checked;
  const filtered = state.tasks.filter(task =>
    (!project || task.project === project) &&
    (!query || [task.title, task.project, task.description, task.id].some(text => text.toLocaleLowerCase().includes(query)))
  );
  const board = $("board");
  board.classList.toggle("show-parked", showParked);
  const columns = showParked ? COLUMNS : COLUMNS.filter(column => column.id !== "parked");
  board.replaceChildren(...columns.map(column =>
    createColumn(column, filtered.filter(task => task.status === column.id))
  ));
}

function render() {
  renderConnection();
  renderStats();
  renderProjects();
  renderBoard();
}

function showToast(message, error = false) {
  clearTimeout(toastTimeout);
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("visible");
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4400);
}

function setSaving(value) {
  state.saving = value;
  updateControls();
}

function updateControls() {
  $("task-submit").disabled = state.saving;
  $("new-task-btn").disabled = state.saving;
  $("refresh-btn").disabled = state.saving || state.loading;
  $("connect-btn").disabled = state.saving;
  document.querySelectorAll('[data-close="task-dialog"]').forEach(button => {
    button.disabled = state.saving;
  });
  document.querySelectorAll("#task-form input, #task-form select, #task-form textarea").forEach(field => {
    field.disabled = state.saving;
  });
}

function taskPath(task) {
  return "tasks/" + task.id + ".md";
}

async function saveTask(nextInput, previous = null) {
  if (!state.token) {
    throw new Error("Connect GitHub to save changes.");
  }
  if (state.saving) throw new Error("Another change is already being saved.");
  const next = validateTask(nextInput);
  if (previous && identicalTask(next, previous)) return false;
  const newStatus = previous && previous.status !== next.status;
  const onlyStatus = newStatus && identicalTask({ ...next, status: previous.status }, previous);
  const message = !previous
    ? "task: create " + next.id
    : onlyStatus
      ? "board: move " + next.id + " to " + next.status
      : "task: update " + next.id;
  const path = taskPath(next);
  const payload = {
    message,
    content: encodeBase64(formatTask(next)),
    branch: BRANCH
  };
  if (previous) payload.sha = previous.sha;
  // A refresh begun before this write must never replace its result.
  invalidateLoad();
  notice("");
  setSaving(true);
  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const result = await github("/contents/" + encodedPath, { method: "PUT", payload });
    const updated = { ...next, path, sha: result.content?.sha };
    if (!updated.sha) throw new Error("GitHub did not return the updated file SHA. Reload to continue.");
    if (previous) {
      state.tasks = state.tasks.map(task => task.id === previous.id ? updated : task);
    } else {
      state.tasks = [...state.tasks, updated];
    }
    state.tasks = sortTasks(state.tasks);
    render();
    showToast("Committed: " + message);
    return true;
  } finally {
    setSaving(false);
  }
}

function openTask(task = null) {
  if (state.saving) return;
  state.editing = task;
  $("task-dialog-eyebrow").textContent = task ? "EDIT WORK ITEM" : "NEW WORK ITEM";
  $("task-dialog-title").textContent = task ? "Edit task" : "Create task";
  $("task-submit").textContent = task ? "Save changes" : "Create task";
  $("task-error").textContent = "";
  $("commit-hint").textContent = "Each change creates one commit on main.";
  const form = $("task-form");
  form.reset();
  for (const key of ["title", "project", "priority", "status", "url", "description"]) {
    if (task) form.elements.namedItem(key).value = task[key] || "";
  }
  $("task-dialog").showModal();
  form.elements.namedItem("title").focus();
}

async function submitTask(event) {
  event.preventDefault();
  const form = $("task-form");
  const fields = Object.fromEntries(new FormData(form).entries());
  const previous = state.editing;
  const input = { ...fields, id: previous?.id || createTaskId() };
  $("task-error").textContent = "";
  try {
    const saved = await saveTask(input, previous);
    $("task-dialog").close();
    if (!saved) showToast("No changes to commit.");
  } catch (error) {
    $("task-error").textContent = describeError(error);
  }
}

async function connect(event) {
  event.preventDefault();
  if (connecting) return;
  const next = $("token-input").value.trim();
  if (!next) return;
  const version = ++authVersion;
  connecting = true;
  $("token-input").value = "";
  $("auth-error").textContent = "";
  $("auth-submit").disabled = true;
  try {
    const loaded = await loadTasks({ token: next, authenticate: true });
    if (!loaded || version !== authVersion) return;
    connecting = false;
    $("auth-dialog").close();
    showToast("GitHub connected. Changes will commit to main.");
  } catch (error) {
    if (version !== authVersion) return;
    $("auth-error").textContent = describeError(error, next);
    notice("Connection failed. Check repository access.", true);
    renderConnection();
  } finally {
    if (version === authVersion) {
      connecting = false;
      $("auth-submit").disabled = false;
    }
  }
}

function cancelConnection() {
  $("token-input").value = "";
  if (!connecting) return;
  authVersion++;
  connecting = false;
  invalidateLoad();
  $("auth-submit").disabled = false;
  notice("Connection canceled. Token discarded from memory.");
}

function closeDialog(dialog) {
  if (dialog.id === "task-dialog" && state.saving) return;
  if (dialog.id === "auth-dialog") cancelConnection();
  dialog.close();
}

function disconnect() {
  if (state.saving) return;
  invalidateLoad();
  state.token = "";
  state.tasks = [];
  state.loaded = false;
  state.editing = null;
  state.dragging = null;
  $("task-form").reset();
  render();
  notice("Disconnected. Token discarded from memory.");
  showToast("Disconnected from GitHub.");
}

function init() {
  $("auth-form").addEventListener("submit", connect);
  $("task-form").addEventListener("submit", submitTask);
  $("connect-btn").addEventListener("click", () => {
    if (state.saving) return;
    if (state.token) {
      disconnect();
      return;
    }
    $("auth-error").textContent = "";
    $("auth-dialog").showModal();
    $("token-input").focus();
  });
  $("new-task-btn").addEventListener("click", () => {
    if (!state.token) { $("auth-dialog").showModal(); return; }
    openTask();
  });
  $("refresh-btn").addEventListener("click", () => {
    if (state.saving) return;
    loadTasks().catch(error => notice(describeError(error), true));
  });
  $("search-input").addEventListener("input", renderBoard);
  $("project-filter").addEventListener("change", renderBoard);
  $("show-parked").addEventListener("change", renderBoard);
  document.querySelectorAll("[data-close]").forEach(button =>
    button.addEventListener("click", () => closeDialog($(button.dataset.close)))
  );
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", event => {
      if (event.target === dialog) closeDialog(dialog);
    });
    dialog.addEventListener("cancel", event => {
      if (dialog.id === "task-dialog" && state.saving) event.preventDefault();
      if (dialog.id === "auth-dialog") cancelConnection();
    });
  }
  $("auth-dialog").addEventListener("close", cancelConnection);
  render();
  loadTasks().catch(error => notice(describeError(error), true));
}

init();


