const supabaseConfig = window.ABSL_SUPABASE || {};
const hasSupabaseConfig = Boolean(supabaseConfig.url && supabaseConfig.anonKey);
const supabaseClient =
  hasSupabaseConfig && window.supabase
    ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
    : null;

let currentUser = null;
let currentProfile = null;
let ticketChannel = null;
let isDataLoading = false;
let adminAlerts = [];

const publicRoutes = ["login", "register"];
const dashboardRoutes = ["customer", "agent", "technician", "admin"];

// Each role gets its own portal: its own page, its own colour, its own name,
// and its own slice of the data. Nothing loads data a role has no business
// seeing, so a technician's browser never even asks for the approval queue.
const portals = {
  customer: {
    name: "Customer Portal",
    tagline: "Raise a job and follow it through",
    accent: "customer",
    loads: ["tickets", "comments", "companies", "staff"]
  },
  agent: {
    name: "Agent Desk",
    tagline: "Triage the queue and keep customers answered",
    accent: "agent",
    loads: ["tickets", "comments", "technicians", "companies", "staff", "callbacks"]
  },
  technician: {
    name: "Technician Field App",
    tagline: "Your assigned jobs and the parts you use",
    accent: "technician",
    loads: ["tickets", "comments", "inventory", "technicians", "staff"]
  },
  admin: {
    name: "CEO Console",
    tagline: "Approvals, limits, and platform health",
    accent: "admin",
    loads: [
      "tickets",
      "comments",
      "staff",
      "callbacks",
      "technicians",
      "inventory",
      "companies",
      "approvals",
      "notifications",
      "alerts",
      "receipts",
      "clientErrors"
    ]
  }
};

function currentPortal() {
  return portals[dashboardRouteForRole()] || portals.customer;
}
const storageKey = "absl-helpdesk-state";
const legacyStorageKey = "absl-helpdesk-demo";

const initialState = {
  role: "customer",
  selectedTicketId: "",
  company: {
    id: "ABSL-COMPANY",
    name: "Automated Barcode Solutions Pvt Ltd",
    domain: "automatedbarcode.net",
    accountLimit: 10
  },
  tickets: [],
  comments: [],
  inventory: [],
  technicians: [],
  approvals: [],
  notifications: [],
  companies: [],
  selectedCompanyId: "",
  staffNames: {},
  callbackQueue: [],
  receipts: [],
  clientErrors: [],
  filters: { query: "", status: "all", priority: "all" },
  page: 1
};

const TICKETS_PER_PAGE = 12;

let state = loadState();

// --- Location capture (Diagram 9) --------------------------------------
// The schema had location_lat / location_lng from the beginning and nothing
// ever wrote to them, so the map button only ever did a text search.
function captureLocation() {
  const status = document.querySelector("#gpsStatus");

  if (!navigator.geolocation) {
    showToast("This browser cannot share a location.", "warning");
    return;
  }

  if (status) status.textContent = "Finding your location…";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude, accuracy } = position.coords;
      const latField = document.querySelector("#ticketLat");
      const lngField = document.querySelector("#ticketLng");
      const accuracyField = document.querySelector("#ticketAccuracy");

      if (latField) latField.value = latitude;
      if (lngField) lngField.value = longitude;
      if (accuracyField) accuracyField.value = accuracy;

      if (status) {
        status.textContent = `Location captured (±${Math.round(accuracy)} m). The technician will get a map pin.`;
      }
    },
    (error) => {
      console.error(error);
      if (status) status.textContent = "Could not get a location. Type the address instead.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

// --- Custom Notification & Modal System ---
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "❌";
  if (type === "warning") icon = "⚠️";

  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">${escapeHtml(message)}</div>
  `;
  
  toast.onclick = () => {
    toast.classList.add("toast-dismiss");
    setTimeout(() => toast.remove(), 300);
  };

  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add("toast-dismiss");
      setTimeout(() => toast.remove(), 300);
    }
  }, 4000);
}

function showModal({ title, body, icon = "info", actions = [] }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modalOverlay");
    const card = document.getElementById("modalCard");
    if (!overlay || !card) {
      resolve(null);
      return;
    }

    let iconChar = "ℹ️";
    if (icon === "success") iconChar = "✅";
    if (icon === "error") iconChar = "❌";
    if (icon === "warning") iconChar = "⚠️";

    card.innerHTML = `
      <div class="modal-icon modal-icon-${icon}">${iconChar}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
      <div class="modal-actions"></div>
    `;

    const actionsContainer = card.querySelector(".modal-actions");
    
    actions.forEach(action => {
      const button = document.createElement("button");
      button.className = action.primary ? "primary-button" : "secondary-button";
      button.type = "button";
      button.textContent = action.label;
      button.onclick = () => {
        overlay.classList.remove("is-visible");
        resolve(action.value);
      };
      actionsContainer.appendChild(button);
    });

    overlay.classList.add("is-visible");
  });
}

// showModal() only ever displays plain text — right for a confirmation, not
// for a document with real structure. A receipt gets its own layout, built
// the same way as everything else: every dynamic value passed through
// escapeHtml individually.
// Bumped on every call so a slow signed-URL fetch from an earlier click
// can tell it's been superseded and skip writing into a modal that has
// since moved on to a different receipt (or closed).
let receiptModalToken = 0;

async function openReceiptModal(receiptId) {
  const myToken = ++receiptModalToken;
  const receipt = state.receipts.find((item) => item.id === receiptId);
  const overlay = document.getElementById("modalOverlay");
  const card = document.getElementById("modalCard");
  if (!receipt || !overlay || !card) return;

  const parts = Array.isArray(receipt.parts_used) ? receipt.parts_used : [];

  card.innerHTML = `
    <div class="receipt">
      <div class="receipt-head">
        <div>
          <span class="small muted">Resolution receipt</span>
          <h3 class="mono">${escapeHtml(receipt.receipt_number)}</h3>
        </div>
        <span class="badge badge-ok">Resolved</span>
      </div>
      <dl class="detail-facts">
        <div><dt>Ticket</dt><dd>${escapeHtml(receipt.ticket_number)}</dd></div>
        <div><dt>Resolved</dt><dd>${escapeHtml(formatDateTime(receipt.resolved_at))}</dd></div>
        <div><dt>Company</dt><dd>${escapeHtml(receipt.company_name || "—")}</dd></div>
        <div><dt>Customer</dt><dd>${escapeHtml(receipt.customer_name || "—")}</dd></div>
        <div><dt>Technician</dt><dd>${escapeHtml(receipt.technician_name || "Unassigned")}</dd></div>
        <div><dt>Resolved by</dt><dd>${escapeHtml(receipt.agent_name || "—")}</dd></div>
        ${
          receipt.service_call_number
            ? `<div><dt>Service call number</dt><dd class="mono">${escapeHtml(receipt.service_call_number)}</dd></div>`
            : ""
        }
      </dl>
      <hr />
      <p class="small muted" style="margin-bottom: 4px;">Problem</p>
      <p>${escapeHtml(receipt.title)}</p>
      ${
        receipt.resolution_notes
          ? `<hr />
             <p class="small muted" style="margin-bottom: 4px;">Resolution notes</p>
             <p>${escapeHtml(receipt.resolution_notes)}</p>`
          : ""
      }
      ${
        parts.length
          ? `<hr />
             <p class="small muted" style="margin-bottom: 4px;">Parts used</p>
             <ul class="parts-list">
               ${parts
                 .map(
                   (part) =>
                     `<li><strong>${escapeHtml(part.name)}</strong> × ${Number(part.quantity)} <span class="small muted">${escapeHtml(part.sku)}</span></li>`
                 )
                 .join("")}
             </ul>`
          : `<hr /><p class="small muted">No parts were recorded against this ticket.</p>`
      }
      ${
        receipt.receipt_photo_path
          ? `<hr />
             <p class="small muted" style="margin-bottom: 4px;">Service call receipt photo</p>
             <div id="receiptPhotoHost" class="small muted">Loading photo…</div>`
          : ""
      }
      <div class="modal-actions">
        <button class="primary-button" type="button" data-close-modal>Close</button>
      </div>
    </div>
  `;

  card.querySelector("[data-close-modal]").onclick = () => {
    overlay.classList.remove("is-visible");
  };

  overlay.classList.add("is-visible");

  // The bucket is private, so the photo needs its own short-lived signed
  // URL - fetched after the modal is already open rather than delaying it,
  // same reasoning as loadTicketDetail()'s attachment signing.
  if (receipt.receipt_photo_path && receipt.receipt_photo_bucket && supabaseClient) {
    try {
      const { data: signed, error } = await supabaseClient.storage
        .from(receipt.receipt_photo_bucket)
        .createSignedUrl(receipt.receipt_photo_path, 60 * 60);

      // A second click (on this or another receipt) while this was in
      // flight already owns the modal now - writing this result in would
      // show the wrong photo (or overwrite content for the new receipt).
      if (myToken !== receiptModalToken) return;

      const host = card.querySelector("#receiptPhotoHost");
      if (host) {
        if (error || !signed?.signedUrl) {
          host.textContent = "This file could not be opened.";
        } else {
          const safeUrl = escapeHtml(signed.signedUrl);
          host.outerHTML = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img src="${safeUrl}" alt="Service call receipt photo" style="max-width:100%;border-radius:8px;" /></a>`;
        }
      }
    } catch (err) {
      if (myToken !== receiptModalToken) return;
      const host = card.querySelector("#receiptPhotoHost");
      if (host) host.textContent = "This file could not be opened.";
      console.error("Could not sign receipt photo", err);
    }
  }
}

// A technician resolving a job must show proof of the work: the service
// call number from their paper docket, plus a photo of it. Both are
// required by change_ticket_status() itself (0007) for a technician
// resolving - this form exists so the requirement is met before the RPC is
// even called, instead of the plain status button just failing.
function openResolveTicketModal(ticketId) {
  const overlay = document.getElementById("modalOverlay");
  const card = document.getElementById("modalCard");
  if (!overlay || !card) return;

  card.innerHTML = `
    <h3>Resolve This Ticket</h3>
    <p class="muted small">Record what you found and what you did, and attach the service call receipt, before marking this job resolved. The customer will see your resolution notes and the service call number.</p>
    <form id="resolveTicketForm">
      <div class="field">
        <label for="resolve-service-call-number">Service call number</label>
        <input id="resolve-service-call-number" name="serviceCallNumber" required maxlength="60" placeholder="e.g. SC-2026-0042" />
      </div>
      <div class="field">
        <label for="resolve-notes">Resolution notes</label>
        <textarea id="resolve-notes" name="resolutionNotes" required rows="4" maxlength="4000"
                  placeholder="What did you find, and what did you do to fix it?"></textarea>
      </div>
      <div class="field">
        <label for="resolve-receipt-photo">Receipt photo</label>
        <input id="resolve-receipt-photo" name="receiptPhoto" type="file" accept="image/png,image/jpeg,image/webp" required />
      </div>
      <div class="field">
        <label for="resolve-extra-photos">Additional photos (optional)</label>
        <input id="resolve-extra-photos" name="additionalPhotos" type="file" accept="image/png,image/jpeg,image/webp" multiple />
        <span class="small muted">Of the fault, the fix, or anything else worth keeping on file.</span>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-close-modal>Cancel</button>
        <button class="primary-button" type="submit">Mark Resolved</button>
      </div>
    </form>
  `;

  card.querySelector("[data-close-modal]").onclick = () => {
    overlay.classList.remove("is-visible");
  };

  card.querySelector("#resolveTicketForm").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const serviceCallNumber = String(form.get("serviceCallNumber") || "").trim();
    const resolutionNotes = String(form.get("resolutionNotes") || "").trim();
    const receiptPhoto = form.get("receiptPhoto");
    const additionalPhotos = form.getAll("additionalPhotos").filter((file) => file && file.size > 0);

    if (!serviceCallNumber) {
      showToast("A service call number is required.", "warning");
      return;
    }

    if (!resolutionNotes) {
      showToast("Resolution notes are required - what did you find, and what did you do?", "warning");
      return;
    }

    if (!receiptPhoto || !receiptPhoto.size) {
      showToast("A photo of the service call receipt is required.", "warning");
      return;
    }

    const checks = [validateUpload(receiptPhoto, "service_receipt"), ...additionalPhotos.map((file) => validateUpload(file, "photo"))];
    const failed = checks.find((check) => !check.ok);
    if (failed) {
      showToast(failed.message, "warning");
      return;
    }

    const submitBtn = card.querySelector("#resolveTicketForm button[type=submit]");
    if (submitBtn) submitBtn.disabled = true;

    // The receipt has to exist in the database before the status RPC will
    // accept the resolution - change_ticket_status() checks for the row,
    // not just that this form was filled in.
    const path = await uploadAttachment(ticketId, receiptPhoto, "ticket-service-receipts", "service_receipt");
    if (!path) {
      if (submitBtn) submitBtn.disabled = false;
      return; // uploadAttachment() already toasted the specific error
    }

    // Best-effort: these are useful, not required, so a failure here must
    // not block a resolution whose one required piece of evidence (the
    // receipt) is already safely on file.
    if (additionalPhotos.length) {
      await Promise.all(
        additionalPhotos.map((file) => uploadAttachment(ticketId, file, "ticket-photos", "photo"))
      );
    }

    overlay.classList.remove("is-visible");
    await updateTicketStatus(ticketId, "resolved", serviceCallNumber, resolutionNotes);
  };

  overlay.classList.add("is-visible");
}

function showConfirm(message, title = "Confirm Action") {
  return showModal({
    title,
    body: message,
    icon: "warning",
    actions: [
      { label: "Cancel", value: false, primary: false },
      { label: "Confirm", value: true, primary: true }
    ]
  });
}

function loadState() {
  const saved = localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey);
  if (!saved) return structuredClone(initialState);

  try {
    return { ...structuredClone(initialState), ...JSON.parse(saved) };
  } catch {
    return structuredClone(initialState);
  }
}

// Only UI preferences are persisted. Ticket titles, customer names and
// comment bodies used to be written to localStorage on every render and left
// there after sign-out — a real exposure on a shared technician tablet.
// Everything else is re-read from the database, which is the only copy that
// is access-controlled.
function saveState() {
  const persisted = {
    role: state.role,
    selectedTicketId: state.selectedTicketId,
    selectedCompanyId: state.selectedCompanyId,
    filters: state.filters,
    page: state.page
  };

  try {
    localStorage.setItem(storageKey, JSON.stringify(persisted));
  } catch (err) {
    console.warn("Could not save UI state", err);
  }
}

// escapeHtml, isUuid, localId, normalizePriority, statusLabel and the rest of
// the pure helpers now live in helpers.js, which is loaded first and covered
// by `npm test`. They are globals, so every call site below is unchanged.

function technicianNameById(technicianId) {
  if (!technicianId || technicianId === "Unassigned") return "Unassigned";

  const technician = state.technicians.find((item) => item.id === technicianId);
  if (technician) return technician.name;

  // A customer does not load the technician list. Fall back to the staff
  // directory rather than showing them a raw uuid.
  return state.staffNames?.[technicianId] || "Assigned";
}

function ticketTechnicianName(ticket) {
  return technicianNameById(ticket?.assignedTechnicianId || ticket?.assignedTechnician);
}

async function createRecord(table, values, options = {}) {
  if (!supabaseClient) return null;

  const { data, error } = await supabaseClient
    .from(table)
    .insert(values)
    .select(options.select || "*")
    .single();

  if (error) {
    showToast(friendlyError(error.message), "error");
    return null;
  }

  return data;
}

// PostgREST answers a write that row-level security filtered out with
// "success, zero rows". Without asking for the affected rows back we would
// report a change that never reached the database, so every write here is
// verified by row count.
const blockedWriteMessage =
  "That change was not permitted, or the record no longer exists. Nothing was saved.";

async function updateRecord(table, id, values) {
  if (!supabaseClient) {
    showToast("Not connected to the database.", "error");
    return false;
  }

  if (!isUuid(id)) {
    showToast("This record is not saved in the database yet.", "warning");
    return false;
  }

  const { data, error } = await supabaseClient
    .from(table)
    .update(values)
    .eq("id", id)
    .select("id");

  if (error) {
    showToast(friendlyError(error.message), "error");
    return false;
  }

  if (!data || data.length === 0) {
    showToast(blockedWriteMessage, "error");
    return false;
  }

  return true;
}

async function removeRecord(table, id) {
  if (!supabaseClient) {
    showToast("Not connected to the database.", "error");
    return false;
  }

  if (!isUuid(id)) {
    showToast("This record is not saved in the database yet.", "warning");
    return false;
  }

  const { data, error } = await supabaseClient
    .from(table)
    .delete()
    .eq("id", id)
    .select("id");

  if (error) {
    showToast(friendlyError(error.message), "error");
    return false;
  }

  if (!data || data.length === 0) {
    showToast(blockedWriteMessage, "error");
    return false;
  }

  return true;
}

