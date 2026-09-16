/* =====================================================================
   ABSL Helpdesk — pure helpers
   =====================================================================
   Everything in here is a pure function with no DOM and no network, which
   is what makes it testable. `tests/helpers.test.mjs` loads this exact
   file, so the code the browser runs is the code the tests cover.

   Loaded as a plain script before app.js, so these are globals in the
   browser and a CommonJS module under Node.
   ===================================================================== */

const UPLOAD_LIMITS = {
  photo: {
    maxBytes: 8 * 1024 * 1024,
    types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    label: "photo"
  },
  voice: {
    maxBytes: 8 * 1024 * 1024,
    types: ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-m4a", "audio/aac"],
    label: "voice note"
  },
  video: {
    maxBytes: 50 * 1024 * 1024,
    types: ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/3gpp"],
    label: "video clip"
  },
  service_receipt: {
    maxBytes: 8 * 1024 * 1024,
    types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    label: "service call receipt photo"
  }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return map[char];
  });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function localId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePriority(priority) {
  const value = String(priority || "medium").toLowerCase();
  if (value === "high") return "High";
  if (value === "low") return "Low";
  return "Medium";
}

function statusLabel(status) {
  const map = {
    new: "New",
    in_progress: "In Progress",
    resolved: "Resolved",
    closed: "Closed"
  };
  return map[status] || "New";
}

/**
 * Which statuses a role is allowed to move a ticket to. Mirrors
 * change_ticket_status() in 0003 — the database is still the authority,
 * this only stops the UI from offering a button that will be refused.
 */
function allowedStatusTransitions(role, currentStatus) {
  const all = ["new", "in_progress", "resolved", "closed"];

  if (role === "agent" || role === "admin") {
    return all.filter((status) => status !== currentStatus);
  }

  if (role === "technician") {
    return ["in_progress", "resolved"].filter((status) => status !== currentStatus);
  }

  // A customer may close their own ticket and nothing else.
  return currentStatus === "closed" ? [] : ["closed"];
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A browser reports a media type with its parameters attached — MediaRecorder
 * produces "audio/webm;codecs=opus", not "audio/webm". Compare on the base
 * type only, or a recording made in the app gets rejected by the app.
 */
function baseMimeType(type) {
  return String(type || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
}

/**
 * Client-side upload gate. Storage rules are enforced by Supabase, this
 * is here so a customer on a phone finds out before a 40 MB upload.
 * Returns { ok: true } or { ok: false, message }.
 */
function validateUpload(file, kind) {
  const limit = UPLOAD_LIMITS[kind];
  if (!limit) return { ok: false, message: "Unknown attachment type." };
  if (!file || !file.size) return { ok: true, skipped: true };

  if (file.size > limit.maxBytes) {
    return {
      ok: false,
      message: `That ${limit.label} is ${formatBytes(file.size)}. The limit is ${formatBytes(limit.maxBytes)}.`
    };
  }

  const type = baseMimeType(file.type);
  if (type && !limit.types.includes(type)) {
    return {
      ok: false,
      message: `${type} is not accepted for a ${limit.label}.`
    };
  }

  return { ok: true };
}

/** Strips anything that could confuse a storage path. */
function safeFileName(name) {
  const cleaned = String(name || "file")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._]+/, "");
  return cleaned.slice(-80) || "file";
}

/** Sri Lankan mobile/landline, with or without +94. */
function isValidPhone(value) {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  return /^(\+94\d{9}|0\d{9})$/.test(digits);
}

/** Strips a displayed phone number down to what a tel: link accepts. */
function telHref(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

function truncate(text, max = 120) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** "3 minutes ago" — takes `now` so it can be tested without clock tricks. */
function relativeTime(value, now = Date.now()) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  return formatDateTime(value);
}

/** Free-text search across the fields an agent would actually search by. */
function matchesQuery(ticket, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;

  return [ticket.number, ticket.title, ticket.customer, ticket.company, ticket.location]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle));
}

function filterTickets(tickets, { query = "", status = "all", priority = "all" } = {}) {
  return (tickets || []).filter((ticket) => {
    if (status !== "all" && ticket.status !== status) return false;
    if (priority !== "all" && normalizePriority(ticket.priority) !== normalizePriority(priority)) {
      return false;
    }
    return matchesQuery(ticket, query);
  });
}

/** Turns a Supabase/Postgres error into something a customer can act on. */
function friendlyError(message) {
  // Accepts a string, an Error, or a Supabase error object.
  const text = String(
    (message && typeof message === "object" && (message.message || message.error_description)) ||
      message ||
      ""
  );

  if (/conflict|already updated/i.test(text)) {
    return "Someone else updated this ticket a moment ago. Reload to see their change.";
  }
  if (/insufficient stock/i.test(text)) {
    return text.replace(/^.*Insufficient stock/i, "Not enough stock");
  }
  if (/account limit reached/i.test(text)) {
    return "Your company has used all of its accounts. Ask an ABSL admin to raise the limit.";
  }
  if (/invalid login credentials/i.test(text)) {
    return "That email and password do not match.";
  }
  if (/email not confirmed/i.test(text)) {
    return "Please open the verification email we sent before signing in.";
  }
  if (/row-level security|not allowed|permitted/i.test(text)) {
    return "You do not have permission to do that.";
  }
  if (/duplicate key|already registered|user already/i.test(text)) {
    return "An account already exists for that email address.";
  }
  if (/fetch|network|failed to fetch/i.test(text)) {
    return "No connection to the server. Check your internet and try again.";
  }
  if (/violates check constraint .*title/i.test(text)) {
    return "The problem summary must be between 3 and 200 characters.";
  }

  return text || "Something went wrong.";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    UPLOAD_LIMITS,
    baseMimeType,
    escapeHtml,
    isUuid,
    localId,
    normalizePriority,
    statusLabel,
    allowedStatusTransitions,
    formatBytes,
    validateUpload,
    safeFileName,
    isValidPhone,
    telHref,
    truncate,
    formatDateTime,
    relativeTime,
    matchesQuery,
    filterTickets,
    friendlyError
  };
}
