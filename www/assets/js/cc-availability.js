/* ==========================================================================
   CraveCorner — Stage 3: Food Availability (cc-availability.js)
   --------------------------------------------------------------------------
   Customer-facing availability: upcoming bookable dates for a product,
   pickup/delivery windows, order-cutoff countdowns, quantity left, and
   sold-out states.

   Reads (public RLS — works for published shops):
     cc_schedules / cc_schedule_items / cc_occurrences via
     cc_schedule_is_public(schedule_id).

   ORDER HOOK (Stage 4 contract):
     CC.openOrderRequest(productId, occurrenceId)
     Stage 4 (orders) will implement this to open its order-request modal.
     Until then, the fallback below shows an honest "Ordering opens with
     Stage 4" modal — the Preorder button never fakes a checkout. Stage 4:
     define window.CC.openOrderRequest BEFORE this file loads (or any time
     before a click) and your implementation wins; this file will not
     overwrite an existing function.

   READY-TODAY HOOK (documented for index.html — NOT wired there yet):
     CC_AVAIL.getReadyToday() → [{ product, shop, occurrence }] for slots
     whose occ_date is "today" in the SHOP's timezone with quantity left.
     Index.html's Ready Today section is Stage 1 demo content; when the live
     backend is on, call getReadyToday() and render with CC.productCard()
     (map rows to { id, name, price, img, shopId, city, state, badge:'ready' }).
     Left unwired deliberately — see the Stage 3 report.

   Requires: assets/js/cc.js (CC), assets/js/cc-menu.js (CC_MENU).
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var M = window.CC_MENU || {};
  var AV = (window.CC_AVAIL = window.CC_AVAIL || {});

  function needSb() {
    if (!CC.live || !CC.sb) throw new Error("The live backend is not connected yet.");
    return CC.sb;
  }

  /* ------------------------------------------------------------------ */
  /* Order hook — the real implementation lives in cc-orders.js           */
  /* ------------------------------------------------------------------ */

  if (typeof CC.openOrderRequest !== "function") {
    /**
     * Fallback if the order module failed to load.
     * @param {string} productId
     * @param {string|null} occurrenceId — the chosen availability slot, if any
     */
    CC.openOrderRequest = function (productId, occurrenceId) {
      CC.honestModal("Ordering isn't available",
        "<p>Order requests can't be placed right now. " +
        "CraveCorner has no in-app checkout ever — payment is arranged directly " +
        "with the seller using their accepted methods.</p>" +
        (occurrenceId
          ? "<p class=\"cc-caption\">You picked an available date — it will carry into the order request once ordering loads.</p>"
          : ""));
    };
    CC.openOrderRequest._ccStage3Fallback = true;
  }

  /* ------------------------------------------------------------------ */
  /* Availability queries                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Schedules that can sell this product: direct product schedules plus
   * full-menu schedules that list it in cc_schedule_items. Shop must be
   * published (enforced by RLS via cc_schedule_is_public).
   */
  AV.getProductSchedules = function (productId) {
    var sb = needSb();
    return sb.from("cc_products").select("id,shop_id,fulfillment,status")
      .eq("id", productId).limit(1).maybeSingle()
      .then(function (rp) {
        if (rp.error) throw rp.error;
        if (!rp.data) throw new Error("Listing not found.");
        var product = rp.data;
        return sb.from("cc_shops_public").select("id,timezone,status")
          .eq("id", product.shop_id).limit(1).maybeSingle()
          .then(function (rs) {
            if (rs.error) throw rs.error;
            if (!rs.data) throw new Error("This shop isn't published right now.");
            var shop = rs.data;
            return Promise.all([
              sb.from("cc_schedules").select("*").eq("product_id", productId)
                .eq("status", "active"),
              sb.from("cc_schedule_items").select("schedule_id")
                .eq("product_id", productId)
            ]).then(function (res) {
              if (res[0].error) throw res[0].error;
              if (res[1].error) throw res[1].error;
              var direct = res[0].data || [];
              var menuIds = (res[1].data || []).map(function (x) { return x.schedule_id; });
              var job = menuIds.length
                ? sb.from("cc_schedules").select("*").in("id", menuIds).eq("status", "active")
                  .then(function (rm) { if (rm.error) throw rm.error; return rm.data || []; })
                : Promise.resolve([]);
              return job.then(function (menuScheds) {
                // RLS public-read already filters to published shops' schedules.
                var all = direct.concat(menuScheds);
                var seen = {}, out = [];
                all.forEach(function (s) { if (!seen[s.id]) { seen[s.id] = 1; out.push(s); } });
                out.forEach(function (s) { s._shop = shop; s._product = product; });
                return { product: product, shop: shop, schedules: out };
              });
            });
          });
      });
  };

  /**
   * Upcoming bookable occurrences for a product.
   * Filters: active schedule, active occurrence, occ_date ≥ today in the
   * SHOP's timezone, window still in the future, quantity left (null =
   * unlimited counts as available).
   * Returns enriched rows sorted by window_start.
   */
  AV.getProductAvailability = function (productId, opts) {
    opts = opts || {};
    var limit = Math.max(1, Math.min(60, +opts.limit || 12));
    return AV.getProductSchedules(productId).then(function (ctx) {
      var sb = needSb();
      if (!ctx.schedules.length) return { product: ctx.product, shop: ctx.shop, slots: [] };
      var tz = ctx.shop.timezone || "America/Chicago";
      var today = M.todayInTz(tz);
      var nowIso = new Date().toISOString();
      var ids = ctx.schedules.map(function (s) { return s.id; });
      return sb.from("cc_occurrences").select("*")
        .in("schedule_id", ids)
        .eq("status", "active")
        .gte("occ_date", today)
        .gt("window_end", nowIso)
        .order("window_start")
        .limit(limit * 3) // over-fetch: quantity filter happens client-side
        .then(function (r) {
          if (r.error) throw r.error;
          var byId = {};
          ctx.schedules.forEach(function (s) { byId[s.id] = s; });
          var slots = (r.data || [])
            .filter(function (o) { return o.quantity_left === null || o.quantity_left > 0; })
            .slice(0, limit)
            .map(function (o) {
              var s = byId[o.schedule_id];
              return {
                occurrence: o,
                schedule: s,
                shopTz: tz,
                fulfillment: M.effectiveFulfillment
                  ? M.effectiveFulfillment(s, ctx.product, null)
                  : { pickup: false, delivery: false, shipping: false }
              };
            });
          return { product: ctx.product, shop: ctx.shop, slots: slots };
        });
    });
  };

  /**
   * Ready-today slots across (optionally) many shops — the documented hook
   * for the homepage Ready Today section. opts: { limit }.
   * NOTE: untestable against the live DB until migrations run; the query
   * shape follows the RLS public-read policies (published shops only).
   */
  AV.getReadyToday = function (opts) {
    opts = opts || {};
    var sb = needSb();
    var limit = Math.max(1, Math.min(24, +opts.limit || 8));
    var nowIso = new Date().toISOString();
    // Candidate window: occurrences ending in the future, dated yesterday→tomorrow
    // in UTC; the per-shop "today" check happens client-side below.
    var d = new Date();
    var from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1))
      .toISOString().slice(0, 10);
    return sb.from("cc_occurrences").select(
      "id,occ_date,window_start,window_end,cutoff_at,quantity_left,status," +
      "cc_schedules!inner(id,product_id,shop_id,status)"
    )
      .eq("status", "active")
      .gte("occ_date", from)
      .gt("window_end", nowIso)
      .order("window_start")
      .limit(200)
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = (r.data || []).filter(function (o) {
          return o.cc_schedules && o.cc_schedules.status === "active" &&
            (o.quantity_left === null || o.quantity_left > 0);
        });
        var shopIds = {};
        rows.forEach(function (o) { shopIds[o.cc_schedules.shop_id] = 1; });
        var sids = Object.keys(shopIds);
        if (!sids.length) return [];
        return sb.from("cc_shops_public")
          .select("id,timezone,name,city,state")
          .in("id", sids)
          .then(function (rs) {
            if (rs.error) throw rs.error;
            var shopById = {};
            (rs.data || []).forEach(function (s) { shopById[s.id] = s; });
            var pids = {};
            rows.forEach(function (o) { if (o.cc_schedules.product_id) pids[o.cc_schedules.product_id] = 1; });
            var pidsArr = Object.keys(pids);
            var pj = pidsArr.length
              ? sb.from("cc_products").select("id,name,price_cents,portion,city,state,status")
                .in("id", pidsArr).in("status", ["active", "paused", "sold_out"])
                .then(function (rp) { if (rp.error) throw rp.error; return rp.data || []; })
              : Promise.resolve([]);
            return pj.then(function (products) {
              var prodById = {};
              products.forEach(function (p) { prodById[p.id] = p; });
              var out = [];
              rows.forEach(function (o) {
                var sched = o.cc_schedules;
                var shop = shopById[sched.shop_id];
                var product = prodById[sched.product_id];
                if (!shop || !product) return; // unpublished shop or full-menu slot: skip
                var today = M.todayInTz(shop.timezone || "America/Chicago");
                if (o.occ_date !== today) return;
                out.push({ product: product, shop: shop, occurrence: o, schedule: sched });
              });
              return out.slice(0, limit);
            });
          });
      });
  };

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Render the availability date list into el for a product.
   * States: loading skeleton → dates with countdowns → sold out → error.
   * Each bookable date gets a Preorder button wired to CC.openOrderRequest.
   */
  AV.renderAvailability = function (el, productId) {
    if (!el) return;
    el.innerHTML = '<div class="cc-avail-loading" role="status" aria-label="Loading availability">' +
      '<div class="cc-skeleton" style="height:18px;width:60%"></div>' +
      '<div class="cc-skeleton" style="height:64px"></div>' +
      '<div class="cc-skeleton" style="height:64px"></div></div>';

    function fail(err) {
      el.innerHTML = CC.states.error({
        title: "Couldn't load availability",
        body: (err && err.message) || "Please try again.",
        retryLabel: "Retry"
      });
      var btn = el.querySelector(".cc-empty-actions button");
      if (btn) btn.addEventListener("click", function () { AV.renderAvailability(el, productId); });
    }

    if (!CC.live) {
      el.innerHTML =
        '<div class="cc-avail-note cc-caption">' +
        CC.icon("calendar") +
        "<span>Live availability dates appear here once the backend is connected. " +
        "The seller sets weekly menus, quantities, and order cutoffs — this page will " +
        "show real dates, countdowns, and sold-out states.</span></div>";
      return;
    }

    AV.getProductAvailability(productId).then(function (ctx) {
      if (!ctx.slots.length) {
        var soldOut = ctx.product.status === "sold_out";
        el.innerHTML =
          '<div class="cc-avail-soldout">' +
          '<span class="cc-badge cc-badge-soldout">Sold Out</span>' +
          '<p class="cc-caption">' +
          (soldOut
            ? "This listing is marked sold out right now. Check back soon — the seller updates availability on their weekly menu."
            : "No upcoming availability dates right now. The seller hasn't opened any slots yet — check back soon.") +
          "</p></div>";
        return { soldOut: true };
      }
      var tz = ctx.shop.timezone || "America/Chicago";
      var html = '<h2 class="cc-h3 cc-avail-title">' + CC.icon("calendar") + " Available dates</h2>" +
        '<ul class="cc-avail-list">' +
        ctx.slots.map(function (s) {
          var o = s.occurrence;
          var cd = M.countdownText(o.cutoff_at);
          var cdClass = cd === "Cutoff passed" ? "is-passed" : "";
          var qty = o.quantity_left === null ? "Made to order" : o.quantity_left + " left";
          var ships = s.fulfillment.shipping;
          return '<li class="cc-avail-row">' +
            '<div class="cc-avail-date"><strong>' + CC.esc(M.fmtDay(o.window_start, tz)) + "</strong>" +
            '<span class="cc-caption">' + CC.esc(M.fmtTime(o.window_start, tz)) + " – " +
            CC.esc(M.fmtTime(o.window_end, tz)) + "</span></div>" +
            '<div class="cc-avail-meta">' +
            '<span class="cc-avail-countdown ' + cdClass + '">' + CC.icon("clock") +
            '<span data-countdown="' + CC.esc(o.cutoff_at || "") + '">' + CC.esc(cd) + "</span></span>" +
            '<span class="cc-badge ' + (o.quantity_left === 0 ? "cc-badge-soldout" : "cc-badge-ready") + '">' +
            CC.esc(qty) + "</span></div>" +
            (ships ? '<p class="cc-caption cc-avail-shipnote">' + CC.icon("shield") +
              "<span>" + CC.esc(M.SHIPPING_LEGAL_TEXT) + "</span></p>" : "") +
            '<button type="button" class="cc-btn cc-btn-primary cc-avail-order" ' +
            'data-order-product="' + CC.esc(productId) + '" data-order-occurrence="' + CC.esc(o.id) + '">' +
            "Preorder</button>" +
            "</li>";
        }).join("") + "</ul>";
      el.innerHTML = html;
      el.querySelectorAll("[data-order-product]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          CC.openOrderRequest(btn.getAttribute("data-order-product"),
            btn.getAttribute("data-order-occurrence"));
        });
      });
      AV.startCountdowns(el);
      return { soldOut: false };
    }).catch(fail);
  };

  /** Live-update every [data-countdown] in root every 30s. */
  AV.startCountdowns = function (root) {
    root = root || document;
    function tick() {
      root.querySelectorAll("[data-countdown]").forEach(function (el) {
        var iso = el.getAttribute("data-countdown");
        var txt = M.countdownText(iso);
        if (el.textContent !== txt) el.textContent = txt;
        var wrap = el.closest(".cc-avail-countdown");
        if (wrap) wrap.classList.toggle("is-passed", txt === "Cutoff passed");
      });
    }
    if (root._ccCountdownTimer) window.clearInterval(root._ccCountdownTimer);
    root._ccCountdownTimer = window.setInterval(tick, 30000);
    tick();
  };

})();