function removeLocalRecord(collectionName, id) {
  state[collectionName] = state[collectionName].filter((item) => item.id !== id);
}

// Ensure the trigger domain setup is seed loaded if missing
function statusBadge(status) {
  const map = {
    new: "badge-new",
    in_progress: "badge-progress",
    resolved: "badge-resolved",
    closed: "badge-closed"
  };
  return `<span class="badge ${map[status] || "badge-muted"}">${statusLabel(status)}</span>`;
}

function selectedTicket() {
  return state.tickets.find((ticket) => ticket.id === state.selectedTicketId) || state.tickets[0] || null;
}

function ticketComments(ticketId) {
  return state.comments.filter((comment) => comment.ticketId === ticketId);
}

function currentCompany() {
  if (!state.company) {
    state.company = structuredClone(initialState.company);
  }
  if (!state.company.domain) {
    state.company.domain = initialState.company.domain;
  }

  // Prefer the real row loaded from the database; the local object is only a
  // placeholder used before sign-in and on the public register page.
  const selected =
    (state.companies || []).find((item) => item.id === state.selectedCompanyId) ||
    (state.companies || [])[0];

  if (selected) {
    return { ...state.company, ...selected };
  }

  return state.company;
}

// "tickets" is a real page (tickets.html) but not one of the four role
// portals — every signed-in role can reach it, none of them has a nav tab
// for it. Kept separate from dashboardRoutes so nav-tab logic elsewhere
// never has to special-case it.
// reset-password isn't gated by canAccessRoute() like the rest of this list
// - render() special-cases it directly, since it must work both with a
// fresh recovery session (currentUser set) and without one (expired link,
// nothing to gate). Listed here only so currentRoute() recognizes the
// filename in the first place.
const extraAuthedRoutes = ["tickets", "reset-password"];

// Full-list pages behind the four admin dashboard panels that used to
// render every row in place (User Approvals, Notifications, Admin System
// Alerts, Resolution Receipts). Unlike extraAuthedRoutes, these need more
// than "someone is signed in" - the data behind them is admin-only, so
// canAccessRoute() checks the role, not just Boolean(currentUser).
const adminOnlyExtraRoutes = ["approvals", "notifications", "system-alerts", "receipts", "client-errors"];

// The Reports page: agent and admin, not technician (their dashboard is
// already scoped to their own jobs) and not customer (report_search() is
// staff-only regardless, but there is no reason to even show the link).
const staffReportRoutes = ["reports"];

