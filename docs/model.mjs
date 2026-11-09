export const STATUS_ORDER = ["backlog", "active", "review", "done", "parked"];
export const COLUMNS = [
  { id: "backlog", label: "Backlog", description: "Worth doing, not yet started" },
  { id: "active", label: "Active", description: "Work deliberately in progress" },
  { id: "review", label: "Review", description: "Waiting on human judgment" },
  { id: "done", label: "Done", description: "Integrated and complete" },
  { id: "parked", label: "Parked", description: "Explicitly deferred" }
];
export const PRIORITIES = ["P0", "P1", "P2"];
const FIELDS = ["id", "title", "project", "status", "priority", "url"];
const ID_PATTERN = /^[A-Za-z0-9_-]{4,100}$/;

export function safeUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); } catch { throw new Error("Related link must be a valid HTTPS URL."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Related link must be a valid HTTPS URL without credentials.");
  }
  return url.href;
}

export function validateTask(input) {
  const task = {
    id: String(input.id ?? "").trim(),
    title: String(input.title ?? "").trim(),
    project: String(input.project ?? "").trim(),
    status: String(input.status ?? "").trim(),
    priority: String(input.priority ?? "").trim(),
    url: safeUrl(input.url),
    description: String(input.description ?? "").trim()
  };
  if (!ID_PATTERN.test(task.id)) throw new Error("Invalid task identifier.");
  if (!task.title || task.title.length > 180) throw new Error("Title must contain 1–180 characters.");
  if (!task.project || task.project.length > 80) throw new Error("Project must contain 1–80 characters.");
  if (!STATUS_ORDER.includes(task.status)) throw new Error("Invalid status.");
  if (!PRIORITIES.includes(task.priority)) throw new Error("Invalid priority.");
  if (task.description.length > 20000) throw new Error("Description is too long.");
  return task;
}

export function formatTask(input) {
  const task = validateTask(input);
  const header = FIELDS.map(key => key + ": " + JSON.stringify(task[key])).join("\n");
  return "---\n" + header + "\n---\n\n" + task.description + "\n";
}

export function parseTask(source, path = "") {
  const match = String(source).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) throw new Error("Missing task front matter in " + path);
  const fields = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = line.match(/^([a-z]+):\s*(.*)$/);
    if (!entry || !FIELDS.includes(entry[1]) || Object.hasOwn(fields, entry[1])) {
      throw new Error("Unsupported or duplicate task field in " + path);
    }
    try {
      const decoded = JSON.parse(entry[2]);
      if (typeof decoded !== "string") throw new Error("Not a string");
      fields[entry[1]] = decoded;
    } catch {
      throw new Error("Task values must be JSON-quoted strings in " + path);
    }
  }
  const task = validateTask({ ...fields, description: match[2] });
  if (path && path !== "tasks/" + task.id + ".md") {
    throw new Error("Task identifier does not match filename: " + path);
  }
  return { ...task, path: path || "tasks/" + task.id + ".md" };
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) =>
    PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id)
  );
}

export function isReviewPr(task) {
  return task.status === "review" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?(?:[?#].*)?$/.test(task.url);
}

export function createTaskId() {
  return "t-" + crypto.randomUUID();
}

export function identicalTask(a, b) {
  return [...FIELDS, "description"].every(key => String(a[key] ?? "") === String(b[key] ?? ""));
}

