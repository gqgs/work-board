import {
  COLUMNS, createTaskId, formatTask, identicalTask, isReviewPr,
  parseTask, sortTasks, validateTask, renderTaskMarkdown,
  publishingInfo, publishingMatches, publishingGroup, PUBLISHING_COLUMNS,
  createPublishingTracker, publishingAlerts, quickAction, applyQuickAction, canAddPostLink, addPostLink, displayDescription
} from "./model.mjs";

const REPO = "gqgs/work";
const BRANCH = "main";
const ROOT = "https://api.github.com/repos/" + REPO;
const NOTIFICATION_ICON = "./assets/eigendynamics-icon.png";
const state = { token: "", tasks: [], loaded: false, loading: false, saving: false, editing: null, viewing: null, receipt: null, dragging: null };
const $ = id => document.getElementById(id);
const H = name => document.createElement(name);
let toastTimeout;
let loadVersion = 0;
let loadController;
let authVersion = 0;
let connecting = false;
let pollTimer;
let lastChecked = 0;
let notificationsEnabled = false;
let notificationRequest = false;
let notificationVersion = 0;
let publishingTracker = createPublishingTracker();
const openNotifications = new Set();
let latestTestNotification;
let quickActionsBlocked = false;

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
      const cached = state.tasks.find(task => task.path === entry.path && task.sha === entry.sha);
      if (cached && token === state.token) return cached;
      const blob = await github("/git/blobs/" + encodeURIComponent(entry.sha), options);
      if (blob.encoding !== "base64") throw new Error("Unsupported encoding: " + entry.path);
      return { ...parseTask(decodeBase64(blob.content), entry.path), sha: entry.sha };
    });
    if (version !== loadVersion) return false;
    if (authenticate) state.token = token;
    state.tasks = sortTasks(tasks);
    state.loaded = true;
    quickActionsBlocked = false;
    lastChecked = Date.now();
    notice(state.token ? "" : "Read-only mode. Connect GitHub to create or change tasks.");
    render();
    checkPublishingAlerts();
    schedulePoll();
    return true;
  } catch (error) {
    if (version !== loadVersion) return false;
    lastChecked = 0;
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
  const loaded = state.loaded && !!state.token && !state.loading;
  const active = state.tasks.filter(task => task.status === "active").length;
  const done = state.tasks.filter(task => task.status === "done").length;
  const review = state.tasks.filter(isReviewPr).length;
  $("active-count").textContent = loaded ? String(active) : "—";
  $("done-count").textContent = loaded ? String(done) : "—";
  $("review-count").textContent = loaded ? String(review) : "—";
  $("review-limit").hidden = !loaded;
  $("review-metric").classList.toggle("over-limit", loaded && review >= 3);
  $("review-metric").title = "Counts only linked PR tasks in Review on this board, not every open GitHub PR.";
  $("total-count").textContent = loaded ? state.tasks.length + (state.tasks.length === 1 ? " task" : " tasks") : "— tasks";
  const parked = state.tasks.filter(task => task.status === "parked").length;
  document.querySelector(".parked-toggle span").textContent = loaded && parked ? "Show parked (" + parked + ")" : "Show parked";
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
  const channels = [...new Set(state.tasks.map(task => publishingInfo(task)?.channel).filter(Boolean))].sort();
  const channelFilter = $("channel-filter");
  const selectedChannel = channelFilter.value;
  channelFilter.replaceChildren(new Option("All channels", ""), ...channels.map(channel => new Option(channel, channel)));
  channelFilter.value = channels.includes(selectedChannel) ? selectedChannel : "";
}

