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

// Locate the one live top-level block while preserving every byte outside it.
// Nested documentation examples are not editable publishing metadata.
function publishingBlock(description) {
  const source = String(description || "");
  let fence = null, publishing = false, malformed = false, count = 0;
  let offset = 0, start = 0;
  const blocks = [];
  for (const rawLine of source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []) {
    const line = rawLine.replace(/(?:\r\n|\r|\n)$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        if (publishing) blocks.push({ start, end: offset, raw: source.slice(start, offset) });
        fence = null; publishing = false;
      }
    } else if (marker) {
      fence = marker[1];
      if (marker[2].trim().startsWith("work-publish")) {
        count++;
        publishing = marker[1][0] === "`" && marker[2].trim() === "work-publish";
        if (!publishing) malformed = true;
        start = offset + rawLine.length;
      }
    }
    offset += rawLine.length;
  }
  if (!count) return null;
  return malformed || count !== 1 || blocks.length !== 1 ? { invalid: true } : blocks[0];
}

// Optional publishing metadata lives in the Markdown body, not the strict
// front matter. Older clients can still read, edit and round-trip these cards.
export function publishingInfo(task, now = Date.now()) {
  const invalid = { state: "invalid", label: "Check publishing metadata", channel: "", due: "" };
  const block = publishingBlock(task.description);
  if (!block) return null;
  if (block.invalid) return invalid;
  try {
    const data = JSON.parse(block.raw);
    const keys = ["version", "channel", "state", "due", "published_url"];
    if (!data || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key)) ||
        data.version !== 1 || typeof data.channel !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(data.channel) ||
        !["draft", "ready", "scheduled", "published", "hold"].includes(data.state)) return invalid;
    const due = data.due ?? "";
    // Require a real calendar date and an explicit offset. Never guess a zone.
    const date = typeof due === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(due);
    if (due && (!date || !Number.isFinite(Date.parse(due)) ||
        +date[2] < 1 || +date[2] > 12 || +date[3] < 1 ||
        +date[3] > new Date(Date.UTC(+date[1], +date[2], 0)).getUTCDate() ||
        +date[4] > 23 || +date[5] > 59 || +date[6] > 59)) return invalid;
    if (typeof due !== "string" || (data.published_url != null && typeof data.published_url !== "string")) return invalid;
    const publishedUrl = safeUrl(data.published_url);
    if (data.state === "scheduled" && !due) return invalid;
    if (data.state === "published" && !publishedUrl) return invalid;
    let state = data.state;
    if (task.status === "parked" || state === "hold") state = "hold";
    else if (task.status === "done" && state !== "published") state = "closed";
    else if (state === "scheduled" && Date.parse(due) <= now) state = "verify";
    else if (["draft", "ready"].includes(state) && due && Date.parse(due) <= now) state = "overdue";
    const labels = { draft: "Preparing", ready: "Ready", scheduled: "Scheduled", published: "Published",
      hold: "On hold", closed: "Done · user-reported", overdue: "Overdue", verify: "Needs verification" };
    return { state, label: labels[state], channel: data.channel, due, publishedUrl, declaredState: data.state };
  } catch { return invalid; }
}

// Exactly one obvious next step. These actions only update the private board.
export function quickAction(task, now = Date.now()) {
  if (["done", "parked"].includes(task.status)) return null;
  const info = publishingInfo(task, now);
  if (info) {
    if (["invalid", "hold", "published", "closed"].includes(info.state)) return null;
    if (info.declaredState === "draft") return { id: "ready", label: "Mark ready" };
    if (["ready", "scheduled"].includes(info.declaredState)) return { id: "complete", label: "Mark complete" };
    return null;
  }
  return {
    backlog: { id: "start", label: "Start" },
    active: { id: "review", label: "Move to review" },
    review: { id: "complete", label: "Mark done" }
  }[task.status] || null;
}

export function applyQuickAction(task, action, now = Date.now()) {
  if (quickAction(task, now)?.id !== action) throw new Error("This action no longer matches the task. Refresh and review its current state.");
  if (action === "ready") {
    const block = publishingBlock(task.description);
    const metadata = { ...JSON.parse(block.raw), state: "ready" };
    const newline = /\r\n|\r|\n/.exec(block.raw)?.[0] || "\n";
    return validateTask({ ...task, description: task.description.slice(0, block.start)
      + JSON.stringify(metadata) + newline + task.description.slice(block.end) });
  }
  // No permalink is invented and existing publishing metadata is unchanged.
  // done + non-published means closed, not independently verified publication.
  const status = { start: "active", review: "review", complete: "done" }[action];
  return validateTask({ ...task, status });
}

export function publishingMatches(task, filter = "", channel = "", now = Date.now()) {
  const info = publishingInfo(task, now);
  return Boolean((!channel || info?.channel === channel) &&
    (!filter || (info && (filter === "all" || info.state === filter ||
      (filter === "upload-ready" && publishingGroup(task, now) === "upload-ready")))));
}

export const PUBLISHING_COLUMNS = [
  { id: "upload-ready", label: "Upload Ready", description: "Prepared for manual publishing; not posting approval" },
  { id: "verify", label: "Needs verification", description: "Scheduled time passed; check the actual result" },
  { id: "preparing", label: "Preparing", description: "Not yet ready, including overdue drafts" },
  { id: "scheduled", label: "Scheduled", description: "Recorded schedule; publication is not assumed" },
  { id: "published", label: "Published", description: "Recorded publication receipt" },
  { id: "hold", label: "Done / On hold", description: "Completed without a publication claim, paused or parked" },
  { id: "invalid", label: "Check metadata", description: "Correct the publishing block before continuing" }
];

