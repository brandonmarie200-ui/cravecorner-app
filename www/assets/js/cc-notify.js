/* ==========================================================================
   CraveCorner — Stage 4: Notifications (cc-notify.js)
   Bell badge + dropdown in the shared header (hooks the existing [data-bell]
   elements rendered by assets/js/app.js — app.js itself is NOT modified),
   notification center data helpers, and in-app preferences.

   Exposes:
     CC.getNotifications({limit, offset, unreadOnly})
     CC.unreadNotifCount()            enabled types only
     CC.markNotificationRead(id)
     CC.markAllNotificationsRead()
     CC.deleteNotification(id)
     CC.notifDeepLink(n)              -> Promise<href> (quote resolves via DB)
     CC.notifMeta(type)               {icon, label}
     CC.notifPrefs() / CC.setNotifPref(type, on)  (localStorage; in-app only)
     CC.notifTypeEnabled(type)
     CC.refreshBell()                 re-render badge + dropdowns

   CONTRACT NOTES:
     - cc_notifications rows are TRIGGER-WRITTEN ONLY (no client INSERT
       policy; cc_notify() revoked from client roles). This UI only reads +
       marks read (self update/delete policies exist).
     - Email toggles are shown honestly as "coming when email is configured" —
       nothing is ever sent from the client.
     - Types seen so far: message | order | custom_order | quote | craving |
       review. Unknown future types degrade gracefully.

   Requires: assets/js/cc.js (CC.ready). Safe no-op when CC.ready is missing,
   when the backend isn't live, or when signed out. Include after app.js.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  function sb() { return CC.sb || null; }
  function esc(s) { return CC.esc(s); }

  /* Badge CSS — injected by this script so app.js stays untouched. */
  var BADGE_CSS =
    ".cc-icon-btn[data-bell]{position:relative}" +
    ".cc-notif-badge{position:absolute;top:0;right:0;min-width:20px;height:20px;padding:0 5px;" +
    "border-radius:999px;background:#F45B83;color:#fff;font-size:11px;font-weight:800;" +
    "display:grid;place-items:center;border:2px solid #FFF9F3;font-family:var(--cc-font-body);" +
    "pointer-events:none;line-height:1}" +
    ".cc-bell-all{display:inline-flex;align-items:center;gap:.35rem;font-size:.82rem;font-weight:700;" +
    "color:#F45B83;min-height:40px}" +
    ".cc-bell-all svg{width:15px;height:15px}" +
    ".cc-bell-all:hover{color:#d13a63}";
  function ensureCss() {
    if (document.getElementById("cc-notify-css")) return;
    var st = document.createElement("style");
    st.id = "cc-notify-css";
    st.textContent = BADGE_CSS;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ */
  /* Type metadata + deep links                                          */
  /* ------------------------------------------------------------------ */

  var TYPE_META = {
    message:      { icon: "message",      label: "Messages" },
    order:        { icon: "shopping-bag", label: "Orders" },
    custom_order: { icon: "clipboard",    label: "Custom orders" },
    quote:        { icon: "edit",         label: "Quotes" },
    craving:      { icon: "heart",        label: "Cravings" },
    review:       { icon: "star",         label: "Reviews" },
    safety:       { icon: "shield",       label: "Safety notices" },
    announcement: { icon: "bell",         label: "Announcements" }
  };
  CC.notifMeta = function (type) {
    return TYPE_META[type] || { icon: "bell", label: "Notifications" };
  };
  CC.notifTypes = function () { return Object.keys(TYPE_META); };

  /**
   * Where a notification leads. Quotes resolve through the DB (ref only
   * carries quote_id) to pick the right detail page.
   */
  CC.notifDeepLink = function (n) {
    var ref = (n && n.ref) || {};
    switch (n && n.type) {
      case "message":
        return Promise.resolve(ref.conversation_id
          ? "inbox.html?conv=" + encodeURIComponent(ref.conversation_id) : "inbox.html");
      case "order":
        return Promise.resolve(ref.order_id
          ? "orders.html?id=" + encodeURIComponent(ref.order_id) : "orders.html");
      case "custom_order":
        return Promise.resolve(ref.custom_order_id
          ? "custom-order.html?id=" + encodeURIComponent(ref.custom_order_id) : "orders.html");
      case "quote":
        if (!ref.quote_id || !sb()) return Promise.resolve("orders.html");
        return sb().from("cc_quotes").select("custom_order_id, order_request_id")
          .eq("id", ref.quote_id).maybeSingle()
          .then(function (r) {
            var q = r.data;
            if (q && q.custom_order_id) return "custom-order.html?id=" + encodeURIComponent(q.custom_order_id);
            if (q && q.order_request_id) return "orders.html?id=" + encodeURIComponent(q.order_request_id);
            return "orders.html";
          })
          .catch(function () { return "orders.html"; });
      case "craving":
        return Promise.resolve("cravings.html");
      case "review":
        return Promise.resolve("orders.html");
      default:
        return Promise.resolve("notifications.html");
    }
  };

  /* ------------------------------------------------------------------ */
  /* Reads / writes (reads + mark-read only — triggers write the rows)   */
  /* ------------------------------------------------------------------ */

  CC.getNotifications = function (opts) {
    opts = opts || {};
    var uid = CC.user ? CC.user.id : null;
    if (!sb() || !uid) return Promise.resolve([]);
    var q = sb().from("cc_notifications").select("*").eq("user_id", uid)
      .order("created_at", { ascending: false });
    if (opts.unreadOnly) q = q.is("read_at", null);
    if (opts.limit) q = q.limit(opts.limit);
    if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit || 30) - 1);
    return q.then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return r.data || [];
    }).catch(function () { return []; });
  };

  CC.unreadNotifCount = function () {
    var uid = CC.user ? CC.user.id : null;
    if (!sb() || !uid) return Promise.resolve(0);
    return sb().from("cc_notifications").select("id, type")
      .eq("user_id", uid).is("read_at", null).limit(200)
      .then(function (r) {
        if (r.error) return 0;
        return (r.data || []).filter(function (n) { return CC.notifTypeEnabled(n.type); }).length;
      })
      .catch(function () { return 0; });
  };

  CC.markNotificationRead = function (id) {
    if (!sb() || !CC.user) return Promise.resolve(false);
    return sb().from("cc_notifications").update({ read_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", CC.user.id)
      .then(function () { CC.refreshBell(); return true; })
      .catch(function () { return false; });
  };

  CC.markAllNotificationsRead = function () {
    if (!sb() || !CC.user) return Promise.resolve(false);
    return sb().from("cc_notifications").update({ read_at: new Date().toISOString() })
      .eq("user_id", CC.user.id).is("read_at", null)
      .then(function () { CC.refreshBell(); return true; })
      .catch(function () { return false; });
  };

  CC.deleteNotification = function (id) {
    if (!sb() || !CC.user) return Promise.resolve(false);
    return sb().from("cc_notifications").delete()
      .eq("id", id).eq("user_id", CC.user.id)
      .then(function () { CC.refreshBell(); return true; })
      .catch(function () { return false; });
  };

  /* ------------------------------------------------------------------ */
  /* In-app preferences (localStorage — honest, client-side only)        */
  /* ------------------------------------------------------------------ */

  var PREF_KEY = "cc_notif_prefs_v1";
  function prefMap() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (e) { return {}; }
  }
  /** All types default ON; a stored false opts out of in-app display. */
  CC.notifTypeEnabled = function (type) {
    var m = prefMap();
    return m[type] !== false;
  };
  CC.notifPrefs = function () {
    var m = prefMap(), out = {};
    CC.notifTypes().forEach(function (t) { out[t] = m[t] !== false; });
    return out;
  };
  CC.setNotifPref = function (type, on) {
    try {
      var m = prefMap();
      m[type] = !!on;
      localStorage.setItem(PREF_KEY, JSON.stringify(m));
    } catch (e) {}
    CC.refreshBell();
  };

  CC.relativeTime = function (iso) {
    if (!iso) return "";
    try {
      var ms = Date.now() - new Date(iso).getTime();
      var min = Math.floor(ms / 60000);
      if (min < 1) return "just now";
      if (min < 60) return min + "m ago";
      var h = Math.floor(min / 60);
      if (h < 24) return h + "h ago";
      var d = Math.floor(h / 24);
      if (d < 7) return d + "d ago";
      return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) { return ""; }
  };

  /* ------------------------------------------------------------------ */
  /* Bell badge + dropdown (hooks app.js header — never rewrites it)     */
  /* ------------------------------------------------------------------ */

  function bellButtons() {
    return Array.prototype.slice.call(document.querySelectorAll("[data-bell]"));
  }

  function paintBadge(btn, count) {
    var badge = btn.querySelector(".cc-notif-badge");
    if (count > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "cc-notif-badge";
        badge.setAttribute("aria-hidden", "true");
        btn.appendChild(badge);
      }
      badge.textContent = count > 99 ? "99+" : String(count);
      btn.setAttribute("aria-label", "Notifications, " + count + " unread");
    } else {
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      btn.setAttribute("aria-label", "Notifications");
    }
  }

  function dropdownItemHtml(n) {
    var meta = CC.notifMeta(n.type);
    return '<a class="s4-bell-item' + (n.read_at ? "" : " is-unread") + '" href="notifications.html">' +
      '<span class="s4-notif-icon">' + CC.icon(meta.icon) + "</span>" +
      "<span><strong>" + esc(n.title || meta.label) + "</strong>" +
      (n.body ? "<span>" + esc(n.body) + "</span>" : "") + "</span></a>";
  }

  function paintDropdown(panel, items) {
    var html = '<p class="cc-bell-title">Notifications</p>';
    if (!items.length) {
      html += '<p class="cc-small cc-muted">You\'re all caught up.</p>';
    } else {
      html += '<div class="s4-bell-list">' + items.map(dropdownItemHtml).join("") + "</div>";
    }
    html += '<a class="cc-bell-all" href="notifications.html">View all ' + CC.icon("share") + "</a>";
    panel.innerHTML = html;
  }

  function paintSignedOut(panel) {
    panel.innerHTML = '<p class="cc-bell-title">Notifications</p>' +
      '<p class="cc-small cc-muted">Sign in to see order updates, messages, and quotes.</p>';
  }

  var _refreshTimer = null;
  CC.refreshBell = function () {
    if (!sb() || !CC.live || !CC.user) return;
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function () {
      var btns = bellButtons();
      if (!btns.length) return;
      CC.unreadNotifCount().then(function (count) {
        btns.forEach(function (b) { paintBadge(b, count); });
      });
      CC.getNotifications({ limit: 6 }).then(function (items) {
        var shown = items.filter(function (n) { return CC.notifTypeEnabled(n.type); });
        btns.forEach(function (b) {
          var panel = b.parentElement ? b.parentElement.querySelector(".cc-bell-panel") : null;
          if (panel) paintDropdown(panel, shown);
        });
      });
    }, 120); // coalesce mark-read bursts
  };

  var _unsub = null;
  function hookBell() {
    ensureCss();
    var btns = bellButtons();
    if (!btns.length) return;
    if (!CC.user) {
      btns.forEach(function (b) {
        paintBadge(b, 0);
        var panel = b.parentElement ? b.parentElement.querySelector(".cc-bell-panel") : null;
        if (panel) paintSignedOut(panel);
      });
      return;
    }
    CC.refreshBell();
    if (_unsub) return;
    try {
      var ch = sb().channel("notif-" + CC.user.id)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "cc_notifications",
            filter: "user_id=eq." + CC.user.id },
          function (payload) {
            if (payload && payload.new && CC.notifTypeEnabled(payload.new.type)) {
              CC.refreshBell();
              if (typeof CC.onNotificationArrived === "function") {
                try { CC.onNotificationArrived(payload.new); } catch (e) {}
              }
            }
          })
        .subscribe();
      _unsub = function () { try { sb().removeChannel(ch); } catch (e) {} };
    } catch (e) {}
  }

  /* Re-hook when auth state flips (sign in/out) without a page reload. */
  function watchAuth() {
    if (typeof CC.onAuth !== "function") return;
    var lastUid = CC.user ? CC.user.id : null;
    CC.onAuth(function (event, user) {
      var uid = user ? user.id : null;
      if (uid !== lastUid) {
        lastUid = uid;
        _myShopReset();
        hookBell();
      }
    });
  }
  function _myShopReset() {
    if (CC.resetMyShop) { try { CC.resetMyShop(); } catch (e) {} }
  }

  /* Boot: wait for the shell (app.js renders the header on DOMContentLoaded
     before page scripts run), then await CC.ready and hook the bell. */
  function boot() {
    if (!CC.ready || typeof CC.ready.then !== "function") return; // cc.js not included
    CC.ready.then(function () {
      hookBell();
      watchAuth();
    }).catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