function createCard(task, draggable = true) {
  const card = node("article", "task-card");
  card.draggable = draggable && !!state.token;
  card.dataset.taskId = task.id;
  card.setAttribute("aria-label", task.title + ", " + (publishingInfo(task)?.label || task.status));
  const top = node("div", "card-overline");
  const project = node("span", "project-pill", task.project);
  project.title = task.project;
  const priority = node("span", "priority " + task.priority, task.priority);
  top.append(project, priority);
  card.append(top, node("h4", "card-title", task.title));
  const publishing = publishingInfo(task);
  if (publishing) {
    card.append(node("p", "publishing-badge " + publishing.state,
      [publishing.channel, publishing.label].filter(Boolean).join(" · ")));
    if (publishing.due) card.append(node("p", "publishing-date", formatPublishingDate(publishing.due)));
    if (publishing.publishedUrl) {
      const receipt = node("a", "publishing-date", "Publication receipt ↗");
      receipt.href = publishing.publishedUrl;
      receipt.target = "_blank";
      receipt.rel = "noopener noreferrer";
      receipt.addEventListener("click", event => event.stopPropagation());
      card.append(receipt);
    }
  }
  const description = displayDescription(task);
  if (description) card.append(node("p", "card-description", description));
  const footer = node("div", "card-footer");
  footer.append(node("span", "card-id", task.id.slice(-8)));
  const details = node("button", "card-details", "Details →");
  details.type = "button";
  details.setAttribute("aria-label", "Read details for " + task.title);
  details.addEventListener("click", event => { event.stopPropagation(); viewTask(task); });
  footer.append(details);
  if (task.url) {
    const link = node("a", "", "Link ↗");
    link.href = task.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.addEventListener("click", event => event.stopPropagation());
    footer.append(link);
  }
  card.append(footer);
  const action = canAddPostLink(task) ? { id: "post-link", label: "Add post link" } : quickAction(task);
  if (action && state.token) {
    const button = node("button", "card-action", action.label);
    button.type = "button";
    button.dataset.taskId = task.id;
    button.setAttribute("aria-label", action.label + ": " + task.title);
    button.disabled = state.saving || state.loading || !state.loaded || quickActionsBlocked;
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (action.id === "post-link") openPostLink(task);
      else performQuickAction(task, action.id);
    });
    card.append(button);
  }
  card.addEventListener("click", () => viewTask(task));
  card.addEventListener("dragstart", event => {
    if (!draggable || !state.token || state.saving || event.target.closest?.("button, a")) { event.preventDefault(); return; }
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

async function performQuickAction(previous, action) {
  if (!state.token || !state.loaded || state.saving || state.loading || quickActionsBlocked) return;
  const current = state.tasks.find(task => task.id === previous.id);
  if (!current || current.sha !== previous.sha || !identicalTask(current, previous)) {
    render();
    showToast("Task changed. Review its current state before trying again.", true);
    return;
  }
  try {
    if (quickAction(current)?.id !== action) return;
    const next = applyQuickAction(current, action);
    await saveTask(next, current);
    const publication = publishingInfo(next);
    if (action === "complete" && publication) {
      showToast("Marked complete on this board. No publication was verified.");
    }
    const control = document.querySelector('[data-task-id="' + current.id + '"] .card-details');
    (control || $("publishing-filter")).focus();
  } catch (error) {
    // A failed response may follow a successful commit. Reconcile, never replay.
    quickActionsBlocked = true;
    updateControls();
    try {
      const loaded = await loadTasks();
      if (!loaded || !state.token) return;
      showToast(describeError(error) + " Board refreshed; review the current state before retrying.", true);
    } catch {
      notice("Could not verify the save result. Refresh successfully before retrying a quick action.", true);
      showToast("Quick actions paused until a successful refresh. No automatic retry was sent.", true);
    }
    updateControls();
  }
}

function resetPostLink() {
  state.receipt = null;
  $("post-link-input").value = "";
  $("post-link-task").textContent = "";
  $("post-link-error").textContent = "";
}

function openPostLink(previous) {
  if (!state.token || !state.loaded || state.saving || state.loading || quickActionsBlocked) return;
  const current = state.tasks.find(task => task.id === previous.id);
  if (!current || current.sha !== previous.sha || !identicalTask(current, previous) || !canAddPostLink(current)) {
    showToast("Task changed or already has a post link. Review its current state.", true);
    return;
  }
  resetPostLink();
  state.receipt = current;
  $("post-link-task").textContent = current.title;
  $("post-link-dialog").showModal();
  updateControls();
  $("post-link-input").focus();
}

async function submitPostLink(event) {
  event.preventDefault();
  if (!state.token || !state.receipt || state.saving || state.loading || quickActionsBlocked) return;
  const previous = state.receipt;
  const current = state.tasks.find(task => task.id === previous.id);
  if (!current || current.sha !== previous.sha || !identicalTask(current, previous)) {
    state.receipt = null;
    $("post-link-error").textContent = "Task changed. Close this form and review the current card before trying again.";
    updateControls();
    return;
  }
  let next;
  try { next = addPostLink(previous, $("post-link-input").value); }
  catch (error) { $("post-link-error").textContent = error.message; return; }
  $("post-link-error").textContent = "";
  try {
    await saveTask(next, previous);
    $("post-link-dialog").close();
    resetPostLink();
    showToast("Post link saved. No external publication was changed.");
    (document.querySelector('[data-task-id="' + previous.id + '"] .card-details') || $("publishing-filter")).focus();
  } catch (error) {
    // Never replay a write after a conflict or an ambiguous network response.
    state.receipt = null;
    quickActionsBlocked = true;
    updateControls();
    try {
      const loaded = await loadTasks();
      if (!loaded || !state.token) return;
      const refreshed = state.tasks.find(task => task.id === previous.id);
      if (publishingInfo(refreshed || {})?.publishedUrl) {
        $("post-link-dialog").close();
        resetPostLink();
        showToast("Board refreshed. A post link is already recorded; it was not overwritten.");
      } else {
        $("post-link-error").textContent = describeError(error) + " Board refreshed. Close this form, review the current card, and try Add post link again.";
      }
    } catch {
      $("post-link-error").textContent = "Could not verify the save result. Close this form and refresh successfully before retrying. No automatic retry was sent.";
    }
    updateControls();
  }
}

function createColumn(column, tasks, { publishing = false } = {}) {
  const section = node("section", "kanban-column");
  if (publishing) {
    section.classList.add("publishing-column");
    section.classList.toggle("upload-ready", column.id === "upload-ready");
    section.dataset.publishing = column.id;
  } else section.dataset.status = column.id;
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
    empty.append(node("strong", "", publishing ? "○" : "＋"), node("span", "", publishing ? "No matching items" : "Drop a task here"));
    items.append(empty);
  } else {
    const ordered = publishing ? sortTasks(tasks).sort((a, b) =>
      (Date.parse(publishingInfo(a)?.due) || Infinity) - (Date.parse(publishingInfo(b)?.due) || Infinity)) : sortTasks(tasks);
    ordered.forEach(task => items.append(createCard(task, !publishing)));
  }
  section.append(heading, items);
  if (publishing) return section; // Derived lane drops never write engineering statuses.
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
  const publishingFilter = $("publishing-filter").value;
  const channel = $("channel-filter").value;
  const filtered = state.tasks.filter(task =>
    (!project || task.project === project) &&
    publishingMatches(task, publishingFilter, channel) &&
    (!query || [task.title, task.project, task.description, task.id].some(text => text.toLocaleLowerCase().includes(query)))
  );
  const board = $("board");
  board.classList.toggle("publishing-view", !!publishingFilter);
  if (publishingFilter) {
    const groups = PUBLISHING_COLUMNS.map(column => ({ column,
      tasks: filtered.filter(task => publishingGroup(task) === column.id) }));
    const keepReadyLane = ["all", "upload-ready"].includes(publishingFilter);
    board.replaceChildren(...groups.filter(group => group.tasks.length || (keepReadyLane && group.column.id === "upload-ready"))
      .map(({ column, tasks }) => createColumn(column, tasks, { publishing: true })));
    if (!board.children.length) board.append(node("p", "empty-column", "No matching items"));
    return;
  }
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
  renderPublishingControls();
  if ($("view-dialog").open && state.viewing) {
    const current = state.tasks.find(task => task.id === state.viewing);
    if (current) renderTaskView(current);
    else $("view-dialog").close();
  }
}

function formatPublishingDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", dateStyle: "medium", timeStyle: "short"
  }).format(new Date(date)) + " · Brasília";
}

