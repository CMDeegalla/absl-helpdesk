/**
 * Assembles dist/ — exactly the files that belong on a public web server.
 *
 *   npm run build
 *
 * This exists because the repository also contains things that must never be
 * uploaded: SQL migrations, the disabled seed script (which still holds the
 * old passwords in its .original backup), local tooling, node_modules and the
 * .bak files from the hardening pass. Dragging the project folder onto a host
 * would publish all of it.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

// Everything the browser actually loads, and nothing else.
const files = [
  "index.html",
  "login.html",
  "register.html",
  "reset-password.html",
  "customer.html",
  "agent.html",
  "technician.html",
  "admin.html",
  "tickets.html",
  "approvals.html",
  "notifications.html",
  "system-alerts.html",
  "receipts.html",
  "client-errors.html",
  "reports.html",
  "404.html",
  "app.js",
  "helpers.js",
  "config.js",
  "styles.css",
  "favicon.svg",
  "robots.txt",
  "_headers"
];

const directories = ["vendor"];

// A publish must never carry these, whatever else changes.
const forbidden = [/\.bak$/i, /\.original$/i, /\.sql$/i, /\.env/i, /node_modules/];

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDirectory(name) {
  const source = path.join(root, name);
  if (!fs.existsSync(source)) return 0;

  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(dist, name, entry.name);

    if (entry.isDirectory()) {
      count += copyDirectory(path.join(name, entry.name));
    } else {
      copyFile(from, to);
      count += 1;
    }
  }
  return count;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

let copied = 0;
const missing = [];

for (const file of files) {
  const from = path.join(root, file);
  if (!fs.existsSync(from)) {
    missing.push(file);
    continue;
  }
  copyFile(from, path.join(dist, file));
  copied += 1;
}

for (const directory of directories) {
  copied += copyDirectory(directory);
}

// Verify nothing sensitive slipped through, and fail loudly if it did.
const leaked = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (forbidden.some((pattern) => pattern.test(full))) {
      leaked.push(path.relative(dist, full));
    }
  }
})(dist);

console.log(`\n  dist/  ${copied} files`);

if (missing.length) {
  console.log(`\n  Missing (not copied): ${missing.join(", ")}`);
}

if (leaked.length) {
  console.error(`\n  REFUSING TO SHIP. These must not be published:\n   - ${leaked.join("\n   - ")}\n`);
  process.exit(1);
}

// The config is the one file that differs per environment; show it so a
// deploy against the wrong project is obvious before it goes out.
const config = fs.readFileSync(path.join(dist, "config.js"), "utf8");
const url = config.match(/url:\s*"([^"]+)"/);
console.log(`\n  Supabase project: ${url ? url[1] : "NOT SET — fix config.js"}`);
console.log(`\n  Ready. Deploy the dist/ folder.\n`);
