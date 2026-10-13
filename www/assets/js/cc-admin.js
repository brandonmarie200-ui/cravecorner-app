/* ==========================================================================
   CraveCorner — admin console shared library (cc-admin.js)
   Stage 6: Admin & Launch.
   --------------------------------------------------------------------------
   SECURITY MODEL (read this before touching anything here):
   - Admin authority is enforced by the DATABASE, not by this UI.
     Every admin RLS policy in sql/10_rls.sql requires cc_is_admin()
     (SECURITY DEFINER; checks auth.jwt() email against cc_admins).
   - This file adds DEFENSE IN DEPTH only: it refuses to render the
     dashboard for non-admins (CC.isAdmin client check) and shows an
     "access denied" state. Hiding UI is not the gate; RLS is.
   - EVERY admin action must call CCAdmin.audit() (and, for enforcement,
     CCAdmin.moderate()). Actions that skip audit are a launch blocker.

   Include order on admin.html (after cc.js):
     <script src="assets/js/supabase.min.js"></script>
     <script src="assets/js/cc.js"></script>
     <script src="assets/js/cc-admin.js"></script>
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var A = (window.CCAdmin = window.CCAdmin || {});

  function sb() {
    if (!CC.sb) throw new Error("Supabase client failed to load (assets/js/supabase.min.js).");
    return CC.sb;
  }

  /* ---- escaping / formatting ------------------------------------------- */
  A.esc = function (v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };

  A.timeAgo = function (iso) {
    if (!iso) return "—";
    var d = new Date(iso), s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    var days = Math.floor(s / 86400);
    if (days < 30) return days + "d ago";
    return d.toLocaleDateString();
  };

  A.fmtDate = function (iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
  };

  A.badge = function (status) {
    var map = {
      published: "ok", active: "ok", approved: "ok", actioned: "ok",
      upheld: "ok", open: "warn", pending: "warn", reviewed: "info",
      draft: "muted", paused: "muted", dismissed: "muted",
      rejected: "bad", suspended: "bad", archived: "bad", overturned: "info",
      urgent: "bad", high: "warn", normal: "info", low: "muted",
      sold_out: "warn"
    };
    var cls = map[String(status)] || "muted";
    return '<span class="adm-badge adm-badge-' + cls + '">' + A.esc(status) + "</span>";
  };

  /* ---- admin gate (defense in depth; the DB is the real gate) ----------- */
  // Resolves { ok:true, user } when the signed-in user is an admin.
  // Rejects with { code } otherwise: "signed-out" | "denied" | "offline".
  A.requireAdmin = function () {
    return CC.ready.then(function () {
      if (!CC.live || !CC.sb) throw { code: "offline" };
      if (!CC.user) throw { code: "signed-out" };
      return CC.refreshAdmin().then(function (isAdmin) {
        if (!isAdmin) throw { code: "denied" };
        return { ok: true, user: CC.user };
      });
    });
  };

  A.adminEmail = function () {
    return (CC.user && CC.user.email) ? String(CC.user.email).toLowerCase() : "unknown";
  };

  /* ---- audit + moderation (every admin action writes these) ------------- */
  A.audit = function (action, targetType, targetId, details) {
    return sb().from("cc_audit_logs").insert({
      actor_admin_email: A.adminEmail(),
      action: action,
      target_type: targetType || null,
      target_id: targetId || null,
      details: details || {}
    }).then(function (r) {
      if (r.error) throw r.error;
      return true;
    });
  };

  // Record an enforcement action AND its audit entry in one call.
  A.moderate = function (opts) {
    // opts: { target_type, target_id, action, reason, details }
    var row = {
      target_type: opts.target_type,
      target_id: opts.target_id || null,
      action: opts.action,
      reason: opts.reason || null,
      actor_admin_email: A.adminEmail()
    };
    return sb().from("cc_moderation_actions").insert(row).select().single()
      .then(function (r) {
        if (r.error) throw r.error;
        return A.audit("moderation." + opts.action, opts.target_type, opts.target_id,
          Object.assign({ moderation_action_id: r.data.id, reason: opts.reason || null },
            opts.details || {}));
      });
  };

  /* ---- confirm dialog (every destructive/irreversible admin action) ----- */
  var dlgEl = null, dlgResolve = null;
  function ensureDialog() {
    if (dlgEl) return dlgEl;
    dlgEl = document.createElement("div");
    dlgEl.className = "adm-dialog-wrap";
    dlgEl.style.display = "none";
    dlgEl.innerHTML =
      '<div class="adm-dialog" role="alertdialog" aria-modal="true">' +
        '<h3 id="adm-dlg-title"></h3>' +
        '<div id="adm-dlg-body" class="adm-dialog-body"></div>' +
        '<label id="adm-dlg-note-wrap" class="adm-field" style="display:none">' +
          '<span id="adm-dlg-note-label">Note (required)</span>' +
          '<textarea id="adm-dlg-note" rows="3"></textarea>' +
        "</label>" +
        '<div class="adm-dialog-actions">' +
          '<button type="button" class="adm-btn" data-act="cancel">Cancel</button>' +
          '<button type="button" class="adm-btn adm-btn-danger" data-act="ok">Confirm</button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(dlgEl);
    dlgEl.addEventListener("click", function (ev) {
      var act = ev.target && ev.target.getAttribute("data-act");
      if (act === "cancel" || ev.target === dlgEl) finish(false);
      else if (act === "ok") finish(true);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && dlgEl.style.display !== "none") finish(false);
    });
    function finish(ok) {
      var noteEl = dlgEl.querySelector("#adm-dlg-note");
      var needNote = dlgEl.querySelector("#adm-dlg-note-wrap").style.display !== "none";
      var note = noteEl ? noteEl.value.trim() : "";
      if (ok && needNote && !note) {
        noteEl.focus();
        noteEl.setAttribute("aria-invalid", "true");
        return; // stay open until the required note is filled in
      }
      dlgEl.style.display = "none";
      var res = dlgResolve; dlgResolve = null;
      if (res) res({ ok: ok, note: note });
    }
    return dlgEl;
  }

  // opts: { title, body (html), confirmLabel, danger=true, requireNote, noteLabel }
  A.confirm = function (opts) {
    opts = opts || {};
    var el = ensureDialog();
    el.querySelector("#adm-dlg-title").textContent = opts.title || "Are you sure?";
    el.querySelector("#adm-dlg-body").innerHTML = opts.body || "";
    var okBtn = el.querySelector('[data-act="ok"]');
    okBtn.textContent = opts.confirmLabel || "Confirm";
    okBtn.className = "adm-btn " + (opts.danger === false ? "adm-btn-primary" : "adm-btn-danger");
    var wrap = el.querySelector("#adm-dlg-note-wrap");
    var noteEl = el.querySelector("#adm-dlg-note");
    if (opts.requireNote) {
      wrap.style.display = "";
      el.querySelector("#adm-dlg-note-label").textContent = opts.noteLabel || "Note (required)";
      noteEl.value = "";
      noteEl.removeAttribute("aria-invalid");
    } else {
      wrap.style.display = "none";
      noteEl.value = "";
    }
    el.style.display = "";
    return new Promise(function (resolve) { dlgResolve = resolve; })
      .then(function (r) {
        if (opts.requireNote && r.ok && !r.note) return { ok: false, note: "" };
        return r;
      });
  };

  /* ---- small UI helpers -------------------------------------------------- */
  A.toast = function (msg, kind) {
    var t = document.createElement("div");
    t.className = "adm-toast" + (kind === "error" ? " adm-toast-error" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("adm-toast-show"); }, 10);
    setTimeout(function () {
      t.classList.remove("adm-toast-show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 3200);
  };

  A.run = function (promiseFn, doneMsg) {
    return Promise.resolve().then(promiseFn).then(function (r) {
      if (doneMsg) A.toast(doneMsg);
      return r;
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      A.toast("Error: " + msg, "error");
      throw e;
    });
  };

  // Head-count helper (uses count/head — fine here; tables are known to exist).
  A.count = function (table, filters) {
    var q = sb().from(table).select("id", { count: "exact", head: true });
    (filters || []).forEach(function (f) { q = q.eq(f[0], f[1]); });
    return q.then(function (r) {
      if (r.error) throw r.error;
      return r.count || 0;
    });
  };
})();