export function publishingGroup(task, now = Date.now()) {
  const info = publishingInfo(task, now);
  if (!info) return null;
  if (["hold", "closed"].includes(info.state)) return "hold";
  if (["ready", "overdue"].includes(info.state) && info.declaredState === "ready") return "upload-ready";
  if (info.declaredState === "draft") return "preparing";
  return info.state;
}

export function createPublishingTracker() {
  return { initialized: false, previous: new Map(), seen: new Set() };
}

// Session-local only. First snapshot establishes the ready baseline; overdue
// and unverified scheduled items may alert once immediately. No titles leave
// the page in notification text. Changed due dates get a new alert identity.
export function publishingAlerts(tasks, tracker, now = Date.now()) {
  const events = [], next = new Map();
  for (const task of tasks) {
    const info = publishingInfo(task, now);
    if (!info) continue;
    next.set(task.id, info.state);
    const kind = info.state;
    const readyTransition = kind === "ready" && tracker.initialized && tracker.previous.get(task.id) !== "ready";
    if (!readyTransition && kind !== "overdue" && kind !== "verify") continue;
    const key = JSON.stringify([task.id, info.channel, kind, info.due]);
    if (tracker.seen.has(key)) continue;
    tracker.seen.add(key);
    events.push({ id: task.id, kind });
  }
  tracker.previous = next;
  tracker.initialized = true;
  return events;
}

// A conservative Markdown subset for the read-only task view. All user-provided
// markup is escaped first; links must be credential-free HTTPS URLs.
function escapeMarkdownHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function taskInline(text) {
  function decorate(value) {
    return String(value).split(/(\x60[^\x60 \n][^\x60\n]*\x60)/g).map(part => {
      if (part.startsWith("\x60") && part.endsWith("\x60") && part.length > 2) {
        return "<code>" + escapeMarkdownHtml(part.slice(1, -1)) + "</code>";
      }
      return escapeMarkdownHtml(part)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    }).join("");
  }

  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https:\/\/[^\s<>()]+)/g;
  let result = "", cursor = 0, match;
  while ((match = linkPattern.exec(text)) !== null) {
    result += decorate(text.slice(cursor, match.index));
    const label = match[1];
    let address = match[2] || match[3];
    let suffix = "";
    if (!label) {
      const trimmed = address.replace(/[.,;!?]+$/, "");
      suffix = address.slice(trimmed.length);
      address = trimmed;
    }
    try {
      const url = safeUrl(address);
      if (!url) throw new Error("Empty link");
      result += '<a href="' + escapeMarkdownHtml(url) +
        '" target="_blank" rel="noopener noreferrer">' +
        decorate(label || address) + "</a>" + decorate(suffix);
    } catch {
      result += decorate(match[0]);
    }
    cursor = linkPattern.lastIndex;
  }
  return result + decorate(text.slice(cursor));
}

export function renderTaskMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [], paragraph = [], quote = [];
  let list = "", code = [], fenced = false;

  function flushParagraph() {
    if (paragraph.length) {
      html.push("<p>" + taskInline(paragraph.join(" ")) + "</p>");
      paragraph.length = 0;
    }
  }
  function flushList() {
    if (list) { html.push("</" + list + ">"); list = ""; }
  }
  function flushQuote() {
    if (quote.length) {
      html.push("<blockquote><p>" + taskInline(quote.join(" ")) + "</p></blockquote>");
      quote.length = 0;
    }
  }
  function flush() { flushParagraph(); flushList(); flushQuote(); }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("\x60\x60\x60")) {
      if (fenced) {
        html.push("<pre><code>" + escapeMarkdownHtml(code.join("\n")) + "</code></pre>");
        code = [];
        fenced = false;
      } else {
        flush();
        fenced = true;
      }
      continue;
    }
    if (fenced) { code.push(line); continue; }
    if (!trimmed) { flush(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.max(2, heading[1].length);
      html.push("<h" + level + ">" + taskInline(heading[2]) + "</h" + level + ">");
      continue;
    }
    if (/^---+$/.test(trimmed)) { flush(); html.push("<hr>"); continue; }
    if (/^>\s?/.test(trimmed)) {
      flushParagraph(); flushList();
      quote.push(trimmed.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();
    const item = /^([-*]|\d+\.)\s+(.+)$/.exec(trimmed);
    if (item) {
      flushParagraph();
      const type = /^\d/.test(item[1]) ? "ol" : "ul";
      if (list !== type) { flushList(); list = type; html.push("<" + type + ">"); }
      const checked = /^\[([ xX])\]\s+(.+)$/.exec(item[2]);
      if (checked) {
        const mark = checked[1].toLowerCase() === "x" ? "☑" : "☐";
        html.push('<li><span aria-label="' + (mark === "☑" ? "Checked" : "Unchecked") +
          '">' + mark + "</span> " + taskInline(checked[2]) + "</li>");
      } else {
        html.push("<li>" + taskInline(item[2]) + "</li>");
      }
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flush();
  if (fenced) html.push("<pre><code>" + escapeMarkdownHtml(code.join("\n")) + "</code></pre>");
  return html.join("\n");
}
