document.addEventListener("DOMContentLoaded", async () => {
  const notice = document.getElementById("notice");
  const currency = (cents, code = "ZAR") => new Intl.NumberFormat("en-ZA", { style: "currency", currency: code }).format((cents || 0) / 100);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const showNotice = (message, error = false) => {
    notice.textContent = message;
    notice.hidden = false;
    notice.classList.toggle("error", error);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  }
  const formObject = (form) => Object.fromEntries(new FormData(form).entries());
  const moneyToCents = (amount) => Math.round(Number(amount || 0) * 100);
  let currentUser;
  let inventory = [];

  try {
    ({ user: currentUser } = await api("/staff/session"));
  } catch {
    window.location.replace("/login.html?staff=1");
    return;
  }
  const roleTitles = {
    director: "Director", guest_relations_manager: "Guest Relations Manager",
    conference_coordinator: "Conference Coordinator", general_worker: "General Worker",
    housekeeping: "Housekeeping"
  };
  document.getElementById("staff-name").textContent =
    `${currentUser.name} · ${currentUser.role === "admin" ? "Administrator" : roleTitles[currentUser.staff_role] || "Staff"}`;
  const rolePanels = {
    director: ["overview", "bookings", "availability", "catalogue", "guests", "inquiries", "finances", "tasks", "attendance", "workforce", "calendar", "guest-services", "announcements", "mail", "settings"],
    guest_relations_manager: ["overview", "bookings", "guests", "inquiries", "tasks", "workforce", "calendar", "guest-services", "announcements", "mail"],
    conference_coordinator: ["overview", "bookings", "availability", "catalogue", "tasks", "workforce", "calendar", "announcements"],
    general_worker: ["overview", "tasks", "attendance", "workforce", "calendar"],
    housekeeping: ["overview", "tasks", "attendance", "workforce", "calendar"]
  };
  if (currentUser.role !== "admin") {
    const allowedPanels = rolePanels[currentUser.staff_role] || rolePanels.general_worker;
    document.querySelectorAll("[data-panel]").forEach(button => {
      button.hidden = !allowedPanels.includes(button.dataset.panel);
    });
  }
  document.getElementById("sign-out").addEventListener("click", async () => {
    try {
      await api("/logout", { method: "POST" });
      window.location.replace("/login.html");
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  const panels = [...document.querySelectorAll(".panel")];
  document.getElementById("staff-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-panel]");
    if (!button) return;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    panels.forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${button.dataset.panel}`));
    const loaders = {
      overview: loadDashboard, bookings: loadBookings, availability: loadInventory, catalogue: loadCatalogue, guests: loadGuests,
      inquiries: loadInquiries, finances: loadFinances, tasks: loadTasks, team: loadUsers, mail: loadEmails,
      settings: loadSettings, attendance: loadAttendance, workforce: loadWorkforce,
      calendar: loadCalendar, "guest-services": loadBreakfast, announcements: loadAnnouncements
    };
    loaders[button.dataset.panel]?.().catch((error) => showNotice(error.message, true));
  });
  document.querySelectorAll("[data-refresh]").forEach((button) => button.addEventListener("click", () => {
    const active = document.querySelector(".nav-item.active")?.dataset.panel;
    const refresh = {
      overview: loadDashboard, bookings: loadBookings, availability: loadInventory,
      team: loadUsers, attendance: loadAttendance, workforce: loadWorkforce,
      calendar: loadCalendar, "guest-services": loadBreakfast, announcements: loadAnnouncements
    }[active] || loadDashboard;
    refresh().catch((error) => showNotice(error.message, true));
  }));

  async function loadDashboard() {
    const { summary } = await api("/staff/dashboard");
    const metrics = [
      ["Awaiting review", summary.pending_bookings],
      ["Arrivals today", summary.arrivals_today],
      ["Departures today", summary.departures_today],
      ["New enquiries", summary.new_inquiries],
      ["Open service tasks", summary.open_tasks],
      ["Email needing attention", summary.queued_emails]
    ];
    document.getElementById("summary-cards").innerHTML = metrics.map(([label, value]) =>
      `<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("");
    document.getElementById("upcoming-arrivals").innerHTML = summary.upcoming_arrivals.length
      ? `<div class="table-wrap"><table><thead><tr><th>Arrival</th><th>Guest</th><th>Room / venue</th><th>Depart</th><th>Guests</th></tr></thead><tbody>${summary.upcoming_arrivals.map((booking) =>
        `<tr><td>${escape(booking.checkin_date)}</td><td>Reservation ${escape(booking.id)}</td><td>${escape(booking.booking_option)}</td><td>${escape(booking.checkout_date)}</td><td>${escape(booking.guests)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty">No upcoming confirmed arrivals.</p>`;
  }

  async function loadInventory() {
    ({ resources: inventory } = await api("/staff/inventory"));
    document.getElementById("inventory-rows").innerHTML = inventory.length ? inventory.map((resource) =>
      `<tr><td>${escape(resource.slug)}</td><td>${escape(resource.name)}<br><span class="muted">${escape(resource.category)}</span></td><td>${escape(resource.units)} units · ${escape(resource.max_guests)} guests/unit</td><td>${resource.price_per_unit_cents == null ? "Quote required" : currency(resource.price_per_unit_cents, resource.currency)}</td><td><span class="status-pill ${resource.active ? "confirmed" : "disabled"}">${resource.active ? "active" : "inactive"}</span></td><td><details><summary>Edit item</summary><form class="resource-edit-form form-grid" data-resource-id="${resource.id}">
        <label>Name <input name="name" value="${escape(resource.name)}" required></label>
        <label>Category <select name="category">${["accommodation", "conference", "dining", "leisure"].map(category => `<option ${category === resource.category ? "selected" : ""}>${category}</option>`).join("")}</select></label>
        <label>Description <input name="description" value="${escape(resource.description)}"></label>
        <label>Available units <input name="units" type="number" min="1" value="${Number(resource.units)}" required></label>
        <label>Guests per unit <input name="max_guests" type="number" min="1" value="${Number(resource.max_guests)}" required></label>
        <label>Rate per unit/day (ZAR) <input name="price" type="number" min="0" step="0.01" value="${resource.price_per_unit_cents == null ? "" : (resource.price_per_unit_cents / 100).toFixed(2)}"></label>
        <button class="button button-small">Save changes</button></form></details>
        ${resource.active ? `<button class="button button-small" data-resource-disable="${resource.id}">Deactivate</button>` : ""}</td></tr>`
    ).join("") : `<tr><td colspan="6" class="empty">Add rooms, venues, or services to enable date availability and automated confirmations.</td></tr>`;
    const options = inventory.filter((item) => item.active).map((item) =>
      `<option value="${escape(item.slug)}">${escape(item.name)} (${escape(item.slug)})</option>`).join("");
    document.getElementById("availability-resource").innerHTML = options || `<option value="">Add inventory first</option>`;
  }

  async function loadBookings() {
    const [data, stock] = await Promise.all([api("/staff/bookings"), api("/staff/inventory")]);
    inventory = stock.resources;
    const options = inventory.filter((item) => item.active).map((item) =>
      `<option value="${item.id}">${escape(item.name)} · ${escape(item.slug)}</option>`).join("");
    document.getElementById("booking-rows").innerHTML = data.bookings.length ? data.bookings.map((booking) =>
      `<tr><td>${escape(booking.name)}<br><span class="muted">${escape(booking.email)}<br>${escape(booking.phone)}</span></td><td>${escape(booking.booking_option)}<br><span class="muted">${escape(booking.booking_type)}</span></td><td>${escape(booking.checkin_date)} → ${escape(booking.checkout_date)}</td><td>${escape(booking.guests)} adult(s), ${escape(booking.children)} child(ren)<br>${escape(booking.units_requested)} unit(s)</td><td><span class="status-pill ${escape(booking.status)}">${escape(booking.status)}</span><br><span class="muted">Payment: ${escape(booking.payment_status)}${booking.quoted_total_cents ? ` · ${currency(booking.quoted_total_cents, booking.currency)}` : ""}</span></td><td><div class="table-actions">${booking.status === "pending" ? `<select aria-label="Inventory assignment" data-resource-for="${booking.id}"><option value="">Assign resource</option>${options}</select><button class="button button-small" data-booking-confirm="${booking.id}">Confirm</button><button class="button button-small" data-booking-cancel="${booking.id}">Decline</button>` : ""}${booking.status === "confirmed" && booking.payment_status !== "paid" && booking.quoted_total_cents ? `<button class="button button-small" data-payment="${booking.id}">Email payment checkout</button>` : ""}</div></td></tr>`
    ).join("") : `<tr><td colspan="6" class="empty">No reservations have been received.</td></tr>`;
  }

  async function loadGuests() {
    const query = document.getElementById("guest-search").value.trim();
    const { guests } = await api(`/staff/guests${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    document.getElementById("guest-rows").innerHTML = guests.length ? guests.map((guest) =>
      `<tr><td>${escape(guest.name)}<br><span class="muted">Joined ${escape(guest.created_at)}</span></td><td>${escape(guest.email)}<br>${escape(guest.phone)}</td><td>${escape(guest.booking_count)}</td><td>${escape(guest.last_checkin || "—")}</td><td><button class="button button-small" data-guest="${guest.id}">Guest history & notes</button></td></tr>`
    ).join("") : `<tr><td colspan="5" class="empty">No guest accounts found. Reservations made as a guest are listed under Reservations.</td></tr>`;
  }

  async function loadInquiries() {
    const { inquiries } = await api("/staff/inquiries");
    document.getElementById("inquiry-rows").innerHTML = inquiries.length ? inquiries.map((item) =>
      `<tr><td>${escape(item.created_at)}</td><td>${escape(item.name)}<br><span class="muted">${escape(item.email)}<br>${escape(item.phone)}</span></td><td><strong>${escape(item.subject)}</strong><br>${escape(item.message)}</td><td><span class="status-pill ${escape(item.status)}">${escape(item.status)}</span></td><td><select data-inquiry-status="${item.id}"><option ${item.status === "new" ? "selected" : ""}>new</option><option ${item.status === "in_progress" ? "selected" : ""} value="in_progress">in progress</option><option ${item.status === "resolved" ? "selected" : ""}>resolved</option></select><button class="button button-small" data-inquiry-save="${item.id}">Save</button></td></tr>`
    ).join("") : `<tr><td colspan="5" class="empty">No enquiries received.</td></tr>`;
  }

  async function loadFinances() {
    const params = new URLSearchParams(formObject(document.getElementById("report-filter")));
    const [report, transactionData] = await Promise.all([
      api(`/staff/reports/summary?${params}`), api(`/staff/reports/financials?${params}`)
    ]);
    const totals = report.finance;
    document.getElementById("financial-summary").innerHTML = (totals.length ? totals : [{ currency: "ZAR", income_cents: 0, expense_cents: 0, net_cents: 0 }]).map((row) =>
      `<div class="metric"><span>Income · ${escape(row.currency)}</span><strong>${currency(row.income_cents, row.currency)}</strong></div><div class="metric"><span>Expenses · ${escape(row.currency)}</span><strong>${currency(row.expense_cents, row.currency)}</strong></div><div class="metric"><span>Net · ${escape(row.currency)}</span><strong>${currency(row.net_cents, row.currency)}</strong></div>`).join("");
    document.getElementById("outstanding").innerHTML = report.outstanding.length ? report.outstanding.map((row) =>
      `<p>${escape(row.count)} reservation(s) · <strong>${currency(row.amount_cents, row.currency)}</strong> ${escape(row.currency)}</p>`).join("") : `<p class="muted">No quoted balances outstanding.</p>`;
    document.getElementById("booking-pipeline").innerHTML = report.bookings.length ? report.bookings.map((row) =>
      `<p><span class="status-pill ${escape(row.status)}">${escape(row.status)}</span> ${escape(row.count)}</p>`).join("") : `<p class="muted">No reservations in this period.</p>`;
    document.getElementById("occupancy-report").innerHTML = report.occupancy.length ? report.occupancy.map((row) =>
      `<p><strong>${escape(row.name)}</strong> · ${escape(row.reserved_unit_nights)} of ${escape(row.capacity_unit_nights)} available unit-days reserved${row.capacity_unit_nights ? ` (${Math.round(row.reserved_unit_nights / row.capacity_unit_nights * 100)}%)` : ""}</p>`).join("") : `<p class="muted">Configure inventory resources to report occupancy.</p>`;
    document.getElementById("ledger-rows").innerHTML = transactionData.entries.length ? transactionData.entries.map((row) =>
      `<tr><td>${escape(row.transaction_date)}</td><td><span class="status-pill">${escape(row.entry_type)}</span></td><td>${escape(row.category)}</td><td>${escape(row.description)}</td><td class="amount">${currency(row.amount_cents, row.currency)}</td><td>${escape(row.receipt_reference)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">No ledger entries for this period.</td></tr>`;
  }

  async function loadTasks() {
    const { tasks } = await api("/staff/tasks");
    document.getElementById("task-rows").innerHTML = tasks.length ? tasks.map((task) =>
      `<tr><td>${escape(task.due_date)}</td><td>${escape(task.title)}<br><span class="muted">${escape(task.description)}</span></td><td>${escape(task.resource_name || "—")}</td><td>${escape(task.assigned_name || "Unassigned")}</td><td><span class="status-pill ${escape(task.status)}">${escape(task.status)}</span></td><td>${task.status !== "done" && task.status !== "cancelled" ? `<button class="button button-small" data-task-start="${task.id}">In progress</button><button class="button button-small" data-task-done="${task.id}">Complete</button>` : ""}</td></tr>`
    ).join("") : `<tr><td colspan="6" class="empty">No housekeeping tasks yet.</td></tr>`;
  }

  async function loadAttendance() {
    const { open, history, site_configured } = await api("/staff/attendance");
    document.getElementById("attendance-status").textContent = !site_configured
      ? "On-premises location has not been configured. Clock-in is unavailable."
      : open ? `Clocked in since ${open.clock_in_at}.` : "You are currently clocked out.";
    document.getElementById("clock-in").disabled = !site_configured || Boolean(open);
    document.getElementById("clock-out").disabled = !site_configured || !open;
    document.getElementById("attendance-history").innerHTML = history.length
      ? history.map(shift => `<p>${escape(shift.clock_in_at)} → ${escape(shift.clock_out_at || "Still clocked in")}</p>`).join("")
      : `<p class="empty">No attendance records yet.</p>`;
  }

  async function loadWorkforce() {
    const director = currentUser.role === "admin" || currentUser.staff_role === "director";
    const scheduleSelector = document.getElementById("schedule-view-user");
    let staffMembers = [];
    document.getElementById("schedule-view-label").hidden = !director;
    if (director) {
      ({ staff: staffMembers } = await api("/staff/workforce"));
      const previous = scheduleSelector.value;
      scheduleSelector.innerHTML = staffMembers.map(person =>
        `<option value="${person.id}">${escape(person.name)} · ${escape(person.staff_role)}</option>`).join("");
      if (staffMembers.some(person => String(person.id) === previous)) scheduleSelector.value = previous;
    }
    const query = director && scheduleSelector.value ? `?user_id=${encodeURIComponent(scheduleSelector.value)}` : "";
    const [schedule, leave] = await Promise.all([api(`/staff/schedule${query}`), api("/staff/leave")]);
    document.getElementById("staff-weekly-schedule").innerHTML = schedule.shifts.length
      ? schedule.shifts.map(shift => `<article class="calendar-event"><strong>${escape(new Date(shift.starts_at).toLocaleString())} – ${escape(new Date(shift.ends_at).toLocaleTimeString())}</strong><p>${escape(shift.assignment || "Scheduled shift")}</p></article>`).join("")
      : `<p class="empty">No shifts published for week of ${escape(schedule.week_of)}.</p>`;
    document.getElementById("leave-requests").innerHTML = leave.requests.length
      ? leave.requests.map(item => `<article class="calendar-event"><strong>${escape(item.staff_name || currentUser.name)} · ${escape(item.start_date)} – ${escape(item.end_date)}</strong><p>${escape(item.reason)} · <span class="status-pill ${escape(item.status)}">${escape(item.status)}</span></p>${leave.can_review && item.status === "pending" ? `<button class="button button-small" data-leave-review="${item.id}" data-leave-status="approved">Approve</button><button class="button button-small" data-leave-review="${item.id}" data-leave-status="declined">Decline</button>` : ""}</article>`).join("")
      : `<p class="empty">No leave requests.</p>`;
    document.getElementById("schedule-publish").hidden = !director;
    if (director) {
      document.querySelector("#shift-form [name=user_id]").innerHTML = staffMembers.map(person =>
        `<option value="${person.id}">${escape(person.name)} · ${escape(person.staff_role)}</option>`).join("");
    }
  }

  async function loadCalendar() {
    const { bookings, events } = await api("/staff/calendar");
    const entries = [
      ...bookings.map(booking => ({ ...booking, kind: "Reservation", date: booking.starts_at })),
      ...events.map(event => ({ ...event, kind: event.category || "Event", date: event.starts_at }))
    ].sort((left, right) => String(left.date).localeCompare(String(right.date)));
    document.getElementById("operations-calendar").innerHTML = entries.length
      ? entries.map(entry => `<article class="calendar-event"><span class="status-pill">${escape(entry.kind)}</span><h2>${escape(entry.title)}</h2><p>${escape(entry.starts_at)} – ${escape(entry.ends_at)}</p>${entry.description ? `<p>${escape(entry.description)}</p>` : ""}${entry.status ? `<span class="status-pill ${escape(entry.status)}">${escape(entry.status)}</span>` : ""}</article>`).join("")
      : `<p class="empty">No upcoming bookings or events.</p>`;
    document.getElementById("event-form").hidden = currentUser.role !== "admin" &&
      !["director", "conference_coordinator"].includes(currentUser.staff_role);
  }

  async function loadBreakfast() {
    const date = document.getElementById("breakfast-service-date").value;
    const params = date ? `?date=${encodeURIComponent(date)}` : "";
    const [menuData, orderData] = await Promise.all([
      api("/staff/breakfast-menu"), api(`/staff/breakfast-orders${params}`)
    ]);
    const menuForm = document.getElementById("breakfast-menu-form");
    const canManageMenu = currentUser.role === "admin" ||
      ["director", "guest_relations_manager"].includes(currentUser.staff_role);
    menuForm.hidden = !canManageMenu;
    document.getElementById("staff-breakfast-menu").innerHTML = menuData.menu.length
      ? menuData.menu.map(item => `<p><strong>${escape(item.name)}</strong> · ${escape(item.dietary_tags)} · ${currency(item.price_cents)} · ${item.available ? "Available" : "Unavailable"} ${canManageMenu ? `<button class="button button-small" data-menu-toggle="${item.id}" data-available="${item.available ? "false" : "true"}">${item.available ? "Hide item" : "Publish item"}</button>` : ""}</p>`).join("")
      : `<p class="empty">Add breakfast items to publish a guest menu.</p>`;
    document.getElementById("staff-breakfast-orders").innerHTML = orderData.orders.length
      ? orderData.orders.map(order => `<article class="calendar-event"><strong>${escape(order.guest_name)} · ${escape(order.item_name)} × ${escape(order.quantity)}</strong><p>Booking ${escape(order.booking_id)} · ${escape(order.service_date)} · ${currency(order.unit_price_cents * order.quantity)} · ${escape(order.notes || "No special notes")} · ${escape(order.payment_status)}</p><span class="status-pill">${escape(order.status)}</span>${order.status !== "served" && order.status !== "cancelled" ? `<div class="table-actions">${["accepted", "prepared", "served"].map(state => `<button class="button button-small" data-order-status="${state}" data-order-id="${order.id}">${state}</button>`).join("")}</div>` : ""}</article>`).join("")
      : `<p class="empty">No breakfast orders for this date.</p>`;
  }

  async function loadAnnouncements() {
    const { announcements } = await api("/staff/announcements");
    document.getElementById("announcement-list").innerHTML = announcements.length
      ? announcements.map(item => `<article class="calendar-event"><strong>${escape(item.title)}</strong><p>${escape(item.message)}</p><small>${escape(item.audience)} · ${escape(item.starts_at)}${item.ends_at ? ` – ${escape(item.ends_at)}` : ""}</small></article>`).join("")
      : `<p class="empty">No announcements published.</p>`;
  }

  async function loadUsers() {
    try {
      const { users } = await api("/admin/users");
      document.getElementById("user-rows").innerHTML = users.map((user) =>
        `<tr><td>${escape(user.name)}</td><td>${escape(user.email)}</td><td>${escape(user.providers || "—")}</td><td><select data-user-role="${user.id}"><option ${user.role === "customer" ? "selected" : ""}>customer</option><option ${user.role === "staff" ? "selected" : ""}>staff</option><option ${user.role === "admin" ? "selected" : ""}>admin</option></select></td><td><select data-staff-role="${user.id}"><option value="director" ${user.staff_role === "director" ? "selected" : ""}>Director</option><option value="guest_relations_manager" ${user.staff_role === "guest_relations_manager" ? "selected" : ""}>Guest Relations Manager</option><option value="conference_coordinator" ${user.staff_role === "conference_coordinator" ? "selected" : ""}>Conference Coordinator</option><option value="general_worker" ${user.staff_role === "general_worker" ? "selected" : ""}>General Worker</option><option value="housekeeping" ${user.staff_role === "housekeeping" ? "selected" : ""}>Housekeeping</option></select></td><td><select data-user-status="${user.id}"><option ${user.status === "active" ? "selected" : ""}>active</option><option ${user.status === "disabled" ? "selected" : ""}>disabled</option></select></td><td><button class="button button-small" data-user-save="${user.id}">Save</button></td></tr>`
      ).join("");
    } catch (error) {
      if (currentUser.role === "admin") throw error;
      document.getElementById("user-rows").innerHTML = `<tr><td colspan="6" class="muted">Team account administration is restricted to administrators.</td></tr>`;
    }
  }

  async function loadEmails() {
    const { emails } = await api("/staff/emails");
    document.getElementById("email-rows").innerHTML = emails.length ? emails.map((item) =>
      `<tr><td>${escape(item.created_at)}</td><td>${escape(item.recipient)}</td><td>${escape(item.subject)}</td><td><span class="status-pill ${escape(item.status)}">${escape(item.status)}</span></td><td>${escape(item.attempts)}<br><span class="inline-error">${escape(item.last_error)}</span></td><td>${item.status === "failed" ? `<button class="button button-small" data-email-retry="${item.id}">Retry</button>` : ""}</td></tr>`
    ).join("") : `<tr><td colspan="6" class="empty">No messages in the delivery queue.</td></tr>`;
  }

  async function loadSettings() {
    const { settings, integrations } = await api("/staff/settings");
    document.querySelector("#settings-form [name=automatic_booking_confirmation]").checked =
      settings.automatic_booking_confirmation === "1";
    for (const field of ["checkin_time", "checkout_time", "breakfast_start", "breakfast_end"]) {
      document.querySelector(`#settings-form [name=${field}]`).value = settings[field] || "";
    }
    document.getElementById("integration-status").innerHTML =
      `<p>Email delivery: <strong>${integrations.email ? "SMTP configured" : "not configured"}</strong> · Yoco Checkout & webhooks: <strong>${integrations.yoco ? "configured" : "not configured"}</strong></p>`;
  }

  const getCurrentLocation = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser does not provide location access."));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      () => reject(new Error("Location access failed. Allow precise location while on the guest-house premises.")),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
  for (const action of ["clock-in", "clock-out"]) {
    document.getElementById(action).addEventListener("click", async () => {
      try {
        const coordinates = await getCurrentLocation();
        await api(`/staff/attendance/${action}`, { method: "POST", body: JSON.stringify(coordinates) });
        showNotice(action === "clock-in" ? "You are clocked in." : "You are clocked out.");
        await loadAttendance();
      } catch (error) {
        showNotice(error.message, true);
      }
    });
  }
  document.getElementById("refresh-workforce").addEventListener("click", () =>
    loadWorkforce().catch(error => showNotice(error.message, true)));
  document.getElementById("schedule-view-user").addEventListener("change", () =>
    loadWorkforce().catch(error => showNotice(error.message, true)));
  document.getElementById("leave-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      await api("/staff/leave", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) });
      event.currentTarget.reset();
      showNotice("Leave request submitted for management review.");
      await loadWorkforce();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("leave-requests").addEventListener("click", async event => {
    const button = event.target.closest("[data-leave-review]");
    if (!button) return;
    try {
      await api(`/staff/leave/${button.dataset.leaveReview}`, {
        method: "PATCH", body: JSON.stringify({ status: button.dataset.leaveStatus })
      });
      showNotice(`Leave request ${button.dataset.leaveStatus}.`);
      await loadWorkforce();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("shift-form").addEventListener("submit", async event => {
    event.preventDefault();
    const shift = formObject(event.currentTarget);
    shift.user_id = Number(shift.user_id);
    shift.starts_at = new Date(shift.starts_at).toISOString();
    shift.ends_at = new Date(shift.ends_at).toISOString();
    try {
      await api("/staff/schedule", { method: "POST", body: JSON.stringify(shift) });
      showNotice("Staff shift published.");
      await loadWorkforce();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("refresh-calendar").addEventListener("click", () =>
    loadCalendar().catch(error => showNotice(error.message, true)));
  document.getElementById("event-form").addEventListener("submit", async event => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    data.starts_at = new Date(data.starts_at).toISOString();
    data.ends_at = new Date(data.ends_at).toISOString();
    try {
      await api("/staff/events", { method: "POST", body: JSON.stringify(data) });
      event.currentTarget.reset();
      showNotice("Event added to the property calendar.");
      await loadCalendar();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("breakfast-service-date").value = new Date().toLocaleDateString("en-CA");
  document.getElementById("breakfast-service-date").addEventListener("change", () =>
    loadBreakfast().catch(error => showNotice(error.message, true)));
  document.getElementById("refresh-breakfast").addEventListener("click", () =>
    loadBreakfast().catch(error => showNotice(error.message, true)));
  document.getElementById("breakfast-menu-form").addEventListener("submit", async event => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    data.price_cents = moneyToCents(data.price);
    delete data.price;
    try {
      await api("/staff/breakfast-menu", { method: "POST", body: JSON.stringify(data) });
      event.currentTarget.reset();
      showNotice("Breakfast item added to the guest menu.");
      await loadBreakfast();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("staff-breakfast-menu").addEventListener("click", async event => {
    const button = event.target.closest("[data-menu-toggle]");
    if (!button) return;
    try {
      await api(`/staff/breakfast-menu/${button.dataset.menuToggle}`, {
        method: "PATCH", body: JSON.stringify({ available: button.dataset.available === "true" })
      });
      showNotice("Breakfast menu updated.");
      await loadBreakfast();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("staff-breakfast-orders").addEventListener("click", async event => {
    const button = event.target.closest("[data-order-status]");
    if (!button) return;
    try {
      await api(`/staff/breakfast-orders/${button.dataset.orderId}`, {
        method: "PATCH", body: JSON.stringify({ status: button.dataset.orderStatus })
      });
      showNotice(`Breakfast order ${button.dataset.orderStatus}.`);
      await loadBreakfast();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("announcement-form").addEventListener("submit", async event => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    if (data.starts_at) data.starts_at = new Date(data.starts_at).toISOString();
    else delete data.starts_at;
    if (data.ends_at) data.ends_at = new Date(data.ends_at).toISOString();
    else delete data.ends_at;
    try {
      await api("/staff/announcements", { method: "POST", body: JSON.stringify(data) });
      event.currentTarget.reset();
      showNotice("Announcement published and notifications queued.");
      await loadAnnouncements();
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  document.getElementById("booking-rows").addEventListener("click", async (event) => {
    const confirmButton = event.target.closest("[data-booking-confirm]");
    const cancelButton = event.target.closest("[data-booking-cancel]");
    const paymentButton = event.target.closest("[data-payment]");
    try {
      if (confirmButton) {
        const bookingId = confirmButton.dataset.bookingConfirm;
        const resourceId = document.querySelector(`[data-resource-for="${bookingId}"]`).value;
        await api(`/staff/bookings/${bookingId}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed", resource_id: Number(resourceId) }) });
        showNotice("Reservation confirmed. Guest confirmation email has been queued.");
        await loadBookings();
      } else if (cancelButton) {
        await api(`/staff/bookings/${cancelButton.dataset.bookingCancel}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
        showNotice("Reservation cancelled.");
        await loadBookings();
      } else if (paymentButton) {
        const checkout = await api(`/staff/bookings/${paymentButton.dataset.payment}/payment`, { method: "POST" });
        const form = document.createElement("form");
        form.method = "POST";
        form.action = checkout.url;
        form.target = "_blank";
        for (const [name, value] of Object.entries(checkout.fields)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.append(input);
        }
        document.body.append(form);
        form.submit();
        form.remove();
        showNotice("Payment checkout opened. Ask the guest to complete payment on the secure provider page.");
      }
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  document.getElementById("inventory-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    data.units = Number(data.units);
    data.max_guests = Number(data.max_guests);
    data.price_per_unit_cents = data.price === "" ? null : moneyToCents(data.price);
    delete data.price;
    try {
      await api("/staff/inventory", { method: "POST", body: JSON.stringify(data) });
      event.currentTarget.reset();
      showNotice("Inventory added.");
      await loadInventory();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  async function loadCatalogue() {
    const { offerings } = await api("/staff/catalogue");
    document.getElementById("catalogue-rows").innerHTML = offerings.length ? offerings.map((item) =>
      `<tr><td>${escape(item.name)}</td><td>${escape(item.description)}</td><td>${escape(item.category)}</td><td>${item.price_cents == null ? "Quote required" : currency(item.price_cents, item.currency)}</td><td><span class="status-pill ${item.active ? "confirmed" : "disabled"}">${item.active ? "active" : "inactive"}</span></td><td><details><summary>Edit item</summary><form class="catalogue-edit-form form-grid" data-offering-id="${item.id}">
        <label>Name <input name="name" value="${escape(item.name)}" required></label><label>Category <input name="category" value="${escape(item.category)}" required></label>
        <label>Description <input name="description" value="${escape(item.description)}"></label>
        <label>Price (ZAR; blank for quote) <input name="price" type="number" min="0" step="0.01" value="${item.price_cents == null ? "" : (item.price_cents / 100).toFixed(2)}"></label>
        <button class="button button-small">Save changes</button></form></details>${item.active ? `<button class="button button-small" data-catalogue-disable="${item.id}">Deactivate</button>` : ""}</td></tr>`
    ).join("") : `<tr><td colspan="6" class="empty">No public catalogue entries yet.</td></tr>`;
  }
  document.getElementById("catalogue-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    data.price_cents = data.price === "" ? null : moneyToCents(data.price);
    delete data.price;
    try {
      await api("/staff/catalogue", { method: "POST", body: JSON.stringify(data) });
      event.currentTarget.reset();
      showNotice("Business catalogue item added.");
      await loadCatalogue();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("catalogue-rows").addEventListener("submit", async (event) => {
    if (!event.target.matches(".catalogue-edit-form")) return;
    event.preventDefault();
    try {
      const data = formObject(event.target);
      data.price_cents = data.price === "" ? null : moneyToCents(data.price);
      delete data.price;
      await api(`/staff/catalogue/${event.target.dataset.offeringId}`, {
        method: "PATCH", body: JSON.stringify(data)
      });
      showNotice("Catalogue item updated.");
      await loadCatalogue();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("catalogue-rows").addEventListener("click", async (event) => {
    const deactivate = event.target.closest("[data-resource-disable]");
    const catalogueDeactivate = event.target.closest("[data-catalogue-disable]");
    if (!catalogueDeactivate) return;
    try {
      await api(`/staff/catalogue/${catalogueDeactivate.dataset.catalogueDisable}`, { method: "DELETE" });
      showNotice("Catalogue item deactivated.");
      await loadCatalogue();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("inventory-rows").addEventListener("submit", async (event) => {
    if (!event.target.matches(".resource-edit-form")) return;
    event.preventDefault();
    const data = formObject(event.target);
    data.units = Number(data.units);
    data.max_guests = Number(data.max_guests);
    data.price_per_unit_cents = data.price === "" ? null : moneyToCents(data.price);
    delete data.price;
    try {
      await api(`/staff/inventory/${event.target.dataset.resourceId}`, {
        method: "PATCH", body: JSON.stringify(data)
      });
      showNotice("Inventory details updated.");
      await loadInventory();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("inventory-rows").addEventListener("click", async (event) => {
    const deactivate = event.target.closest("[data-resource-disable]");
    if (!deactivate) return;
    try {
      await api(`/staff/inventory/${deactivate.dataset.resourceDisable}`, {
        method: "PATCH", body: JSON.stringify({ active: false })
      });
      showNotice("Inventory deactivated.");
      await loadInventory();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("availability-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = formObject(event.currentTarget);
    const params = new URLSearchParams(values);
    try {
      const result = await api(`/availability?${params}`);
      document.getElementById("availability-result").textContent = result.available
        ? `${result.resource} has ${result.available_units} unit(s) available.`
        : `Unavailable: ${result.available_units} unit(s) remain.`;
    } catch (error) {
      document.getElementById("availability-result").textContent = error.message;
    }
  });
  let guestSearchTimer;
  document.getElementById("guest-search").addEventListener("input", () => {
    clearTimeout(guestSearchTimer);
    guestSearchTimer = setTimeout(() => loadGuests().catch((error) => showNotice(error.message, true)), 250);
  });
  document.getElementById("guest-rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-guest]");
    if (!button) return;
    try {
      const detail = await api(`/staff/guests/${button.dataset.guest}`);
      const box = document.getElementById("guest-detail");
      box.hidden = false;
      box.innerHTML = `<h2>${escape(detail.guest.name)} · Guest account</h2><p>${escape(detail.guest.email)} · ${escape(detail.guest.phone)}</p><h3>Stay history</h3>${detail.bookings.map((item) => `<p>${escape(item.checkin_date)} → ${escape(item.checkout_date)} · ${escape(item.booking_option)} · ${escape(item.status)} · ${item.quoted_total_cents ? currency(item.quoted_total_cents, item.currency) : "Unpriced"}</p>`).join("") || "<p>No stays on the account yet.</p>"}<h3>Staff notes</h3>${detail.notes.map((item) => `<p>${escape(item.created_at)} · ${escape(item.note)}</p>`).join("") || "<p>No notes.</p>"}<form id="guest-note-form" data-guest-id="${detail.guest.id}" class="inline-form"><label>Add internal note <input name="note" maxlength="2000" required></label><button class="button">Save note</button></form>`;
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("guest-detail").addEventListener("submit", async (event) => {
    if (event.target.id !== "guest-note-form") return;
    event.preventDefault();
    try {
      await api(`/staff/guests/${event.target.dataset.guestId}/notes`, { method: "POST", body: JSON.stringify(formObject(event.target)) });
      showNotice("Guest note saved.");
      await loadGuests();
      document.querySelector(`[data-guest="${event.target.dataset.guestId}"]`)?.click();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("inquiry-rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-inquiry-save]");
    if (!button) return;
    const id = button.dataset.inquirySave;
    const status = document.querySelector(`[data-inquiry-status="${id}"]`).value;
    try {
      await api(`/staff/inquiries/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      showNotice("Enquiry status updated.");
      await loadInquiries();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("report-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    loadFinances().catch((error) => showNotice(error.message, true));
  });
  document.getElementById("download-report").addEventListener("click", () => {
    const params = new URLSearchParams(formObject(document.getElementById("report-filter")));
    window.location.assign(`/api/staff/reports/financials.csv?${params}`);
  });
  document.getElementById("ledger-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    data.amount_cents = moneyToCents(data.amount);
    delete data.amount;
    try {
      await api("/staff/ledger", { method: "POST", body: JSON.stringify(data) });
      event.currentTarget.reset();
      showNotice("Ledger entry saved.");
      await loadFinances();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/staff/tasks", { method: "POST", body: JSON.stringify(formObject(event.currentTarget)) });
      event.currentTarget.reset();
      showNotice("Task created.");
      await loadTasks();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("task-rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-task-start], [data-task-done]");
    if (!button) return;
    const id = button.dataset.taskStart || button.dataset.taskDone;
    const status = button.dataset.taskDone ? "done" : "in_progress";
    try {
      await api(`/staff/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadTasks();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("user-rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-user-save]");
    if (!button) return;
    const id = button.dataset.userSave;
    const role = document.querySelector(`[data-user-role="${id}"]`).value;
    const staffRole = document.querySelector(`[data-staff-role="${id}"]`).value;
    const status = document.querySelector(`[data-user-status="${id}"]`).value;
    try {
      await api(`/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role, status, ...(role === "staff" || role === "admin" ? { staff_role: staffRole } : {}) })
      });
      showNotice("User access updated.");
      await loadUsers();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("flush-mail").addEventListener("click", async () => {
    try {
      const result = await api("/staff/emails/flush", { method: "POST", body: "{}" });
      showNotice(`Sent ${result.sent} message(s); ${result.queued} remain queued.`);
      await loadEmails();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("email-rows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-email-retry]");
    if (!button) return;
    try {
      await api(`/staff/emails/${button.dataset.emailRetry}/retry`, { method: "POST", body: "{}" });
      showNotice("Email returned to the queue.");
      await loadEmails();
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = formObject(event.currentTarget);
    data.automatic_booking_confirmation = event.currentTarget.elements.automatic_booking_confirmation.checked;
    try {
      await api("/staff/settings", { method: "PATCH", body: JSON.stringify(data) });
      showNotice("Property operations settings saved.");
      await loadSettings();
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  document.getElementById("task-form").elements.due_date.value = new Date().toISOString().slice(0, 10);
  const reportDates = document.getElementById("report-filter").elements;
  reportDates.from.value = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  reportDates.to.value = new Date().toISOString().slice(0, 10);
  await loadDashboard();
});