function currentRoute() {
  const pageName = window.location.pathname.split("/").pop().replace(".html", "");
  if (
    publicRoutes.includes(pageName) ||
    dashboardRoutes.includes(pageName) ||
    extraAuthedRoutes.includes(pageName) ||
    adminOnlyExtraRoutes.includes(pageName) ||
    staffReportRoutes.includes(pageName)
  ) {
    return pageName;
  }

  const route = window.location.hash.replace(/^#\/?/, "");
  return route || null;
}

function userRole() {
  return currentProfile?.role || state.role || "customer";
}

// Resolves proper dashboard views
function dashboardRouteForRole(role = userRole()) {
  return dashboardRoutes.includes(role) ? role : "customer";
}

function allowedDashboardRoutes() {
  if (!currentUser) return [];
  const role = dashboardRouteForRole();
  return role === "admin" ? dashboardRoutes : [role];
}

function canAccessRoute(route) {
  if (publicRoutes.includes(route)) return true;
  if (extraAuthedRoutes.includes(route)) return Boolean(currentUser);
  if (adminOnlyExtraRoutes.includes(route)) return Boolean(currentUser) && userRole() === "admin";
  if (staffReportRoutes.includes(route)) return Boolean(currentUser) && ["agent", "admin"].includes(userRole());
  if (!dashboardRoutes.includes(route) || !currentUser) return false;
  return allowedDashboardRoutes().includes(route);
}

function navigateTo(route) {
  if (currentRoute() === route) {
    render();
    return;
  }
  window.location.href = `${route}.html`;
}

function routeLabel(route) {
  const labels = {
    login: "Login",
    register: "Register",
    customer: portals.customer.name,
    agent: portals.agent.name,
    technician: portals.technician.name,
    admin: portals.admin.name,
    tickets: "My Tickets",
    approvals: "User Approvals",
    notifications: "Notifications",
    "system-alerts": "Admin System Alerts",
    receipts: "Resolution Receipts",
    "client-errors": "Client Errors",
    reports: "Reports"
  };
  return labels[route] || "Page";
}

function pageHeading(title, description) {
  const who = currentProfile?.full_name || currentUser?.email || "";
  const role = userRole();

  return `
    <section class="page-heading">
      <div>
        <p class="eyebrow">ABSL Helpdesk</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(description)}</p>
      </div>
      ${
        who
          ? `<div class="portal-identity">
               <span class="badge badge-role">${escapeHtml(role)}</span>
               <strong>${escapeHtml(who)}</strong>
             </div>`
          : ""
      }
    </section>
  `;
}

async function loadCurrentUser() {
  if (!supabaseClient) return null;

  try {
    const { data } = await supabaseClient.auth.getUser();
    currentUser = data.user;

    if (!currentUser) {
      currentProfile = null;
      return null;
    }

    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("*")
      .eq("id", currentUser.id)
      .maybeSingle();

    currentProfile = profile || null;
    return currentUser;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function getLoggedInProfile() {
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return null;
  }

  if (!currentUser || !currentProfile) {
    await loadCurrentUser();
  }

  if (!currentUser) {
    showToast("Please login first.", "warning");
    return null;
  }

  if (!currentProfile) {
    showToast("Profile not found. Please register first.", "error");
    return null;
  }

  if (currentProfile.approval_status !== "approved") {
    showToast("Your account is waiting for admin approval.", "info");
    return null;
  }

  return currentProfile;
}

async function signUpUser(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return;
  }

  const form = new FormData(event.target);
  const email = form.get("email");
  const password = form.get("password");
  const fullName = form.get("fullName");
  const companyName = form.get("companyName");
  // This is a REQUEST only. handle_new_user() always creates the profile as
  // an unprivileged customer; an admin grants the technician role on
  // approval. Never send a role the database would trust.
  const requestedRole = form.get("role") === "technician" ? "technician" : "customer";

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          company_name: companyName,
          requested_role: requestedRole // reviewed by an admin, not trusted
        }
      }
    });

    if (error) {
      if (error.message.toLowerCase().includes("limit") || error.message.toLowerCase().includes("account limit reached")) {
        await showModal({
          title: "Registration Limit Exceeded",
          body: "Your company has reached its registration account limit. Please contact your ABSL administrator to increase the limit.",
          icon: "error",
          actions: [{ label: "OK", value: true, primary: true }]
        });
      } else {
        showToast(friendlyError(error.message), "error");
      }
      return;
    }

    await showModal({
      title: "Verify Email",
      body: "Registration successful! A verification email has been sent. Please check your inbox and verify your email.",
      icon: "success",
      actions: [{ label: "OK", value: true, primary: true }]
    });

    event.target.reset();
    navigateTo("login");
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function signInUser(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return;
  }

  const form = new FormData(event.target);
  const email = form.get("email");
  const password = form.get("password");

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    await loadCurrentUser();
    
    if (currentProfile && currentProfile.approval_status !== "approved") {
      showToast("Your account is pending administrator approval.", "info");
      navigateTo("login");
      return;
    }

    subscribeToTicketUpdates();
    await loadRealSupportData({ shouldRender: false });
    state.role = dashboardRouteForRole();
    saveState();
    showToast("Login successful.", "success");
    navigateTo(state.role);
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function requestPasswordReset(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return;
  }

  const form = new FormData(event.target);
  const email = String(form.get("email") || "").trim();

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password.html`
    });

    // Same message whether or not the address is registered - confirming an
    // account exists from this response would let someone enumerate real
    // customer/staff emails one attempt at a time.
    if (error) {
      console.error(error);
    }

    showForgotPassword = false;
    await showModal({
      title: "Check Your Email",
      body: "If an account exists for that address, a password reset link is on its way. Check your inbox and spam folder - the link expires after a short time.",
      icon: "success",
      actions: [{ label: "OK", value: true, primary: true }]
    });
  } catch (err) {
    console.error(err);
    showForgotPassword = false;
    showToast("Something went wrong sending the reset link. Please try again.", "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function updatePassword(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return;
  }

  const form = new FormData(event.target);
  const password = form.get("password");
  const confirmPassword = form.get("confirmPassword");

  if (password !== confirmPassword) {
    showToast("Passwords do not match.", "error");
    return;
  }

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    await showModal({
      title: "Password Updated",
      body: "Your password has been changed. Please log in with your new password.",
      icon: "success",
      actions: [{ label: "Go to login", value: true, primary: true }]
    });

    // The recovery session is single-purpose - end it and send them to a
    // fresh login with the new password, rather than silently landing them
    // in a dashboard from a link that may have sat in an inbox for a while.
    await supabaseClient.auth.signOut();
    window.location.href = "login.html";
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function signOutUser() {
  if (!supabaseClient) return;
  if (ticketChannel) {
    supabaseClient.removeChannel(ticketChannel);
    ticketChannel = null;
  }
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  adminAlerts = [];

  // Ticket titles, customer names and comment bodies were being left in
  // localStorage after sign-out — a real problem on a shared technician
  // tablet. Wipe the cached working set and keep only UI preferences.
  state = structuredClone(initialState);
  localStorage.removeItem(storageKey);
  localStorage.removeItem(legacyStorageKey);

  showToast("Logged out successfully.", "info");
  navigateTo("login");
}

function setRole(role) {
  state.role = role;
  saveState();
  navigateTo(role);
}

async function openTicket(ticketId) {
  state.selectedTicketId = ticketId;
  saveState();
  render();

  // The detail panel renders below the ticket list on the same page, not on
  // a separate URL. Without this, pressing "Open" silently filled in a
  // section the customer had to go hunting for — it looked like the button
  // had done nothing. Scroll to it the moment the basic ticket info is on
  // screen; don't wait for attachments/history to finish loading.
  document.querySelector("#ticketDetail")?.scrollIntoView({ behavior: "smooth", block: "start" });

  await loadTicketDetail(ticketId);
  render();
}

async function changeRealTicketStatus(ticketId, newStatus, expectedVersion, serviceCallNumber = null, resolutionNotes = null) {
  if (!supabaseClient) return { ok: false, message: "Offline mode" };

  const { error } = await supabaseClient.rpc("change_ticket_status", {
    p_ticket_id: ticketId,
    p_new_status: newStatus,
    p_expected_version: expectedVersion,
    p_service_call_number: serviceCallNumber,
    p_resolution_notes: resolutionNotes
  });

  if (error) {
    return { ok: false, message: error.message };
  }

  return { ok: true };
}

async function updateTicketStatus(ticketId, status, serviceCallNumber = null, resolutionNotes = null) {
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) return;

  if (supabaseClient && isUuid(ticket.id)) {
    const res = await changeRealTicketStatus(ticket.id, status, ticket.version, serviceCallNumber, resolutionNotes);
    if (!res.ok) {
      // Diagram 18: the loser of a race is shown what actually happened and
      // asked to decide again. The old flow offered "Refresh & Overwrite",
      // which silently threw away the other agent's change.
      if (res.message.includes("Conflict") || res.message.includes("version")) {
        await loadRealSupportData({ shouldRender: false });
        const latest = state.tickets.find((item) => item.id === ticketId);

        const proceed = await showModal({
          title: "Someone got there first",
          // showModal() escapes body as plain text — no HTML tags here, or
          // the literal characters "<strong>" show up on screen.
          body: `Another team member changed this ticket while you were looking at it. ` +
                `It is now "${statusLabel(latest?.status || ticket.status)}". ` +
                `Do you still want to set it to "${statusLabel(status)}"?`,
          icon: "warning",
          actions: [
            { label: "Keep their change", value: false, primary: false },
            { label: `Set to ${statusLabel(status)}`, value: true, primary: true }
          ]
        });

        render();

        if (proceed && latest && latest.status !== status) {
          const retry = await changeRealTicketStatus(latest.id, status, latest.version, serviceCallNumber, resolutionNotes);
          if (!retry.ok) {
            showToast(friendlyError(retry.message), "error");
            return;
          }
          await loadRealSupportData({ shouldRender: false });
          await loadTicketDetail(ticketId);
          render();
          showToast("Status updated.", "success");
        }
        return;
      }

      showToast(friendlyError(res.message), "error");
      return;
    }
  }

  ticket.status = status;
  ticket.version += 1;
  saveState();
  await loadTicketDetail(ticketId);
  render();
  showToast("Status updated.", "success");
}

// Approval, and the role that comes with it, is decided entirely server-side
// by admin_review_registration(). The browser cannot grant a role directly:
// the profiles table rejects any self-service change to role or
// approval_status (see 0003_security_hardening.sql).
async function approveUser(profileId, status) {
  if (!supabaseClient) {
    showToast("Not connected to the database.", "error");
    return;
  }

  if (!isUuid(profileId)) {
    showToast("This registration is not in the database.", "warning");
    return;
  }

  const approval = state.approvals.find((item) => item.id === profileId);
  const approve = status === "approved";
  let reason = null;

  if (!approve) {
    const confirmed = await showConfirm(
      `Reject the registration for ${approval?.email || "this user"}? They can apply again afterwards.`,
      "Reject Registration"
    );
    if (!confirmed) return;
    reason = "Rejected by ABSL admin";
  }

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.rpc("admin_review_registration", {
      p_profile_id: profileId,
      p_approve: approve,
      p_grant_role: approve ? approval?.requestedRole || "customer" : null,
      p_reason: reason
    });

    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    showToast(
      approve
        ? `Approved as ${approval?.requestedRole || "customer"}.`
        : "Registration rejected.",
      approve ? "success" : "info"
    );

    await loadRealApprovals();
    await loadRealTechnicians();
    saveState();
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function retryNotification(id) {
  const notification = state.notifications.find((item) => item.id === id);
  if (!notification) return;

  if (supabaseClient && isUuid(id)) {
    const updated = await updateRecord("notifications", id, {
      status: "pending",
      next_attempt_at: new Date().toISOString(),
      error_message: null
    });
    if (!updated) return;
  }

  notification.status = "pending";
  saveState();
  render();
  showToast("Retrying notification.", "success");
}

// Diagram 12. Assignment used to be a bare UPDATE from the browser: no
// audit entry, no notification to the technician, and a fake local comment
// that nobody else could see. reassign_ticket() does all three server-side.
async function assignTechnician(ticketId, technicianId, reason) {
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket || !supabaseClient || !isUuid(ticketId)) return;

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.rpc("reassign_ticket", {
      p_ticket_id: ticketId,
      p_technician_id: isUuid(technicianId) ? technicianId : null,
      p_reason: reason || null
    });

    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    showToast(
      isUuid(technicianId)
        ? `Assigned to ${technicianNameById(technicianId)}.`
        : "Technician unassigned.",
      "success"
    );

    await loadRealSupportData({ shouldRender: false });
    await loadTicketDetail(ticketId);
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

// --- Diagram 6: callback requests --------------------------------------
async function loadCallbackQueue() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from("callback_requests")
    .select("id, ticket_id, phone, status, created_at, requested_by")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("callback queue", error);
    return;
  }

  state.callbackQueue = (data || []).map((row) => {
    const ticket = state.tickets.find((item) => item.id === row.ticket_id);
    return {
      id: row.id,
      ticketId: row.ticket_id,
      ticketNumber: ticket?.number || "",
      title: ticket?.title || "",
      customer: ticket?.customer || "",
      phone: row.phone,
      waitingSince: relativeTime(row.created_at)
    };
  });
}

async function requestCallback(event, ticketId) {
  event.preventDefault();

  const phone = String(new FormData(event.target).get("phone") || "").trim();

  if (!isValidPhone(phone)) {
    showToast("Enter a valid phone number, for example 0771234567.", "warning");
    return;
  }

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.rpc("request_callback", {
      p_ticket_id: ticketId,
      p_phone: phone
    });

    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    showToast("Callback requested. An agent will call you.", "success");
    await loadTicketDetail(ticketId);
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function completeCallback(callbackId) {
  const confirmed = await showConfirm(
    "Mark this callback as done? A note goes onto the ticket thread.",
    "Callback complete"
  );
  if (!confirmed) return;

  isDataLoading = true;
  render();

  try {
    const { error } = await supabaseClient.rpc("complete_callback", {
      p_callback_id: callbackId,
      p_note: null
    });

    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    showToast("Callback marked as done.", "success");
    await loadRealSupportData({ shouldRender: false });
    if (state.selectedTicketId) await loadTicketDetail(state.selectedTicketId);
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function consumeRealInventory(ticketId, inventoryItemId, quantity) {
  if (!supabaseClient) return false;

  const { error } = await supabaseClient.rpc("consume_inventory", {
    p_ticket_id: ticketId,
    p_inventory_item_id: inventoryItemId,
    p_quantity: quantity
  });

  if (error) {
    showToast(friendlyError(error.message), "error");
    return false;
  }

  // The caller (useInventory) shows its own success toast naming the part
  // and the new stock level — a second generic one here just doubled up.
  return true;
}

// Diagram 13. The Work button used to fire against whichever ticket happened
// to be selected, with no confirmation and no check that the job was even
// this technician's — and it faked a local comment that nobody else saw.
async function useInventory(itemId) {
  const item = state.inventory.find((part) => part.id === itemId);
  if (!item || item.qty <= 0) return;

  const ticket = selectedTicket();
  if (!ticket) {
    showToast("Open the job you are working on first, then take the part.", "warning");
    return;
  }

  if (ticket.assignedTechnicianId !== currentProfile?.id && userRole() !== "admin") {
    showToast("You can only take parts against a job assigned to you.", "warning");
    return;
  }

  const confirmed = await showConfirm(
    `Take 1 × ${item.name} (${item.sku}) for ticket ${ticket.number}? Stock will drop to ${item.qty - 1}.`,
    "Confirm part use"
  );
  if (!confirmed) return;

  isDataLoading = true;
  render();

  try {
    if (supabaseClient && isUuid(ticket.id) && isUuid(itemId)) {
      const ok = await consumeRealInventory(ticket.id, itemId, 1);
      if (!ok) return;
    }

    showToast(`Took 1 × ${item.name}.`, "success");
    await loadRealInventory();
    await loadTicketDetail(ticket.id);
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function createRealTicket(ticket) {
  const profile = await getLoggedInProfile();
  if (!profile) return null;

  const lat = Number.parseFloat(ticket.lat);
  const lng = Number.parseFloat(ticket.lng);
  const accuracy = Number.parseFloat(ticket.accuracy);

  const data = await createRecord("tickets", {
    company_id: profile.company_id,
    created_by: profile.id,
    title: String(ticket.title || "").trim(),
    description: String(ticket.description || "").trim() || ticket.title,
    priority: normalizePriority(ticket.priority).toLowerCase(),
    location_name: ticket.location,
    location_lat: Number.isFinite(lat) ? lat : null,
    location_lng: Number.isFinite(lng) ? lng : null,
    location_accuracy_m: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
    site_contact_phone: ticket.siteContactPhone || null,
    wants_callback: ticket.callback
  });

  if (!data) return null;
  showToast(`Ticket created: ${data.ticket_number}`, "success");
  return data;
}

async function uploadAttachment(ticketId, file, bucketName, fileType) {
  if (!file || file.size === 0) return null;

  const profile = await getLoggedInProfile();
  if (!profile) return null;

  const originalName = file.name || `${fileType}-${Date.now()}`;
  // A random component, not just Date.now() - two files uploaded together
  // (the resolve form's "additional photos" go up concurrently via
  // Promise.all) can compute the same millisecond, and two phones/exports
  // sharing a filename like IMG_0001.jpg would otherwise collide on the
  // exact same path and the second upload({upsert:false}) would fail.
  const filePath = `${ticketId}/${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeFileName(originalName)}`;

  try {
    const { error: uploadError } = await supabaseClient.storage
      .from(bucketName)
      .upload(filePath, file, {
        contentType: file.type || undefined,
        cacheControl: "3600",
        upsert: false
      });

    if (uploadError) {
      showToast(friendlyError(uploadError.message), "error");
      return null;
    }

    const { error: dbError } = await supabaseClient.from("ticket_attachments").insert({
      ticket_id: ticketId,
      uploaded_by: profile.id,
      bucket_name: bucketName,
      file_path: filePath,
      file_type: fileType,
      file_size: file.size,
      mime_type: file.type || null,
      original_name: originalName
    });

    if (dbError) {
      // The row is what makes the file findable; if it fails, take the
      // orphaned object back out of storage instead of leaving it there.
      await supabaseClient.storage.from(bucketName).remove([filePath]);
      showToast(friendlyError(dbError.message), "error");
      return null;
    }

    return filePath;
  } catch (err) {
    showToast(friendlyError(err), "error");
    return null;
  }
}

async function createTicket(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const wantsCallback = data.get("callback") === "on";
  const callbackPhone = String(data.get("callbackPhone") || "").trim();
  const siteContactPhone = String(data.get("siteContactPhone") || "").trim();

  if (wantsCallback && !isValidPhone(callbackPhone)) {
    showToast("Add a phone number we can call you on, for example 0771234567.", "warning");
    return;
  }

  if (siteContactPhone && !isValidPhone(siteContactPhone)) {
    showToast("The site contact number doesn't look right — try 0771234567.", "warning");
    return;
  }

  const nextNumber = String(state.tickets.length + 1).padStart(6, "0");
  const ticket = {
    id: localId("TCK"),
    number: `ABSL-${new Date().getFullYear()}-${nextNumber}`,
    title: data.get("title"),
    description: data.get("description"),
    lat: data.get("lat"),
    lng: data.get("lng"),
    accuracy: data.get("accuracy"),
    customer: data.get("customer"),
    company: data.get("company"),
    status: "new",
    priority: normalizePriority(data.get("priority")),
    location: data.get("location"),
    siteContactPhone,
    callback: data.get("callback") === "on",
    version: 1,
    assignedAgent: "Unassigned",
    assignedTechnician: "Unassigned",
    assignedTechnicianId: "",
    createdAt: new Date().toLocaleString()
  };

  isDataLoading = true;
  render();

  try {
    if (supabaseClient) {
      const realTicket = await createRealTicket(ticket);
      if (!realTicket) return;

      ticket.id = realTicket.id;
      ticket.number = realTicket.ticket_number;

      // Diagram 6: the callback goes into a real queue an agent works from,
      // not just a checkbox on the ticket.
      if (wantsCallback) {
        const { error: callbackError } = await supabaseClient.rpc("request_callback", {
          p_ticket_id: realTicket.id,
          p_phone: callbackPhone
        });

        if (callbackError) {
          showToast(
            `Ticket created, but the callback request failed: ${friendlyError(callbackError.message)}`,
            "warning"
          );
        }
      }
    }

    state.selectedTicketId = ticket.id;
    event.target.reset();

    // Re-read from the database rather than trusting the local copy, so the
    // ticket number, timestamps and status all match what was actually saved.
    await loadRealSupportData({ shouldRender: false });
    await loadTicketDetail(ticket.id);
    saveState();
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function updateTicketDetails(event, ticketId) {
  event.preventDefault();
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) return;

  const data = new FormData(event.target);
  const siteContactPhone = String(data.get("siteContactPhone") || "").trim();
  const values = {
    title: String(data.get("title") || "").trim(),
    priority: normalizePriority(data.get("priority")),
    location: String(data.get("location") || "").trim(),
    siteContactPhone,
    callback: data.get("callback") === "on"
  };

  if (!values.title) {
    showToast("Ticket title is required.", "warning");
    return;
  }

  if (siteContactPhone && !isValidPhone(siteContactPhone)) {
    showToast("The site contact number doesn't look right — try 0771234567.", "warning");
    return;
  }

  isDataLoading = true;
  render();

  try {
    const updated = await updateRecord("tickets", ticketId, {
      title: values.title,
      priority: normalizePriority(values.priority).toLowerCase(),
      location_name: values.location,
      site_contact_phone: siteContactPhone || null,
      wants_callback: values.callback
    });

    if (!updated) return;

    Object.assign(ticket, values);
    ticket.version += 1;
    saveState();
    await loadTicketDetail(ticketId);
    showToast("Ticket updated.", "success");
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function deleteTicket(ticketId) {
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) return;

  const confirmed = await showConfirm(`Are you sure you want to delete ticket ${ticket.number}? This operation is permanent.`, "Delete Ticket");
  if (!confirmed) return;

  isDataLoading = true;
  render();

  try {
    const removed = await removeRecord("tickets", ticketId);
    if (!removed) return;

    removeLocalRecord("tickets", ticketId);
    state.comments = state.comments.filter((comment) => comment.ticketId !== ticketId);
    state.selectedTicketId = state.tickets[0]?.id || "";
    saveState();
    showToast("Ticket deleted.", "success");
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function addRealComment(ticketId, body) {
  if (!supabaseClient || !isUuid(ticketId)) return true;

  const profile = await getLoggedInProfile();
  if (!profile) return false;

  const { error } = await supabaseClient.from("ticket_comments").insert({
    ticket_id: ticketId,
    author_id: profile.id,
    body
  });

  if (error) {
    showToast(friendlyError(error.message), "error");
    return false;
  }

  return true;
}

async function addComment(event, ticketId) {
  event.preventDefault();
  const data = new FormData(event.target);
  const body = data.get("comment");
  if (!body.trim()) return;

  const submit = event.target.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;

  try {
    const saved = await addRealComment(ticketId, body);
    if (!saved) return;

    event.target.reset();

    // Read the thread back so the comment carries its real id, author and
    // timestamp — the local copy used to say "Agent" for everyone.
    await loadRealComments();
    saveState();
    render();
  } finally {
    if (submit) submit.disabled = false;
  }
}

// Lets staff attach a photo of the fault/issue at any point while a job is
// still open, not only inside the resolve-ticket form - "upload photos of
// the reported fault, issue, or other relevant problems" is an ongoing
// capability, not a one-time step at the end. Routed through the
// add_progress_photo() RPC (0009) so the attachment row and the
// thread comment announcing it are written together - an upload with no
// comment, or vice versa, is exactly the kind of drift a single atomic
// step avoids.
async function addProgressPhoto(event, ticketId) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return;
  }

  const form = new FormData(event.target);
  const file = form.get("photo");

  if (!file || !file.size) {
    showToast("Choose a photo to add.", "warning");
    return;
  }

  const check = validateUpload(file, "photo");
  if (!check.ok) {
    showToast(check.message, "warning");
    return;
  }

  const submitBtn = event.target.querySelector("button[type=submit]");
  if (submitBtn) submitBtn.disabled = true;

  try {
    const originalName = file.name || `photo-${Date.now()}`;
    // A random component, not just Date.now() - two files uploaded together
  // (the resolve form's "additional photos" go up concurrently via
  // Promise.all) can compute the same millisecond, and two phones/exports
  // sharing a filename like IMG_0001.jpg would otherwise collide on the
  // exact same path and the second upload({upsert:false}) would fail.
  const filePath = `${ticketId}/${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeFileName(originalName)}`;

    const { error: uploadError } = await supabaseClient.storage
      .from("ticket-photos")
      .upload(filePath, file, { contentType: file.type || undefined, cacheControl: "3600", upsert: false });

    if (uploadError) {
      showToast(friendlyError(uploadError.message), "error");
      return;
    }

    const { error: rpcError } = await supabaseClient.rpc("add_progress_photo", {
      p_ticket_id: ticketId,
      p_bucket_name: "ticket-photos",
      p_file_path: filePath,
      p_file_size: file.size,
      p_mime_type: file.type || null,
      p_original_name: originalName
    });

    if (rpcError) {
      // The file is already in storage but unrecorded - remove it rather
      // than leave an orphan nothing can ever reference or clean up.
      await supabaseClient.storage.from("ticket-photos").remove([filePath]);
      showToast(friendlyError(rpcError.message), "error");
      return;
    }

    event.target.reset();
    await loadTicketDetail(ticketId);
    await loadRealComments();
    render();
    showToast("Photo added.", "success");
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Frees the storage space a photo/voice/video attachment was using, not
// just the database row - the two are deleted together so nothing is left
// as an orphaned file nobody can find or clean up later. The RLS policies
// backing both deletes (0013) already refuse this for a service call
// receipt regardless of what the UI offers; attachmentGallery() also
// never renders the button for one.
async function deleteAttachment(attachmentId, bucketName, filePath, ticketId) {
  if (!supabaseClient || !isUuid(attachmentId)) return;

  const confirmed = await showConfirm(
    "Delete this file? This cannot be undone.",
    "Delete Attachment"
  );
  if (!confirmed) return;

  isDataLoading = true;
  render();

  try {
    const deletedRow = await removeRecord("ticket_attachments", attachmentId);
    if (!deletedRow) return; // removeRecord() already toasted the error

    const { error: storageError } = await supabaseClient.storage.from(bucketName).remove([filePath]);
    if (storageError) {
      // The reference is already gone (freeing the database side, and the
      // customer/staff no longer see it) even if the file itself could
      // not be removed - not worth blocking on or rolling back for.
      console.error("Attachment row deleted but storage file remove failed", storageError);
    }

    await loadTicketDetail(ticketId);
    render();
    showToast("Attachment deleted.", "success");
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function deleteComment(commentId) {
  const comment = state.comments.find((item) => item.id === commentId);
  if (!comment) return;

  const confirmed = await showConfirm("Are you sure you want to delete this comment?", "Delete Comment");
  if (!confirmed) return;

  isDataLoading = true;
  render();

  try {
    const removed = await removeRecord("ticket_comments", commentId);
    if (!removed) return;

    removeLocalRecord("comments", commentId);
    saveState();
    showToast("Comment deleted.", "success");
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

async function loadRealTickets(options = {}) {
  const shouldRender = options?.shouldRender !== false;

  if (!supabaseClient) return;

  // Embed the creator and the company so the queue shows "Nimal — Cargills"
  // instead of the literal words "Customer" and "Company". RLS scopes both:
  // a customer only ever resolves their own name and company.
  const { data, error } = await supabaseClient
    .from("tickets")
    .select(
      "*, created_by_profile:profiles!tickets_created_by_fkey(full_name), company:companies(name)"
    )
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error(error);
    showToast(friendlyError(error.message), "error");
    return;
  }

  state.tickets = data.map((ticket) => ({
    id: ticket.id,
    number: ticket.ticket_number,
    title: ticket.title,
    customer: ticket.created_by_profile?.full_name || "Customer",
    company: ticket.company?.name || "",
    status: ticket.status,
    priority: normalizePriority(ticket.priority),
    location: ticket.location_name || "",
    callback: ticket.wants_callback,
    version: ticket.version,
    assignedAgent: ticket.assigned_agent_id || "Unassigned",
    assignedTechnician: technicianNameById(ticket.assigned_technician_id),
    assignedTechnicianId: ticket.assigned_technician_id || "",
    createdAt: ticket.created_at
  }));

  if (state.tickets.length > 0 && !state.selectedTicketId) {
    state.selectedTicketId = state.tickets[0].id;
  }

  saveState();
  if (shouldRender) render();
}

// --- Ticket detail -----------------------------------------------------
// Photos and voice notes were being uploaded and then never shown to
// anybody: the detail panel just said "attachments are stored with the
// ticket". ticket_detail() returns the attachments, the status history, the
// parts used and any open callback in one round trip; the storage buckets
// are private, so each file needs a short-lived signed URL.
let ticketDetail = { id: null, data: null, loading: false };

async function loadTicketDetail(ticketId) {
  if (!supabaseClient || !isUuid(ticketId)) {
    ticketDetail = { id: ticketId, data: null, loading: false };
    return;
  }

  ticketDetail = { id: ticketId, data: ticketDetail.data, loading: true };

  const { data, error } = await supabaseClient.rpc("ticket_detail", {
    p_ticket_id: ticketId
  });

  if (error) {
    ticketDetail = { id: ticketId, data: null, loading: false };
    showToast(friendlyError(error.message), "error");
    return;
  }

  const attachments = data?.attachments || [];
  await Promise.all(
    attachments.map(async (attachment) => {
      const { data: signed, error: signError } = await supabaseClient.storage
        .from(attachment.bucket_name)
        .createSignedUrl(attachment.file_path, 60 * 60);

      if (signError) {
        console.error("Could not sign attachment", attachment.file_path, signError);
        attachment.url = null;
      } else {
        attachment.url = signed?.signedUrl || null;
      }
    })
  );

  ticketDetail = { id: ticketId, data, loading: false };
}

function currentDetail() {
  return ticketDetail.id === state.selectedTicketId ? ticketDetail.data : null;
}

async function loadRealComments() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from("ticket_comments")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  state.comments = (data || []).map((comment) => ({
    id: comment.id,
    ticketId: comment.ticket_id,
    authorId: comment.author_id,
    author: comment.author_id === currentProfile?.id ? "You" : "Team member",
    body: comment.body,
    createdAt: relativeTime(comment.created_at)
  }));
}

// Customers used to see every staff reply as "Team member". The
// staff_directory view exposes just id, name and role — no emails, no
// customer rows — so a name can be shown without opening up the profiles
// table.
async function loadStaffDirectory() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from("staff_directory")
    .select("id, full_name, role");

  if (error) {
    console.error("staff directory", error);
    return;
  }

  state.staffNames = {};
  (data || []).forEach((person) => {
    const role = person.role ? ` (${person.role})` : "";
    state.staffNames[person.id] = `${person.full_name}${role}`;
  });
}

async function loadRealTechnicians() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, full_name, email")
    .eq("role", "technician")
    .eq("approval_status", "approved")
    .order("full_name", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  state.technicians = (data || []).map((profile) => ({
    id: profile.id,
    name: profile.full_name || profile.email
  }));
}

async function loadRealInventory() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from("inventory_items")
    .select("id, sku, name, category, quantity_on_hand, reorder_level")
    .order("name", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  state.inventory = (data || []).map((item) => ({
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    qty: item.quantity_on_hand,
    reorderLevel: item.reorder_level
  }));
}

async function loadRealApprovals() {
  if (!supabaseClient || userRole() !== "admin") return;

  const { data, error } = await supabaseClient
    .from("approval_requests")
    .select("profile_id, company_name, requested_email, requested_role, status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    showToast(`Could not load approvals: ${error.message}`, "error");
    return;
  }

  state.approvals = (data || []).map((request) => ({
    id: request.profile_id,
    name: request.requested_email,
    email: request.requested_email,
    company: request.company_name,
    requestedRole: request.requested_role || "customer",
    status: request.status
  }));
}

// The admin console used to hold a hard-coded company id ("ABSL-COMPANY"),
// so "Update Limit" never wrote anything. Load the real rows instead.
// RLS does the scoping: a customer gets only their own company row, an
// admin gets every company.
async function loadRealCompanies() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from("companies")
    .select("id, name, account_limit, status")
    .order("name", { ascending: true });

  if (error) {
    console.error(error);
    showToast(`Could not load companies: ${error.message}`, "error");
    return;
  }

  state.companies = (data || []).map((company) => ({
    id: company.id,
    name: company.name,
    accountLimit: company.account_limit,
    status: company.status
  }));

  const own = state.companies.find((company) => company.id === currentProfile?.company_id);
  const active = state.companies.find((company) => company.id === state.selectedCompanyId);

  if (!active) {
    state.selectedCompanyId = (own || state.companies[0])?.id || "";
  }
}

async function loadRealNotifications() {
  if (!supabaseClient || userRole() !== "admin") return;

  const { data, error } = await supabaseClient
    .from("notifications")
    .select("id, channel, subject, status, attempts, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    return;
  }

  state.notifications = (data || []).map((notification) => ({
    id: notification.id,
    subject: notification.subject,
    channel: notification.channel,
    status: notification.status,
    attempts: notification.attempts
  }));
}

async function loadRealAdminAlerts() {
  if (!supabaseClient || userRole() !== "admin") return;

  const { data, error } = await supabaseClient
    .from("admin_alerts")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    return;
  }

  adminAlerts = data || [];
}

// A receipt is generated automatically in the database the instant a ticket
// becomes Resolved — see 0005's on_ticket_resolved trigger. Nothing here
// creates one; this only reads the record for the admin console.
async function loadRealReceipts() {
  if (!supabaseClient || userRole() !== "admin") return;

  const { data, error } = await supabaseClient
    .from("ticket_receipts")
    .select("*")
    .order("resolved_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error(error);
    showToast(`Could not load receipts: ${friendlyError(error.message)}`, "error");
    return;
  }

  state.receipts = data || [];
}

async function acknowledgeAlert(alertId) {
  if (!supabaseClient || !isUuid(alertId)) return;

  isDataLoading = true;
  render();

  try {
    const updated = await updateRecord("admin_alerts", alertId, {
      acknowledged: true,
      acknowledged_by: currentProfile?.id || null,
      acknowledged_at: new Date().toISOString()
    });

    if (updated) {
      showToast("Alert acknowledged.", "success");
      await loadRealAdminAlerts();
    }
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

// A browser JS error a real user hit, reported by logClientError() below.
// Same visibility model as admin_alerts: admin-only, acknowledge to clear.
async function loadRealClientErrors() {
  if (!supabaseClient || userRole() !== "admin") return;

  const { data, error } = await supabaseClient
    .from("client_error_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error(error);
    return;
  }

  state.clientErrors = data || [];
}

async function acknowledgeClientError(errorId) {
  if (!supabaseClient || !isUuid(errorId)) return;

  isDataLoading = true;
  render();

  try {
    const updated = await updateRecord("client_error_logs", errorId, {
      acknowledged: true,
      acknowledged_by: currentProfile?.id || null,
      acknowledged_at: new Date().toISOString()
    });

    if (updated) {
      showToast("Error acknowledged.", "success");
      await loadRealClientErrors();
    }
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isDataLoading = false;
    render();
  }
}

// The last error message logged and when, so a tight failing loop reports
// once instead of flooding the table with the same row hundreds of times.
// Keyed by message, not a single last-seen slot - two distinct errors
// alternating (A, B, A, B, ...) would never match "the previous one" with
// only one slot, so a loop tripping two different failures kept writing
// a row on every single occurrence instead of being throttled at all.
// Capped so a script generating endless distinct messages cannot grow
// this without bound.
const loggedErrorTimestamps = new Map();
const MAX_TRACKED_ERROR_MESSAGES = 50;

// Fire-and-forget by design: reporting an error must never itself throw,
// block the UI, or affect what the user was doing when it happened.
// Unauthenticated visitors (login/register) are not logged - there is no
// one to attribute the row to, and it would otherwise be an open,
// unauthenticated write endpoint.
async function logClientError(message, stack) {
  if (!supabaseClient || !currentUser) return;

  const safeMessage = String(message || "Unknown error").slice(0, 2000);
  const now = Date.now();
  const lastSeen = loggedErrorTimestamps.get(safeMessage);
  if (lastSeen && now - lastSeen < 30000) {
    return;
  }
  if (loggedErrorTimestamps.size >= MAX_TRACKED_ERROR_MESSAGES) {
    loggedErrorTimestamps.clear();
  }
  loggedErrorTimestamps.set(safeMessage, now);

  try {
    await supabaseClient.from("client_error_logs").insert({
      profile_id: currentUser.id,
      message: safeMessage,
      stack: stack ? String(stack).slice(0, 8000) : null,
      // Deliberately excludes window.location.hash: a password-reset
      // visit carries a live Supabase recovery access_token/refresh_token
      // in the URL fragment (see resetPasswordPage()), and this table is
      // admin-readable - logging the full href would persist a working
      // auth credential into it if a JS error fired on that page.
      page_url: (window.location.origin + window.location.pathname + window.location.search).slice(0, 500),
      user_agent: navigator.userAgent
    });
  } catch (err) {
    // Logging the failure to log is exactly the loop this function exists
    // to avoid - console only, never rethrow.
    console.error("Failed to record client error", err);
  }
}

async function loadRealSupportData(options = {}) {
  const shouldRender = options?.shouldRender !== false;

  if (!supabaseClient) return;

  isDataLoading = true;
  if (shouldRender) render();

  // Only fetch what this portal actually shows.
  const loads = currentPortal().loads;
  const loaders = {
    comments: loadRealComments,
    staff: loadStaffDirectory,
    technicians: loadRealTechnicians,
    inventory: loadRealInventory,
    companies: loadRealCompanies,
    callbacks: loadCallbackQueue,
    approvals: loadRealApprovals,
    notifications: loadRealNotifications,
    alerts: loadRealAdminAlerts,
    receipts: loadRealReceipts,
    clientErrors: loadRealClientErrors
  };

  try {
    await loadRealTickets({ shouldRender: false });
    await Promise.all(
      loads.filter((name) => loaders[name]).map((name) => loaders[name]())
    );
  } catch (err) {
    console.error(err);
  } finally {
    isDataLoading = false;
    saveState();
    if (shouldRender) render();
  }
}

// Every realtime event used to trigger a full reload of every table plus a
// full re-render, for every connected client. A busy afternoon on the agent
// queue turned that into a refetch storm. Coalesce bursts into one refresh.
let refreshTimer = null;
let refreshInFlight = false;

function scheduleRefresh(loader) {
  if (refreshTimer) clearTimeout(refreshTimer);

  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (refreshInFlight) {
      scheduleRefresh(loader);
      return;
    }

    refreshInFlight = true;
    try {
      await loader();
      render();
    } catch (err) {
      console.error(err);
    } finally {
      refreshInFlight = false;
    }
  }, 400);
}

function subscribeToTicketUpdates() {
  if (!supabaseClient) return;

  if (ticketChannel) {
    supabaseClient.removeChannel(ticketChannel);
  }

  const refreshAll = () =>
    scheduleRefresh(() => loadRealSupportData({ shouldRender: false }));

  ticketChannel = supabaseClient
    .channel("ticket-updates")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "tickets" },
      refreshAll
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "ticket_comments" },
      refreshAll
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "admin_alerts" },
      () => scheduleRefresh(loadRealAdminAlerts)
    )
    .subscribe();
}

async function updateCompanyLimit(companyId, newLimit) {
  if (!Number.isInteger(newLimit) || newLimit < 1) {
    showToast("Enter a valid account limit.", "warning");
    return false;
  }

  const updated = await updateRecord("companies", companyId, { account_limit: newLimit });
  if (!updated) return false;

  showToast("Company account limit updated.", "success");
  return true;
}

async function handleCompanyLimitUpdate() {
  const select = document.querySelector("#companySelect");
  const input = document.querySelector("#companyLimitInput");
  const companyId = select?.value || state.selectedCompanyId;
  const newLimit = Number.parseInt(input?.value, 10);

  if (!companyId) {
    showToast("Select a company first.", "warning");
    return;
  }

  isDataLoading = true;
  render();

  try {
    const updated = await updateCompanyLimit(companyId, newLimit);
    if (!updated) return;

    state.selectedCompanyId = companyId;
    await loadRealCompanies();
    saveState();
  } finally {
    isDataLoading = false;
    render();
  }
}

function stats() {
  return {
    open: state.tickets.filter((ticket) => ticket.status !== "closed").length,
    pendingApproval: state.approvals.filter((approval) => approval.status === "pending").length,
    lowStock: state.inventory.filter((item) => item.qty <= 5).length
  };
}

// Each portal gets the numbers that matter to it. Showing "Pending approvals"
// to a technician was always a zero, because that data is admin-only.
function renderStats() {
  const data = stats();
  const route = currentRoute();

  const cards = [`<article class="stat-card"><span class="muted">Open tickets</span><strong>${data.open}</strong></article>`];

  if (route === "technician") {
    const mine = state.tickets.filter(
      (ticket) => ticket.assignedTechnicianId === currentProfile?.id
    ).length;
    cards.push(`<article class="stat-card"><span class="muted">My jobs</span><strong>${mine}</strong></article>`);
    cards.push(`<article class="stat-card"><span class="muted">Low stock items</span><strong>${data.lowStock}</strong></article>`);
  }

  if (route === "agent") {
    const unassigned = state.tickets.filter(
      (ticket) => !ticket.assignedTechnicianId && ticket.status !== "closed"
    ).length;
    cards.push(`<article class="stat-card"><span class="muted">Waiting for a technician</span><strong>${unassigned}</strong></article>`);
    cards.push(`<article class="stat-card"><span class="muted">Callback requests</span><strong>${state.tickets.filter((ticket) => ticket.callback).length}</strong></article>`);
  }

  if (route === "admin") {
    cards.push(`<article class="stat-card"><span class="muted">Pending approvals</span><strong>${data.pendingApproval}</strong></article>`);
    cards.push(`<article class="stat-card"><span class="muted">Low stock items</span><strong>${data.lowStock}</strong></article>`);
    cards.push(`<article class="stat-card"><span class="muted">Unread alerts</span><strong>${adminAlerts.filter((alert) => !alert.acknowledged).length}</strong></article>`);
  }

  // A fixed 3-column grid was fine for customer (1 card) and agent/technician
  // (3 cards each), but admin has 4 — the 4th wrapped alone into row two with
  // two empty column tracks beside it. Measured: 769px of dead space at
  // desktop width. .stats-grid auto-fits to however many cards a role
  // actually has, so this holds for any future count too.
  return `<section class="dashboard-grid stats-grid">${cards.join("")}</section>`;
}

// Search and filters live outside the list host, so typing in the box does
// not re-render the box out from under the cursor.
function ticketToolbar(total) {
  const { query, status, priority } = state.filters;

  return `
    <div class="ticket-toolbar">
      <label class="sr-only" for="ticketSearch">Search tickets</label>
      <input id="ticketSearch" type="search" placeholder="Search number, title, customer, site…"
             value="${escapeHtml(query)}" autocomplete="off" />
      <select data-filter="status" aria-label="Filter by status">
        <option value="all" ${status === "all" ? "selected" : ""}>All statuses</option>
        <option value="new" ${status === "new" ? "selected" : ""}>New</option>
        <option value="in_progress" ${status === "in_progress" ? "selected" : ""}>In Progress</option>
        <option value="resolved" ${status === "resolved" ? "selected" : ""}>Resolved</option>
        <option value="closed" ${status === "closed" ? "selected" : ""}>Closed</option>
      </select>
      <select data-filter="priority" aria-label="Filter by priority">
        <option value="all" ${priority === "all" ? "selected" : ""}>Any priority</option>
        <option value="High" ${priority === "High" ? "selected" : ""}>High</option>
        <option value="Medium" ${priority === "Medium" ? "selected" : ""}>Medium</option>
        <option value="Low" ${priority === "Low" ? "selected" : ""}>Low</option>
      </select>
      <span class="small muted">${total} ticket${total === 1 ? "" : "s"}</span>
    </div>
    <div id="ticketListHost">${ticketListHostContent()}</div>
  `;
}

// Same toolbar, two different lists behind it: a five-card preview wherever
// it's embedded next to other panels as a secondary dashboard convenience,
// and the real, paginated, fully-searchable list everywhere the ticket
// queue is the actual job being done on that screen — tickets.html, and
// the agent dashboard's "Ticket Queue" panel, which is an agent's primary
// work surface, not a preview of something else. Capping it at five cards
// silently broke search for any query matching more than five tickets.
function ticketListHostContent() {
  return ["tickets", "agent"].includes(currentRoute())
    ? renderTicketList()
    : renderTicketListCompact(filterTickets(state.tickets, state.filters));
}

function pagination(totalPages) {
  if (totalPages <= 1) return "";

  const page = Math.min(state.page, totalPages);
  const buttons = [];

  for (let index = 1; index <= totalPages; index += 1) {
    if (index === 1 || index === totalPages || Math.abs(index - page) <= 1) {
      buttons.push(
        `<button class="${index === page ? "primary-button" : "secondary-button"} compact-button"
                 type="button" data-page="${index}" ${index === page ? 'aria-current="page"' : ""}>${index}</button>`
      );
    } else if (buttons[buttons.length - 1] !== "…") {
      buttons.push("…");
    }
  }

  return `<nav class="pagination" aria-label="Ticket pages">${buttons
    .map((item) => (item === "…" ? `<span class="small muted">…</span>` : item))
    .join("")}</nav>`;
}

// Re-renders only the list, keeping focus in the search box.
function renderTicketListOnly() {
  const host = document.querySelector("#ticketListHost");
  if (!host) {
    render();
    return;
  }

  host.innerHTML = ticketListHostContent();
  bindEvents();

  const search = document.querySelector("#ticketSearch");
  if (search) {
    const end = search.value.length;
    search.focus();
    search.setSelectionRange(end, end);
  }
}

// One card, shared by the full paginated list and the compact dashboard
// preview — the two used to duplicate this markup, which is exactly how
// they'd quietly drift apart over time.
function ticketCardHtml(ticket, canDeleteTicket) {
  const safeId = escapeHtml(ticket.id);
  const safeTitle = escapeHtml(ticket.title);
  const safeNumber = escapeHtml(ticket.number);
  const safePriority = escapeHtml(normalizePriority(ticket.priority));
  const safeCompany = escapeHtml(ticket.company || "Company");
  const safeLocation = escapeHtml(ticket.location || "No location provided");

  return `
    <article class="ticket-card">
      <div>
        <h3>${safeTitle}</h3>
        <div class="ticket-meta">
          <span class="badge badge-muted">${safeNumber}</span>
          ${statusBadge(ticket.status)}
          <span class="badge ${safePriority === "High" ? "badge-danger" : "badge-muted"}">${safePriority}</span>
          ${ticket.callback ? `<span class="badge badge-ok">☎ Callback</span>` : ""}
          ${ticket.id === state.selectedTicketId ? `<span class="badge badge-ok">Open</span>` : ""}
        </div>
        <p class="small muted">
          ${escapeHtml(ticket.customer || "")}${safeCompany ? ` · ${safeCompany}` : ""} · ${safeLocation}
        </p>
        <p class="small muted">${escapeHtml(relativeTime(ticket.createdAt))}</p>
      </div>
      <div class="ticket-card-actions">
        <button class="secondary-button" type="button" data-open-ticket="${safeId}">Open</button>
        ${
          canDeleteTicket
            ? `<button class="danger-button" type="button" data-delete-ticket="${safeId}">Delete</button>`
            : ""
        }
      </div>
    </article>
  `;
}

function emptyTicketListMessage() {
  const filtered =
    state.filters.query || state.filters.status !== "all" || state.filters.priority !== "all";
  return `<div class="empty-state">${
    filtered
      ? "No ticket matches that search. Clear the filters to see everything."
      : "No tickets yet."
  }</div>`;
}

function renderTicketList(tickets = null) {
  if (isDataLoading) {
    return `<div class="loading-spinner">Fetching ticket queue…</div>`;
  }

  const source = tickets || filterTickets(state.tickets, state.filters);

  if (!source.length) return emptyTicketListMessage();

  const totalPages = Math.max(1, Math.ceil(source.length / TICKETS_PER_PAGE));
  const page = Math.min(Math.max(1, state.page), totalPages);
  const visible = tickets
    ? source
    : source.slice((page - 1) * TICKETS_PER_PAGE, page * TICKETS_PER_PAGE);

  // Match the database: only an admin can delete a ticket, and the check is
  // on the signed-in profile's role, not on which page is open.
  const canDeleteTicket = userRole() === "admin";

  return `
    <div class="ticket-list">
      ${visible.map((ticket) => ticketCardHtml(ticket, canDeleteTicket)).join("")}
    </div>
    ${tickets ? "" : pagination(totalPages)}
  `;
}

// A dashboard panel is a preview, not the whole inbox — five cards and a
// clear way to see the rest, rather than every ticket (or a full pager)
// competing for space with the create-ticket form or the callback queue
// next to it.
const TICKETS_PREVIEW_COUNT = 5;

function renderTicketListCompact(source) {
  if (isDataLoading) {
    return `<div class="loading-spinner">Fetching ticket queue…</div>`;
  }

  if (!source.length) return emptyTicketListMessage();

  const canDeleteTicket = userRole() === "admin";
  const visible = source.slice(0, TICKETS_PREVIEW_COUNT);

  return `
    <div class="ticket-list">
      ${visible.map((ticket) => ticketCardHtml(ticket, canDeleteTicket)).join("")}
    </div>
    ${
      source.length > TICKETS_PREVIEW_COUNT
        ? `<div class="ticket-list-more">
             <a class="secondary-button" href="tickets.html">See all ${source.length} tickets</a>
           </div>`
        : ""
    }
  `;
}

// The full, searchable, fully paginated list — what "See all" leads to.
// Reuses the exact same toolbar and filter state as the compact preview,
// so a search typed on the dashboard panel is still applied here.
function ticketsPage() {
  // Just one panel — no grid needed. A one-child .hero-grid would still
  // reserve its unused minmax(300px, …) second column and leave the exact
  // kind of dead space this whole pass has been closing elsewhere.
  return `
    <div class="panel">
      <div class="panel-title">
        <h2>All Tickets</h2>
        <a class="secondary-button" href="${dashboardRouteForRole()}.html">Back</a>
      </div>
      ${ticketToolbar(filterTickets(state.tickets, state.filters).length)}
    </div>
    <br />
    ${renderTicketDetail(selectedTicket())}
  `;
}

// Not loaded as part of any portal's dashboard data - this is a
// deliberately on-demand search (report_search() caps at 500 rows and
// still returns everything by default with no filter, which is too much
// to dump onto the screen unasked). State lives outside `state` itself so
// a stale search result never gets persisted to localStorage.
let reportFilters = { customer: "", serviceCallNumber: "", dateFrom: "", dateTo: "" };
let reportResults = [];
let reportSearched = false;
let isReportLoading = false;

function reportsPage() {
  return `
    <div class="panel">
      <div class="panel-title">
        <h2>Reports</h2>
        <a class="secondary-button" href="${dashboardRouteForRole()}.html">Back</a>
      </div>
      <p class="muted small">Search by customer, service call number, or date. The reported fault, the technician's findings and resolution, and the service call number all show together in one summary.</p>
      <form id="reportSearchForm" class="form-grid">
        <div class="field">
          <label for="report-customer">Customer, email or company</label>
          <input id="report-customer" name="customer" value="${escapeHtml(reportFilters.customer)}" placeholder="e.g. Jane Silva" />
        </div>
        <div class="field">
          <label for="report-service-call">Service call number</label>
          <input id="report-service-call" name="serviceCallNumber" value="${escapeHtml(reportFilters.serviceCallNumber)}" placeholder="e.g. SC-2026-0042" />
        </div>
        <div class="field">
          <label for="report-date-from">From</label>
          <input id="report-date-from" name="dateFrom" type="date" value="${escapeHtml(reportFilters.dateFrom)}" />
        </div>
        <div class="field">
          <label for="report-date-to">To</label>
          <input id="report-date-to" name="dateTo" type="date" value="${escapeHtml(reportFilters.dateTo)}" />
        </div>
        <div class="action-row">
          <button class="primary-button" type="submit" ${isReportLoading ? "disabled" : ""}>${isReportLoading ? "Searching…" : "Search"}</button>
        </div>
      </form>
    </div>
    <br />
    <div class="panel">
      <div class="panel-title">
        <h2>Results</h2>
        ${
          reportResults.length
            ? `<button class="secondary-button" type="button" id="exportReportsBtn">Export to spreadsheet</button>`
            : ""
        }
      </div>
      ${reportResultsHtml()}
    </div>
  `;
}

function reportResultsHtml() {
  if (isReportLoading) {
    return `<div class="loading-spinner">Searching…</div>`;
  }

  if (!reportSearched) {
    return `<div class="empty-state">Enter at least one filter above and search — every ticket at once would be too much to scan.</div>`;
  }

  if (!reportResults.length) {
    return `<div class="empty-state">No tickets match those filters.</div>`;
  }

  return `
    <div class="ticket-list">
      ${reportResults
        .map(
          (row) => `
        <article class="ticket-card">
          <div>
            <h3>${escapeHtml(row.title)}</h3>
            <div class="ticket-meta">
              <span class="badge badge-muted">${escapeHtml(row.ticket_number)}</span>
              ${statusBadge(row.status)}
              ${row.service_call_number ? `<span class="badge badge-ok mono">${escapeHtml(row.service_call_number)}</span>` : ""}
            </div>
            <p class="small muted">
              ${escapeHtml(row.customer_name || row.customer_email || "Unknown customer")}${row.company_name ? ` · ${escapeHtml(row.company_name)}` : ""}
            </p>
            <p class="small muted">${escapeHtml(relativeTime(row.created_at))}</p>
            ${
              row.resolution_notes
                ? `<button class="link-button" type="button" data-view-report="${escapeHtml(row.id)}">Click here to view technician message</button>`
                : ""
            }
          </div>
          <div class="ticket-card-actions">
            <button class="secondary-button" type="button" data-view-report="${escapeHtml(row.id)}">View Summary</button>
          </div>
        </article>
      `
        )
        .join("")}
    </div>
  `;
}

/** Wraps a value for one CSV field: quoted, with internal quotes doubled,
 *  whenever it contains a comma, quote or newline - the one escaping rule
 *  every spreadsheet app (Excel, Google Sheets, LibreOffice) agrees on. */
function csvField(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// CSV rather than a real .xlsx: it opens correctly in both Google Sheets
// and Excel with no extra library, no CDN script, and no new dependency
// in a project that has deliberately carried none beyond supabase-js.
function exportReportsToCsv() {
  if (!reportResults.length) return;

  const headers = [
    "Ticket Number",
    "Status",
    "Service Call Number",
    "Customer",
    "Customer Email",
    "Company",
    "Technician",
    "Reported",
    "Resolved",
    "Reported Fault",
    "Technician Message"
  ];

  const rows = reportResults.map((row) => [
    row.ticket_number,
    statusLabel(row.status),
    row.service_call_number || "",
    row.customer_name || "",
    row.customer_email || "",
    row.company_name || "",
    row.technician_name || "",
    formatDateTime(row.created_at),
    row.resolved_at ? formatDateTime(row.resolved_at) : "",
    row.description || row.title || "",
    row.resolution_notes || ""
  ]);

  // A UTF-8 byte-order mark, so Excel opens the file as UTF-8 instead of
  // guessing the system codepage and mangling non-ASCII names.
  const bom = String.fromCharCode(0xfeff);
  const csv =
    bom +
    [headers, ...rows]
      .map((line) => line.map(csvField).join(","))
      .join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `absl-service-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function searchReports(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showToast("Supabase is not configured.", "warning");
    return;
  }

  const form = new FormData(event.target);
  reportFilters = {
    customer: String(form.get("customer") || "").trim(),
    serviceCallNumber: String(form.get("serviceCallNumber") || "").trim(),
    dateFrom: String(form.get("dateFrom") || ""),
    dateTo: String(form.get("dateTo") || "")
  };

  isReportLoading = true;
  render();

  try {
    const { data, error } = await supabaseClient.rpc("report_search", {
      p_customer_query: reportFilters.customer || null,
      p_service_call_number: reportFilters.serviceCallNumber || null,
      p_date_from: reportFilters.dateFrom || null,
      p_date_to: reportFilters.dateTo || null
    });

    if (error) {
      showToast(friendlyError(error.message), "error");
      return;
    }

    reportResults = data || [];
    reportSearched = true;
  } catch (err) {
    showToast(friendlyError(err), "error");
  } finally {
    isReportLoading = false;
    render();
  }
}

