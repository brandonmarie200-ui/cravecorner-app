/* ==========================================================================
   CraveCorner — Stage 5 shared live helpers (assets/js/cc-community.js)
   --------------------------------------------------------------------------
   Shared building blocks for the live community features (Stage 5):
   community feed, cravings board, favorites/following, reviews.

   Requires (loaded before this file):
     assets/js/icons.js        -> CC.icon
     assets/js/supabase.min.js -> window.supabase
     assets/js/cc.js           -> CC.sb / CC.live / CC.user / CC.ready /
                                  CC.signIn / CC.signUp / CC.imgUrl /
                                  CC.centsToPrice / CC.onAuth
   Requires at CALL time (app.js, loaded after this file):
     CC.esc, CC.states, and the .cc-modal CSS classes it injects.

   Load order on a page:
     icons.js, demo.js, supabase.min.js, cc.js,
     cc-community.js, cc-cravings.js, cc-reviews.js, app.js

   LIVE vs DEMO: every helper here no-ops or returns early when CC.live is
   false. Pages keep their Stage 1 demo behavior untouched in that case.

   Honest-data rules enforced here:
   - like_count is trigger-maintained: always displayed as read from the DB,
     re-fetched after a like/unlike so the UI can never invent a count.
   - Posts have no "save" in the schema (cc_favorites is products/shops
     only), so live post cards offer Like — never a fake Save.
   - Report reasons go to cc_reports; nothing is auto-moderated client-side.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var CC5 = (window.CC5 = window.CC5 || {});

  function esc(s) { return CC.esc(s); }
  function sb() { return CC.sb; }
  function live() { return !!(CC.live && CC.sb); }

  /* ------------------------------------------------------------------ */
  /* Time + date                                                         */
  /* ------------------------------------------------------------------ */

  /** "5m ago", "3h ago", "Oct 9, 2026" */
  CC5.timeAgo = function (iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 7) return d + "d ago";
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  /** Local YYYY-MM-DD for "today" (used for needed_by expiry math). */
  CC5.todayStr = function () {
    var d = new Date();
    function p(n) { return ("0" + n).slice(-2); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  };

  /** "2026-10-20" -> "Oct 20, 2026" */
  CC5.fmtDate = function (ymd) {
    if (!ymd) return "";
    var p = String(ymd).split("-");
    if (p.length < 3) return String(ymd);
    return new Date(+p[0], +p[1] - 1, +p[2])
      .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  /** Open cravings whose needed_by passed are "past", not active. */
  CC5.isExpired = function (craving) {
    return !!(craving && craving.status === "open" && craving.needed_by &&
              craving.needed_by < CC5.todayStr());
  };

  /* ------------------------------------------------------------------ */
  /* Stars                                                               */
  /* ------------------------------------------------------------------ */

  /** 5 star icons, n filled. Decorative except for the aria-label. */
  CC5.starsHtml = function (n, cls) {
    n = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    var out = '<span class="cc5-stars' + (cls ? " " + esc(cls) : "") + '"' +
      ' role="img" aria-label="' + n + " out of 5 stars" + '">';
    for (var i = 1; i <= 5; i++) {
      out += CC.icon("star", "cc5-star" + (i <= n ? " on" : ""));
    }
    return out + "</span>";
  };

  /* ------------------------------------------------------------------ */
  /* Toast (transient, non-blocking feedback)                            */
  /* ------------------------------------------------------------------ */

  CC5.toast = function (msg) {
    var host = document.getElementById("cc5-toast-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "cc5-toast-host";
      host.className = "cc5-toast-host";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    var el = document.createElement("div");
    el.className = "cc5-toast";
    el.textContent = String(msg == null ? "" : msg);
    host.appendChild(el);
    window.setTimeout(function () {
      el.classList.add("cc5-toast-out");
      window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
    }, 2600);
  };

  /* ------------------------------------------------------------------ */
  /* Modal shell (uses the .cc-modal classes app.js injects)             */
  /* ------------------------------------------------------------------ */

  function modalShell(title, bodyHtml) {
    var wrap = document.createElement("div");
    wrap.className = "cc-modal-backdrop";
    wrap.setAttribute("data-modal", "");
    wrap.innerHTML =
      '<div class="cc-modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
        '<div class="cc-modal-head"><h2 class="cc-h3">' + esc(title) + "</h2>" +
        '<button type="button" class="cc-modal-x" data-cc5-x aria-label="Close dialog">&times;</button></div>' +
        '<div class="cc-modal-body cc5-modal-body">' + bodyHtml + "</div>" +
      "</div>";
    function close() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      document.body.style.overflow = "";
    }
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.closest("[data-cc5-x]") || e.target.closest("[data-cc5-cancel]")) close();
    });
    document.body.appendChild(wrap);
    document.body.style.overflow = "hidden";
    var first = wrap.querySelector("input, select, textarea, button.cc-btn-primary");
    if (first) { try { first.focus(); } catch (e) {} }
    return { el: wrap, close: close };
  }
  CC5.modal = modalShell;

  CC5.confirmModal = function (title, bodyHtml, confirmLabel) {
    return new Promise(function (resolve) {
      var m = modalShell(title,
        "<p>" + bodyHtml + "</p>" +
        '<div class="cc-modal-actions">' +
          '<button type="button" class="cc-btn cc-btn-ghost" data-cc5-cancel>Cancel</button>' +
          '<button type="button" class="cc-btn cc-btn-danger" data-cc5-ok>' + esc(confirmLabel || "Confirm") + "</button>" +
        "</div>");
      m.el.querySelector("[data-cc5-ok]").addEventListener("click", function () { m.close(); resolve(true); });
      var done = false;
      function onClose() { if (!done) { done = true; resolve(false); } }
      m.el.addEventListener("click", function (e) {
        if (e.target === m.el || e.target.closest("[data-cc5-x]") || e.target.closest("[data-cc5-cancel]")) onClose();
      });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Auth                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Promise<user|null>. Resolves with the signed-in user, or null when the
   * visitor cancels. Never fakes an action: callers must abort when null.
   */
  CC5.requireAuth = function (actionLabel) {
    return new Promise(function (resolve) {
      if (CC.user) { resolve(CC.user); return; }
      openAuthModal(actionLabel || "do that", resolve);
    });
  };

  function openAuthModal(actionLabel, resolve) {
    var done = false;
    function finish(user) { if (!done) { done = true; resolve(user || null); } }
    var m = modalShell("Sign in",
      '<p class="cc5-auth-lead">Sign in to ' + esc(actionLabel) + ". CraveCorner accounts are free.</p>" +
      '<div data-cc5-auth-err></div>' +
      '<form data-cc5-auth-form novalidate>' +
        '<div class="cc-field" data-cc5-name-row hidden>' +
          '<label class="cc-label" for="cc5-auth-name">Display name</label>' +
          '<input class="cc-input" id="cc5-auth-name" name="name" autocomplete="nickname" maxlength="60">' +
        "</div>" +
        '<div class="cc-field">' +
          '<label class="cc-label" for="cc5-auth-email">Email</label>' +
          '<input class="cc-input" id="cc5-auth-email" name="email" type="email" autocomplete="email" required>' +
        "</div>" +
        '<div class="cc-field">' +
          '<label class="cc-label" for="cc5-auth-pass">Password</label>' +
          '<input class="cc-input" id="cc5-auth-pass" name="password" type="password" autocomplete="current-password" required minlength="6">' +
        "</div>" +
        '<div class="cc-modal-actions">' +
          '<button type="button" class="cc-btn cc-btn-ghost" data-cc5-cancel>Cancel</button>' +
          '<button type="submit" class="cc-btn cc-btn-primary" data-cc5-submit>Sign in</button>' +
        "</div>" +
      "</form>" +
      '<p class="cc5-auth-toggle"><button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-cc5-toggle>New here? Create an account</button></p>');

    var mode = "signin";
    var form = m.el.querySelector("[data-cc5-auth-form]");
    var errBox = m.el.querySelector("[data-cc5-auth-err]");
    var submitBtn = m.el.querySelector("[data-cc5-submit]");
    var toggleBtn = m.el.querySelector("[data-cc5-toggle]");
    var nameRow = m.el.querySelector("[data-cc5-name-row]");

    function showErr(msg) {
      errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' + esc(msg) + "</div>";
    }
    toggleBtn.addEventListener("click", function () {
      mode = mode === "signin" ? "signup" : "signin";
      var isUp = mode === "signup";
      nameRow.hidden = !isUp;
      submitBtn.textContent = isUp ? "Create account" : "Sign in";
      toggleBtn.textContent = isUp ? "Have an account? Sign in" : "New here? Create an account";
      m.el.querySelector(".cc-modal-head h2").textContent = isUp ? "Create account" : "Sign in";
      errBox.innerHTML = "";
    });
    m.el.addEventListener("click", function (e) {
      if (e.target === m.el || e.target.closest("[data-cc5-x]") || e.target.closest("[data-cc5-cancel]")) finish(null);
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errBox.innerHTML = "";
      var email = form.elements.email.value.trim();
      var pass = form.elements.password.value;
      if (!email || !pass) { showErr("Enter your email and password."); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = mode === "signup" ? "Creating…" : "Signing in…";
      var attempt = mode === "signup"
        ? CC.signUp(email, pass, (form.elements.name.value || "").trim() || undefined)
        : CC.signIn(email, pass);
      attempt.then(function () {
        if (CC.user) { m.close(); finish(CC.user); }
        else {
          // e.g. email confirmation still pending — no session yet.
          errBox.innerHTML = '<div class="cc-alert cc-alert-info" role="status">Account created — check your email to confirm it, then sign in.</div>';
          submitBtn.disabled = false;
          submitBtn.textContent = mode === "signup" ? "Create account" : "Sign in";
          finish(null);
        }
      }).catch(function (err) {
        showErr((err && err.message) || "Sign-in failed. Try again.");
        submitBtn.disabled = false;
        submitBtn.textContent = mode === "signup" ? "Create account" : "Sign in";
      });
    });
  }

  /**
   * Full auth card for the profile page. Renders a sign-in/up form when
   * logged out, or the account row + sign-out when logged in.
   * onChange(user|null) fires after any auth state change.
   */
  CC5.authCard = function (host, onChange) {
    function render() {
      if (CC.user) {
        var name = null;
        sb().from("cc_profiles").select("display_name").eq("user_id", CC.user.id).maybeSingle()
          .then(function (r) { name = (r.data && r.data.display_name) || null; paint(); })
          .catch(function () { paint(); });
        var painted = false;
        function paint() {
          if (painted) return; painted = true;
          host.innerHTML =
            '<div class="cc5-profile-head cc-card">' +
              '<div class="cc5-profile-id"><span class="cc5-profile-ava" aria-hidden="true">' +
                esc((name || CC.user.email || "?").charAt(0).toUpperCase()) + "</span>" +
                '<div><strong>' + esc(name || "CraveCorner member") + "</strong>" +
                '<p class="cc-small cc-muted">' + esc(CC.user.email || "") + "</p></div></div>" +
              '<button type="button" class="cc-btn cc-btn-outline cc-btn-sm" data-cc5-signout>Sign out</button>' +
            "</div>";
          host.querySelector("[data-cc5-signout]").addEventListener("click", function () {
            CC.signOut().then(function () { CC5.clearShopCache(); render(); if (onChange) onChange(null); });
          });
        }
        paint();
      } else {
        host.innerHTML =
          '<div class="cc5-auth-card cc-card">' +
            '<h2 class="cc-h3">Sign in to CraveCorner</h2>' +
            '<p class="cc-muted cc-small">Likes, follows, saved items, cravings, and reviews sync with your free account.</p>' +
            '<div data-cc5-auth-err></div>' +
            '<form data-cc5-auth-form novalidate>' +
              '<div class="cc-field" data-cc5-name-row hidden>' +
                '<label class="cc-label" for="cc5p-name">Display name</label>' +
                '<input class="cc-input" id="cc5p-name" name="name" autocomplete="nickname" maxlength="60">' +
              "</div>" +
              '<div class="cc-field"><label class="cc-label" for="cc5p-email">Email</label>' +
                '<input class="cc-input" id="cc5p-email" name="email" type="email" autocomplete="email" required></div>' +
              '<div class="cc-field"><label class="cc-label" for="cc5p-pass">Password</label>' +
                '<input class="cc-input" id="cc5p-pass" name="password" type="password" autocomplete="current-password" required minlength="6"></div>' +
              '<div class="cc-modal-actions" style="justify-content:flex-start;">' +
                '<button type="submit" class="cc-btn cc-btn-primary" data-cc5-submit>Sign in</button>' +
                '<button type="button" class="cc-btn cc-btn-ghost" data-cc5-toggle>New here? Create an account</button>' +
              "</div>" +
            "</form>" +
          "</div>";
        var mode = "signin";
        var form = host.querySelector("[data-cc5-auth-form]");
        var errBox = host.querySelector("[data-cc5-auth-err]");
        var submitBtn = host.querySelector("[data-cc5-submit]");
        var toggleBtn = host.querySelector("[data-cc5-toggle]");
        var nameRow = host.querySelector("[data-cc5-name-row]");
        toggleBtn.addEventListener("click", function () {
          mode = mode === "signin" ? "signup" : "signin";
          var isUp = mode === "signup";
          nameRow.hidden = !isUp;
          submitBtn.textContent = isUp ? "Create account" : "Sign in";
          toggleBtn.textContent = isUp ? "Have an account? Sign in" : "New here? Create an account";
          errBox.innerHTML = "";
        });
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          errBox.innerHTML = "";
          var email = form.elements.email.value.trim();
          var pass = form.elements.password.value;
          if (!email || !pass) {
            errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">Enter your email and password.</div>';
            return;
          }
          submitBtn.disabled = true;
          var attempt = mode === "signup"
            ? CC.signUp(email, pass, (form.elements.name.value || "").trim() || undefined)
            : CC.signIn(email, pass);
          attempt.then(function () {
            if (CC.user) { CC5.clearShopCache(); render(); if (onChange) onChange(CC.user); }
            else {
              errBox.innerHTML = '<div class="cc-alert cc-alert-info" role="status">Account created — check your email to confirm it, then sign in.</div>';
              submitBtn.disabled = false;
            }
          }).catch(function (err) {
            errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' + esc((err && err.message) || "Sign-in failed.") + "</div>";
            submitBtn.disabled = false;
          });
        });
      }
    }
    render();
    return { refresh: render };
  };

  /** "Sign in to X" box for logged-out states (never fakes the action). */
  CC5.loginWall = function (actionLabel) {
    return '<div class="cc5-login-wall">' +
      '<div class="cc5-login-wall-art" aria-hidden="true">' + CC.icon("user") + "</div>" +
      '<p class="cc-empty-title">Sign in to ' + esc(actionLabel) + "</p>" +
      '<p class="cc-empty-text">CraveCorner accounts are free — your likes, follows, and saves sync with your account.</p>' +
      '<div class="cc-empty-actions"><button type="button" class="cc-btn cc-btn-primary" data-cc5-open-auth>Sign in</button></div>' +
    "</div>";
  };

  /* ------------------------------------------------------------------ */
  /* Current user's shop (owner read of cc_shops)                        */
  /* ------------------------------------------------------------------ */

  var shopCache = {};
  CC5.clearShopCache = function () { shopCache = {}; };
  CC5.myShop = function () {
    if (!live() || !CC.user) return Promise.resolve(null);
    var uid = CC.user.id;
    if (shopCache[uid] !== undefined) return Promise.resolve(shopCache[uid]);
    return sb().from("cc_shops").select("id,name,slug,status,city,state")
      .eq("user_id", uid).maybeSingle()
      .then(function (r) {
        shopCache[uid] = r.error ? null : (r.data || null);
        return shopCache[uid];
      })
      .catch(function () { return null; });
  };
  if (CC.onAuth) CC.onAuth(function () { CC5.clearShopCache(); });

  /* ------------------------------------------------------------------ */
  /* Photo uploads (bucket paths: <uid>/<ts>-<i>.<ext>)                  */
  /* ------------------------------------------------------------------ */

  CC5.uploadPhotos = function (bucket, files, uid, max) {
    max = max || 4;
    var list = [];
    for (var i = 0; i < files.length && list.length < max; i++) {
      var f = files[i];
      if (!f.type || f.type.indexOf("image/") !== 0) {
        return Promise.reject(new Error("Only image files can be uploaded."));
      }
      if (f.size > 6 * 1024 * 1024) {
        return Promise.reject(new Error("Each photo must be under 6 MB."));
      }
      list.push(f);
    }
    var paths = [];
    var chain = Promise.resolve();
    list.forEach(function (f, i) {
      chain = chain.then(function () {
        var ext = ((f.name || "").split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
        var path = uid + "/" + Date.now() + "-" + i + "." + ext;
        return sb().storage.from(bucket).upload(path, f, { contentType: f.type }).then(function (r) {
          if (r.error) throw r.error;
          paths.push(path);
        });
      });
    });
    return chain.then(function () { return paths; });
  };

  /* ------------------------------------------------------------------ */
  /* Share (Web Share API with clipboard fallback)                       */
  /* ------------------------------------------------------------------ */

  CC5.share = function (title, text, url, btn) {
    var labelEl = btn ? btn.querySelector("[data-cc5-share-label]") : null;
    function done(label) {
      if (!labelEl) return;
      var orig = labelEl.getAttribute("data-cc5-share-orig") || labelEl.textContent;
      labelEl.setAttribute("data-cc5-share-orig", orig);
      labelEl.textContent = label;
      window.setTimeout(function () { labelEl.textContent = orig; }, 1800);
    }
    if (navigator.share) {
      navigator.share({ title: title, text: text, url: url }).catch(function () { /* dismissed */ });
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { done("Link copied"); },
        function () { done("Copy failed"); });
    } else {
      done("Copy unavailable");
    }
  };

  /* ------------------------------------------------------------------ */
  /* Reports -> cc_reports                                               */
  /* ------------------------------------------------------------------ */

  var REPORT_REASONS = {
    post:    ["Spam or scam", "Inappropriate content", "Misleading information", "Harassment", "Other"],
    review:  ["Fake or incentivized review", "Inappropriate content", "Not about this order", "Other"],
    craving: ["Spam or scam", "Inappropriate content", "Other"],
    product: ["Spam or scam", "Inappropriate content", "Misleading listing", "Other"],
    shop:    ["Spam or scam", "Inappropriate content", "Misleading business", "Other"]
  };

  /**
   * Report any target. opts.appealNote adds the "disagree with a moderation
   * decision?" support link (used for reviews).
   */
  CC5.report = function (targetType, targetId, label, opts) {
    opts = opts || {};
    CC5.requireAuth("report content").then(function (user) {
      if (!user || !live()) return;
      var reasons = REPORT_REASONS[targetType] || REPORT_REASONS.post;
      var m = modalShell("Report " + (label || targetType),
        '<div data-cc5-rep-err></div>' +
        '<form data-cc5-rep-form>' +
          '<div class="cc-field"><label class="cc-label" for="cc5-rep-reason">Reason</label>' +
            '<select class="cc-select" id="cc5-rep-reason" name="reason">' +
              reasons.map(function (r) { return '<option value="' + esc(r) + '">' + esc(r) + "</option>"; }).join("") +
            "</select></div>" +
          '<div class="cc-field"><label class="cc-label" for="cc5-rep-details">Details <span class="cc-muted">(optional)</span></label>' +
            '<textarea class="cc-textarea" id="cc5-rep-details" name="details" rows="3" maxlength="1000" ' +
              'placeholder="What should the moderators know?"></textarea></div>' +
          (opts.appealNote
            ? '<p class="cc-small cc-muted">Disagreeing with a moderation decision on your own content? ' +
              '<a href="contact.html">Contact support</a> to appeal it.</p>'
            : "") +
          '<div class="cc-modal-actions">' +
            '<button type="button" class="cc-btn cc-btn-ghost" data-cc5-cancel>Cancel</button>' +
            '<button type="submit" class="cc-btn cc-btn-primary">Send report</button>' +
          "</div>" +
        "</form>");
      var form = m.el.querySelector("[data-cc5-rep-form]");
      var errBox = m.el.querySelector("[data-cc5-rep-err]");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        sb().from("cc_reports").insert({
          reporter_id: user.id,
          target_type: targetType,
          target_id: targetId,
          reason: form.elements.reason.value,
          details: (form.elements.details.value || "").trim() || null
        }).then(function (r) {
          if (r.error) throw r.error;
          m.el.querySelector(".cc5-modal-body").innerHTML =
            CC.states.success({ title: "Report sent", body: "Thanks — moderators will take a look." });
          window.setTimeout(m.close, 1600);
        }).catch(function (err) {
          btn.disabled = false;
          errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' +
            esc((err && err.message) || "Could not send the report.") + "</div>";
        });
      });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Live post card (mirrors .cc-post-card markup from the design system) */
  /* ------------------------------------------------------------------ */

  var KIND_LABEL = { update: "Update", special: "Special", menu: "Menu", availability: "Availability" };

  /**
   * post: cc_posts row. shop: cc_shops_public row (may be null).
   * o: { liked, following, isOwner, product {id,name,price_cents,portion} }
   */
  CC5.postCard = function (post, shop, o) {
    o = o || {};
    shop = shop || {};
    var logo = shop.logo_url ? CC.imgUrl("cc-shop-images", shop.logo_url) : null;
    var place = [shop.city, shop.state].filter(Boolean).join(", ");
    var photos = post.photos || [];
    var media = "";
    if (photos.length) {
      var first = CC.imgUrl("cc-post-images", photos[0]);
      media = '<div class="cc-post-media cc5-post-media">' +
        '<img src="' + esc(first) + '" alt="' + esc("Photo from " + (shop.name || "a local shop")) + '" loading="lazy">' +
        (photos.length > 1
          ? '<span class="cc-badge cc-badge-info cc5-photo-count">' + photos.length + " photos</span>"
          : "") +
      "</div>";
    }
    var prod = "";
    if (o.product) {
      prod = '<a class="cc5-prod-link" href="product.html?id=' + esc(o.product.id) + '">' +
        CC.icon("shopping-bag") + "<span>" + esc(o.product.name) +
        " · " + esc(CC.centsToPrice(o.product.price_cents)) +
        (o.product.portion ? " " + esc(o.product.portion) : "") + "</span></a>";
    }
    var liked = !!o.liked, following = !!o.following;
    var kindLabel = KIND_LABEL[post.kind] || "Update";
    var pageUrl = "community.html";
    try { pageUrl = window.location.href.split("#")[0]; } catch (e) {}

    return '<article class="cc-post-card" data-cc5-post="' + esc(post.id) + '">' +
      '<div class="cc-post-head">' +
        (logo
          ? '<img class="cc-avatar" src="' + esc(logo) + '" alt="" loading="lazy">'
          : '<span class="cc-avatar cc5-ava-fallback" aria-hidden="true">' + CC.icon("store") + "</span>") +
        '<div class="cc-post-who">' +
          '<p class="cc-post-author">' +
            (shop.id
              ? '<a href="shop.html?id=' + esc(shop.id) + '">' + esc(shop.name || "Local shop") + "</a>"
              : esc(shop.name || "Local shop")) +
          "</p>" +
          '<p class="cc-post-time">' + esc(CC5.timeAgo(post.created_at)) + (place ? " · " + esc(place) : "") + "</p>" +
        "</div>" +
        '<span class="cc-badge cc-badge-info">' + esc(kindLabel) + "</span>" +
      "</div>" +
      '<p class="cc-post-body">' + esc(post.body) + "</p>" +
      media + prod +
      '<div class="cc-post-actions">' +
        '<button type="button" class="cc-post-action" data-cc5-like="' + esc(post.id) + '" ' +
          'aria-pressed="' + (liked ? "true" : "false") + '" aria-label="Like this post">' +
          CC.icon("heart") + '<span data-cc5-like-label>Like · ' + (post.like_count || 0) + "</span></button>" +
        '<button type="button" class="cc-post-action" data-cc5-share ' +
          'data-cc5-share-title="' + esc((shop.name || "CraveCorner") + " on CraveCorner") + '" ' +
          'data-cc5-share-text="' + esc(String(post.body || "").slice(0, 120)) + '" ' +
          'data-cc5-share-url="' + esc(pageUrl) + '" aria-label="Share this post">' +
          CC.icon("share") + '<span data-cc5-share-label>Share</span></button>' +
        (o.isOwner
          ? '<button type="button" class="cc-post-action" data-cc5-delete-post="' + esc(post.id) + '" aria-label="Delete this post">' +
            CC.icon("delete") + "<span>Delete</span></button>"
          : (shop.id
            ? '<button type="button" class="cc-btn cc-btn-sm ' + (following ? "cc-btn-secondary" : "cc-btn-outline") + '" ' +
              'data-cc5-follow="' + esc(shop.id) + '" aria-pressed="' + (following ? "true" : "false") + '">' +
              (following ? "Following" : "Follow") + "</button>"
            : "")) +
        '<button type="button" class="cc-post-action" data-cc5-report-post="' + esc(post.id) + '" aria-label="Report this post">' +
          CC.icon("warning") + "<span>Report</span></button>" +
      "</div>" +
    "</article>";
  };

  /* ------------------------------------------------------------------ */
  /* Actions (delegated; pages call CC5.bindActions(container, ctx))      */
  /* ------------------------------------------------------------------ */

  function paintFollow(btn, on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "Following" : "Follow";
    btn.classList.toggle("cc-btn-secondary", on);
    btn.classList.toggle("cc-btn-outline", !on);
  }

  CC5._toggleLike = function (btn) {
    var postId = btn.getAttribute("data-cc5-like");
    CC5.requireAuth("like posts").then(function (user) {
      if (!user || !live()) return;
      var uid = user.id;
      btn.disabled = true;
      sb().from("cc_likes").insert({ user_id: uid, post_id: postId }).then(function (r) {
        if (r.error && r.error.code === "23505") {
          // Already liked -> unlike.
          return sb().from("cc_likes").delete().eq("user_id", uid).eq("post_id", postId)
            .then(function (d) { if (d.error) throw d.error; return false; });
        }
        if (r.error) throw r.error;
        return true;
      }).then(function (likedNow) {
        // Re-read the trigger-maintained count — never invent it.
        return sb().from("cc_posts").select("like_count").eq("id", postId).single()
          .then(function (rr) {
            var count = (rr.data && rr.data.like_count) || 0;
            Array.prototype.forEach.call(
              document.querySelectorAll('[data-cc5-like="' + postId + '"]'),
              function (b) {
                b.setAttribute("aria-pressed", likedNow ? "true" : "false");
                var lab = b.querySelector("[data-cc5-like-label]");
                if (lab) lab.textContent = "Like · " + count;
                b.disabled = false;
              });
          });
      }).catch(function (err) {
        btn.disabled = false;
        CC5.toast((err && err.message) || "Could not update the like.");
      });
    });
  };

  CC5._toggleFollow = function (btn) {
    var shopId = btn.getAttribute("data-cc5-follow");
    CC5.requireAuth("follow shops").then(function (user) {
      if (!user || !live()) return;
      var uid = user.id;
      btn.disabled = true;
      sb().from("cc_follows").insert({ follower_id: uid, shop_id: shopId }).then(function (r) {
        if (r.error && r.error.code === "23505") {
          return sb().from("cc_follows").delete().eq("follower_id", uid).eq("shop_id", shopId)
            .then(function (d) { if (d.error) throw d.error; return false; });
        }
        if (r.error) throw r.error;
        return true;
      }).then(function (on) {
        Array.prototype.forEach.call(
          document.querySelectorAll('[data-cc5-follow="' + shopId + '"]'),
          function (b) { paintFollow(b, on); b.disabled = false; });
        CC5.toast(on ? "Following this shop." : "Unfollowed.");
      }).catch(function (err) {
        btn.disabled = false;
        CC5.toast((err && err.message) || "Could not update the follow.");
      });
    });
  };

  CC5._toggleFavorite = function (btn, kind) {
    // kind: "product" | "shop" -> cc_favorites (exactly one of product_id/shop_id)
    var id = btn.getAttribute(kind === "product" ? "data-cc5-fav-product" : "data-cc5-fav-shop");
    CC5.requireAuth("save items").then(function (user) {
      if (!user || !live()) return;
      var uid = user.id;
      var row = kind === "product" ? { user_id: uid, product_id: id } : { user_id: uid, shop_id: id };
      var col = kind === "product" ? "product_id" : "shop_id";
      btn.disabled = true;
      sb().from("cc_favorites").insert(row).then(function (r) {
        if (r.error && r.error.code === "23505") {
          return sb().from("cc_favorites").delete().eq("user_id", uid).eq(col, id)
            .then(function (d) { if (d.error) throw d.error; return false; });
        }
        if (r.error) throw r.error;
        return true;
      }).then(function (on) {
        var sel = kind === "product" ? '[data-cc5-fav-product="' + id + '"]' : '[data-cc5-fav-shop="' + id + '"]';
        Array.prototype.forEach.call(document.querySelectorAll(sel), function (b) {
          b.setAttribute("aria-pressed", on ? "true" : "false");
          var lab = b.querySelector("[data-cc5-fav-label]");
          if (lab) lab.textContent = on ? "Saved" : "Save";
          b.disabled = false;
        });
        CC5.toast(on ? "Saved." : "Removed from saved.");
      }).catch(function (err) {
        btn.disabled = false;
        CC5.toast((err && err.message) || "Could not update saved items.");
      });
    });
  };

  CC5._deletePost = function (btn) {
    var postId = btn.getAttribute("data-cc5-delete-post");
    CC5.requireAuth("delete posts").then(function (user) {
      if (!user || !live()) return;
      CC5.confirmModal("Delete this post?",
        "This removes the post for everyone. This cannot be undone.", "Delete post")
        .then(function (ok) {
          if (!ok) return;
          return sb().from("cc_posts").delete().eq("id", postId).then(function (r) {
            if (r.error) throw r.error;
            var card = btn.closest('[data-cc5-post="' + postId + '"]') || btn.closest(".cc-post-card");
            if (card && card.parentNode) card.parentNode.removeChild(card);
            CC5.toast("Post deleted.");
          });
        }).catch(function (err) {
          CC5.toast((err && err.message) || "Could not delete the post.");
        });
    });
  };

  /**
   * One delegated listener for every data-cc5-* action. Pages call this once
   * on the container they render live cards into.
   */
  CC5.bindActions = function (root) {
    if (!root || root._cc5Bound) return;
    root._cc5Bound = true;
    root.addEventListener("click", function (e) {
      var t = e.target, el;
      function up(sel) { return t.closest ? t.closest(sel) : null; }
      if ((el = up("[data-cc5-open-auth]"))) {
        e.preventDefault();
        CC5.requireAuth("continue").then(function () {});
        return;
      }
      if ((el = up("[data-cc5-like]"))) { e.preventDefault(); CC5._toggleLike(el); return; }
      if ((el = up("[data-cc5-follow]"))) { e.preventDefault(); CC5._toggleFollow(el); return; }
      if ((el = up("[data-cc5-fav-product]"))) { e.preventDefault(); CC5._toggleFavorite(el, "product"); return; }
      if ((el = up("[data-cc5-fav-shop]"))) { e.preventDefault(); CC5._toggleFavorite(el, "shop"); return; }
      if ((el = up("[data-cc5-share]"))) {
        e.preventDefault();
        CC5.share(
          el.getAttribute("data-cc5-share-title") || document.title,
          el.getAttribute("data-cc5-share-text") || "",
          el.getAttribute("data-cc5-share-url") || window.location.href,
          el);
        return;
      }
      if ((el = up("[data-cc5-delete-post]"))) { e.preventDefault(); CC5._deletePost(el); return; }
      if ((el = up("[data-cc5-report-post]"))) { CC5.report("post", el.getAttribute("data-cc5-report-post"), "this post"); return; }
      if ((el = up("[data-cc5-report-review]"))) { CC5.report("review", el.getAttribute("data-cc5-report-review"), "this review", { appealNote: true }); return; }
      if ((el = up("[data-cc5-report-craving]"))) { CC5.report("craving", el.getAttribute("data-cc5-report-craving"), "this craving"); return; }
      if ((el = up("[data-cc5-report-product]"))) { CC5.report("product", el.getAttribute("data-cc5-report-product"), "this listing"); return; }
      if ((el = up("[data-cc5-report-shop]"))) { CC5.report("shop", el.getAttribute("data-cc5-report-shop"), "this shop"); return; }
    });
  };

  /* ------------------------------------------------------------------ */
  /* Live-mode intercepts (capture phase, so Stage 1 demo handlers in    */
  /* app.js never fire when the backend is live)                         */
  /* ------------------------------------------------------------------ */

  // Bottom-nav "create" FAB: in live mode it opens the real post composer
  // instead of the Stage 2 honest-modal.
  document.addEventListener("click", function (e) {
    if (!CC.live) return;
    var fab = e.target && e.target.closest ? e.target.closest("[data-create]") : null;
    if (fab) {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = "create.html";
    }
  }, true);

})();