function renderPublishingControls() {
  const supported = typeof Notification !== "undefined" && globalThis.isSecureContext === true;
  const button = $("notifications-btn");
  button.disabled = !supported || !state.token || !state.loaded || state.loading || notificationRequest;
  button.textContent = !supported ? "System alerts unavailable" : notificationsEnabled ? "Pause tab alerts" : "Enable tab alerts";
  $("test-alert-btn").disabled = !state.token || !state.loaded || state.loading || notificationRequest;
  $("sync-status").textContent = !state.token ? "Connect to check publishing dates."
    : lastChecked ? "Last checked " + formatPublishingDate(lastChecked) + ". Refreshes every minute while connected."
    : "Not checked. Alerts wait for a successful refresh.";
}

function createBoardNotification(title, options) {
  // Branding is optional: a rejected icon must not prevent the alert itself.
  // No preflight requests, external assets, or retries after asynchronous errors.
  try {
    return new Notification(title, { ...options, icon: NOTIFICATION_ICON });
  } catch {
    return new Notification(title, options);
  }
}

function sendTestAlert() {
  const result = $("test-alert-result");
  if (!state.token || !state.loaded) { result.textContent = "Connect GitHub first. No test alert was sent."; return; }
  if (typeof Notification === "undefined" || globalThis.isSecureContext !== true) {
    result.textContent = "System notifications are unavailable in this browser or context. No test alert was sent."; return;
  }
  if (Notification.permission === "denied") {
    result.textContent = "Notifications are blocked for this site. Review the browser's site settings, then enable tab alerts."; return;
  }
  if (!notificationsEnabled || Notification.permission !== "granted") {
    result.textContent = "Choose Enable tab alerts first. This test does not request permission."; return;
  }
  try {
    if (latestTestNotification) {
      openNotifications.delete(latestTestNotification);
      latestTestNotification.close();
      latestTestNotification = null;
    }
    const notification = createBoardNotification("Work test alert", {
      body: "This is a test. No tasks were changed.", tag: "work-publishing-test", silent: true
    });
    latestTestNotification = notification;
    openNotifications.add(notification);
    notification.onclose = () => openNotifications.delete(notification);
    notification.onclick = () => { globalThis.focus?.(); notification.close(); };
    notification.onerror = () => {
      if (latestTestNotification === notification && openNotifications.has(notification)) result.textContent = "The browser reported that the test alert could not be displayed. Check system notification settings.";
    };
    result.textContent = "Browser accepted the test alert. Check your system notification center; this does not confirm it was displayed.";
  } catch {
    result.textContent = "The browser could not create the test alert. Check browser and system notification settings. No tasks were changed.";
  }
}