// showModal() only shows plain text - a service report has real structure,
// so it gets its own layout, the same reasoning openReceiptModal() already
// follows for a resolution receipt.
function openReportSummaryModal(reportId) {
  const report = reportResults.find((row) => row.id === reportId);
  const overlay = document.getElementById("modalOverlay");
  const card = document.getElementById("modalCard");
  if (!report || !overlay || !card) return;

  card.innerHTML = `
    <div class="receipt">
      <div class="receipt-head">
        <div>
          <span class="small muted">Service report</span>
          <h3 class="mono">${escapeHtml(report.ticket_number)}</h3>
        </div>
        ${statusBadge(report.status)}
      </div>
      <dl class="detail-facts">
        <div><dt>Customer</dt><dd>${escapeHtml(report.customer_name || report.customer_email || "—")}</dd></div>
        <div><dt>Company</dt><dd>${escapeHtml(report.company_name || "—")}</dd></div>
        <div><dt>Technician</dt><dd>${escapeHtml(report.technician_name || "Unassigned")}</dd></div>
        <div><dt>Service call number</dt><dd class="mono">${escapeHtml(report.service_call_number || "—")}</dd></div>
        <div><dt>Reported</dt><dd>${escapeHtml(formatDateTime(report.created_at))}</dd></div>
        <div><dt>Resolved</dt><dd>${report.resolved_at ? escapeHtml(formatDateTime(report.resolved_at)) : "—"}</dd></div>
      </dl>
      <hr />
      <p class="small muted" style="margin-bottom: 4px;">Reported fault</p>
      <p>${escapeHtml(report.description || report.title)}</p>
      <hr />
      <p class="small muted" style="margin-bottom: 4px;">Technician's findings, actions taken and resolution</p>
      <p>${report.resolution_notes ? escapeHtml(report.resolution_notes) : "Not yet resolved."}</p>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-close-modal>Close</button>
        <button class="primary-button" type="button" data-open-full-ticket="${escapeHtml(report.id)}">Open full ticket</button>
      </div>
    </div>
  `;

  card.querySelector("[data-close-modal]").onclick = () => {
    overlay.classList.remove("is-visible");
  };

  card.querySelector("[data-open-full-ticket]").onclick = () => {
    state.selectedTicketId = report.id;
    saveState();
    overlay.classList.remove("is-visible");
    window.location.href = "tickets.html";
  };

  overlay.classList.add("is-visible");
}

