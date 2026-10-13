/* ==========================================================================
   CraveCorner — Stage 3: Food Availability (cc-menu.js)
   --------------------------------------------------------------------------
   Scheduler + inventory library for weekly menus, occurrences, exceptions,
   and inventory adjustments. Used by menu.html (seller) and
   cc-availability.js (customer-facing availability on product.html).

   DB contract (sql/SCHEMA.md + 00_schema.sql):
     cc_schedules           kind ∈ weekly/dates/range; days int[] 0=Mon..6=Sun;
                            product_id NULL = full daily menu (rows in
                            cc_schedule_items); quantity NULL = unlimited;
                            inventory_mode ∈ auto/manual; status ∈ active/paused
     cc_schedule_items      products in a full-menu schedule
     cc_schedule_exceptions UNIQUE(schedule_id, ex_date); kind ∈ paused/override;
                            override = jsonb of occurrence field overrides
     cc_occurrences         materialized slots; UNIQUE(schedule_id, occ_date);
                            window_start/window_end/cutoff_at are timestamptz
                            computed from the SHOP's timezone at materialization;
                            quantity_left ≥ 0 enforced by the DB (loud errors)
     cc_inventory_logs      append-ish; manual adjustments MUST write a row
                            with a human reason
     cc_inventory_reservations  order_request_id UNIQUE; status ∈ held/released;
                            created by trigger on confirm (auto mode)

   Materialization model: there is NO server-side materializer — this file
   generates occurrence rows client-side from (schedule + exceptions) and
   inserts them. Source of truth stays schedule+exceptions:
     - "edit ONE occurrence"      → upsert a cc_schedule_exceptions row
                                    (kind='override') AND update the occurrence
     - "edit THIS AND FUTURE"     → update the schedule, then re-materialize
                                    from the chosen date; occurrences that have
                                    confirmed orders are updated IN PLACE (never
                                    deleted) after explicit confirmation
     - "pause a date"             → exception kind='paused' + occurrence paused
     - kind='dates' schedules have no dates column in the DB; the chosen dates
       are fully materialized at creation and the occurrences ARE the record.
       Later edits for dates-kind schedules are per-occurrence.

   Timezone rule: the shop's cc_shops.timezone (e.g. America/Chicago) is the
   seller-local zone. window_start/window_end/cutoff_at are computed from
   seller-local date+time into timestamptz here; display converts back with
   the same zone. Pure helpers below are DOM- and network-free.

   Honesty rules: never invent counts (all come from queries); confirmed
   orders are never silently changed — any edit touching a date with
   confirmed/held orders warns and requires explicit confirmation.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var M = (window.CC_MENU = window.CC_MENU || {});

  /* ------------------------------------------------------------------ */
  /* Pure date / timezone helpers (no DOM, no network — unit-testable)    */
  /* ------------------------------------------------------------------ */

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function parseDateStr(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3] };
  }

  function parseTimeStr(s) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || "").trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    return { h: +m[1], mi: +m[2] };
  }

  var _fmtCache = {};
  function cachedFmt(tz, opts) {
    var key = tz + "|" + JSON.stringify(opts);
    if (!_fmtCache[key]) {
      _fmtCache[key] = new Intl.DateTimeFormat("en-US",
        Object.assign({ timeZone: tz }, opts));
    }
    return _fmtCache[key];
  }

  /* Milliseconds to add to a UTC epoch to get the wall-clock epoch in tz. */
  function tzOffsetMs(tz, date) {
    var parts = cachedFmt(tz, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).formatToParts(date);
    var p = {};
    for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
    var h = +p.hour; if (h === 24) h = 0; // some locales emit 24:xx at midnight
    return Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second) -
      date.getTime();
  }

  /** "Today" as YYYY-MM-DD in the given IANA timezone. */
  M.todayInTz = function (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA",
        { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date());
    } catch (e) {
      var d = new Date();
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
  };

  /**
   * Seller-local date+time ("2026-10-14", "10:00") in tz → ISO timestamptz.
   * Iterates twice so DST transitions land on the right instant.
   */
  M.zonedTimeToUtcIso = function (tz, dateStr, timeStr) {
    var d = parseDateStr(dateStr), t = parseTimeStr(timeStr);
    if (!d || !t) throw new Error("Bad date/time: " + dateStr + " " + timeStr);
    var guess = Date.UTC(d.y, d.mo - 1, d.d, t.h, t.mi, 0);
    var inst = guess;
    for (var i = 0; i < 2; i++) inst = guess - tzOffsetMs(tz, new Date(inst));
    return new Date(inst).toISOString();
  };

  /** Add n days to a YYYY-MM-DD string (pure calendar math, UTC-based). */
  M.addDays = function (dateStr, n) {
    var d = parseDateStr(dateStr);
    if (!d) return null;
    var x = new Date(Date.UTC(d.y, d.mo - 1, d.d) + n * 86400000);
    return x.getUTCFullYear() + "-" + pad(x.getUTCMonth() + 1) + "-" + pad(x.getUTCDate());
  };

  /** Day of week for a YYYY-MM-DD, 0=Mon .. 6=Sun (matches cc_schedules.days). */
  M.dowMon0 = function (dateStr) {
    var d = parseDateStr(dateStr);
    if (!d) return -1;
    return (new Date(Date.UTC(d.y, d.mo - 1, d.d)).getUTCDay() + 6) % 7;
  };

  M.mondayOfWeek = function (dateStr) { return M.addDays(dateStr, -M.dowMon0(dateStr)); };

  var DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  M.dowLabel = function (dateStr) { return DOW_SHORT[M.dowMon0(dateStr)] || ""; };

  /** "Tue, Oct 14" from a timestamptz, shown in tz. */
  M.fmtDay = function (iso, tz) {
    try {
      return cachedFmt(tz, { weekday: "short", month: "short", day: "numeric" })
        .format(new Date(iso));
    } catch (e) { return String(iso || "").slice(0, 10); }
  };

  /** "10:00 AM" from a timestamptz, shown in tz. */
  M.fmtTime = function (iso, tz) {
    try {
      return cachedFmt(tz, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    } catch (e) { return ""; }
  };

  /** "Tuesday, October 14, 2026" from a YYYY-MM-DD, shown in tz (noon-UTC anchor). */
  M.fmtDateLong = function (dateStr, tz) {
    var d = parseDateStr(dateStr);
    if (!d) return String(dateStr || "");
    try {
      return cachedFmt(tz || "UTC",
        { weekday: "long", month: "long", day: "numeric", year: "numeric" })
        .format(new Date(Date.UTC(d.y, d.mo - 1, d.d, 12)));
    } catch (e) { return dateStr; }
  };

  /**
   * Cutoff countdown copy: "order within 3h 12m", "order within 25m",
   * "order within 2d 4h", "No cutoff", "Cutoff passed".
   */
  M.countdownText = function (cutoffIso, nowMs) {
    if (!cutoffIso) return "No cutoff";
    var diff = new Date(cutoffIso).getTime() - (nowMs || Date.now());
    if (!(diff > 0)) return "Cutoff passed";
    var s = Math.floor(diff / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return "order within " + d + "d " + h + "h";
    if (h > 0) return "order within " + h + "h " + m + "m";
    if (m > 0) return "order within " + m + "m";
    return "order within 1m";
  };

  M.KIND_LABEL = { weekly: "Every Week", dates: "Specific Dates", range: "Limited Date Range" };
  M.MODE_LABEL = { auto: "Auto", manual: "Manual" };
  M.COMMITTED_STATUSES = ["confirmed", "awaiting_customer", "preparing", "ready", "completed"];
  M.HORIZON_DAYS = 84; // weekly schedules materialize 12 weeks ahead

  /** Legal reminder shown whenever shipping fulfillment is enabled. */
  M.SHIPPING_LEGAL_TEXT =
    "Shipping homemade food is the seller\u2019s own responsibility — packaging, " +
    "spoilage, and carrier rules are self-declared by the seller and are " +
    "not verified by CraveCorner.";

  /* ------------------------------------------------------------------ */
  /* Materialization (pure): (schedule + exceptions) → occurrence slots   */
  /* ------------------------------------------------------------------ */

  function makeSlot(schedule, ex, shopTz, dateStr) {
    var ws = M.zonedTimeToUtcIso(shopTz, dateStr, schedule.start_time);
    var we = M.zonedTimeToUtcIso(shopTz, dateStr, schedule.end_time);
    var cutoff = null;
    if (+schedule.preorder_cutoff_hours > 0) {
      cutoff = new Date(new Date(ws).getTime() -
        (+schedule.preorder_cutoff_hours) * 3600000).toISOString();
    }
    var slot = {
      occ_date: dateStr,
      window_start: ws,
      window_end: we,
      cutoff_at: cutoff,
      quantity: schedule.quantity == null ? null : +schedule.quantity,
      quantity_left: schedule.quantity == null ? null : +schedule.quantity,
      status: schedule.status === "paused" ? "paused" : "active"
    };
    if (ex) {
      if (ex.kind === "paused") {
        slot.status = "paused";
      } else if (ex.kind === "override" && ex.override) {
        var o = ex.override;
        ["window_start", "window_end", "cutoff_at", "quantity", "quantity_left", "status"]
          .forEach(function (k) { if (o[k] !== undefined) slot[k] = o[k]; });
      }
    }
    return slot;
  }

  /**
   * Build occurrence slots. schedule: cc_schedules row shape. exceptions:
   * cc_schedule_exceptions rows. shopTz: IANA zone. opts: { fromDate,
   * dates } — dates is required for kind='dates' (the DB has no dates
   * column; dates-kind schedules are fully materialized at creation).
   */
  M.buildSlots = function (schedule, exceptions, shopTz, opts) {
    opts = opts || {};
    var today = M.todayInTz(shopTz);
    var exMap = {};
    (exceptions || []).forEach(function (x) { exMap[x.ex_date] = x; });
    var dates = [];
    var i, cur;
    if (schedule.kind === "weekly") {
      var days = schedule.days || [];
      var start = schedule.start_date > today ? schedule.start_date : today;
      if (opts.fromDate && opts.fromDate > start) start = opts.fromDate;
      var horizon = M.addDays(start, M.HORIZON_DAYS);
      var end = schedule.end_date || horizon;
      if (end > horizon) end = horizon;
      for (cur = start; cur <= end; cur = M.addDays(cur, 1)) {
        if (days.indexOf(M.dowMon0(cur)) !== -1) dates.push(cur);
      }
    } else if (schedule.kind === "range") {
      var rstart = schedule.start_date > today ? schedule.start_date : today;
      if (opts.fromDate && opts.fromDate > rstart) rstart = opts.fromDate;
      var cap = M.addDays(rstart, 120);
      var rend = schedule.end_date || M.addDays(rstart, 30);
      if (rend > cap) rend = cap;
      for (cur = rstart; cur <= rend; cur = M.addDays(cur, 1)) dates.push(cur);
    } else if (schedule.kind === "dates") {
      var list = opts.dates || schedule._dates || [];
      for (i = 0; i < list.length; i++) {
        if (list[i] >= today) dates.push(list[i]);
      }
      dates.sort();
    }
    return dates.map(function (dt) { return makeSlot(schedule, exMap[dt], shopTz, dt); });
  };

  /* ------------------------------------------------------------------ */
  /* Modal + confirm dialog (same cc-modal shell markup as app.js)        */
  /* ------------------------------------------------------------------ */

  M.openModal = function (title, bodyHtml, actionsHtml) {
    M.closeModal();
    var wrap = document.createElement("div");
    wrap.className = "cc-modal-backdrop";
    wrap.setAttribute("data-modal", "");
    wrap.innerHTML =
      '<div class="cc-modal" role="dialog" aria-modal="true" aria-label="' + CC.esc(title) + '" tabindex="-1">' +
        '<div class="cc-modal-head"><h2 class="cc-h3">' + CC.esc(title) + "</h2>" +
        '<button type="button" class="cc-modal-x" data-modal-close aria-label="Close dialog">&times;</button></div>' +
        '<div class="cc-modal-body">' + bodyHtml + "</div>" +
        (actionsHtml ? '<div class="cc-modal-actions">' + actionsHtml + "</div>" : "") +
      "</div>";
    document.body.appendChild(wrap);
    document.body.style.overflow = "hidden";
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.closest("[data-modal-close]")) M.closeModal();
    });
    wrap.addEventListener("keydown", function (e) {
      if (e.key === "Escape") M.closeModal();
    });
    var dlg = wrap.firstElementChild;
    var f = dlg.querySelector("input:not([type=hidden]), select, textarea, button.cc-btn");
    (f || dlg).focus();
    return wrap;
  };

  M.closeModal = function () {
    if (CC.closeModal) { CC.closeModal(); return; }
    var w = document.querySelector("[data-modal]");
    if (w) w.remove();
    document.body.style.overflow = "";
  };

  /**
   * Promise<boolean> confirm dialog. opts: { title, bodyHtml, confirmLabel,
   * danger, requireAcknowledge, acknowledgeLabel }.
   */
  M.confirmDialog = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      var body = (opts.bodyHtml || "") +
        (opts.requireAcknowledge
          ? '<label class="cc-check cc-menu-ack"><input type="checkbox" id="cc-menu-ack"> ' +
            "<span>" + CC.esc(opts.acknowledgeLabel || "I understand and want to proceed") + "</span></label>"
          : "");
      var w = M.openModal(opts.title || "Are you sure?", body,
        '<button type="button" class="cc-btn cc-btn-secondary" data-modal-cancel>Cancel</button>' +
        '<button type="button" class="cc-btn ' + (opts.danger ? "cc-btn-danger" : "cc-btn-primary") + '"' +
          ' id="cc-menu-confirm-ok"' + (opts.requireAcknowledge ? " disabled" : "") + ">" +
          CC.esc(opts.confirmLabel || "Confirm") + "</button>");
      var ok = w.querySelector("#cc-menu-confirm-ok");
      if (opts.requireAcknowledge) {
        w.querySelector("#cc-menu-ack").addEventListener("change", function (e) {
          ok.disabled = !e.target.checked;
        });
      }
      ok.addEventListener("click", function () { M.closeModal(); done(true); });
      w.querySelector("[data-modal-cancel]").addEventListener("click", function () {
        M.closeModal(); done(false);
      });
      w.querySelector("[data-modal-close]").addEventListener("click", function () { done(false); });
      // Backdrop click / Escape also close the modal via M.openModal's own
      // handlers — settle the promise as "cancelled" in those paths too.
      w.addEventListener("click", function (e) {
        if (e.target === w) window.setTimeout(function () { done(false); }, 0);
      });
      w.addEventListener("keydown", function (e) {
        if (e.key === "Escape") window.setTimeout(function () { done(false); }, 0);
      });
    });
  };

  /** Small inline toast (success/error/info), auto-dismissed. */
  M.toast = function (msg, kind) {
    var host = document.getElementById("cc-menu-toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "cc-menu-toasts";
      host.className = "cc-menu-toasts";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    var el = document.createElement("div");
    el.className = "cc-alert cc-alert-" + (kind === "error" ? "danger" : kind === "success" ? "success" : "info") +
      " cc-menu-toast";
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = CC.icon(kind === "error" ? "warning" : "check") +
      "<div>" + CC.esc(msg) + "</div>";
    host.appendChild(el);
    window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
  };

  /* ------------------------------------------------------------------ */
  /* Backend access                                                      */
  /* ------------------------------------------------------------------ */

  function needSb() {
    if (!CC.live || !CC.sb) throw new Error("The live backend is not connected yet.");
    return CC.sb;
  }
  M.needSb = needSb;

  function needUser() {
    if (!CC.user) throw new Error("Please sign in first.");
    return CC.user;
  }

  /** The signed-in seller's own shop row (full row incl. timezone). Null if none. */
  M.getMyShop = function () {
    var sb = needSb(); needUser();
    return sb.from("cc_shops").select("*").eq("user_id", CC.user.id)
      .limit(1).maybeSingle()
      .then(function (r) { if (r.error) throw r.error; return r.data || null; });
  };

  /** Sellable products for the schedule picker. */
  M.getProducts = function (shopId) {
    var sb = needSb();
    return sb.from("cc_products")
      .select("id,name,price_cents,portion,status,fulfillment")
      .eq("shop_id", shopId)
      .in("status", ["active", "paused", "sold_out"])
      .order("name")
      .then(function (r) { if (r.error) throw r.error; return r.data || []; });
  };

  /** Schedules enriched with _items (products) and _exceptions. */
  M.getSchedules = function (shopId) {
    var sb = needSb();
    return sb.from("cc_schedules").select("*").eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        if (!rows.length) return [];
        var ids = rows.map(function (x) { return x.id; });
        return Promise.all([
          sb.from("cc_schedule_items")
            .select("schedule_id,product_id,cc_products(id,name,price_cents)")
            .in("schedule_id", ids),
          sb.from("cc_schedule_exceptions").select("*")
            .in("schedule_id", ids).order("ex_date")
        ]).then(function (res) {
          if (res[0].error) throw res[0].error;
          if (res[1].error) throw res[1].error;
          var itemsBy = {}, exBy = {};
          (res[0].data || []).forEach(function (it) {
            (itemsBy[it.schedule_id] = itemsBy[it.schedule_id] || []).push(it);
          });
          (res[1].data || []).forEach(function (x) {
            (exBy[x.schedule_id] = exBy[x.schedule_id] || []).push(x);
          });
          rows.forEach(function (s) {
            s._items = itemsBy[s.id] || [];
            s._exceptions = exBy[s.id] || [];
          });
          return rows;
        });
      });
  };

  M.getSchedule = function (scheduleId) {
    var sb = needSb();
    return sb.from("cc_schedules").select("*").eq("id", scheduleId).single()
      .then(function (r) { if (r.error) throw r.error; return r.data; });
  };

  /** Occurrences for schedules in a date window, each with _schedule attached. */
  M.getOccurrences = function (schedules, fromDate, toDate) {
    var sb = needSb();
    var ids = (schedules || []).map(function (s) { return s.id; });
    if (!ids.length) return Promise.resolve([]);
    var byId = {};
    schedules.forEach(function (s) { byId[s.id] = s; });
    var q = sb.from("cc_occurrences").select("*").in("schedule_id", ids)
      .order("occ_date").order("window_start");
    if (fromDate) q = q.gte("occ_date", fromDate);
    if (toDate) q = q.lte("occ_date", toDate);
    return q.then(function (r) {
      if (r.error) throw r.error;
      (r.data || []).forEach(function (o) { o._schedule = byId[o.schedule_id]; });
      return r.data || [];
    });
  };

  /**
   * Day view: schedules + that date's occurrences, each annotated with
   * _committed (confirmed/preparing/… order count), _pending, _held (units
   * held by reservations). Read-only — used to guard edits.
   */
  M.getDayView = function (shopId, dateStr) {
    var sb = needSb();
    return M.getSchedules(shopId).then(function (schedules) {
      var ids = schedules.map(function (s) { return s.id; });
      if (!ids.length) return { schedules: schedules, occurrences: [] };
      var byId = {};
      schedules.forEach(function (s) { byId[s.id] = s; });
      return sb.from("cc_occurrences").select("*")
        .in("schedule_id", ids).eq("occ_date", dateStr)
        .order("window_start")
        .then(function (r) {
          if (r.error) throw r.error;
          var occs = r.data || [];
          occs.forEach(function (o) { o._schedule = byId[o.schedule_id]; });
          if (!occs.length) return { schedules: schedules, occurrences: [] };
          var oids = occs.map(function (o) { return o.id; });
          return Promise.all([
            sb.from("cc_order_requests").select("id,occurrence_id,status")
              .in("occurrence_id", oids),
            sb.from("cc_inventory_reservations").select("occurrence_id,qty")
              .in("occurrence_id", oids).eq("status", "held")
          ]).then(function (res) {
            if (res[0].error) throw res[0].error;
            if (res[1].error) throw res[1].error;
            var committed = {}, pending = {}, held = {};
            (res[0].data || []).forEach(function (o) {
              if (M.COMMITTED_STATUSES.indexOf(o.status) !== -1) {
                committed[o.occurrence_id] = (committed[o.occurrence_id] || 0) + 1;
              } else if (o.status === "pending") {
                pending[o.occurrence_id] = (pending[o.occurrence_id] || 0) + 1;
              }
            });
            (res[1].data || []).forEach(function (rv) {
              held[rv.occurrence_id] = (held[rv.occurrence_id] || 0) + rv.qty;
            });
            occs.forEach(function (o) {
              o._committed = committed[o.id] || 0;
              o._pending = pending[o.id] || 0;
              o._held = held[o.id] || 0;
            });
            return { schedules: schedules, occurrences: occs };
          });
        });
    });
  };

  /** Sum of units held by reservations for one occurrence. */
  M.getHeldQty = function (occurrenceId) {
    var sb = needSb();
    return sb.from("cc_inventory_reservations").select("qty")
      .eq("occurrence_id", occurrenceId).eq("status", "held")
      .then(function (r) {
        if (r.error) throw r.error;
        return (r.data || []).reduce(function (a, x) { return a + x.qty; }, 0);
      });
  };

  /**
   * Conflict scan: for occurrence ids, how many committed orders exist and
   * on which dates. Returns { total, byDate: {date: n} }.
   */
  M.checkConflicts = function (occurrenceIds) {
    var sb = needSb();
    if (!occurrenceIds.length) return Promise.resolve({ total: 0, byDate: {} });
    return sb.from("cc_order_requests").select("id,occurrence_id,status")
      .in("occurrence_id", occurrenceIds)
      .then(function (r) {
        if (r.error) throw r.error;
        var hitIds = {};
        (r.data || []).forEach(function (o) {
          if (M.COMMITTED_STATUSES.indexOf(o.status) !== -1) hitIds[o.occurrence_id] = 1;
        });
        var ids = Object.keys(hitIds);
        if (!ids.length) return { total: 0, byDate: {} };
        return sb.from("cc_occurrences").select("id,occ_date").in("id", ids)
          .then(function (r2) {
            if (r2.error) throw r2.error;
            var byDate = {};
            (r2.data || []).forEach(function (o) {
              byDate[o.occ_date] = (byDate[o.occ_date] || 0) + 1;
            });
            return { total: ids.length, byDate: byDate };
          });
      });
  };

  /* ------------------------------------------------------------------ */
  /* Schedule writes                                                     */
  /* ------------------------------------------------------------------ */

  function validateScheduleInput(input) {
    if (!input.shop_id) throw new Error("Missing shop.");
    if (["weekly", "dates", "range"].indexOf(input.kind) === -1) throw new Error("Pick a schedule kind.");
    if (input.kind === "weekly" && !(input.days && input.days.length))
      throw new Error("Pick at least one day of the week.");
    if (input.kind === "dates" && !(input.dates && input.dates.length))
      throw new Error("Pick at least one date.");
    if (input.kind === "range" && !input.end_date)
      throw new Error("Pick an end date for a date-range schedule.");
    if (!parseTimeStr(input.start_time) || !parseTimeStr(input.end_time))
      throw new Error("Pick a valid start and end time.");
    if (input.start_time >= input.end_time)
      throw new Error("End time must be after start time.");
    if (input.quantity !== null && input.quantity !== "" &&
        (isNaN(+input.quantity) || +input.quantity < 0))
      throw new Error("Quantity can't be negative.");
  }

  /**
   * Create a schedule + items + materialized occurrences.
   * input: { shop_id, shop_tz, product_id|null, items[], kind, days[],
   *          dates[], start_date, end_date, start_time, end_time,
   *          preorder_cutoff_hours, quantity|null, inventory_mode,
   *          fulfillment{}, status }
   */
  M.createSchedule = function (input) {
    var sb = needSb(); needUser();
    validateScheduleInput(input);
    var qty = (input.quantity === "" || input.quantity == null) ? null : Math.floor(+input.quantity);
    var row = {
      shop_id: input.shop_id,
      product_id: input.product_id || null,
      kind: input.kind,
      days: input.kind === "weekly" ? input.days.slice().sort() : null,
      start_date: input.kind === "dates" ? input.dates.slice().sort()[0] : input.start_date,
      end_date: input.kind === "range" ? input.end_date
        : (input.kind === "dates" ? input.dates.slice().sort().pop() : (input.end_date || null)),
      start_time: input.start_time,
      end_time: input.end_time,
      preorder_cutoff_hours: Math.max(0, +input.preorder_cutoff_hours || 0),
      quantity: qty,
      inventory_mode: input.inventory_mode === "auto" ? "auto" : "manual",
      fulfillment: input.fulfillment || {},
      status: input.status === "paused" ? "paused" : "active"
    };
    return sb.from("cc_schedules").insert(row).select().single()
      .then(function (r) {
        if (r.error) throw r.error;
        var sched = r.data;
        var job = Promise.resolve();
        if (!sched.product_id && input.items && input.items.length) {
          job = sb.from("cc_schedule_items").insert(
            input.items.map(function (pid) { return { schedule_id: sched.id, product_id: pid }; })
          ).then(function (r2) { if (r2.error) throw r2.error; });
        }
        return job.then(function () {
          var schedShape = Object.assign({}, sched, { _dates: input.dates });
          var slots = M.buildSlots(schedShape, [], input.shop_tz, { dates: input.dates });
          if (!slots.length) return sched;
          var occRows = slots.map(function (sl) {
            return Object.assign({ schedule_id: sched.id }, sl);
          });
          return sb.from("cc_occurrences").insert(occRows)
            .then(function (r3) { if (r3.error) throw r3.error; return sched; });
        });
      });
  };

  /**
   * Re-materialize occurrences from fromDate forward, honoring exceptions.
   * Occurrences WITH committed orders are updated in place (never deleted);
   * the rest are rebuilt. Returns { rebuilt, preserved }.
   * patch: schedule fields to change (times, quantity, cutoff, mode, status).
   */
  M.rematerializeFrom = function (scheduleId, patch, fromDate, shopTz, opts) {
    var sb = needSb();
    opts = opts || {};
    return M.getSchedule(scheduleId).then(function (sched) {
      var next = Object.assign({}, sched, patch || {});
      return sb.from("cc_schedule_exceptions").select("*").eq("schedule_id", scheduleId)
        .then(function (re) {
          if (re.error) throw re.error;
          var exceptions = re.data || [];
          return sb.from("cc_occurrences").select("id,occ_date")
            .eq("schedule_id", scheduleId).gte("occ_date", fromDate)
            .then(function (ro) {
              if (ro.error) throw ro.error;
              var existing = ro.data || [];
              var ids = existing.map(function (o) { return o.id; });
              return M.checkConflicts(ids).then(function (conf) {
                var conflictIds = [];
                // find occurrence ids that have committed orders
                var needDetail = conf.total > 0;
                var detailJob = needDetail
                  ? sb.from("cc_order_requests").select("occurrence_id")
                    .in("occurrence_id", ids)
                    .in("status", M.COMMITTED_STATUSES)
                    .then(function (r3) {
                      if (r3.error) throw r3.error;
                      var set = {};
                      (r3.data || []).forEach(function (o) { set[o.occurrence_id] = 1; });
                      return set;
                    })
                  : Promise.resolve({});
                return detailJob.then(function (conflictSet) {
                  var preserve = [], rebuild = [];
                  existing.forEach(function (o) {
                    if (conflictSet[o.id]) preserve.push(o); else rebuild.push(o);
                  });
                  function proceed() {
                    var jobs = [];
                    if (patch && Object.keys(patch).length) {
                      jobs.push(sb.from("cc_schedules").update(patch).eq("id", scheduleId)
                        .then(function (r4) { if (r4.error) throw r4.error; }));
                    }
                    if (rebuild.length) {
                      jobs.push(sb.from("cc_occurrences")
                        .delete().in("id", rebuild.map(function (o) { return o.id; }))
                        .then(function (r5) { if (r5.error) throw r5.error; }));
                    }
                    return Promise.all(jobs).then(function () {
                      var slots = M.buildSlots(next, exceptions, shopTz,
                        { fromDate: fromDate, dates: opts.dates });
                      // skip dates already preserved (they keep their rows)
                      var preservedDates = {};
                      preserve.forEach(function (o) { preservedDates[o.occ_date] = 1; });
                      var toInsert = slots.filter(function (sl) { return !preservedDates[sl.occ_date]; })
                        .map(function (sl) { return Object.assign({ schedule_id: scheduleId }, sl); });
                      var insJob = toInsert.length
                        ? sb.from("cc_occurrences").insert(toInsert)
                          .then(function (r6) { if (r6.error) throw r6.error; })
                        : Promise.resolve();
                      // in-place update for preserved rows (times/cutoff/quantity)
                      var upJobs = preserve.map(function (o) {
                        var sl = slots.filter(function (x) { return x.occ_date === o.occ_date; })[0];
                        if (!sl) return Promise.resolve();
                        return M.getHeldQty(o.id).then(function (held) {
                          var upd = {
                            window_start: sl.window_start,
                            window_end: sl.window_end,
                            cutoff_at: sl.cutoff_at
                          };
                          if (sl.quantity !== null) {
                            upd.quantity = sl.quantity;
                            // never silently drop below held reservations
                            upd.quantity_left = Math.max(held, sl.quantity_left == null ? held : sl.quantity_left);
                          }
                          return sb.from("cc_occurrences").update(upd).eq("id", o.id)
                            .then(function (r7) { if (r7.error) throw r7.error; });
                        });
                      });
                      return Promise.all([insJob].concat(upJobs)).then(function () {
                        return { rebuilt: toInsert.length, preserved: preserve.length };
                      });
                    });
                  }
                  if (conf.total > 0 && !opts.skipConflictWarning) {
                    var dateList = Object.keys(conf.byDate).sort().map(function (dt) {
                      return M.fmtDateLong(dt, shopTz) + " (" + conf.byDate[dt] + ")";
                    }).join(", ");
                    return M.confirmDialog({
                      title: "Confirmed orders on these dates",
                      bodyHtml: "<p>This change touches <strong>" + conf.total +
                        "</strong> date(s) with confirmed orders: " + CC.esc(dateList) + ".</p>" +
                        "<p>Those dates keep their existing slots and are updated in place — " +
                        "confirmed orders are <strong>never</strong> moved or canceled silently. " +
                        "If the new quantity is below held reservations, it is raised to match.</p>",
                      confirmLabel: "Apply change anyway",
                      danger: true,
                      requireAcknowledge: true,
                      acknowledgeLabel: "I understand confirmed orders are affected"
                    }).then(function (ok) { return ok ? proceed() : { rebuilt: 0, preserved: 0, cancelled: true }; });
                  }
                  return proceed();
                });
              });
            });
        });
    });
  };

  /** Pause a whole schedule + its future occurrences. */
  M.pauseSchedule = function (scheduleId, shopTz) {
    var sb = needSb();
    var today = M.todayInTz(shopTz);
    return sb.from("cc_schedules").update({ status: "paused" }).eq("id", scheduleId)
      .then(function (r) {
        if (r.error) throw r.error;
        return sb.from("cc_occurrences").update({ status: "paused" })
          .eq("schedule_id", scheduleId).gte("occ_date", today).neq("status", "paused");
      })
      .then(function (r2) { if (r2.error) throw r2.error; return true; });
  };

  /** Resume a schedule; paused-by-exception dates stay paused. */
  M.resumeSchedule = function (scheduleId, shopTz) {
    var sb = needSb();
    var today = M.todayInTz(shopTz);
    return sb.from("cc_schedules").update({ status: "active" }).eq("id", scheduleId)
      .then(function (r) {
        if (r.error) throw r.error;
        return sb.from("cc_schedule_exceptions").select("ex_date")
          .eq("schedule_id", scheduleId).eq("kind", "paused");
      })
      .then(function (re) {
        if (re.error) throw re.error;
        var exDates = (re.data || []).map(function (x) { return x.ex_date; });
        var q = sb.from("cc_occurrences").update({ status: "active" })
          .eq("schedule_id", scheduleId).gte("occ_date", today).eq("status", "paused");
        if (exDates.length) q = q.not("occ_date", "in", "(" + exDates.join(",") + ")");
        return q.then(function (r2) { if (r2.error) throw r2.error; return true; });
      });
  };

  /**
   * Delete a schedule. Blocked when any occurrence has committed orders
   * (those rows must be honored first); otherwise requires confirmation.
   */
  M.deleteSchedule = function (scheduleId) {
    var sb = needSb();
    return sb.from("cc_occurrences").select("id").eq("schedule_id", scheduleId)
      .then(function (r) {
        if (r.error) throw r.error;
        var ids = (r.data || []).map(function (o) { return o.id; });
        return M.checkConflicts(ids);
      })
      .then(function (conf) {
        if (conf.total > 0) {
          throw new Error("This schedule has confirmed orders on " + conf.total +
            " date(s). Pause it instead of deleting — confirmed orders must be honored.");
        }
        return M.confirmDialog({
          title: "Delete schedule?",
          bodyHtml: "<p>This removes the schedule and all of its future availability. " +
            "Past dates are kept for your records.</p>",
          confirmLabel: "Delete schedule",
          danger: true
        });
      })
      .then(function (ok) {
        if (!ok) return false;
        return sb.from("cc_schedules").delete().eq("id", scheduleId)
          .then(function (r2) { if (r2.error) throw r2.error; return true; });
      });
  };

  /** Extend a weekly schedule's materialization window by 12 more weeks. */
  M.extendSchedule = function (scheduleId, shopTz) {
    var sb = needSb();
    return Promise.all([
      M.getSchedule(scheduleId),
      sb.from("cc_occurrences").select("occ_date").eq("schedule_id", scheduleId)
        .order("occ_date", { ascending: false }).limit(1)
    ]).then(function (res) {
      var sched = res[0];
      var last = res[1].data && res[1].data[0] ? res[1].data[0].occ_date : null;
      if (sched.kind !== "weekly") throw new Error("Only weekly schedules need extending.");
      if (sched.end_date && last && last >= sched.end_date) {
        throw new Error("This schedule already runs through its end date.");
      }
      var fromDate = last ? M.addDays(last, 1) : M.todayInTz(shopTz);
      return sb.from("cc_schedule_exceptions").select("*").eq("schedule_id", scheduleId)
        .then(function (re) {
          if (re.error) throw re.error;
          var slots = M.buildSlots(sched, re.data || [], shopTz, { fromDate: fromDate });
          if (!slots.length) throw new Error("Nothing new to add — the schedule already covers the next 12 weeks.");
          var rows = slots.map(function (sl) { return Object.assign({ schedule_id: scheduleId }, sl); });
          return sb.from("cc_occurrences").insert(rows)
            .then(function (r2) {
              if (r2.error) throw r2.error;
              return rows.length;
            });
        });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Occurrence + exception writes                                       */
  /* ------------------------------------------------------------------ */

  function upsertException(scheduleId, dateStr, kind, override) {
    var sb = needSb();
    return sb.from("cc_schedule_exceptions")
      .upsert({ schedule_id: scheduleId, ex_date: dateStr, kind: kind, override: override || null },
        { onConflict: "schedule_id,ex_date" })
      .then(function (r) { if (r.error) throw r.error; return true; });
  }
  M.upsertException = upsertException;

  function removeException(scheduleId, dateStr) {
    var sb = needSb();
    return sb.from("cc_schedule_exceptions")
      .delete().eq("schedule_id", scheduleId).eq("ex_date", dateStr)
      .then(function (r) { if (r.error) throw r.error; return true; });
  }
  M.removeException = removeException;

  /** Pause / resume a single occurrence (keeps an exception for truth). */
  M.setOccurrenceStatus = function (occId, scheduleId, dateStr, status) {
    var sb = needSb();
    var job = (status === "paused")
      ? upsertException(scheduleId, dateStr, "paused", null)
      : removeException(scheduleId, dateStr);
    return job.then(function () {
      var patch = { status: status };
      return sb.from("cc_occurrences").update(patch).eq("id", occId)
        .then(function (r) { if (r.error) throw r.error; return true; });
    });
  };

  /**
   * Edit ONE occurrence: stores kind='override' with the changed fields and
   * updates the row. If the occurrence has committed orders and the change
   * touches times/quantity, warns + requires explicit confirmation.
   */
  M.overrideOccurrence = function (occId, scheduleId, dateStr, fields) {
    var sb = needSb();
    return M.checkConflicts([occId]).then(function (conf) {
      function apply() {
        return sb.from("cc_schedule_exceptions").select("override")
          .eq("schedule_id", scheduleId).eq("ex_date", dateStr).limit(1).maybeSingle()
          .then(function (r) {
            if (r.error) throw r.error;
            var merged = Object.assign({}, (r.data && r.data.override) || {}, fields);
            return upsertException(scheduleId, dateStr, "override", merged);
          })
          .then(function () {
            return sb.from("cc_occurrences").update(fields).eq("id", occId);
          })
          .then(function (r2) { if (r2.error) throw r2.error; return true; });
      }
      if (conf.total > 0) {
        return M.confirmDialog({
          title: "Confirmed orders on this date",
          bodyHtml: "<p>" + CC.esc(M.fmtDateLong(dateStr)) + " has confirmed orders. " +
            "They keep their slots — this edit changes the listing going forward " +
            "and never moves or cancels a confirmed order.</p>",
          confirmLabel: "Edit this date anyway",
          danger: true,
          requireAcknowledge: true,
          acknowledgeLabel: "I understand confirmed orders are affected"
        }).then(function (ok) { return ok ? apply() : false; });
      }
      return apply();
    });
  };

  /** Pause a specific date (holiday / day off). */
  M.pauseDate = function (scheduleId, dateStr, shopTz) {
    return upsertException(scheduleId, dateStr, "paused", null).then(function () {
      var sb = needSb();
      return sb.from("cc_occurrences").update({ status: "paused" })
        .eq("schedule_id", scheduleId).eq("occ_date", dateStr)
        .then(function (r) { if (r.error) throw r.error; return true; });
    });
  };

  /** Unpause a specific date. */
  M.unpauseDate = function (scheduleId, dateStr) {
    return removeException(scheduleId, dateStr).then(function () {
      var sb = needSb();
      return sb.from("cc_occurrences").select("id,quantity_left").eq("schedule_id", scheduleId)
        .eq("occ_date", dateStr).limit(1).maybeSingle()
        .then(function (r) {
          if (r.error) throw r.error;
          if (!r.data) return true;
          var st = r.data.quantity_left === 0 ? "sold_out" : "active";
          return sb.from("cc_occurrences").update({ status: st }).eq("id", r.data.id)
            .then(function (r2) { if (r2.error) throw r2.error; return true; });
        });
    });
  };

  /**
   * Bulk-edit a kind='dates' schedule: the chosen dates are already fully
   * materialized, so this updates the schedule row plus every future
   * occurrence in place (times, cutoff, quantity, mode, status).
   * patch may include: start_time, end_time, preorder_cutoff_hours,
   * quantity, inventory_mode, fulfillment, status.
   */
  M.updateDatesKind = function (scheduleId, patch, shopTz) {
    var sb = needSb();
    var today = M.todayInTz(shopTz);
    return M.getSchedule(scheduleId).then(function (sched) {
      if (sched.kind !== "dates") throw new Error("Not a specific-dates schedule.");
      return sb.from("cc_occurrences").select("id,occ_date")
        .eq("schedule_id", scheduleId).gte("occ_date", today)
        .then(function (ro) {
          if (ro.error) throw ro.error;
          var occs = ro.data || [];
          var ids = occs.map(function (o) { return o.id; });
          return M.checkConflicts(ids).then(function (conf) {
            function apply() {
              var jobs = [];
              if (Object.keys(patch).length) {
                jobs.push(sb.from("cc_schedules").update(patch).eq("id", scheduleId)
                  .then(function (r) { if (r.error) throw r.error; }));
              }
              var next = Object.assign({}, sched, patch);
              var per = occs.map(function (o) {
                var ws = M.zonedTimeToUtcIso(shopTz, o.occ_date, next.start_time);
                var we = M.zonedTimeToUtcIso(shopTz, o.occ_date, next.end_time);
                var cutoff = +next.preorder_cutoff_hours > 0
                  ? new Date(new Date(ws).getTime() - (+next.preorder_cutoff_hours) * 3600000).toISOString()
                  : null;
                return M.getHeldQty(o.id).then(function (held) {
                  var upd = { window_start: ws, window_end: we, cutoff_at: cutoff };
                  if (next.quantity !== null && next.quantity !== undefined) {
                    upd.quantity = next.quantity;
                    upd.quantity_left = Math.max(held, next.quantity);
                  }
                  if (next.status === "paused") upd.status = "paused";
                  return sb.from("cc_occurrences").update(upd).eq("id", o.id)
                    .then(function (r2) { if (r2.error) throw r2.error; });
                });
              });
              return Promise.all(jobs.concat(per)).then(function () {
                return { updated: occs.length };
              });
            }
            if (conf.total > 0) {
              var dateList = Object.keys(conf.byDate).sort().join(", ");
              return M.confirmDialog({
                title: "Confirmed orders on these dates",
                bodyHtml: "<p>This change touches <strong>" + conf.total +
                  "</strong> date(s) with confirmed orders: " + CC.esc(dateList) + ".</p>" +
                  "<p>Those dates are updated in place — confirmed orders are " +
                  "<strong>never</strong> moved or canceled silently.</p>",
                confirmLabel: "Apply change anyway",
                danger: true,
                requireAcknowledge: true,
                acknowledgeLabel: "I understand confirmed orders are affected"
              }).then(function (ok) { return ok ? apply() : { updated: 0, cancelled: true }; });
            }
            return apply();
          });
        });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Fulfillment                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Effective fulfillment for a schedule: schedule-level flags win when set,
   * else the product's flags, else the shop defaults. Returns
   * { pickup, delivery, shipping } booleans.
   */
  M.effectiveFulfillment = function (schedule, product, shop) {
    var out = { pickup: false, delivery: false, shipping: false };
    ["pickup", "delivery", "shipping"].forEach(function (k) {
      if (schedule && schedule.fulfillment && schedule.fulfillment[k] !== undefined) {
        out[k] = !!schedule.fulfillment[k];
      } else if (product && product.fulfillment && product.fulfillment[k] !== undefined) {
        out[k] = !!product.fulfillment[k];
      } else if (shop) {
        var sk = "fulfillment_" + k;
        if (shop[sk] !== undefined) out[k] = !!shop[sk];
      }
    });
    return out;
  };

  M.setShopFulfillment = function (shopId, flags) {
    var sb = needSb(); needUser();
    return sb.from("cc_shops").update({
      fulfillment_pickup: !!flags.pickup,
      fulfillment_delivery: !!flags.delivery,
      fulfillment_shipping: !!flags.shipping
    }).eq("id", shopId).eq("user_id", CC.user.id)
      .then(function (r) { if (r.error) throw r.error; return true; });
  };

  M.setProductFulfillment = function (productId, flags) {
    var sb = needSb();
    return sb.from("cc_products").update({
      fulfillment: { pickup: !!flags.pickup, delivery: !!flags.delivery, shipping: !!flags.shipping }
    }).eq("id", productId)
      .then(function (r) { if (r.error) throw r.error; return true; });
  };

  M.fulfillmentChips = function (flags) {
    var map = { pickup: ["store", "Pickup"], delivery: ["location", "Delivery"], shipping: ["shopping-bag", "Shipping"] };
    return ["pickup", "delivery", "shipping"].filter(function (k) { return flags[k]; })
      .map(function (k) {
        return '<span class="cc-badge cc-badge-info cc-menu-chip">' + CC.icon(map[k][0]) +
          CC.esc(map[k][1]) + "</span>";
      }).join("");
  };

})();