function checkPublishingAlerts() {
  if (!notificationsEnabled || !state.token || !state.loaded || !lastChecked) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    stopPublishingAlerts();
    return;
  }
  const events = publishingAlerts(state.tasks, publishingTracker);
  if (!events.length) return;
  const counts = kind => events.filter(event => event.kind === kind).length;
  const summary = [["ready", "newly ready"], ["overdue", "overdue"], ["verify", "need verification"]]
    .filter(([kind]) => counts(kind)).map(([kind, label]) => counts(kind) + " " + label).join("; ");
  try {
    const notification = createBoardNotification("Work publishing check", {
      body: summary + ". Open your private board for details.", tag: "work-publishing", silent: true
    });
    openNotifications.add(notification);
    notification.onclose = () => openNotifications.delete(notification);
    notification.onclick = () => { globalThis.focus?.(); notification.close(); };
  } catch {
    stopPublishingAlerts();
    showToast("System alerts unavailable here. Publishing filters still work.", true);
  }
}

function stopPublishingAlerts({ reset = false } = {}) {
  notificationVersion++;
  notificationsEnabled = false;
  notificationRequest = false;
  if (reset) publishingTracker = createPublishingTracker();
  if (reset) $("test-alert-result").textContent = "";
  for (const notification of openNotifications) notification.close();
  openNotifications.clear();
  latestTestNotification = null;
  renderPublishingControls();
}