function attachmentGallery(detail) {
  const attachments = detail?.attachments || [];

  if (!attachments.length) {
    return `<p class="small muted">No photo was attached to this ticket.</p>`;
  }

  return `
    <div class="attachment-grid">
      ${attachments
        .map((attachment) => {
          const name = escapeHtml(attachment.original_name || attachment.file_path.split("/").pop());
          const size = attachment.file_size ? ` · ${formatBytes(attachment.file_size)}` : "";
          // The service call receipt is the required evidence behind a
          // resolution (and, once resolved, behind an already-generated
          // Resolution Receipt that copied its file path) - never
          // offered for deletion, matching the RLS policy that backs
          // this up server-side regardless of what the UI offers.
          const canDelete =
            attachment.file_type !== "service_receipt" &&
            (attachment.uploaded_by === currentProfile?.id || userRole() === "admin");
          const deleteButton = canDelete
            ? `<button class="danger-button compact-button" type="button"
                 data-delete-attachment="${escapeHtml(attachment.id)}"
                 data-attachment-bucket="${escapeHtml(attachment.bucket_name)}"
                 data-attachment-path="${escapeHtml(attachment.file_path)}"
                 data-attachment-ticket="${escapeHtml(detail?.ticket?.id || "")}">Delete</button>`
            : "";

          if (!attachment.url) {
            return `<div class="attachment attachment-broken">
                      <strong>${name}</strong>
                      <span class="small muted">This file could not be opened.</span>
                      ${deleteButton}
                    </div>`;
          }

          if (attachment.file_type === "voice") {
            return `<div class="attachment attachment-voice">
                      <strong>🎙 Voice note</strong>
                      <audio controls preload="none" src="${escapeHtml(attachment.url)}"></audio>
                      <span class="small muted">${name}${size}</span>
                      ${deleteButton}
                    </div>`;
          }

          if (attachment.file_type === "video") {
            return `<div class="attachment attachment-video">
                      <strong>🎬 Video clip</strong>
                      <video controls preload="metadata" src="${escapeHtml(attachment.url)}"></video>
                      <span class="small muted">${name}${size}</span>
                      ${deleteButton}
                    </div>`;
          }

          if (attachment.file_type === "service_receipt") {
            return `<figure class="attachment attachment-photo">
                      <a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
                        <img src="${escapeHtml(attachment.url)}" alt="Service call receipt: ${name}" loading="lazy" />
                      </a>
                      <figcaption class="small muted">🧾 Service call receipt · ${name}${size}</figcaption>
                    </figure>`;
          }

          return `<figure class="attachment attachment-photo">
                    <a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
                      <img src="${escapeHtml(attachment.url)}" alt="Photo attached to this ticket: ${name}" loading="lazy" />
                    </a>
                    <figcaption class="small muted">${name}${size}</figcaption>
                    ${deleteButton}
                  </figure>`;
        })
        .join("")}
    </div>
  `;
}

function statusTimeline(detail) {
  const history = detail?.history || [];

  if (!history.length) {
    return `<p class="small muted">No status changes recorded yet.</p>`;
  }

  return `
    <ol class="timeline">
      ${history
        .map(
          (entry) => `
        <li>
          <strong>${escapeHtml(statusLabel(entry.new_status))}</strong>
          ${entry.old_status ? `<span class="small muted"> from ${escapeHtml(statusLabel(entry.old_status))}</span>` : ""}
          <div class="small muted">
            ${escapeHtml(entry.changed_by_name || "System")} · ${escapeHtml(relativeTime(entry.created_at))}
          </div>
        </li>`
        )
        .join("")}
    </ol>
  `;
}

function partsUsedList(detail) {
  const parts = detail?.parts_used || [];
  if (!parts.length) return "";

  return `
    <hr />
    <h3>Parts used</h3>
    <ul class="parts-list">
      ${parts
        .map(
          (part) => `<li>
            <strong>${escapeHtml(part.name)}</strong> × ${Number(part.quantity)}
            <span class="small muted">${escapeHtml(part.sku)} · ${escapeHtml(relativeTime(part.created_at))}</span>
          </li>`
        )
        .join("")}
    </ul>
  `;
}

function commentAuthorName(comment, detail) {
  if (comment.authorId && comment.authorId === currentProfile?.id) return "You";
  if (comment.authorId && state.staffNames[comment.authorId]) {
    return state.staffNames[comment.authorId];
  }
  if (detail?.ticket?.created_by && comment.authorId === detail.ticket.created_by) {
    return detail.created_by_name || "Customer";
  }
  return comment.author || "Team member";
}

