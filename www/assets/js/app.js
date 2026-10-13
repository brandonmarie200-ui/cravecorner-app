/* ==========================================================================
   CraveCorner — shared app JS (Stage 1: homepage + shared shell)
   Extends window.CC (defined by assets/js/icons.js). Renders the shared
   header/footer/demo banner, location picker, card builders, state helpers,
   and modal/search utilities used by every page.

   PAGE-BUILDER CONTRACT: a page sets `window.CC_ACTIVE_NAV` ('home',
   'explore', 'community', 'cravings', 'messages', 'profile', 'create')
   and optionally `window.CC_PAGE_INIT = function(){ ... }` (page-specific
   rendering). app.js runs CC_PAGE_INIT after the shell is rendered, on
   DOMContentLoaded. All card builders return escaped HTML strings.

   NOTE: image paths are root-relative ('assets/img/...'). Pages in
   subdirectories must adjust CC.img or use their own path prefix.
   ========================================================================== */
(function () {
  "use strict";

  var CC = window.CC = window.CC || {};

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /** Escape text for safe HTML interpolation (XSS-safe). */
  CC.esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  /** Image path helper — root pages only (see contract note above). */
  CC.img = function (n) { return "assets/img/" + n; };

  var UNIT_LABEL = { each: "each", dozen: "dozen", plate: "plate", tray: "tray" };

  /** "$14.00 <small>/ dozen</small>" — live rows pass free-text portion through. */
  CC.formatPrice = function (p) {
    var price = "$" + Number(p.price).toFixed(2);
    var unit = UNIT_LABEL[p.priceUnit] ? " / " + UNIT_LABEL[p.priceUnit]
      : (p.priceUnit ? " / " + p.priceUnit : "");
    return CC.esc(price) + (unit ? ' <small>' + CC.esc(unit) + "</small>" : "");
  };

  function demo() { return window.CC_DEMO || {}; }
  function shopById(id) {
    var shops = demo().SHOPS || [];
    for (var i = 0; i < shops.length; i++) if (shops[i].id === id) return shops[i];
    return null;
  }
  function categoryName(slug) {
    var cats = demo().CATEGORIES || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].slug === slug) return cats[i].name;
    return slug;
  }

  /* ------------------------------------------------------------------ */
  /* Shared shell styles — injected once so any page including app.js    */
  /* gets header/footer/banner/modal/card styles with zero extra CSS.   */
  /* ------------------------------------------------------------------ */
  var SHELL_CSS = [
    "/* CraveCorner shared shell (injected by assets/js/app.js) */",
    ".cc-demo-banner{position:relative;z-index:80;display:flex;align-items:center;justify-content:center;gap:.6rem;background:var(--cc-mango-50);border-bottom:1px solid var(--cc-mango-200);color:var(--cc-cocoa);font-size:.8rem;font-weight:500;padding:.6rem 3rem .6rem 1rem;text-align:center;line-height:1.4}",
    ".cc-demo-banner strong{font-weight:700}",
    ".cc-demo-banner-x{position:absolute;right:.4rem;top:50%;transform:translateY(-50%);width:44px;height:44px;display:grid;place-items:center;border:0;background:transparent;border-radius:50%;font-size:1.4rem;line-height:1;color:var(--cc-cocoa-soft);cursor:pointer}",
    ".cc-demo-banner-x:hover{background:var(--cc-mango-200);color:var(--cc-cocoa)}",
    ".cc-mobilebar{display:flex;align-items:center;gap:.35rem;padding:.55rem .9rem;background:rgba(255,249,243,.94);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--cc-border-soft);position:sticky;top:0;z-index:60}",
    ".cc-mobilebar .cc-brand img{height:30px;width:auto}",
    ".cc-loc-btn{flex:1;display:inline-flex;align-items:center;gap:.35rem;min-height:44px;min-width:0;padding:.4rem .6rem;border:0;background:transparent;border-radius:12px;color:var(--cc-cocoa-soft);font-size:.85rem;font-weight:600;cursor:pointer;text-align:left}",
    ".cc-loc-btn:hover{background:var(--cc-pink-50);color:var(--cc-cocoa)}",
    ".cc-loc-btn svg{width:18px;height:18px;flex:none;color:var(--cc-pink-deep)}",
    ".cc-loc-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "@media (min-width:1024px){.cc-mobilebar{display:none}}",
    ".cc-bell-wrap{position:relative;flex:none}",
    ".cc-bell-panel{position:absolute;top:calc(100% + 10px);right:-8px;width:min(320px,82vw);background:#fff;border:1px solid var(--cc-border-soft);border-radius:18px;box-shadow:var(--cc-shadow-lg);padding:1.1rem 1.1rem 1.25rem;z-index:90;text-align:left}",
    ".cc-bell-panel::before{content:\"\";position:absolute;top:-7px;right:22px;width:12px;height:12px;background:#fff;border-left:1px solid var(--cc-border-soft);border-top:1px solid var(--cc-border-soft);transform:rotate(45deg)}",
    ".cc-bell-title{font-family:var(--cc-font-head);font-weight:800;font-size:1rem;margin-bottom:.35rem;color:var(--cc-cocoa)}",
    ".cc-topnav-search{flex:1;max-width:340px;min-width:170px}",
    ".cc-topnav-search .cc-input{min-height:44px;font-size:.9rem}",
    "@media (min-width:1024px){.cc-topnav .cc-navlink{font-size:.9rem;padding:.5rem .75rem;white-space:nowrap}}",
    ".cc-footer{margin-top:2.5rem;background:#fff;border-top:1px solid var(--cc-border-soft)}",
    ".cc-footer-top{display:grid;gap:1.75rem;padding:2.25rem 0 1.5rem}",
    ".cc-footer-brand img{height:34px;width:auto;margin-bottom:.6rem}",
    ".cc-footer-tagline{color:var(--cc-cocoa-soft);font-size:.95rem;max-width:26ch}",
    ".cc-footer-cols{display:grid;grid-template-columns:repeat(2,1fr);gap:1.5rem}",
    ".cc-footer-cols h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--cc-cocoa-mute);margin-bottom:.55rem;font-weight:700}",
    ".cc-footer-cols ul{list-style:none;padding:0;display:grid;gap:.1rem}",
    ".cc-footer-cols a{display:inline-flex;align-items:center;min-height:40px;color:var(--cc-cocoa-soft);font-size:.95rem;font-weight:500}",
    ".cc-footer-cols a:hover{color:var(--cc-pink-deep);text-decoration:none}",
    ".cc-footer-bottom{border-top:1px solid var(--cc-border-soft);padding:1.1rem 0 1.4rem}",
    ".cc-footer-bottom p{font-size:.8rem;color:var(--cc-cocoa-mute);text-align:center}",
    "@media (min-width:768px){.cc-footer-top{grid-template-columns:1.1fr 2fr;align-items:start}.cc-footer-cols{grid-template-columns:repeat(3,1fr)}}",
    ".cc-modal-backdrop{position:fixed;inset:0;z-index:120;background:rgba(52,43,50,.55);display:flex;align-items:center;justify-content:center;padding:1rem}",
    ".cc-modal{background:#fff;border-radius:22px;width:100%;max-width:460px;max-height:88dvh;overflow:auto;padding:1.4rem;box-shadow:var(--cc-shadow-lg)}",
    ".cc-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:1rem}",
    ".cc-modal-head h2{color:var(--cc-cocoa)}",
    ".cc-modal-x{flex:none;width:44px;height:44px;margin:-.4rem -.4rem 0 0;border:0;background:transparent;border-radius:50%;font-size:1.5rem;line-height:1;color:var(--cc-cocoa-soft);cursor:pointer}",
    ".cc-modal-x:hover{background:var(--cc-cream-deep);color:var(--cc-cocoa)}",
    ".cc-modal-body{font-size:.95rem;color:var(--cc-cocoa-soft)}",
    ".cc-modal-body p+p{margin-top:.7rem}",
    ".cc-modal-actions{display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.25rem;flex-wrap:wrap}",
    ".cc-loc-form .cc-field{margin-bottom:.9rem}",
    ".cc-loc-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}",
    ".cc-product-title a{color:var(--cc-cocoa)}",
    ".cc-product-title a:hover{color:var(--cc-pink-deep);text-decoration:none}",
    ".ccx-fulfill-row{display:flex;flex-wrap:wrap;gap:.7rem;font-size:.78rem;color:var(--cc-cocoa-mute);font-weight:600}",
    ".ccx-fulfill-row span{display:inline-flex;align-items:center;gap:.3rem}",
    ".ccx-fulfill-row svg{width:14px;height:14px}",
    ".ccx-shop-card{overflow:hidden}",
    ".ccx-shop-cover{position:relative;aspect-ratio:16/9;background:var(--cc-cream-deep)}",
    ".ccx-shop-cover img{width:100%;height:100%;object-fit:cover}",
    ".ccx-shop-cover .cc-badge{position:absolute;top:.65rem;left:.65rem}",
    ".ccx-shop-body{padding:1rem 1.1rem 1.15rem;display:grid;gap:.45rem}",
    ".ccx-shop-name{font-family:var(--cc-font-head);font-weight:800;font-size:1.05rem;line-height:1.3;color:var(--cc-cocoa)}",
    ".ccx-shop-name a{color:var(--cc-cocoa)}",
    ".ccx-shop-name a:hover{color:var(--cc-pink-deep);text-decoration:none}",
    ".ccx-shop-blurb{font-size:.88rem;color:var(--cc-cocoa-soft)}",
    ".ccx-chips{display:flex;flex-wrap:wrap;gap:.4rem}",
    ".ccx-chip{display:inline-flex;align-items:center;min-height:32px;padding:.25rem .7rem;border-radius:999px;background:var(--cc-lilac-50);color:var(--cc-lilac-ink);font-size:.75rem;font-weight:600}",
    ".ccx-fulfill{display:flex;flex-wrap:wrap;gap:.9rem;font-size:.8rem;color:var(--cc-cocoa-soft);font-weight:600}",
    ".ccx-fulfill span{display:inline-flex;align-items:center;gap:.35rem}",
    ".ccx-fulfill svg{width:16px;height:16px;color:var(--cc-pink-deep)}",
    ".ccx-shop-actions{display:flex;gap:.6rem;margin-top:.3rem}",
    ".ccx-shop-actions .cc-btn{flex:1}",
    ".ccx-craving-card{padding:1.15rem;display:grid;gap:.6rem}",
    ".ccx-craving-top{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}",
    ".ccx-craving-top h3{font-size:1.02rem;font-weight:800;line-height:1.35;color:var(--cc-cocoa)}",
    ".ccx-craving-top .cc-badge{flex:none;margin-top:.15rem}",
    ".ccx-craving-desc{font-size:.9rem;color:var(--cc-cocoa-soft)}",
    ".ccx-craving-meta{list-style:none;padding:0;display:grid;gap:.35rem;font-size:.85rem;color:var(--cc-cocoa-soft)}",
    ".ccx-craving-meta li{display:flex;align-items:center;gap:.5rem}",
    ".ccx-craving-meta svg{width:16px;height:16px;color:var(--cc-pink-deep);flex:none}"
  ].join("\n");

  function ensureShellStyles() {
    if (document.getElementById("cc-shell")) return;
    var st = document.createElement("style");
    st.id = "cc-shell";
    st.textContent = SHELL_CSS;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ */
  /* Saved items + follows (localStorage only — no backend yet)          */
  /* ------------------------------------------------------------------ */
  function storeGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); }
    catch (e) { return {}; }
  }
  function storeSet(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  CC.isSaved = function (type, id) { return !!storeGet("cc_saved")[type + ":" + id]; };
  CC.toggleSave = function (type, id) {
    var s = storeGet("cc_saved"), k = type + ":" + id;
    if (s[k]) delete s[k]; else s[k] = 1;
    storeSet("cc_saved", s);
    return !!s[k];
  };
  CC.isFollowing = function (type, id) { return !!storeGet("cc_followed")[type + ":" + id]; };
  CC.toggleFollow = function (type, id) {
    var s = storeGet("cc_followed"), k = type + ":" + id;
    if (s[k]) delete s[k]; else s[k] = 1;
    storeSet("cc_followed", s);
    return !!s[k];
  };

  /** Paint saved/follow state onto already-rendered buttons. */
  CC.refreshSaveUI = function (root) {
    root = root || document;
    Array.prototype.forEach.call(root.querySelectorAll("[data-save]"), function (btn) {
      var on = CC.isSaved(btn.getAttribute("data-save"), btn.getAttribute("data-id"));
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      syncPostLike(btn);
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-follow]"), function (btn) {
      paintFollow(btn, CC.isFollowing(btn.getAttribute("data-follow"), btn.getAttribute("data-id")));
    });
  };

  function paintFollow(btn, on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "Following" : "Follow";
    btn.classList.toggle("cc-btn-secondary", on);
    btn.classList.toggle("cc-btn-outline", !on);
  }

  function syncPostLike(btn) {
    var label = btn.querySelector("[data-like-label]");
    if (!label) return;
    var base = parseInt(btn.getAttribute("data-likes") || "0", 10) || 0;
    var on = btn.getAttribute("aria-pressed") === "true";
    label.textContent = "Like · " + (base + (on ? 1 : 0));
  }

  /* ------------------------------------------------------------------ */
  /* Demo banner                                                         */
  /* ------------------------------------------------------------------ */
  CC.showDemoBanner = function () {
    try { if (localStorage.getItem("cc_demo_banner") === "dismissed") return; } catch (e) {}
    if (document.getElementById("cc-demo-banner")) return;
    var el = document.createElement("div");
    el.className = "cc-demo-banner";
    el.id = "cc-demo-banner";
    el.setAttribute("role", "note");
    el.innerHTML =
      "<span><strong>Preview build</strong> — all listings are samples for design review. Real sellers coming soon.</span>" +
      '<button type="button" class="cc-demo-banner-x" data-dismiss-banner aria-label="Dismiss notice">&times;</button>';
    document.body.insertAdjacentElement("afterbegin", el);
  };

  function dismissBanner() {
    var el = document.getElementById("cc-demo-banner");
    if (el) el.remove();
    try { localStorage.setItem("cc_demo_banner", "dismissed"); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Header: mobile top bar + desktop topnav + mobile bottom nav          */
  /* ------------------------------------------------------------------ */
  var NAV_LINKS = [
    ["explore", "Explore", "explore.html"],
    ["community", "Community", "community.html"],
    ["cravings", "Cravings Board", "cravings.html"],
    ["messages", "Messages", "messages.html"],
    ["profile", "Profile", "profile.html"],
    ["create", "Manage Shop", "create.html"]
  ];

  function bellWrapHtml() {
    return '<div class="cc-bell-wrap">' +
      '<button type="button" class="cc-icon-btn" data-bell aria-label="Notifications" aria-expanded="false">' +
      CC.icon("bell") + "</button>" +
      '<div class="cc-bell-panel" hidden>' +
      '<p class="cc-bell-title">Notifications</p>' +
      '<p class="cc-small cc-muted">Order updates, messages, and shop news land here.</p>' +
      '<p><a href="notifications.html">View all notifications</a></p>' +
      "</div></div>";
  }

  function closeAllPanels() {
    Array.prototype.forEach.call(document.querySelectorAll(".cc-bell-panel"), function (p) {
      p.hidden = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-bell]"), function (b) {
      b.setAttribute("aria-expanded", "false");
    });
  }

  function toggleBell(btn) {
    var panel = btn.parentElement.querySelector(".cc-bell-panel");
    if (!panel) return;
    var willOpen = panel.hidden;
    closeAllPanels();
    panel.hidden = !willOpen;
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  function navLinksHtml(active) {
    return NAV_LINKS.map(function (l) {
      return '<a class="cc-navlink' + (l[0] === active ? " is-active" : "") + '" href="' +
        CC.esc(l[2]) + '"' + (l[0] === active ? ' aria-current="page"' : "") + ">" +
        CC.esc(l[1]) + "</a>";
    }).join("");
  }

  function bottomNavHtml(active) {
    function item(key, href, icon, label) {
      return '<a class="cc-bnav-item' + (key === active ? " is-active" : "") + '" href="' +
        href + '"' + (key === active ? ' aria-current="page"' : "") + ">" +
        CC.icon(icon) + "<span>" + label + "</span></a>";
    }
    return '<nav class="cc-bottomnav" aria-label="Primary">' +
      item("home", "index.html", "home", "Home") +
      item("explore", "explore.html", "compass", "Explore") +
      '<button type="button" class="cc-bnav-fab" data-create aria-label="Create a listing">' + CC.icon("plus") + "</button>" +
      item("messages", "messages.html", "message", "Inbox") +
      item("profile", "profile.html", "user", "Profile") +
      "</nav>";
  }

  CC.renderHeader = function (active) {
    var host = document.getElementById("cc-header");
    if (!host) return;
    active = active || "home";
    var loc = CC.location.get();
    var locLabel = loc && loc.label ? loc.label : "Set location";
    var logo = CC.img("logo-cc.jpg");

    host.innerHTML =
      '<div class="cc-mobilebar">' +
        '<a class="cc-brand" href="index.html" aria-label="CraveCorner home">' +
          '<img src="' + CC.esc(logo) + '" alt="CraveCorner"></a>' +
        '<button type="button" class="cc-loc-btn" data-loc-open aria-label="Set your location">' +
          CC.icon("location") + '<span class="cc-loc-label">' + CC.esc(locLabel) + "</span></button>" +
        bellWrapHtml() +
        '<a class="cc-icon-btn" href="profile.html" aria-label="Profile">' + CC.icon("user") + "</a>" +
      "</div>" +
      '<nav class="cc-topnav" aria-label="Primary"><div class="cc-container cc-topnav-inner">' +
        '<a class="cc-brand" href="index.html" aria-label="CraveCorner home">' +
          '<img src="' + CC.esc(logo) + '" alt="CraveCorner"></a>' +
        '<form class="cc-topnav-search cc-search" data-cc-search role="search">' + CC.icon("search") +
          '<input class="cc-input" type="search" name="q" placeholder="Search dishes, shops, cravings\u2026" aria-label="Search CraveCorner"></form>' +
        '<div class="cc-navlinks">' + navLinksHtml(active) + "</div>" +
        '<div class="cc-nav-actions">' + bellWrapHtml() +
          '<a class="cc-icon-btn" href="profile.html" aria-label="Profile">' + CC.icon("user") + "</a></div>" +
      "</div></nav>" +
      bottomNavHtml(active);
  };

  /* ------------------------------------------------------------------ */
  /* Footer                                                              */
  /* ------------------------------------------------------------------ */
  function footerCol(title, links) {
    var lis = links.map(function (l) {
      return '<li><a href="' + CC.esc(l[1]) + '">' + CC.esc(l[0]) + "</a></li>";
    }).join("");
    return '<div><h3>' + CC.esc(title) + "</h3><ul>" + lis + "</ul></div>";
  }

  CC.renderFooter = function () {
    var host = document.getElementById("cc-footer");
    if (!host) return;
    host.innerHTML =
      '<footer class="cc-footer"><div class="cc-container">' +
        '<div class="cc-footer-top">' +
          '<div class="cc-footer-brand">' +
            '<img src="' + CC.esc(CC.img("logo-cc.jpg")) + '" alt="CraveCorner">' +
            '<p class="cc-footer-tagline">Find your craving. Support someone local.</p>' +
          "</div>" +
          '<nav class="cc-footer-cols" aria-label="Footer">' +
            footerCol("Discover", [["Explore", "explore.html"], ["Categories", "explore.html"],
              ["Cravings Board", "cravings.html"], ["Community", "community.html"]]) +
            footerCol("Sellers", [["Start selling", "create.html"], ["Seller rules", "policies.html"]]) +
            footerCol("Company", [["About", "policies.html"], ["Policies", "policies.html"],
              ["Contact", "contact.html"]]) +
          "</nav>" +
        "</div>" +
        '<div class="cc-footer-bottom">' +
          "<p>\u00A9 2026 CraveCorner \u00B7 Preview build \u2014 sample data shown for design review only.</p>" +
        "</div>" +
      "</div></footer>";
  };

  /* ------------------------------------------------------------------ */
  /* Location (localStorage only)                                        */
  /* ------------------------------------------------------------------ */
  CC.location = {
    KEY: "cc_location",
    get: function () {
      try {
        var raw = localStorage.getItem("cc_location");
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    set: function (loc) {
      try { localStorage.setItem("cc_location", JSON.stringify(loc)); } catch (e) {}
    }
  };

  CC.refreshLocationLabels = function () {
    var loc = CC.location.get();
    var label = loc && loc.label ? loc.label : "Set location";
    Array.prototype.forEach.call(document.querySelectorAll(".cc-loc-label"), function (el) {
      el.textContent = label;
    });
  };

  var US_STATES = [
    ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
    ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["DC","District of Columbia"],
    ["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],
    ["IN","Indiana"],["IA","Iowa"],["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],
    ["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],
    ["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],
    ["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],["NY","New York"],
    ["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],
    ["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],["SD","South Dakota"],
    ["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virginia"],
    ["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"]
  ];

  CC.openLocationModal = function () {
    var cur = CC.location.get() || {};
    var stateOpts = ['<option value="">State</option>'].concat(US_STATES.map(function (s) {
      return '<option value="' + s[0] + '"' + (cur.state === s[0] ? " selected" : "") + ">" + s[1] + "</option>";
    })).join("");
    var radii = ["5", "10", "25", "50"];
    var radiusOpts = radii.map(function (r) {
      return '<option value="' + r + '"' + (String(cur.radius) === r ? " selected" : "") + ">Within " + r + " mi</option>";
    }).join("");

    var body =
      '<form id="cc-loc-form" class="cc-loc-form">' +
        '<div class="cc-field"><label class="cc-label" for="cc-zip">ZIP code</label>' +
          '<input class="cc-input" id="cc-zip" name="zip" inputmode="numeric" maxlength="10" ' +
          'placeholder="e.g. 78629" value="' + CC.esc(cur.zip || "") + '"></div>' +
        '<div class="cc-loc-grid">' +
          '<div class="cc-field"><label class="cc-label" for="cc-city">City</label>' +
            '<input class="cc-input" id="cc-city" name="city" placeholder="e.g. Gonzales" ' +
            'value="' + CC.esc(cur.city || "") + '"></div>' +
          '<div class="cc-field"><label class="cc-label" for="cc-state">State</label>' +
            '<select class="cc-select" id="cc-state" name="state">' + stateOpts + "</select></div>" +
        "</div>" +
        '<div class="cc-field"><label class="cc-label" for="cc-radius">Search radius</label>' +
          '<select class="cc-select" id="cc-radius" name="radius">' + radiusOpts + "</select></div>" +
        '<p class="cc-hint">Used to sort nearby shops and cravings. Stored only on this device.</p>' +
        '<div class="cc-modal-actions">' +
          '<button type="button" class="cc-btn cc-btn-ghost" data-modal-close>Cancel</button>' +
          '<button type="submit" class="cc-btn cc-btn-primary">Save location</button>' +
        "</div>" +
      "</form>";

    var wrap = openModalShell("Your location", body);
    var form = wrap.querySelector("#cc-loc-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var zip = form.elements.zip.value.trim();
      var city = form.elements.city.value.trim();
      var state = form.elements.state.value;
      if (!zip && !city) { form.elements.zip.focus(); return; }
      var label = city ? city + (state ? ", " + state : "") : "ZIP " + zip;
      CC.location.set({ label: label, zip: zip, city: city, state: state, radius: form.elements.radius.value });
      CC.refreshLocationLabels();
      /* Let live pages re-apply the nearby filter immediately. */
      try { document.dispatchEvent(new CustomEvent("cc:location-changed")); } catch (e) {}
      closeModal();
    });
  };

  /* ------------------------------------------------------------------ */
  /* Modals                                                              */
  /* ------------------------------------------------------------------ */
  var lastFocus = null;

  function focusables(dialog) {
    return Array.prototype.filter.call(
      dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && el.offsetParent !== null; }
    );
  }

  function trapTab(e, dialog) {
    var f = focusables(dialog);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }

  function openModalShell(title, bodyHtml) {
    closeModal();
    lastFocus = document.activeElement;
    var wrap = document.createElement("div");
    wrap.className = "cc-modal-backdrop";
    wrap.setAttribute("data-modal", "");
    wrap.innerHTML =
      '<div class="cc-modal" role="dialog" aria-modal="true" aria-label="' + CC.esc(title) + '" tabindex="-1">' +
        '<div class="cc-modal-head"><h2 class="cc-h3">' + CC.esc(title) + "</h2>" +
        '<button type="button" class="cc-modal-x" data-modal-close aria-label="Close dialog">&times;</button></div>' +
        '<div class="cc-modal-body">' + bodyHtml + "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    document.body.style.overflow = "hidden";
    var dialog = wrap.firstElementChild;
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.closest("[data-modal-close]")) closeModal();
    });
    wrap.addEventListener("keydown", function (e) { if (e.key === "Tab") trapTab(e, dialog); });
    var f = focusables(dialog);
    (f[0] || dialog).focus();
    return wrap;
  }

  function closeModal() {
    var w = document.querySelector("[data-modal]");
    if (w) w.remove();
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }
  CC.closeModal = closeModal;

  /** Generic modal with a single dismiss button. */
  CC.honestModal = function (title, bodyHtml) {
    return openModalShell(title,
      bodyHtml +
      '<div class="cc-modal-actions">' +
        '<button type="button" class="cc-btn cc-btn-primary" data-modal-close>Got it</button>' +
      "</div>");
  };

  /* ------------------------------------------------------------------ */
  /* Card builders (return escaped HTML strings)                         */
  /* ------------------------------------------------------------------ */
  var BADGE_MAP = {
    ready:   ["cc-badge-ready", "Ready today"],
    made:    ["cc-badge-info", "Made to order"],
    "new":   ["cc-badge-new", "New"],
    soldout: ["cc-badge-soldout", "Sold out"]
  };
  var FULFILL_MAP = {
    pickup:   ["store", "Pickup"],
    delivery: ["location", "Delivery"],
    shipping: ["shopping-bag", "Shipping"]
  };

  function fulfillIcons(arr, cls) {
    return (arr || []).map(function (f) {
      var m = FULFILL_MAP[f];
      if (!m) return "";
      return "<span>" + CC.icon(m[0]) + CC.esc(m[1]) + "</span>";
    }).join("");
  }

  /* shopOverride: live branches pass the resolved shop row directly
     (demo path still resolves via shopById). p.imgUrl: resolved storage URL. */
  CC.productCard = function (p, shopOverride) {
    var shop = shopOverride || shopById(p.shopId) || {};
    var shopName = shop.name || p._shopName || "";
    var imgSrc = p.imgUrl || CC.img(p.img || "placeholder-food.jpg");
    var b = BADGE_MAP[p.badge];
    var badgeHtml = b ? '<span class="cc-badge ' + b[0] + '">' + CC.esc(b[1]) + "</span>" : "";
    var saved = CC.isSaved("product", p.id);
    return '<article class="cc-product-card">' +
      '<div class="cc-product-media">' +
        '<img src="' + CC.esc(imgSrc) + '" alt="' + CC.esc(p.name) + '" loading="lazy">' +
        badgeHtml +
        '<button type="button" class="cc-product-fav" data-save="product" data-id="' + CC.esc(p.id) + '" ' +
          'aria-pressed="' + (saved ? "true" : "false") + '" aria-label="Save ' + CC.esc(p.name) + '">' +
          CC.icon("heart") + "</button>" +
      "</div>" +
      '<div class="cc-product-body">' +
        '<h3 class="cc-product-title"><a href="product.html?id=' + CC.esc(p.id) + '">' + CC.esc(p.name) + "</a></h3>" +
        '<p class="cc-product-shop">' + CC.icon("store") + "<span>" + CC.esc(shopName) + "</span></p>" +
        '<p class="cc-caption">' + CC.esc(p.city) + ", " + CC.esc(p.state) + "</p>" +
        '<div class="ccx-fulfill-row">' + fulfillIcons(p.fulfillment) + "</div>" +
        '<div class="cc-product-row"><span class="cc-price">' + CC.formatPrice(p) + "</span></div>" +
      "</div></article>";
  };

  /* s.coverUrl: resolved storage URL for live shops (demo uses s.cover asset). */
  CC.shopCard = function (s) {
    var following = CC.isFollowing("shop", s.id);
    var coverSrc = s.coverUrl || CC.img(s.cover || "placeholder-food.jpg");
    var cats = (s.categories || []).map(function (slug) {
      return '<span class="ccx-chip">' + CC.esc(categoryName(slug)) + "</span>";
    }).join("");
    return '<article class="ccx-shop-card cc-card">' +
      '<div class="ccx-shop-cover">' +
        '<img src="' + CC.esc(coverSrc) + '" alt="' + CC.esc(s.name) + '" loading="lazy">' +
        (s.isNew ? '<span class="cc-badge cc-badge-new">New</span>' : "") +
      "</div>" +
      '<div class="ccx-shop-body">' +
        '<h3 class="ccx-shop-name"><a href="shop.html?id=' + CC.esc(s.id) + '">' + CC.esc(s.name) + "</a></h3>" +
        '<p class="cc-small cc-muted">' + CC.esc(s.city) + ", " + CC.esc(s.state) + "</p>" +
        '<p class="ccx-shop-blurb">' + CC.esc(s.blurb) + "</p>" +
        '<div class="ccx-chips">' + cats + "</div>" +
        '<div class="ccx-fulfill">' + fulfillIcons(s.fulfillment) + "</div>" +
        '<div class="ccx-shop-actions">' +
          '<button type="button" class="cc-btn cc-btn-sm ' + (following ? "cc-btn-secondary" : "cc-btn-outline") + '" ' +
            'data-follow="shop" data-id="' + CC.esc(s.id) + '" aria-pressed="' + (following ? "true" : "false") + '">' +
            (following ? "Following" : "Follow") + "</button>" +
          '<a class="cc-btn cc-btn-sm cc-btn-ghost" href="shop.html?id=' + CC.esc(s.id) + '">View shop</a>' +
        "</div>" +
      "</div></article>";
  };

  CC.postCard = function (post) {
    var shop = shopById(post.shopId) || {};
    var saved = CC.isSaved("post", post.id);
    var likes = (parseInt(post.likes, 10) || 0) + (saved ? 1 : 0);
    var place = [shop.city, shop.state].filter(Boolean).join(", ");
    return '<article class="cc-post-card">' +
      '<div class="cc-post-head">' +
        '<img class="cc-avatar" src="' + CC.esc(CC.img(shop.cover || "placeholder-food.jpg")) + '" alt="" loading="lazy">' +
        '<div class="cc-post-who">' +
          '<p class="cc-post-author">' + CC.esc(shop.name || "Sample shop") + "</p>" +
          '<p class="cc-post-time">Sample post' + (place ? " · " + CC.esc(place) : "") + "</p>" +
        "</div>" +
        '<span class="cc-badge cc-badge-info">Sample</span>' +
      "</div>" +
      '<p class="cc-post-body">' + CC.esc(post.caption) + "</p>" +
      '<div class="cc-post-media"><img src="' + CC.esc(CC.img(post.img)) + '" alt="' +
        CC.esc("Photo from " + (shop.name || "a sample shop")) + '" loading="lazy"></div>' +
      '<div class="cc-post-actions">' +
        '<button type="button" class="cc-post-action" data-save="post" data-id="' + CC.esc(post.id) + '" ' +
          'data-likes="' + (parseInt(post.likes, 10) || 0) + '" aria-pressed="' + (saved ? "true" : "false") + '">' +
          CC.icon("heart") + '<span data-like-label>Like · ' + likes + "</span></button>" +
        '<button type="button" class="cc-post-action" data-post-share>' + CC.icon("share") + "<span>Share</span></button>" +
      "</div></article>";
  };

  var CRAVING_STATUS = {
    open:   ["cc-badge-info", "Open"],
    found:  ["cc-badge-ready", "Matched"],
    closed: ["cc-badge-soldout", "Closed"]
  };

  CC.cravingCard = function (c) {
    var st = CRAVING_STATUS[c.status] || CRAVING_STATUS.open;
    return '<article class="ccx-craving-card cc-card">' +
      '<div class="ccx-craving-top"><h3>' + CC.esc(c.title) + '</h3>' +
        '<span class="cc-badge ' + st[0] + '">' + CC.esc(st[1]) + "</span></div>" +
      '<p class="ccx-craving-desc">' + CC.esc(c.description) + "</p>" +
      '<ul class="ccx-craving-meta">' +
        "<li>" + CC.icon("location") + "<span>" + CC.esc(c.city) + ", " + CC.esc(c.state) + "</span></li>" +
        "<li>" + CC.icon("clock") + "<span>Needed by " + CC.esc(c.neededBy) + "</span></li>" +
        "<li>" + CC.icon("clipboard") + "<span>Budget " + CC.esc(c.budget) + "</span></li>" +
      "</ul>" +
      '<div><button type="button" class="cc-btn cc-btn-sm cc-btn-outline" data-craving-reply>Reply to this craving</button></div>' +
    "</article>";
  };

  /* ------------------------------------------------------------------ */
  /* State helpers (skeleton / empty / error / success)                  */
  /* ------------------------------------------------------------------ */
  CC.states = {
    skeletonCards: function (n) {
      n = Math.max(1, parseInt(n, 10) || 4);
      var out = "";
      for (var i = 0; i < n; i++) {
        out += '<div class="cc-product-card" aria-hidden="true">' +
          '<div class="cc-product-media cc-skeleton"></div>' +
          '<div class="cc-product-body">' +
            '<div class="cc-skeleton" style="height:18px;width:82%"></div>' +
            '<div class="cc-skeleton" style="height:14px;width:55%"></div>' +
            '<div class="cc-skeleton" style="height:22px;width:40%"></div>' +
          "</div></div>";
      }
      return '<div class="cc-grid-products">' + out + "</div>";
    },
    empty: function (o) {
      o = o || {};
      var action = (o.actionLabel && o.actionHref)
        ? '<div class="cc-empty-actions"><a class="cc-btn cc-btn-secondary" href="' + CC.esc(o.actionHref) + '">' +
          CC.esc(o.actionLabel) + "</a></div>" : "";
      return '<div class="cc-empty">' +
        '<div class="cc-empty-art">' + CC.icon(o.icon || "search") + "</div>" +
        '<p class="cc-empty-title">' + CC.esc(o.title || "Nothing here yet") + "</p>" +
        (o.body ? '<p class="cc-empty-text">' + CC.esc(o.body) + "</p>" : "") +
        action + "</div>";
    },
    error: function (o) {
      o = o || {};
      return '<div class="cc-empty">' +
        '<div class="cc-empty-art">' + CC.icon("warning") + "</div>" +
        '<p class="cc-empty-title">' + CC.esc(o.title || "Something went wrong") + "</p>" +
        (o.body ? '<p class="cc-empty-text">' + CC.esc(o.body) + "</p>" : "") +
        '<div class="cc-empty-actions"><button type="button" class="cc-btn cc-btn-secondary" ' +
          'onclick="location.reload()">' + CC.esc(o.retryLabel || "Try again") + "</button></div>" +
      "</div>";
    },
    success: function (o) {
      o = o || {};
      return '<div class="cc-alert cc-alert-success" role="status">' + CC.icon("check") +
        "<div><strong>" + CC.esc(o.title || "Done") + "</strong>" +
        (o.body ? "<br>" + CC.esc(o.body) : "") + "</div></div>";
    }
  };

  /* ------------------------------------------------------------------ */
  /* Search                                                              */
  /* ------------------------------------------------------------------ */
  CC.initSearch = function (form) {
    if (!form || form._ccSearchInit) return;
    form._ccSearchInit = true;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = form.querySelector('input[name="q"]');
      var q = input ? input.value.trim() : "";
      window.location.href = "explore.html" + (q ? "?q=" + encodeURIComponent(q) : "");
    });
  };

  /* ------------------------------------------------------------------ */
  /* Global wiring: delegation, Esc, image fallback                      */
  /* ------------------------------------------------------------------ */
  function onDocClick(e) {
    var t = e.target;

    var saveBtn = t.closest("[data-save]");
    if (saveBtn) {
      var on = CC.toggleSave(saveBtn.getAttribute("data-save"), saveBtn.getAttribute("data-id"));
      saveBtn.setAttribute("aria-pressed", on ? "true" : "false");
      syncPostLike(saveBtn);
      return;
    }
    var fBtn = t.closest("[data-follow]");
    if (fBtn) {
      paintFollow(fBtn, CC.toggleFollow(fBtn.getAttribute("data-follow"), fBtn.getAttribute("data-id")));
      return;
    }
    var bell = t.closest("[data-bell]");
    if (bell) { toggleBell(bell); return; }
    if (t.closest("[data-loc-open]")) { CC.openLocationModal(); return; }
    if (t.closest("[data-create]")) {
      window.location.href = "create.html";
      return;
    }
    if (t.closest("[data-craving-reply]")) {
      ensureSignedIn("reply to cravings").then(function (ok) {
        if (ok) window.location.href = "cravings.html";
      });
      return;
    }
    if (t.closest("[data-post-share]")) {
      var shareUrl = window.location.href.split("#")[0];
      var shareData = { title: "CraveCorner", text: "Fresh from a local kitchen on CraveCorner", url: shareUrl };
      if (navigator.share) {
        navigator.share(shareData).catch(function () { /* dismissed */ });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl).then(function () {
          CC.honestModal("Link copied", "<p>The link to this post is on your clipboard.</p>");
        }, function () {
          CC.honestModal("Share", "<p>Copy this link to share:</p><p style=\"word-break:break-all\">" + CC.esc(shareUrl) + "</p>");
        });
      } else {
        CC.honestModal("Share", "<p>Copy this link to share:</p><p style=\"word-break:break-all\">" + CC.esc(shareUrl) + "</p>");
      }
      return;
    }
    if (t.closest("[data-dismiss-banner]")) { dismissBanner(); return; }

    if (!t.closest(".cc-bell-panel")) closeAllPanels();
  }

  function onDocKeydown(e) {
    if (e.key === "Escape") {
      if (document.querySelector("[data-modal]")) closeModal();
      else closeAllPanels();
    }
  }

  /* Sign-in gate for actions that need an account. Resolves true when the
     visitor is (now) signed in, false when they cancel. Never fakes it. */
  function ensureSignedIn(actionLabel) {
    if (CC.user) return Promise.resolve(true);
    if (window.CC5 && typeof CC5.requireAuth === "function") {
      return CC5.requireAuth(actionLabel).then(function (u) { return !!u; });
    }
    var next = window.location.pathname.split("/").pop() + window.location.search;
    window.location.href = "auth.html?next=" + encodeURIComponent(next);
    return Promise.resolve(false);
  }

  function wireGlobal() {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onDocKeydown);
    /* Broken images fall back to the placeholder (once — no loops). */
    document.addEventListener("error", function (e) {
      var el = e.target;
      if (el && el.tagName === "IMG" && !el.getAttribute("data-cc-fbk")) {
        el.setAttribute("data-cc-fbk", "1");
        el.src = CC.img("placeholder-food.jpg");
      }
    }, true);
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
  function init() {
    ensureShellStyles();
    CC.showDemoBanner();
    CC.renderHeader(window.CC_ACTIVE_NAV || "home");
    CC.renderFooter();
    document.body.classList.add("cc-has-bottomnav");
    wireGlobal();
    CC.refreshSaveUI(document);
    CC.refreshLocationLabels();
    // Service worker: web only — skipped inside the native app wrapper
    // (Capacitor serves from capacitor://localhost; the native shell handles caching).
    try {
      var isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      if (!isNativeApp && "serviceWorker" in navigator) {
        window.addEventListener("load", function () {
          navigator.serviceWorker.register("sw.js").catch(function () {});
        });
      }
    } catch (e) {}
    Array.prototype.forEach.call(document.querySelectorAll("form[data-cc-search]"), CC.initSearch);
    if (typeof window.CC_PAGE_INIT === "function") {
      try { window.CC_PAGE_INIT(); }
      catch (err) { console.error("[CraveCorner] page init failed:", err); }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