async function togglePublishingAlerts() {
  if (notificationsEnabled) { stopPublishingAlerts(); return; }
  if (notificationRequest || !state.token || !state.loaded || state.loading ||
      typeof Notification === "undefined" || globalThis.isSecureContext !== true) return;
  const version = ++notificationVersion;
  notificationRequest = true;
  renderPublishingControls();
  try {
    // Called only by the explicit button click, never on page load or connect.
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission() : Notification.permission;
    if (version !== notificationVersion || !state.token) return;
    if (permission !== "granted") {
      showToast("System alerts are not allowed. Use publishing filters or your separate reminder.");
      return;
    }
    notificationsEnabled = true;
    publishingTracker.initialized = false;
    publishingTracker.previous.clear();
    await loadTasks();
  } catch (error) {
    if (version === notificationVersion) showToast(describeError(error), true);
  } finally {
    if (version === notificationVersion) {
      notificationRequest = false;
      renderPublishingControls();
    }
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (state.token) pollTimer = setTimeout(pollTasks, 60000);
}

async function pollTasks() {
  if (!state.token) return;
  try {
    // Do not interrupt a save, refresh, or the user's unsaved form.
    if (!state.saving && !state.loading && !$("task-dialog").open && !$("post-link-dialog").open) await loadTasks();
  } catch (error) { notice(describeError(error), true); }
  finally { schedulePoll(); renderPublishingControls(); }
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
  $("post-link-submit").disabled = state.saving || state.loading || !state.receipt || quickActionsBlocked;
  $("post-link-input").disabled = state.saving;
  document.querySelectorAll('[data-close="post-link-dialog"]').forEach(button => { button.disabled = state.saving; });
  document.querySelectorAll(".card-action").forEach(button => {
    button.disabled = !state.token || !state.loaded || state.saving || state.loading || quickActionsBlocked;
  });
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
  renderStats();
  renderPublishingControls();
}

function taskPath(task) {
  return "tasks/" + task.id + ".md";
}

async function saveTask(nextInput, previous = null) {
  if (!state.token) {
    throw new Error("Connect GitHub to save changes.");
  }
  if (state.saving) throw new Error("Another change is already being saved.");
  if (previous && !previous.sha) throw new Error("Task file SHA is missing. Refresh before changing it.");
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
    // Alerts wait for the next full refresh, not other potentially stale cards.
    showToast("Committed: " + message);
    return true;
  } finally {
    setSaving(false);
  }
}

function renderTaskView(task) {
  $("view-title").textContent = task.title;
  $("view-project").textContent = task.project;
  const publishing = publishingInfo(task);
  $("view-status").textContent = publishing?.label || COLUMNS.find(column => column.id === task.status)?.label || task.status;
  const priorities = { P0: "P0 · Urgent", P1: "P1 · Next", P2: "P2 · Later" };
  $("view-priority").textContent = priorities[task.priority] || task.priority;
  const description = displayDescription(task);
  $("view-description").innerHTML = description
    ? renderTaskMarkdown(description)
    : '<p class="empty-description">No description provided.</p>';
  $("view-related").hidden = !task.url;
  $("view-related-link").href = task.url || "";
  $("view-related-link").textContent = task.url || "";
  $("view-post").hidden = !publishing?.publishedUrl;
  $("view-post-link").href = publishing?.publishedUrl || "";
  $("view-post-link").textContent = publishing?.publishedUrl || "";
  $("view-reference").textContent = task.id;
  $("view-edit-btn").hidden = !state.token;
}