function renderTicketDetail(ticket) {
  if (!ticket) {
    return `<section class="panel" id="ticketDetail"><div class="empty-state">Select a ticket to see the full history, photos and replies.</div></section>`;
  }

  const detail = currentDetail();
  const role = userRole();
  const isStaff = ["agent", "technician", "admin"].includes(role);
  const canDeleteContent = role === "admin";
  // Prefer the freshly-loaded detail record over the cached dashboard list:
  // state.tickets only updates from the realtime subscription, which can
  // silently drop (backgrounded tab, network blip) and leave a permission
  // decision looking at a stale assignee until the next full reload.
  // currentDetail() is refetched whenever this ticket is (re)selected, so
  // it is the more current of the two whenever it has loaded.
  const assignedTechnicianId = detail?.ticket
    ? detail.ticket.assigned_technician_id
    : ticket.assignedTechnicianId;
  // Same staleness concern as assignedTechnicianId above: if another staff
  // member resolves or closes this ticket while this client's realtime
  // subscription has silently dropped, ticket.status here would still read
  // "in_progress" and keep offering the Add-photo form on a job that is
  // actually already finished.
  const ticketStatus = detail?.ticket ? detail.ticket.status : ticket.status;
  // Mirrors the "Staff update tickets" RLS policy exactly: an agent or admin
  // may edit any ticket, but a technician only one assigned to them — not
  // every ticket in the queue. Showing the edit form more broadly than the
  // database allows just produced a confusing "not permitted" error on save.
  const canEditAsStaff =
    role === "agent" ||
    role === "admin" ||
    (role === "technician" && assignedTechnicianId === currentProfile?.id);
  const canEdit = canEditAsStaff || (ticket.status === "new" && detail?.ticket?.created_by === currentProfile?.id);
  // Mirrors reassign_ticket()'s own permission check: a technician may only
  // touch a job that is unclaimed or already theirs. The control used to be
  // shown to every technician for every ticket, enabled, and only the RPC
  // rejected it — a confusing "not permitted" error on click instead of the
  // control simply not being offered.
  const canReassign =
    role === "agent" ||
    role === "admin" ||
    (role === "technician" &&
      (!assignedTechnicianId || assignedTechnicianId === currentProfile?.id));
  // A technician claiming an unclaimed job may only claim it for themselves
  // — reassign_ticket() now rejects handing an unclaimed job to a colleague,
  // so don't offer that colleague as an option in the first place.
  const technicianOptions =
    role === "technician" && !assignedTechnicianId
      ? state.technicians.filter((technician) => technician.id === currentProfile?.id)
      : state.technicians;
  const comments = ticketComments(ticket.id);

  const safeTicketId = escapeHtml(ticket.id);
  const safeTitle = escapeHtml(ticket.title);
  const safeNumber = escapeHtml(ticket.number);
  const safeLocation = escapeHtml(ticket.location || "");
  const priority = normalizePriority(ticket.priority);
  const raisedBy = escapeHtml(detail?.created_by_name || ticket.customer || "Customer");
  const companyName = escapeHtml(detail?.company_name || ticket.company || "");
  const description = detail?.ticket?.description || "";
  const callback = detail?.callback;
  const hasCoords = detail?.ticket?.location_lat != null && detail?.ticket?.location_lng != null;
  const nextStatuses = allowedStatusTransitions(role, ticketStatus);
  const selectedTechnicianId = assignedTechnicianId || "";

  return `
    <section class="detail-grid" id="ticketDetail">
      <article class="panel">
        <div class="panel-title">
          <div>
            <h2>${safeTitle}</h2>
            <p class="muted">${safeNumber} · version ${Number(ticket.version)} · ${escapeHtml(relativeTime(ticket.createdAt))}</p>
          </div>
          ${statusBadge(ticketStatus)}
        </div>

        ${
          callback
            ? `<div class="inline-banner inline-banner-warning callback-banner">
                 ☎ <strong>Callback requested</strong> on ${escapeHtml(callback.phone)}
                 ${
                   ["agent", "admin"].includes(role)
                     ? `<button class="primary-button compact-button" type="button" data-complete-callback="${escapeHtml(callback.id)}">Mark as called</button>`
                     : `<span class="small muted">An agent will call you back.</span>`
                 }
               </div>`
            : ""
        }

        <dl class="detail-facts">
          <div><dt>Raised by</dt><dd>${raisedBy}</dd></div>
          <div><dt>Company</dt><dd>${companyName || "—"}</dd></div>
          <div><dt>Priority</dt><dd>${escapeHtml(priority)}</dd></div>
          <div><dt>Technician</dt><dd>${escapeHtml(ticketTechnicianName(ticket))}</dd></div>
          <div>
            <dt>Location</dt>
            <dd>
              ${safeLocation || "Not provided"}
              ${
                safeLocation || hasCoords
                  ? `<button class="link-button" type="button" data-map-ticket="${safeTicketId}">Open map</button>`
                  : ""
              }
              ${hasCoords ? `<span class="badge badge-ok">GPS</span>` : ""}
            </dd>
          </div>
          ${
            detail?.ticket?.site_contact_phone
              ? `<div>
                   <dt>Site contact</dt>
                   <dd><a href="tel:${escapeHtml(telHref(detail.ticket.site_contact_phone))}">${escapeHtml(detail.ticket.site_contact_phone)}</a></dd>
                 </div>`
              : ""
          }
          ${
            detail?.ticket?.service_call_number
              ? `<div>
                   <dt>Service call number</dt>
                   <dd class="mono">${escapeHtml(detail.ticket.service_call_number)}</dd>
                 </div>`
              : ""
          }
        </dl>

        ${
          description
            ? `<div class="ticket-description"><h3>Description</h3><p>${escapeHtml(description)}</p></div>`
            : ""
        }

        ${
          detail?.ticket?.resolution_notes
            ? `<div class="ticket-description">
                 <h3>Resolution notes</h3>
                 <p>${escapeHtml(detail.ticket.resolution_notes)}</p>
               </div>`
            : ""
        }

        <hr />

        <h3>Attachments</h3>
        ${ticketDetail.loading && !detail ? `<div class="loading-spinner">Loading attachments…</div>` : attachmentGallery(detail)}

        ${
          canEditAsStaff && !["resolved", "closed"].includes(ticketStatus)
            ? `<form class="action-row" data-progress-photo-form="${safeTicketId}">
                 <label class="sr-only" for="progress-photo-${safeTicketId}">Add a photo</label>
                 <input id="progress-photo-${safeTicketId}" name="photo" type="file" accept="image/png,image/jpeg,image/webp" required />
                 <button class="secondary-button" type="submit">Add photo</button>
               </form>`
            : ""
        }

        ${
          canEdit
            ? `
        <hr />
        <details class="edit-block">
          <summary>Edit ticket details</summary>
          <form class="form-grid update-ticket-form" data-ticket-update-form="${safeTicketId}">
            <div class="field">
              <label for="edit-title-${safeTicketId}">Problem summary</label>
              <input id="edit-title-${safeTicketId}" name="title" value="${safeTitle}" maxlength="200" required />
            </div>
            <div class="field">
              <label for="edit-priority-${safeTicketId}">Priority</label>
              <select id="edit-priority-${safeTicketId}" name="priority">
                <option ${priority === "High" ? "selected" : ""}>High</option>
                <option ${priority === "Medium" ? "selected" : ""}>Medium</option>
                <option ${priority === "Low" ? "selected" : ""}>Low</option>
              </select>
            </div>
            <div class="field">
              <label for="edit-location-${safeTicketId}">Location</label>
              <input id="edit-location-${safeTicketId}" name="location" value="${safeLocation}" maxlength="200" />
            </div>
            <div class="field">
              <label for="edit-site-contact-${safeTicketId}">Site contact number</label>
              <input id="edit-site-contact-${safeTicketId}" name="siteContactPhone" type="tel" maxlength="20"
                     value="${escapeHtml(detail?.ticket?.site_contact_phone || "")}"
                     placeholder="Who should the technician call on arrival?" />
            </div>
            <div class="action-row">
              <button class="primary-button" type="submit">Save changes</button>
              ${
                canDeleteContent
                  ? `<button class="danger-button" type="button" data-delete-ticket="${safeTicketId}">Delete ticket</button>`
                  : ""
              }
            </div>
          </form>
        </details>`
            : ""
        }

        <hr />

        <h3>Conversation</h3>
        <div class="comment-thread">
          ${
            comments.length
              ? comments
                  .map((comment) => {
                    const safeCommentId = escapeHtml(comment.id);
                    const author = escapeHtml(commentAuthorName(comment, detail));
                    const mine = comment.authorId === currentProfile?.id;
                    return `
              <div class="comment ${mine ? "comment-mine" : ""}">
                <div class="comment-header">
                  <strong>${author}</strong>
                  <span class="small muted">${escapeHtml(comment.createdAt)}</span>
                  ${
                    comment.id && (canDeleteContent || mine)
                      ? `<button class="danger-button compact-button" type="button" data-delete-comment="${safeCommentId}">Delete</button>`
                      : ""
                  }
                </div>
                <p>${escapeHtml(comment.body)}</p>
              </div>`;
                  })
                  .join("")
              : `<div class="empty-state">No replies yet. Write the first one below.</div>`
          }
        </div>

        <form class="action-row comment-form" data-comment-form="${safeTicketId}">
          <label class="sr-only" for="comment-${safeTicketId}">Write a reply</label>
          <input id="comment-${safeTicketId}" name="comment" maxlength="4000" placeholder="Write a reply…" required />
          <button class="primary-button" type="submit">Send</button>
        </form>
      </article>

      <aside class="panel">
        <h3>Status</h3>
        ${
          nextStatuses.length
            ? `<div class="action-row">
                 ${nextStatuses
                   .map(
                     (status) =>
                       `<button class="secondary-button" type="button" data-status="${escapeHtml(status)}" data-ticket="${safeTicketId}">${escapeHtml(statusLabel(status))}</button>`
                   )
                   .join("")}
               </div>
               <p class="small muted">The database checks the ticket version on every change, so two people cannot overwrite each other.</p>`
            : `<p class="small muted">This ticket is ${escapeHtml(statusLabel(ticketStatus))}. You cannot change it from here.</p>`
        }

        ${
          canReassign
            ? `
        <hr />
        <h3>Technician</h3>
        <div class="field">
          <label for="technician-${safeTicketId}">Assign or hand over</label>
          <select id="technician-${safeTicketId}" data-technician-select="${safeTicketId}">
            <option value="">Unassigned</option>
            ${technicianOptions
              .map(
                (technician) => `
                  <option value="${escapeHtml(technician.id)}" ${
                    technician.id === selectedTechnicianId ? "selected" : ""
                  }>${escapeHtml(technician.name)}${technician.id === currentProfile?.id ? " (me)" : ""}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="field">
          <label for="handover-reason-${safeTicketId}">Reason (optional)</label>
          <input id="handover-reason-${safeTicketId}" data-handover-reason="${safeTicketId}" maxlength="200" placeholder="e.g. fully booked today" />
        </div>
        <button class="primary-button" type="button" data-assign-technician="${safeTicketId}" ${
                technicianOptions.length ? "" : "disabled"
              }>${selectedTechnicianId ? "Reassign" : "Assign"}</button>
        ${technicianOptions.length ? "" : `<p class="small muted">No approved technician accounts yet.</p>`}`
            : ""
        }

        ${
          !isStaff && !callback
            ? `
        <hr />
        <h3>Prefer a phone call?</h3>
        <form data-callback-form="${safeTicketId}">
          <div class="field">
            <label for="callback-phone-${safeTicketId}">Your phone number</label>
            <input id="callback-phone-${safeTicketId}" name="phone" type="tel" placeholder="07X XXX XXXX"
                   value="${escapeHtml(currentProfile?.phone || "")}" required />
          </div>
          <button class="secondary-button" type="submit">Request a callback</button>
        </form>`
            : ""
        }

        ${partsUsedList(detail)}

        <hr />
        <h3>History</h3>
        ${statusTimeline(detail)}
      </aside>
    </section>
  `;
}


// Toggles the login page between the normal form and the "email me a reset
// link" form, without a route change - Supabase needs a real page
// (reset-password.html) for the link itself, but requesting the link is
// just a different view of the same login screen.
let showForgotPassword = false;

function loginPage(message = "") {
  if (showForgotPassword) {
    return `
      <section class="auth-page">
        <form class="panel auth-card" id="forgotPasswordForm">
          <p class="auth-kicker">Secure helpdesk access</p>
          <h2>Reset your password</h2>
          <p class="muted">Enter the email on your account and we will send a link to set a new password.</p>
          <div class="field">
            <label for="forgot-email">Email</label>
            <input id="forgot-email" name="email" type="email" required />
          </div>
          <button class="primary-button" type="submit">Send reset link</button>
          <p class="auth-switch"><a href="#" id="backToLoginLink">Back to login</a></p>
        </form>
      </section>
    `;
  }

  return `
    <section class="auth-page">
      <form class="panel auth-card" id="loginForm">
        <p class="auth-kicker">Secure helpdesk access</p>
        <h2>Login</h2>
        ${message ? `<div class="notice">${message}</div>` : ""}
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" required />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" required />
        </div>
        <button class="primary-button" type="submit">Login</button>
        <p class="auth-switch"><a href="#" id="forgotPasswordLink">Forgot password?</a></p>
        <p class="auth-switch">New customer? <a href="register.html">Create an account</a></p>
      </form>
    </section>
  `;
}

function resetPasswordPage() {
  // Supabase appends #access_token=...&type=recovery&... to the redirect
  // URL from the reset email. Checking for it directly is synchronous and
  // available on first render - waiting on the PASSWORD_RECOVERY auth event
  // instead would work too, but only after an async round trip the page
  // would otherwise render once before.
  const hasRecoveryToken = window.location.hash.includes("type=recovery");

  if (!hasRecoveryToken) {
    return `
      <section class="auth-page">
        <article class="panel auth-card">
          <p class="auth-kicker">Reset password</p>
          <h2>This link has expired</h2>
          <p class="muted">Password reset links are single-use and expire after a short time. Request a new one from the login page.</p>
          <a class="primary-button" href="login.html">Back to login</a>
        </article>
      </section>
    `;
  }

  return `
    <section class="auth-page">
      <form class="panel auth-card" id="resetPasswordForm">
        <p class="auth-kicker">Reset password</p>
        <h2>Choose a new password</h2>
        <p class="muted">This link is single-use. Set a new password to finish signing back in.</p>
        <div class="field">
          <label for="new-password">New password</label>
          <input id="new-password" name="password" type="password" minlength="6" required />
        </div>
        <div class="field">
          <label for="confirm-password">Confirm password</label>
          <input id="confirm-password" name="confirmPassword" type="password" minlength="6" required />
        </div>
        <button class="primary-button" type="submit">Set new password</button>
      </form>
    </section>
  `;
}

function registerPage() {
  const company = currentCompany();

  return `
    <section class="auth-page">
      <form class="panel auth-card" id="registerForm">
        <p class="auth-kicker">New account</p>
        <h2>Register</h2>
        <p class="muted">Customer accounts on @${escapeHtml(company.domain)} are approved automatically. Personal email addresses, and all field-staff requests, are reviewed by an ABSL admin first.</p>
        <div class="field">
          <label for="reg-role">Register as</label>
          <select id="reg-role" name="role" required>
            <option value="customer">Customer</option>
            <option value="technician">Technician / Field Staff (needs admin approval)</option>
          </select>
        </div>
        <div class="field">
          <label for="reg-name">Full name</label>
          <input id="reg-name" name="fullName" required />
        </div>
        <div class="field">
          <label for="reg-company">Company name</label>
          <input id="reg-company" name="companyName" required />
        </div>
        <div class="field">
          <label for="reg-email">Email</label>
          <input id="reg-email" name="email" type="email" required />
        </div>
        <div class="field">
          <label for="reg-password">Password</label>
          <input id="reg-password" name="password" type="password" minlength="6" required />
        </div>
        <button class="primary-button" type="submit">Create Account</button>
        <p class="auth-switch">Already registered? <a href="login.html">Login here</a></p>
      </form>
    </section>
  `;
}

function pendingApprovalPage() {
  return `
    <section class="auth-page">
      <article class="panel auth-card">
        <p class="auth-kicker">Account pending</p>
        <h2>Waiting for admin approval</h2>
        <p class="muted">Your account exists, but an ABSL admin must approve it before you can open the dashboard.</p>
        <button class="secondary-button" type="button" id="signOutBtn">Sign Out</button>
      </article>
    </section>
  `;
}

function customerView() {
  const customerName = currentProfile?.full_name || currentUser?.email || "";
  const companyName = currentCompany().name;

  return `
    <section class="hero-grid">
      <div class="panel">
        <div class="panel-title">
          <h2>Create New Ticket</h2>
        </div>
        <form id="newTicketForm">
          <!-- Name and company come from the signed-in account. They used to be
               free-text boxes that were never sent to the database at all. -->
          <div class="identity-strip">
            <div>
              <span class="small muted">Raised by</span>
              <strong>${escapeHtml(customerName)}</strong>
            </div>
            <div>
              <span class="small muted">Company</span>
              <strong>${escapeHtml(companyName)}</strong>
            </div>
          </div>
          <input type="hidden" name="customer" value="${escapeHtml(customerName)}" />
          <input type="hidden" name="company" value="${escapeHtml(companyName)}" />
          <div class="field">
            <label for="title">Problem</label>
            <input id="title" name="title" minlength="3" maxlength="200"
                   placeholder="Example: scanner not reading barcodes" required />
          </div>
          <div class="field">
            <label for="description">What is happening?</label>
            <textarea id="description" name="description" rows="4" maxlength="5000"
                      placeholder="When did it start, what have you already tried, is the machine still usable?"></textarea>
            <span class="small muted">Optional, but it usually saves a phone call.</span>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="priority">Priority</label>
              <select id="priority" name="priority">
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </select>
            </div>
            <div class="field">
              <label for="location">Location</label>
              <input id="location" name="location" maxlength="200" placeholder="Customer site location" />
              <div class="recorder-row">
                <button class="secondary-button compact-button" type="button" id="useGpsBtn">📍 Use my location</button>
                <span id="gpsStatus" class="small muted" aria-live="polite"></span>
              </div>
              <input type="hidden" name="lat" id="ticketLat" />
              <input type="hidden" name="lng" id="ticketLng" />
              <input type="hidden" name="accuracy" id="ticketAccuracy" />
            </div>
          </div>
          <div class="field">
            <label for="siteContactPhone">Site contact number</label>
            <input id="siteContactPhone" name="siteContactPhone" type="tel" maxlength="20"
                   placeholder="Who should the technician call on arrival? 07X XXX XXXX" />
            <span class="small muted">Only if it is not you — a security guard, receptionist, or whoever is at the site.</span>
          </div>
          <label class="field inline-check">
            <span>Need phone callback?</span>
            <input type="checkbox" name="callback" id="wantsCallback" />
          </label>
          <div class="field" id="callbackPhoneField" hidden>
            <label for="callbackPhone">Phone number for the callback</label>
            <input id="callbackPhone" name="callbackPhone" type="tel" placeholder="07X XXX XXXX"
                   value="${escapeHtml(currentProfile?.phone || "")}" />
          </div>
          <div class="action-row">
            <button class="primary-button" type="submit">Submit Ticket</button>
          </div>
        </form>
      </div>
      <div class="panel">
        <h2>My Tickets</h2>
        ${ticketToolbar(filterTickets(state.tickets, state.filters).length)}
      </div>
    </section>
    <br />
    ${renderTicketDetail(selectedTicket())}
  `;
}

function agentView() {
  return `
    ${renderStats()}
    <br />
    <section class="hero-grid">
      <div class="panel">
        <div class="panel-title">
          <h2>Ticket Queue</h2>
          <div class="action-row">
            <a class="secondary-button" href="reports.html">Reports</a>
            <button class="secondary-button" type="button" id="loadRealTicketsBtn">Refresh</button>
          </div>
        </div>
        ${ticketToolbar(filterTickets(state.tickets, state.filters).length)}
      </div>
      <div class="panel">
        <div class="panel-title">
          <h2>Callback Queue</h2>
          <span class="badge ${state.callbackQueue.length ? "badge-danger" : "badge-muted"}">
            ${state.callbackQueue.length} waiting
          </span>
        </div>
        ${
          state.callbackQueue.length
            ? state.callbackQueue
                .map(
                  (callback) => `
          <div class="inventory-row">
            <div>
              <strong>${escapeHtml(callback.phone)}</strong>
              <p class="small muted">
                ${escapeHtml(callback.ticketNumber)} · ${escapeHtml(truncate(callback.title, 48))}
              </p>
              <span class="small muted">${escapeHtml(callback.customer)} · waiting ${escapeHtml(callback.waitingSince)}</span>
            </div>
            <div class="action-row">
              <a class="secondary-button compact-button" href="tel:${escapeHtml(telHref(callback.phone))}">Call</a>
              <button class="primary-button compact-button" type="button" data-complete-callback="${escapeHtml(callback.id)}">Done</button>
            </div>
          </div>`
                )
                .join("")
            : `<div class="empty-state">Nobody is waiting for a call.</div>`
        }
      </div>
    </section>
    <br />
    ${renderTicketDetail(selectedTicket())}
  `;
}

function technicianView() {
  // Only this technician's jobs. The old filter showed every assigned ticket
  // in the system, so an admin opening this page saw other people's work as
  // if it were their own.
  const myId = currentProfile?.id;
  const assigned = state.tickets.filter((ticket) => ticket.assignedTechnicianId === myId);
  const isMine = userRole() === "technician";

  return `
    ${renderStats()}
    <br />
    <section class="hero-grid">
      <div class="panel">
        <div class="panel-title">
          <h2>${isMine ? "My Jobs" : "Technician Jobs"}</h2>
          <span class="badge badge-muted">${assigned.length} assigned</span>
        </div>
        ${
          assigned.length
            ? renderTicketListCompact(assigned)
            : `<div class="empty-state">No jobs assigned to you right now. An agent will assign work here.</div>`
        }
      </div>
      <div class="panel">
        <h2>Parts Inventory</h2>
        ${
          state.inventory.length
            ? state.inventory
                .map(
                  (item) => `
            <div class="inventory-row">
              <div>
                <strong>${escapeHtml(item.name)}</strong>
                <p class="small muted">${escapeHtml(item.sku)} - ${escapeHtml(item.category)} - Stock: ${item.qty}</p>
              </div>
              <button class="primary-button" type="button" data-use-part="${escapeHtml(item.id)}" ${
                    item.qty <= 0 ? "disabled" : ""
                  }>Work</button>
            </div>
          `
                )
                .join("")
            : `<div class="empty-state">No inventory items found. Add inventory in Supabase before using parts.</div>`
        }
      </div>
    </section>
    <br />
    ${renderTicketDetail(selectedTicket())}
  `;
}

// Same shape as the ticket list's compact preview: a handful of cards next
// to whatever else shares the dashboard, with a "See all" link to a
// dedicated page instead of every row (which is how these four admin
// panels used to render - fine with a handful of rows, unusable once real
// usage piles up months of approvals, notifications, alerts or receipts
// into one endless scrolling card next to three short ones).
const ADMIN_LIST_PREVIEW_COUNT = 5;

function adminListPreview(items, rowRenderer, seeAllHref, seeAllNoun, emptyMessage) {
  if (!items.length) return `<div class="empty-state">${emptyMessage}</div>`;

  const visible = items.slice(0, ADMIN_LIST_PREVIEW_COUNT);
  const rows = visible.map(rowRenderer).join("");
  const more =
    items.length > ADMIN_LIST_PREVIEW_COUNT
      ? `<div class="ticket-list-more">
           <a class="secondary-button" href="${seeAllHref}">See all ${items.length} ${seeAllNoun}</a>
         </div>`
      : "";

  return rows + more;
}

// One row renderer per list, shared between the compact dashboard preview
// and that list's full page - the two used to duplicate this markup for
// ticket cards too, which is exactly how they quietly drifted apart.
function approvalRowHtml(approval) {
  return `
    <div class="inventory-row">
      <div>
        <strong>${escapeHtml(approval.name)}</strong>
        <p class="small muted">${escapeHtml(approval.email)} - ${escapeHtml(approval.company)}</p>
        <span class="badge ${approval.status === "approved" ? "badge-ok" : "badge-muted"}">${escapeHtml(approval.status)}</span>
        <span class="badge ${approval.requestedRole === "technician" ? "badge-danger" : "badge-muted"}">requests: ${escapeHtml(approval.requestedRole)}</span>
      </div>
      <div class="action-row">
        ${
          approval.status === "pending"
            ? `<button class="primary-button compact-button" type="button" data-approve="${escapeHtml(approval.id)}">Approve as ${escapeHtml(approval.requestedRole)}</button>
               <button class="danger-button compact-button" type="button" data-reject="${escapeHtml(approval.id)}">Reject</button>`
            : `<span class="small muted">Reviewed</span>`
        }
      </div>
    </div>
  `;
}

function notificationRowHtml(notification) {
  return `
    <div class="inventory-row">
      <div>
        <strong>${escapeHtml(notification.subject)}</strong>
        <p class="small muted">${escapeHtml(notification.channel)} - attempts: ${notification.attempts}</p>
        <span class="badge ${notification.status === "dead_letter" ? "badge-danger" : "badge-muted"}">${escapeHtml(notification.status)}</span>
      </div>
      <button class="secondary-button compact-button" type="button" data-retry="${escapeHtml(notification.id)}">Retry</button>
    </div>
  `;
}

function alertRowHtml(alert) {
  return `
    <div class="alert-card">
      <div class="alert-severity alert-severity-${escapeHtml(alert.severity)}"></div>
      <div>
        <strong>${escapeHtml(alert.title)}</strong>
        <p class="small muted">${escapeHtml(alert.body)}</p>
        <span class="small muted">${new Date(alert.created_at).toLocaleString()}</span>
      </div>
      <div>
        ${
          !alert.acknowledged
            ? `<button class="primary-button compact-button" type="button" data-ack-alert="${escapeHtml(alert.id)}">Acknowledge</button>`
            : `<span class="badge badge-muted">Acknowledged</span>`
        }
      </div>
    </div>
  `;
}

function receiptRowHtml(receipt) {
  return `
    <div class="inventory-row">
      <div>
        <strong class="mono">${escapeHtml(receipt.receipt_number)}</strong>
        ${receipt.service_call_number ? `<span class="badge badge-ok mono">${escapeHtml(receipt.service_call_number)}</span>` : ""}
        <p class="small muted">
          ${escapeHtml(receipt.ticket_number)} · ${escapeHtml(receipt.customer_name || "—")}
          ${receipt.company_name ? ` · ${escapeHtml(receipt.company_name)}` : ""}
        </p>
        <span class="small muted">${escapeHtml(relativeTime(receipt.resolved_at))}</span>
      </div>
      <button class="secondary-button compact-button" type="button" data-view-receipt="${escapeHtml(receipt.id)}">View</button>
    </div>
  `;
}

function clientErrorRowHtml(err) {
  const who = (err.profile_id && state.staffNames[err.profile_id]) || "A customer";
  const page = (err.page_url || "").replace(window.location.origin, "") || "unknown page";

  return `
    <div class="inventory-row">
      <div>
        <strong>${escapeHtml(truncate(err.message, 140))}</strong>
        <p class="small muted">${escapeHtml(who)} · ${escapeHtml(page)}</p>
        <span class="small muted">${escapeHtml(relativeTime(err.created_at))}</span>
      </div>
      ${
        !err.acknowledged
          ? `<button class="primary-button compact-button" type="button" data-ack-client-error="${escapeHtml(err.id)}">Acknowledge</button>`
          : `<span class="badge badge-muted">Acknowledged</span>`
      }
    </div>
  `;
}

// route -> { title, badge, items, rowRenderer, emptyMessage } for the five
// "See all" pages above. One generic page renderer and one generic route
// branch in render() use this instead of five near-identical copies.
function adminListRoutes() {
  return {
    approvals: {
      title: "User Approvals",
      items: state.approvals,
      rowRenderer: approvalRowHtml,
      emptyMessage: "No approval requests are waiting."
    },
    notifications: {
      title: "Notifications",
      items: state.notifications,
      rowRenderer: notificationRowHtml,
      emptyMessage: "No notifications are queued."
    },
    "system-alerts": {
      title: "Admin System Alerts",
      items: adminAlerts,
      rowRenderer: alertRowHtml,
      emptyMessage: "No critical system events logged."
    },
    receipts: {
      title: "Resolution Receipts",
      items: state.receipts,
      rowRenderer: receiptRowHtml,
      emptyMessage: "No tickets have been resolved yet."
    },
    "client-errors": {
      title: "Client Errors",
      items: state.clientErrors,
      rowRenderer: clientErrorRowHtml,
      emptyMessage: "No browser errors reported."
    }
  };
}

function adminListPage(route) {
  const list = adminListRoutes()[route];
  if (!list) return `<div class="panel"><div class="empty-state">Page not found.</div></div>`;

  return `
    <div class="panel">
      <div class="panel-title">
        <h2>${escapeHtml(list.title)}</h2>
        <a class="secondary-button" href="admin.html">Back</a>
      </div>
      ${
        list.items.length
          ? list.items.map(list.rowRenderer).join("")
          : `<div class="empty-state">${list.emptyMessage}</div>`
      }
    </div>
  `;
}

function adminView() {
  const company = currentCompany();

  return `
    ${renderStats()}
    <br />
    <div class="action-row" style="margin-bottom: 20px; align-items: center;">
      <span class="small muted">• Click here to view service reports</span>
      <a class="secondary-button" href="reports.html">Reports</a>
    </div>
    <section class="dashboard-grid">
      <article class="panel">
        <div class="panel-title">
          <h2>User Approvals</h2>
          <span class="badge badge-muted">Personal email review</span>
        </div>
        ${adminListPreview(
          state.approvals,
          approvalRowHtml,
          "approvals.html",
          "requests",
          "No approval requests are waiting."
        )}
      </article>

      <article class="panel">
        <h2>Company Limit</h2>
        <p class="muted">When a company reaches the account limit, admin can increase or reject the request.</p>
        ${
          state.companies.length
            ? `
        <div class="field">
          <label for="companySelect">Company</label>
          <select id="companySelect">
            ${state.companies
              .map(
                (item) => `
              <option value="${escapeHtml(item.id)}" ${item.id === company.id ? "selected" : ""}>
                ${escapeHtml(item.name)} (limit ${item.accountLimit})
              </option>`
              )
              .join("")}
          </select>
        </div>
        <div class="notice">${escapeHtml(company.name)} current customer limit: ${company.accountLimit} users.</div>
        <div class="field">
          <label for="companyLimitInput">New account limit</label>
          <input id="companyLimitInput" type="number" min="1" value="${company.accountLimit}" />
        </div>
        <div class="action-row">
          <button class="primary-button" type="button" id="updateCompanyLimitBtn">Update Limit</button>
        </div>`
            : `<div class="empty-state">No companies loaded yet.</div>`
        }
      </article>

      <article class="panel">
        <h2>Notifications</h2>
        ${adminListPreview(
          state.notifications,
          notificationRowHtml,
          "notifications.html",
          "notifications",
          "No notifications are queued."
        )}
      </article>
    </section>
    
    <br />
    
    <section class="dashboard-grid">
      <article class="panel panel-span-2">
        <div class="panel-title">
          <h2>Admin System Alerts</h2>
          <span class="badge badge-danger">Dead-letter Escalate</span>
        </div>
        ${adminListPreview(
          adminAlerts,
          alertRowHtml,
          "system-alerts.html",
          "alerts",
          "No critical system events logged."
        )}
      </article>

      <article class="panel">
        <div class="panel-title">
          <h2>Inventory CSV Cleanup</h2>
          <span class="badge badge-muted">Migration ready</span>
        </div>
        <p class="muted">Use the script in scripts/import_inventory_csv.js to clean old spreadsheet data before loading it into Supabase.</p>
      </article>

      <article class="panel panel-span-full">
        <div class="panel-title">
          <h2>Resolution Receipts</h2>
          <span class="badge badge-muted">${state.receipts.length} on file</span>
        </div>
        <p class="muted small">Generated automatically the moment a ticket is marked Resolved. Each one keeps its own record — deleting the ticket later does not remove its receipt.</p>
        ${adminListPreview(
          state.receipts,
          receiptRowHtml,
          "receipts.html",
          "receipts",
          "No tickets have been resolved yet."
        )}
      </article>

      <article class="panel panel-span-full">
        <div class="panel-title">
          <h2>Client Errors</h2>
          <span class="badge ${state.clientErrors.some((err) => !err.acknowledged) ? "badge-danger" : "badge-muted"}">
            ${state.clientErrors.filter((err) => !err.acknowledged).length} unacknowledged
          </span>
        </div>
        <p class="muted small">A JavaScript error a real signed-in user actually hit in their browser, reported automatically - not a test, not a log line someone has to go looking for.</p>
        ${adminListPreview(
          state.clientErrors,
          clientErrorRowHtml,
          "client-errors.html",
          "errors",
          "No browser errors reported."
        )}
      </article>
    </section>
  `;
}

function render() {
  const app = document.querySelector("#app");
  const badge = document.querySelector("#connectionBadge");
  
  if (badge) {
    badge.textContent = supabaseClient ? "Connected" : "Supabase not connected";
    badge.className = supabaseClient ? "badge badge-ok" : "badge badge-muted";
  }

  const views = {
    customer: {
      title: portals.customer.name,
      description: "Create support tickets, request callback support, and follow updates.",
      render: customerView
    },
    agent: {
      title: portals.agent.name,
      description: "Review incoming tickets, reply to customers, assign technicians, and update ticket progress.",
      render: agentView
    },
    technician: {
      title: portals.technician.name,
      description: "Open your assigned field jobs, consume inventory with the Work button, and keep job notes up to date.",
      render: technicianView
    },
    admin: {
      title: portals.admin.name,
      description: "Approve users, manage company account limits, monitor notifications, and keep the platform healthy.",
      render: adminView
    }
  };

  const route = currentRoute() || (currentUser ? dashboardRouteForRole() : "login");
  updateNavigation(route);

  if (!currentRoute()) {
    navigateTo(route);
    return;
  }

  // Checked before the logged-in-redirect below: a password reset link logs
  // the visitor in via a short-lived recovery session, so currentUser is
  // set here on a legitimate visit. Redirecting them into the dashboard
  // instead of letting them set a new password would defeat the feature.
  if (route === "reset-password") {
    app.innerHTML = resetPasswordPage();
    bindEvents();
    // Supabase's client already consumed the recovery token from the URL
    // fragment by this point (it processes the hash during client
    // startup, well before this render happens); scrub it from the
    // address bar and history now so a live access_token/refresh_token
    // doesn't keep sitting there for the rest of this page visit (in
    // browser history, and previously also in error logs - see
    // logClientError()'s page_url handling). Guarded by the hash still
    // being present so this runs once, not on every re-render.
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    return;
  }

  if (currentUser && publicRoutes.includes(route)) {
    navigateTo(dashboardRouteForRole());
    return;
  }

  if (route === "login") {
    app.innerHTML = loginPage();
    bindEvents();
    return;
  }

  if (route === "register") {
    app.innerHTML = registerPage();
    bindEvents();
    return;
  }

  if (route === "tickets") {
    if (!currentUser) {
      app.innerHTML = loginPage("Please login before opening your tickets.");
      bindEvents();
      return;
    }

    if (currentProfile?.approval_status && currentProfile.approval_status !== "approved") {
      app.innerHTML = pendingApprovalPage();
      bindEvents();
      return;
    }

    // Keep the signed-in role's own colour and identity — this is a detail
    // page reached from inside a portal, not a portal of its own, so
    // state.role stays whatever it already was rather than being set here.
    document.body.dataset.portal = portals[dashboardRouteForRole()]?.accent || "customer";
    app.innerHTML = pageHeading("My Tickets", "Every ticket you can see, searchable and fully paginated.") + ticketsPage();
    bindEvents();
    return;
  }

  if (adminOnlyExtraRoutes.includes(route)) {
    if (!currentUser) {
      app.innerHTML = loginPage(`Please login before opening ${routeLabel(route)}.`);
      bindEvents();
      return;
    }

    if (currentProfile?.approval_status && currentProfile.approval_status !== "approved") {
      app.innerHTML = pendingApprovalPage();
      bindEvents();
      return;
    }

    if (!canAccessRoute(route)) {
      navigateTo(dashboardRouteForRole());
      return;
    }

    document.body.dataset.portal = "admin";
    app.innerHTML = pageHeading(routeLabel(route), "Full list.") + adminListPage(route);
    bindEvents();
    return;
  }

  if (staffReportRoutes.includes(route)) {
    if (!currentUser) {
      app.innerHTML = loginPage(`Please login before opening ${routeLabel(route)}.`);
      bindEvents();
      return;
    }

    if (currentProfile?.approval_status && currentProfile.approval_status !== "approved") {
      app.innerHTML = pendingApprovalPage();
      bindEvents();
      return;
    }

    if (!canAccessRoute(route)) {
      navigateTo(dashboardRouteForRole());
      return;
    }

    document.body.dataset.portal = portals[dashboardRouteForRole()]?.accent || "agent";
    app.innerHTML = pageHeading("Reports", "Every job's fault, findings and resolution in one searchable place.") + reportsPage();
    bindEvents();
    return;
  }

  if (!dashboardRoutes.includes(route)) {
    app.innerHTML = loginPage("This page was not found. Please login to continue.");
    bindEvents();
    return;
  }

  if (!currentUser) {
    app.innerHTML = loginPage(`Please login before opening the ${routeLabel(route)}.`);
    bindEvents();
    return;
  }

  if (currentProfile?.approval_status && currentProfile.approval_status !== "approved") {
    app.innerHTML = pendingApprovalPage();
    bindEvents();
    return;
  }

  if (!canAccessRoute(route)) {
    navigateTo(dashboardRouteForRole());
    return;
  }

  state.role = route;
  saveState();

  // Give each portal its own colour and name, so nobody has to guess which
  // one they are looking at.
  document.body.dataset.portal = portals[route]?.accent || "customer";

  let headerHtml = pageHeading(views[route].title, views[route].description);

  // The CEO can open the other three portals; make it obvious that this is
  // not their own desk.
  if (userRole() === "admin" && route !== "admin") {
    headerHtml =
      `<div class="inline-banner inline-banner-warning" style="margin-bottom: 20px;">
         👁 <strong>Viewing as admin:</strong> this is the ${escapeHtml(views[route].title)}.
         <a href="admin.html">Back to the CEO Console</a>
       </div>` + headerHtml;
  }

  // Prepends warning banner if offline
  if (!supabaseClient) {
    headerHtml = `
      <div class="inline-banner inline-banner-warning" style="margin-bottom: 20px;">
        ⚠️ <strong>Database Offline:</strong> Running in demo mock mode (using LocalStorage). Configure config.js to connect to Supabase.
      </div>
    ` + headerHtml;
  }

  app.innerHTML = headerHtml + views[route].render();
  bindEvents();
}

function updateNavigation(route) {
  const appNav = document.querySelector("#appNav");
  const publicLinks = document.querySelectorAll(".public-link");
  const signOutBtnGlobal = document.querySelector("#signOutBtnGlobal");
  const allowedRoutes = allowedDashboardRoutes();
  // A password reset link establishes a real currentUser via a short-lived
  // recovery session, but showing the full portal nav here would invite
  // clicking into a dashboard mid-reset. Treat this page as logged-out for
  // navigation purposes regardless of that session.
  const isLoggedIn = Boolean(currentUser) && route !== "reset-password";

  if (appNav) appNav.hidden = !isLoggedIn;
  if (signOutBtnGlobal) signOutBtnGlobal.hidden = !isLoggedIn;
  publicLinks.forEach((link) => {
    link.hidden = isLoggedIn;
  });

  document.querySelectorAll("[data-route]").forEach((link) => {
    const linkRoute = link.dataset.route;
    link.hidden = isLoggedIn && !allowedRoutes.includes(linkRoute);
    link.classList.toggle("is-active", linkRoute === route);
  });
}

function bindEvents() {
  // NOTE: the "quick demo login" buttons were removed before launch. They
  // autofilled live production credentials (including the CEO admin account)
  // for anyone who opened the login page.

  document.querySelectorAll("[data-route]").forEach((link) => {
    link.onclick = () => setRole(link.dataset.route);
  });

  document.querySelectorAll("[data-open-ticket]").forEach((button) => {
    button.onclick = () => openTicket(button.dataset.openTicket);
  });

  document.querySelectorAll("[data-ticket-update-form]").forEach((form) => {
    form.onsubmit = (event) => updateTicketDetails(event, form.dataset.ticketUpdateForm);
  });

  document.querySelectorAll("[data-delete-ticket]").forEach((button) => {
    button.onclick = () => deleteTicket(button.dataset.deleteTicket);
  });

  document.querySelectorAll("[data-delete-comment]").forEach((button) => {
    button.onclick = () => deleteComment(button.dataset.deleteComment);
  });

  document.querySelectorAll("[data-status]").forEach((button) => {
    button.onclick = () => {
      const ticketId = button.dataset.ticket;
      const status = button.dataset.status;
      // Was technician-only - an agent or admin resolving directly (from
      // the Agent Desk, the CEO Console, or an admin "viewing as" another
      // portal) bypassed this form entirely, so the ticket got marked
      // Resolved with no service call number, notes or receipt on file
      // and nothing on screen explained why. Only staff can even see a
      // "Resolved" button in the first place (allowedStatusTransitions()
      // never offers it to a customer), so no role check is needed here.
      if (status === "resolved") {
        openResolveTicketModal(ticketId);
        return;
      }
      updateTicketStatus(ticketId, status);
    };
  });

  document.querySelectorAll("[data-use-part]").forEach((button) => {
    button.onclick = () => useInventory(button.dataset.usePart);
  });

  document.querySelectorAll("[data-approve]").forEach((button) => {
    button.onclick = () => approveUser(button.dataset.approve, "approved");
  });

  document.querySelectorAll("[data-reject]").forEach((button) => {
    button.onclick = () => approveUser(button.dataset.reject, "rejected");
  });

  document.querySelectorAll("[data-retry]").forEach((button) => {
    button.onclick = () => retryNotification(button.dataset.retry);
  });

  document.querySelectorAll("[data-ack-alert]").forEach((button) => {
    button.onclick = () => acknowledgeAlert(button.dataset.ackAlert);
  });

  document.querySelectorAll("[data-ack-client-error]").forEach((button) => {
    button.onclick = () => acknowledgeClientError(button.dataset.ackClientError);
  });

  document.querySelectorAll("[data-view-receipt]").forEach((button) => {
    button.onclick = () => openReceiptModal(button.dataset.viewReceipt);
  });

  document.querySelectorAll("[data-assign-technician]").forEach((button) => {
    button.onclick = () => {
      const ticketId = button.dataset.assignTechnician;
      const select = document.querySelector(`[data-technician-select="${ticketId}"]`);
      const reason = document.querySelector(`[data-handover-reason="${ticketId}"]`);
      assignTechnician(ticketId, select ? select.value : "", reason ? reason.value.trim() : "");
    };
  });

  document.querySelectorAll("[data-callback-form]").forEach((form) => {
    form.onsubmit = (event) => requestCallback(event, form.dataset.callbackForm);
  });

  document.querySelectorAll("[data-complete-callback]").forEach((button) => {
    button.onclick = () => completeCallback(button.dataset.completeCallback);
  });

  const useGpsBtn = document.querySelector("#useGpsBtn");
  if (useGpsBtn) useGpsBtn.onclick = captureLocation;

  const wantsCallback = document.querySelector("#wantsCallback");
  const callbackPhoneField = document.querySelector("#callbackPhoneField");
  if (wantsCallback && callbackPhoneField) {
    callbackPhoneField.hidden = !wantsCallback.checked;
    wantsCallback.onchange = () => {
      callbackPhoneField.hidden = !wantsCallback.checked;
    };
  }

  const ticketSearch = document.querySelector("#ticketSearch");
  if (ticketSearch) {
    ticketSearch.oninput = () => {
      state.filters.query = ticketSearch.value;
      state.page = 1;
      renderTicketListOnly();
    };
  }

  document.querySelectorAll("[data-filter]").forEach((select) => {
    select.onchange = () => {
      state.filters[select.dataset.filter] = select.value;
      state.page = 1;
      render();
    };
  });

  document.querySelectorAll("[data-page]").forEach((button) => {
    button.onclick = () => {
      state.page = Number(button.dataset.page);
      render();
      document.querySelector("#app")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  document.querySelectorAll("[data-map]").forEach((button) => {
    button.onclick = () => {
      const location = button.dataset.map;
      if (!location) {
        showToast("No location was provided for this ticket.", "warning");
        return;
      }
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`, "_blank");
    };
  });

  // Diagram 9: prefer the GPS pin the customer shared; fall back to a text
  // search on the address they typed.
  document.querySelectorAll("[data-map-ticket]").forEach((button) => {
    button.onclick = () => {
      const ticketId = button.dataset.mapTicket;
      const ticket = state.tickets.find((item) => item.id === ticketId);
      const detail = ticketDetail.id === ticketId ? ticketDetail.data : null;
      const lat = detail?.ticket?.location_lat;
      const lng = detail?.ticket?.location_lng;

      if (lat != null && lng != null) {
        window.open(
          `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`,
          "_blank",
          "noopener"
        );
        return;
      }

      if (!ticket?.location) {
        showToast("No location was provided for this ticket.", "warning");
        return;
      }

      window.open(
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ticket.location)}`,
        "_blank",
        "noopener"
      );
    };
  });

  document.querySelectorAll("[data-comment-form]").forEach((form) => {
    form.onsubmit = (event) => addComment(event, form.dataset.commentForm);
  });

  document.querySelectorAll("[data-progress-photo-form]").forEach((form) => {
    form.onsubmit = (event) => addProgressPhoto(event, form.dataset.progressPhotoForm);
  });

  document.querySelectorAll("[data-delete-attachment]").forEach((button) => {
    button.onclick = () =>
      deleteAttachment(
        button.dataset.deleteAttachment,
        button.dataset.attachmentBucket,
        button.dataset.attachmentPath,
        button.dataset.attachmentTicket
      );
  });

  const reportSearchForm = document.querySelector("#reportSearchForm");
  if (reportSearchForm) reportSearchForm.onsubmit = searchReports;

  const exportReportsBtn = document.querySelector("#exportReportsBtn");
  if (exportReportsBtn) exportReportsBtn.onclick = exportReportsToCsv;

  document.querySelectorAll("[data-view-report]").forEach((button) => {
    button.onclick = () => openReportSummaryModal(button.dataset.viewReport);
  });

  const loginForm = document.querySelector("#loginForm");
  if (loginForm) loginForm.onsubmit = signInUser;

  const forgotPasswordLink = document.querySelector("#forgotPasswordLink");
  if (forgotPasswordLink) {
    forgotPasswordLink.onclick = (event) => {
      event.preventDefault();
      showForgotPassword = true;
      render();
    };
  }

  const backToLoginLink = document.querySelector("#backToLoginLink");
  if (backToLoginLink) {
    backToLoginLink.onclick = (event) => {
      event.preventDefault();
      showForgotPassword = false;
      render();
    };
  }

  const forgotPasswordForm = document.querySelector("#forgotPasswordForm");
  if (forgotPasswordForm) forgotPasswordForm.onsubmit = requestPasswordReset;

  const resetPasswordForm = document.querySelector("#resetPasswordForm");
  if (resetPasswordForm) resetPasswordForm.onsubmit = updatePassword;

  const registerForm = document.querySelector("#registerForm");
  if (registerForm) registerForm.onsubmit = signUpUser;

  const signOutBtn = document.querySelector("#signOutBtn");
  if (signOutBtn) signOutBtn.onclick = signOutUser;

  const signOutBtnGlobal = document.querySelector("#signOutBtnGlobal");
  if (signOutBtnGlobal) signOutBtnGlobal.onclick = signOutUser;

  const newTicketForm = document.querySelector("#newTicketForm");
  if (newTicketForm) newTicketForm.onsubmit = createTicket;

  const loadRealTicketsBtn = document.querySelector("#loadRealTicketsBtn");
  if (loadRealTicketsBtn) loadRealTicketsBtn.onclick = loadRealSupportData;

  const updateCompanyLimitBtn = document.querySelector("#updateCompanyLimitBtn");
  if (updateCompanyLimitBtn) updateCompanyLimitBtn.onclick = handleCompanyLimitUpdate;

  const companySelect = document.querySelector("#companySelect");
  if (companySelect) {
    companySelect.onchange = () => {
      state.selectedCompanyId = companySelect.value;
      saveState();
      render();
    };
  }
}

window.addEventListener("hashchange", render);

// --- Error boundary ----------------------------------------------------
// Without this, a thrown error left the customer looking at a half-drawn
// screen with no idea anything had gone wrong.
let lastErrorAt = 0;

function reportUnexpectedError(source, error) {
  console.error(`[ABSL] ${source}`, error);

  // One entry point for both halves of "something broke": tell the admin
  // console (logClientError, its own separate 30s-per-message dedup) and
  // tell the person looking at the screen right now (the toast below,
  // rate-limited separately). These used to be two independently
  // registered window.addEventListener("error"/"unhandledrejection")
  // pairs; merged into this single existing handler instead.
  logClientError(
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? error.stack : undefined
  );

  // One message per five seconds; a render loop must not become a toast loop.
  const now = Date.now();
  if (now - lastErrorAt < 5000) return;
  lastErrorAt = now;

  showToast(
    "Something went wrong on this screen. Reload the page, and tell ABSL support if it keeps happening.",
    "error"
  );
}

window.addEventListener("error", (event) => {
  reportUnexpectedError("uncaught", event.error || event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportUnexpectedError("promise", event.reason);
});

// --- Connection state --------------------------------------------------
function updateConnectionBadge() {
  const badge = document.querySelector("#connectionBadge");
  if (!badge) return;

  if (!navigator.onLine) {
    badge.textContent = "Offline";
    badge.className = "badge badge-danger";
    return;
  }

  badge.textContent = supabaseClient ? "Connected" : "Not connected";
  badge.className = supabaseClient ? "badge badge-ok" : "badge badge-muted";
}

window.addEventListener("offline", () => {
  updateConnectionBadge();
  showToast("You are offline. Changes will not be saved until the connection returns.", "warning");
});

window.addEventListener("online", async () => {
  updateConnectionBadge();
  showToast("Back online.", "success");
  if (currentUser) await loadRealSupportData();
});

// --- Session ------------------------------------------------------------
// A token can expire or be revoked in another tab. React to it instead of
// leaving the user clicking buttons that will all fail.
if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && currentUser) {
      currentUser = null;
      currentProfile = null;
      state = structuredClone(initialState);
      localStorage.removeItem(storageKey);
      showToast("Your session ended. Please sign in again.", "info");
      navigateTo("login");
    }
  });
}

loadCurrentUser()
  .then(async () => {
    // A password reset link signs the visitor in via a short-lived recovery
    // session so it can call updateUser() - that is not a real login, and
    // loading the full dashboard for it is both wasted work and the wrong
    // screen to land on before a new password has even been set.
    if (currentUser && currentRoute() !== "reset-password") {
      subscribeToTicketUpdates();
      await loadRealSupportData({ shouldRender: false });
      if (state.selectedTicketId) await loadTicketDetail(state.selectedTicketId);
    }
    render();
    updateConnectionBadge();
  })
  .catch((err) => {
    reportUnexpectedError("startup", err);
    render();
  });
