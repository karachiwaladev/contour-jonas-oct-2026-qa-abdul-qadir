// Task rules for the todo app: tags, dates, recurrence, flags and sort order. Pure functions, no DOM
// and no storage. Classic script (not a module): its declarations are globals that app.js uses.

// Comma-separated input → trimmed, lowercased, de-duplicated tags.
function parseTags(text) {
  const tags = (text || "").split(",").map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean);
  return [...new Set(tags)];
}

function toISO(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Today's date as YYYY-MM-DD in local time, matching <input type="date"> values.
function todayISO() {
  const d = new Date();
  return toISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// ---- Recurrence ----
// repeat = { every: 1..99, unit: "day" | "week" | "month" | "year", anchorDay?: 1..31 } or null.
// anchorDay keeps monthly/yearly tasks on their original day of the month: a task due on
// the 31st lands on the last day of shorter months, then returns to the 31st.

const REPEAT_UNITS = ["day", "week", "month", "year"];

// Builds a repeat rule from form values; null means "does not repeat".
function parseRepeat(unit, every, dueDate) {
  if (!REPEAT_UNITS.includes(unit)) return null;
  const n = Math.min(99, Math.max(1, Math.floor(Number(every)) || 1));
  const repeat = { every: n, unit };
  if ((unit === "month" || unit === "year") && dueDate) repeat.anchorDay = Number(dueDate.slice(8, 10));
  return repeat;
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

// One step of the schedule: dueDate + interval.
function addInterval(dueDate, repeat) {
  const [y, m, d] = dueDate.split("-").map(Number);
  if (repeat.unit === "day" || repeat.unit === "week") {
    const next = new Date(y, m - 1, d + repeat.every * (repeat.unit === "week" ? 7 : 1));
    return toISO(next.getFullYear(), next.getMonth() + 1, next.getDate());
  }
  const anchor = repeat.anchorDay || d;
  const months = repeat.unit === "month" ? repeat.every : repeat.every * 12;
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toISO(ny, nm, Math.min(anchor, daysInMonth(ny, nm)));
}

// Next occurrence after dueDate, following the schedule and skipping dates already in the past.
function nextDueDate(dueDate, repeat, today = todayISO()) {
  let next = addInterval(dueDate, repeat);
  while (next < today) next = addInterval(next, repeat);
  return next;
}

function repeatLabel(repeat) {
  return repeat.every === 1 ? `Every ${repeat.unit}` : `Every ${repeat.every} ${repeat.unit}s`;
}

// "overdue" | "due-today" | null. Completed tasks are never flagged.
function dueStatus(task, today = todayISO()) {
  if (task.done || !task.dueDate) return null;
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "due-today";
  return null;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---- Priority ----

const PRIORITIES = ["high", "medium", "low"]; // highest first: the index is the sort rank
const DEFAULT_PRIORITY = "medium";

// Any stored or form value → a known priority. Missing or unknown values are Medium.
function parsePriority(value) {
  return PRIORITIES.includes(value) ? value : DEFAULT_PRIORITY;
}

function priorityLabel(priority) {
  return priority[0].toUpperCase() + priority.slice(1);
}

// Tasks saved before due dates, tags, repeats and priorities existed lack those fields.
function normalize(task) {
  return {
    ...task, dueDate: task.dueDate || null, tags: Array.isArray(task.tags) ? task.tags : [],
    repeat: task.repeat || null, priority: parsePriority(task.priority),
  };
}

// Earliest due date first, undated tasks last; same date: higher priority first, then creation order.
function compareTasks(a, b) {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  const rank = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
  return rank || a.createdAt - b.createdAt;
}