function viewTask(task) {
  if (state.saving) return;
  state.viewing = task.id;
  renderTaskView(task);
  $("view-dialog").showModal();
  $("view-dialog").scrollTop = 0;
}

function editViewedTask() {
  if (!state.token || state.saving || !state.viewing) return;
  const task = state.tasks.find(item => item.id === state.viewing);
  if (!task) return;
  $("view-dialog").close();
  openTask(task);
}

function openTask(task = null) {
  if (state.saving) return;
  state.editing = task;
  $("task-dialog-eyebrow").textContent = task ? "EDIT WORK ITEM" : "NEW WORK ITEM";
  $("task-dialog-title").textContent = task ? "Edit task" : "Create task";
  $("task-submit").textContent = task ? "Save changes" : "Create task";
  $("task-cancel-btn").textContent = task ? "Back to details" : "Cancel";
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
    if (previous) {
      const current = state.tasks.find(task => task.id === previous.id) || previous;
      viewTask(current);
    }
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
  if (["task-dialog", "post-link-dialog"].includes(dialog.id) && state.saving) return;
  if (dialog.id === "auth-dialog") cancelConnection();
  const previous = dialog.id === "task-dialog" && state.editing
    ? state.tasks.find(task => task.id === state.editing.id) : null;
  dialog.close();
  if (dialog.id === "post-link-dialog") resetPostLink();
  if (previous) viewTask(previous);
}

function disconnect() {
  if (state.saving) return;
  invalidateLoad();
  state.token = "";
  quickActionsBlocked = false;
  lastChecked = 0;
  clearTimeout(pollTimer);
  stopPublishingAlerts({ reset: true });
  state.tasks = [];
  state.loaded = false;
  state.editing = null;
  state.viewing = null;
  state.dragging = null;
  if ($("post-link-dialog").open) $("post-link-dialog").close();
  resetPostLink();
  if ($("view-dialog").open) $("view-dialog").close();
  if ($("task-dialog").open) $("task-dialog").close();
  for (const id of ["view-title", "view-project", "view-status", "view-priority", "view-reference", "view-related-link", "view-post-link"]) $(id).textContent = "";
  $("view-description").innerHTML = "";
  $("view-related-link").removeAttribute?.("href");
  $("view-post-link").removeAttribute?.("href");
  $("view-post").hidden = true;
  $("task-form").reset();
  render();
  notice("Disconnected. Token discarded from memory.");
  showToast("Disconnected from GitHub.");
}

function init() {
  $("post-link-form").addEventListener("submit", submitPostLink);
  $("post-link-dialog").addEventListener("close", resetPostLink);
  $("test-alert-btn").addEventListener("click", sendTestAlert);
  $("notifications-btn").addEventListener("click", togglePublishingAlerts);
  $("publishing-filter").addEventListener("change", renderBoard);
  $("channel-filter").addEventListener("change", renderBoard);
  $("auth-form").addEventListener("submit", connect);
  $("task-form").addEventListener("submit", submitTask);
  $("view-edit-btn").addEventListener("click", editViewedTask);
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
      if (["task-dialog", "post-link-dialog"].includes(dialog.id)) {
        event.preventDefault();
        if (!state.saving) closeDialog(dialog);
      }
      if (dialog.id === "auth-dialog") cancelConnection();
    });
  }
  $("auth-dialog").addEventListener("close", cancelConnection);
  render();
  loadTasks().catch(error => notice(describeError(error), true));
}

init();


