/**
 * Unit tests for the pure helpers the app depends on.
 *
 *   node --test tests/
 *
 * These load helpers.js itself — the same file the browser loads — so a
 * passing run says something about the shipped code, not about a copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h = require("../helpers.js");

test("escapeHtml neutralises every HTML-significant character", () => {
  assert.equal(
    h.escapeHtml('<script>alert("x")</script>'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
  );
  assert.equal(h.escapeHtml("O'Brien & Sons"), "O&#039;Brien &amp; Sons");
  assert.equal(h.escapeHtml(null), "");
  assert.equal(h.escapeHtml(undefined), "");
  assert.equal(h.escapeHtml(0), "0");
});

test("escapeHtml blocks an attribute-breakout payload", () => {
  const payload = '" onload="steal()';
  assert.ok(!h.escapeHtml(payload).includes('"'));
});

test("isUuid accepts real ids and rejects look-alikes", () => {
  assert.ok(h.isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
  assert.ok(!h.isUuid("TCK-1234-abcd"));
  assert.ok(!h.isUuid(""));
  assert.ok(!h.isUuid(null));
  assert.ok(!h.isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c330"));
});

test("normalizePriority is case-insensitive and defaults to Medium", () => {
  assert.equal(h.normalizePriority("HIGH"), "High");
  assert.equal(h.normalizePriority("low"), "Low");
  assert.equal(h.normalizePriority("nonsense"), "Medium");
  assert.equal(h.normalizePriority(undefined), "Medium");
});

test("statusLabel covers every enum value in the database", () => {
  assert.equal(h.statusLabel("new"), "New");
  assert.equal(h.statusLabel("in_progress"), "In Progress");
  assert.equal(h.statusLabel("resolved"), "Resolved");
  assert.equal(h.statusLabel("closed"), "Closed");
});

test("a customer may only close their own ticket", () => {
  assert.deepEqual(h.allowedStatusTransitions("customer", "new"), ["closed"]);
  assert.deepEqual(h.allowedStatusTransitions("customer", "closed"), []);
});

test("an agent may move a ticket anywhere except where it already is", () => {
  const next = h.allowedStatusTransitions("agent", "in_progress");
  assert.ok(!next.includes("in_progress"));
  assert.deepEqual(next, ["new", "resolved", "closed"]);
});

test("a technician may progress and resolve, never close", () => {
  assert.deepEqual(h.allowedStatusTransitions("technician", "new"), ["in_progress", "resolved"]);
  assert.ok(!h.allowedStatusTransitions("technician", "resolved").includes("closed"));
});

test("validateUpload rejects an oversized photo", () => {
  const result = h.validateUpload({ size: 20 * 1024 * 1024, type: "image/jpeg" }, "photo");
  assert.equal(result.ok, false);
  assert.match(result.message, /limit is/);
});

test("validateUpload rejects an executable pretending to be a photo", () => {
  const result = h.validateUpload({ size: 1024, type: "application/x-msdownload" }, "photo");
  assert.equal(result.ok, false);
});

test("validateUpload accepts a normal phone video and rejects an oversized one", () => {
  assert.equal(h.validateUpload({ size: 20 * 1024 * 1024, type: "video/mp4" }, "video").ok, true);
  const result = h.validateUpload({ size: 80 * 1024 * 1024, type: "video/mp4" }, "video");
  assert.equal(result.ok, false);
  assert.match(result.message, /limit is/);
});

test("validateUpload accepts an iPhone .mov video clip", () => {
  assert.equal(h.validateUpload({ size: 15 * 1024 * 1024, type: "video/quicktime" }, "video").ok, true);
});

test("validateUpload accepts a normal phone photo and a webm voice note", () => {
  assert.equal(h.validateUpload({ size: 2 * 1024 * 1024, type: "image/jpeg" }, "photo").ok, true);
  assert.equal(h.validateUpload({ size: 300 * 1024, type: "audio/webm" }, "voice").ok, true);
});

test("validateUpload accepts a service call receipt photo and rejects a PDF", () => {
  assert.equal(h.validateUpload({ size: 1.5 * 1024 * 1024, type: "image/jpeg" }, "service_receipt").ok, true);
  assert.equal(h.validateUpload({ size: 500 * 1024, type: "application/pdf" }, "service_receipt").ok, false);
});

// Regression: MediaRecorder reports the codec as a parameter on the media
// type, so a recording made inside the app was being rejected by the app.
test("validateUpload accepts what MediaRecorder actually produces", () => {
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/webm; codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "AUDIO/WEBM;CODECS=OPUS"
  ]) {
    assert.equal(h.validateUpload({ size: 200 * 1024, type }, "voice").ok, true, type);
  }
});

test("baseMimeType strips parameters and normalises case", () => {
  assert.equal(h.baseMimeType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(h.baseMimeType("IMAGE/JPEG"), "image/jpeg");
  assert.equal(h.baseMimeType(" image/png ; x=1"), "image/png");
  assert.equal(h.baseMimeType(""), "");
  assert.equal(h.baseMimeType(undefined), "");
});

test("stripping parameters does not let a disallowed type through", () => {
  assert.equal(h.validateUpload({ size: 1024, type: "video/mp4;codecs=avc1" }, "voice").ok, false);
});

test("validateUpload treats an empty file input as nothing to do", () => {
  const result = h.validateUpload({ size: 0, type: "" }, "photo");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test("safeFileName strips path traversal and exotic characters", () => {
  assert.ok(!h.safeFileName("../../etc/passwd").includes("/"));
  assert.ok(!h.safeFileName("../../etc/passwd").includes(".."));
  assert.equal(h.safeFileName("my photo (1).jpg"), "my_photo_1_.jpg");
  assert.equal(h.safeFileName(""), "file");
});

test("safeFileName keeps names short enough for a storage key", () => {
  assert.ok(h.safeFileName("a".repeat(300) + ".jpg").length <= 80);
});

test("formatBytes reads the way a person would say it", () => {
  assert.equal(h.formatBytes(512), "512 B");
  assert.equal(h.formatBytes(2048), "2 KB");
  assert.equal(h.formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(h.formatBytes(-1), "");
});

test("isValidPhone accepts local and international Sri Lankan numbers", () => {
  assert.ok(h.isValidPhone("0771234567"));
  assert.ok(h.isValidPhone("+94771234567"));
  assert.ok(h.isValidPhone("077 123 4567"));
  assert.ok(!h.isValidPhone("12345"));
  assert.ok(!h.isValidPhone(""));
});

test("relativeTime describes recent events in words", () => {
  const now = new Date("2026-08-22T12:00:00Z").getTime();
  assert.equal(h.relativeTime("2026-08-22T11:59:40Z", now), "just now");
  assert.equal(h.relativeTime("2026-08-22T11:30:00Z", now), "30 minutes ago");
  assert.equal(h.relativeTime("2026-08-22T09:00:00Z", now), "3 hours ago");
  assert.equal(h.relativeTime("2026-08-20T12:00:00Z", now), "2 days ago");
  assert.equal(h.relativeTime("", now), "");
});

test("relativeTime says 'minute' not 'minutes' for one", () => {
  const now = new Date("2026-08-22T12:00:00Z").getTime();
  assert.equal(h.relativeTime("2026-08-22T11:59:00Z", now), "1 minute ago");
});

const sampleTickets = [
  { number: "ABSL-2026-000001", title: "Scanner not reading", status: "new", priority: "high", company: "Cargills", location: "Colombo" },
  { number: "ABSL-2026-000002", title: "Printer jam", status: "closed", priority: "low", company: "Keells", location: "Kandy" },
  { number: "ABSL-2026-000003", title: "Label misprint", status: "new", priority: "medium", company: "Cargills", location: "Galle" }
];

test("search matches ticket number, title, company and location", () => {
  assert.equal(h.filterTickets(sampleTickets, { query: "000002" }).length, 1);
  assert.equal(h.filterTickets(sampleTickets, { query: "scanner" }).length, 1);
  assert.equal(h.filterTickets(sampleTickets, { query: "cargills" }).length, 2);
  assert.equal(h.filterTickets(sampleTickets, { query: "kandy" }).length, 1);
});

test("search is case-insensitive and ignores surrounding spaces", () => {
  assert.equal(h.filterTickets(sampleTickets, { query: "  PRINTER  " }).length, 1);
});

test("filters combine", () => {
  assert.equal(h.filterTickets(sampleTickets, { status: "new" }).length, 2);
  assert.equal(h.filterTickets(sampleTickets, { status: "new", priority: "high" }).length, 1);
  assert.equal(h.filterTickets(sampleTickets, {}).length, 3);
});

test("friendlyError rewrites the errors a customer can actually hit", () => {
  assert.match(h.friendlyError("Conflict: ticket was already updated by another user"), /Reload/);
  assert.match(h.friendlyError("Invalid login credentials"), /do not match/);
  assert.match(h.friendlyError("Email not confirmed"), /verification email/);
  assert.match(h.friendlyError("new row violates row-level security policy"), /permission/);
  assert.match(h.friendlyError("Company account limit reached."), /raise the limit/);
  assert.match(h.friendlyError("TypeError: Failed to fetch"), /connection/);
});

test("friendlyError passes an unknown message through rather than hiding it", () => {
  assert.equal(h.friendlyError("some new database error"), "some new database error");
  assert.equal(h.friendlyError(""), "Something went wrong.");
  assert.equal(h.friendlyError(null), "Something went wrong.");
});

test("friendlyError unwraps Error objects and Supabase error shapes", () => {
  assert.match(h.friendlyError(new Error("Invalid login credentials")), /do not match/);
  assert.match(h.friendlyError({ message: "Email not confirmed" }), /verification email/);
  assert.equal(h.friendlyError({ message: "plain" }), "plain");
});

test("truncate keeps short strings untouched", () => {
  assert.equal(h.truncate("short", 10), "short");
  assert.equal(h.truncate("a".repeat(20), 10).length, 10);
});
