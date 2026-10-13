/* ==========================================================================
   CraveCorner — Stage 4: Orders (cc-orders.js)
   Order requests, quotes, status flow, timelines, payment honesty.

   Exposes:
     CC.openOrderRequest(productId, occurrenceId)  -- the hook other stages call
     CC.ORDER_FLOW / CC.orderChip(status) / CC.orderStatusLabel(status, role)
     CC.myShop()            cached promise -> own cc_shops row or null
     CC.getOrderDetail(id)  order + product + shop + history + quotes
     CC.orderActions(order, role)  allowed actions for viewer role
     CC.setOrderStatus(orderId, toStatus)  (trigger errors surfaced honestly)
     CC.cancelOrder(orderId)
     CC.openQuoteModal({orderRequestId, customOrderId, proposeChanges})
     CC.acceptProposedChanges(order, quote)   buyer, order-request quotes
     CC.rejectProposedChanges(order, quote)   buyer, order-request quotes
     CC.acceptCustomQuote(customOrder, quote) buyer, custom-order quotes
     CC.setQuoteStatus(quoteId, status)       seller only (accepted/rejected/revised)
     CC.setPaymentNote(orderId, note)        null | 'seller-reported' | 'customer-reported'
     CC.timelineHtml(history, order)         status history timeline
     CC.s4Modal(title, bodyHtml)             shared modal shell -> {el, close}
     CC.formatDateTime(iso) / CC.formatDate(yyyyMmDd) / CC.occLabel(occ, tz)

   ABSOLUTE RULES (from the DB contract):
     - NO checkout, NO payment processing, NO "Pay now" buttons. Payments are
       arranged off-platform between customer and seller.
     - payment_note may only ever be null / 'seller-reported' / 'customer-reported'
       (CHECK-enforced). Never display "Paid" — always "reported by seller/
       customer". Never auto-mark paid.
     - On confirm in auto inventory mode the DB trigger reserves stock and
       RAISES on insufficient availability — surface error.message honestly.

   Requires: assets/js/cc.js (CC.sb / CC.ready / CC.live). Include after app.js.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  function sb() { return CC.sb || null; }
  function esc(s) { return CC.esc(s); }

  /* ------------------------------------------------------------------ */
  /* Status flow                                                         */
  /* ------------------------------------------------------------------ */

  CC.ORDER_FLOW = [
    { key: "pending",           label: "Pending",           buyerLabel: "Request sent — waiting on the seller", icon: "clock" },
    { key: "awaiting_customer", label: "Awaiting customer", buyerLabel: "Seller proposed changes — your call", icon: "edit" },
    { key: "confirmed",         label: "Confirmed",         icon: "check" },
    { key: "preparing",         label: "Preparing",         icon: "clipboard" },
    { key: "ready",             label: "Ready",             buyerLabel: "Ready for pickup / delivery", icon: "shopping-bag" },
    { key: "completed",         label: "Completed",         icon: "star" }
  ];
  var TERMINAL_BAD = { declined: 1, canceled: 1 };

  var CHIP_CLASS = {
    pending: "s4-chip-pending",
    awaiting_customer: "s4-chip-awaiting",
    confirmed: "s4-chip-progress",
    preparing: "s4-chip-progress",
    ready: "s4-chip-ready",
    completed: "s4-chip-done",
    declined: "s4-chip-bad",
    canceled: "s4-chip-muted"
  };

  function flowEntry(status) {
    for (var i = 0; i < CC.ORDER_FLOW.length; i++) {
      if (CC.ORDER_FLOW[i].key === status) return CC.ORDER_FLOW[i];
    }
    return null;
  }

  CC.orderStatusLabel = function (status, role) {
    var e = flowEntry(status);
    if (e) return (role === "buyer" && e.buyerLabel) ? e.buyerLabel : e.label;
    if (status === "declined") return "Declined";
    if (status === "canceled") return "Canceled";
    return status;
  };

  CC.orderChip = function (status, role) {
    var e = flowEntry(status);
    var icon = e ? e.icon : (TERMINAL_BAD[status] ? "warning" : "clock");
    return '<span class="cc-badge s4-chip ' + (CHIP_CLASS[status] || "s4-chip-muted") + '">' +
      CC.icon(icon) + esc(CC.orderStatusLabel(status, role)) + "</span>";
  };

  var CUSTOM_LABEL = {
    open: "Open", quoted: "Quoted", accepted: "Accepted",
    declined: "Declined", completed: "Completed", canceled: "Canceled"
  };
  var CUSTOM_CHIP = {
    open: "s4-chip-pending", quoted: "s4-chip-awaiting", accepted: "s4-chip-progress",
    declined: "s4-chip-bad", completed: "s4-chip-done", canceled: "s4-chip-muted"
  };
  CC.customOrderChip = function (status) {
    return '<span class="cc-badge s4-chip ' + (CUSTOM_CHIP[status] || "s4-chip-muted") + '">' +
      CC.icon("clipboard") + esc(CUSTOM_LABEL[status] || status) + "</span>";
  };

  var QUOTE_LABEL = { pending: "Pending", accepted: "Accepted", rejected: "Rejected", revised: "Revised" };
  var QUOTE_CHIP = { pending: "s4-chip-awaiting", accepted: "s4-chip-done", rejected: "s4-chip-muted", revised: "s4-chip-muted" };
  CC.quoteChip = function (status) {
    return '<span class="cc-badge s4-chip ' + (QUOTE_CHIP[status] || "s4-chip-muted") + '">' +
      CC.icon("edit") + esc(QUOTE_LABEL[status] || status) + "</span>";
  };

  /* ------------------------------------------------------------------ */
  /* Small formatting helpers                                            */
  /* ------------------------------------------------------------------ */

  CC.formatDateTime = function (iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString(undefined,
        { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  };

  CC.formatDate = function (yyyyMmDd) {
    if (!yyyyMmDd) return "";
    try {
      // Parse at noon to dodge timezone-day shifts on bare dates.
      return new Date(yyyyMmDd + "T12:00:00").toLocaleDateString(undefined,
        { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } catch (e) { return yyyyMmDd; }
  };

  CC.todayStr = function () {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  };

  /* "Sat, Oct 17 · 9:00 AM – 12:00 PM · 4 left" */
  CC.occLabel = function (occ, tz) {
    if (!occ) return "";
    try {
      var opts = { weekday: "short", month: "short", day: "numeric" };
      var tOpts = { hour: "numeric", minute: "2-digit" };
      if (tz) { opts.timeZone = tz; tOpts.timeZone = tz; }
      var d = new Date(occ.window_start).toLocaleDateString(undefined, opts);
      var t = new Date(occ.window_start).toLocaleTimeString(undefined, tOpts) +
        " – " + new Date(occ.window_end).toLocaleTimeString(undefined, tOpts);
      var left = (occ.quantity_left == null) ? "" :
        " · " + occ.quantity_left + " left";
      return d + " · " + t + left;
    } catch (e) { return occ.occ_date || ""; }
  };

  /* ------------------------------------------------------------------ */
  /* Shared modal shell (uses app.js .cc-modal styles)                   */
  /* ------------------------------------------------------------------ */

  function focusables(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  CC.s4Modal = function (title, bodyHtml) {
    if (typeof CC.closeModal === "function") CC.closeModal();
    var lastFocus = document.activeElement;
    var wrap = document.createElement("div");
    wrap.className = "cc-modal-backdrop";
    wrap.setAttribute("data-s4-modal", "");
    wrap.innerHTML =
      '<div class="cc-modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" tabindex="-1">' +
        '<div class="cc-modal-head"><h2 class="cc-h3">' + esc(title) + "</h2>" +
        '<button type="button" class="cc-modal-x" data-s4-close aria-label="Close dialog">&times;</button></div>' +
        '<div class="cc-modal-body">' + bodyHtml + "</div>" +
      "</div>";
    function close() {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      document.body.style.overflow = "";
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    }
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.closest("[data-s4-close]")) close();
    });
    wrap.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { close(); return; }
      if (e.key === "Tab") {
        var f = focusables(wrap.firstElementChild);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    });
    document.body.appendChild(wrap);
    document.body.style.overflow = "hidden";
    var f0 = focusables(wrap.firstElementChild);
    (f0[0] || wrap.firstElementChild).focus();
    return { el: wrap, close: close };
  };

  /* Honest modal for "this needs the live backend / an account" states. */
  CC.s4Honest = function (title, bodyHtml) {
    return CC.s4Modal(title,
      bodyHtml +
      '<div class="cc-modal-actions">' +
        '<button type="button" class="cc-btn cc-btn-primary" data-s4-close>Got it</button>' +
      "</div>");
  };

  function needBackendModal() {
    CC.s4Honest("You're offline",
      "<p>Order requests need a connection to the CraveCorner marketplace.</p>" +
      "<p>Check your connection and try again. CraveCorner never runs in-app checkout — payment is always arranged directly with the seller using their accepted methods.</p>");
  }

  function needAccountModal() {
    var next = window.location.pathname.split("/").pop() + window.location.search;
    CC.s4Modal("Sign in to place an order",
      "<p>Order requests need a free CraveCorner account.</p>" +
      "<p>CraveCorner never runs in-app checkout — payment is always arranged directly with the seller.</p>" +
      '<div class="cc-modal-actions">' +
        '<a class="cc-btn cc-btn-primary" href="auth.html?next=' + CC.esc(encodeURIComponent(next)) + '">Sign in / Sign up</a>' +
        '<button type="button" class="cc-btn cc-btn-ghost" data-s4-close>Not now</button>' +
      "</div>");
  }

  /* ------------------------------------------------------------------ */
  /* Shop / product lookups                                              */
  /* ------------------------------------------------------------------ */

  var _myShop = null; // cached promise
  CC.myShop = function () {
    if (_myShop) return _myShop;
    _myShop = CC.ready.then(function (r) {
      if (!r.live || !r.user || !sb()) return null;
      return sb().from("cc_shops").select("id, name, slug, status")
        .eq("user_id", r.user.id).maybeSingle()
        .then(function (res) { return res.error ? null : (res.data || null); })
        .catch(function () { return null; });
    });
    return _myShop;
  };
  /** Drop the cached shop (e.g. after sign-out / account switch). */
  CC.resetMyShop = function () { _myShop = null; };

  CC.getPublicShop = function (shopId) {
    return sb().from("cc_shops_public")
      .select("id, user_id, name, slug, city, state, service_area, " +
              "fulfillment_pickup, fulfillment_delivery, fulfillment_shipping, timezone, status")
      .eq("id", shopId).maybeSingle()
      .then(function (r) { return r.error ? null : r.data; });
  };

  CC.getProductCover = function (productId) {
    return sb().from("cc_product_images")
      .select("storage_path").eq("product_id", productId)
      .order("is_cover", { ascending: false }).order("position").limit(1)
      .then(function (r) {
        if (r.error || !r.data || !r.data.length) return null;
        return CC.imgUrl("cc-product-images", r.data[0].storage_path);
      })
      .catch(function () { return null; });
  };

  /* Occurrences bookable for a product (active slots, future, not past cutoff). */
  CC.getProductOccurrences = function (productId) {
    var client = sb();
    return client.from("cc_schedules").select("id")
      .eq("product_id", productId).eq("status", "active")
      .then(function (r1) {
        var ids = (r1.data || []).map(function (s) { return s.id; });
        return client.from("cc_schedule_items").select("schedule_id")
          .eq("product_id", productId)
          .then(function (r2) {
            (r2.data || []).forEach(function (row) {
              if (ids.indexOf(row.schedule_id) === -1) ids.push(row.schedule_id);
            });
            if (!ids.length) return [];
            return client.from("cc_occurrences").select("*")
              .in("schedule_id", ids).eq("status", "active")
              .gte("occ_date", CC.todayStr()).order("occ_date").order("window_start")
              .limit(40)
              .then(function (r3) {
                if (r3.error) return [];
                var now = Date.now();
                return (r3.data || []).filter(function (o) {
                  if (o.cutoff_at && new Date(o.cutoff_at).getTime() < now) return false;
                  if (o.quantity_left != null && o.quantity_left <= 0) return false;
                  return true;
                });
              });
          });
      })
      .catch(function () { return []; });
  };

  /* ------------------------------------------------------------------ */
  /* Order request flow: CC.openOrderRequest(productId, occurrenceId)    */
  /* ------------------------------------------------------------------ */

  var FULFILL_META = {
    pickup:   { icon: "store",        label: "Pickup",   hint: "Pick up from the seller" },
    delivery: { icon: "location",     label: "Delivery", hint: "Delivered to you" },
    shipping: { icon: "shopping-bag", label: "Shipping", hint: "Shipped to you" }
  };

  function productFulfillment(product, shop) {
    var out = [];
    var pf = product.fulfillment || {};
    ["pickup", "delivery", "shipping"].forEach(function (k) {
      if (pf[k] === true) out.push(k);
    });
    if (!out.length && shop) {
      if (shop.fulfillment_pickup) out.push("pickup");
      if (shop.fulfillment_delivery) out.push("delivery");
      if (shop.fulfillment_shipping) out.push("shipping");
    }
    if (!out.length) out.push("pickup");
    return out;
  }

  function dollarsToCents(str) {
    var n = Math.round(parseFloat(str) * 100);
    return (isFinite(n) && n >= 0) ? n : null;
  }

  /**
   * The hook other stages call to start an order request.
   * - Backend not live  -> honest offline modal (no fake ordering).
   * - Signed out        -> sign-in prompt (accounts are free).
   * - Live + signed in  -> real modal: options, qty, date/slot, fulfillment,
   *                        note -> inserts cc_order_requests (status pending).
   */
  CC.openOrderRequest = function (productId, occurrenceId) {
    if (!sb() || !CC.live) { needBackendModal(); return; }
    CC.ready.then(function (r) {
      if (!r.live) { needBackendModal(); return; }
      if (!r.user) { needAccountModal(); return; }
      openOrderRequestLive(productId, occurrenceId, r.user);
    });
  };

  function openOrderRequestLive(productId, occurrenceId, user) {
    var client = sb();
    var modal = CC.s4Modal("Request order",
      '<div class="cc-loading" role="status" aria-live="polite">Loading listing…</div>');

    client.from("cc_products").select("*").eq("id", productId).maybeSingle()
      .then(function (pr) {
        if (pr.error) throw new Error(pr.error.message || "Couldn't load this listing.");
        var product = pr.data;
        if (!product) throw new Error("This listing no longer exists.");
        if (product.status === "sold_out") { soldOutModal(product); modal.close(); return null; }
        if (product.status !== "active") {
          modal.close();
          CC.s4Honest("Not available right now",
            "<p>This listing isn't currently accepting orders. Check back later or message the seller.</p>" +
            '<p class="cc-caption">Listings must be active before an order request can be placed.</p>');
          return null;
        }
        return Promise.all([
          product,
          CC.getPublicShop(product.shop_id),
          client.from("cc_product_options").select("*").eq("product_id", product.id).order("position"),
          CC.getProductCover(product.id),
          CC.getProductOccurrences(product.id)
        ]);
      })
      .then(function (all) {
        if (!all) return; // handled above
        var product = all[0], shop = all[1], optRes = all[2], cover = all[3], occs = all[4];
        if (!shop) {
          modal.close();
          CC.s4Honest("Shop unavailable",
            "<p>This shop isn't published right now, so order requests are paused.</p>");
          return;
        }
        renderOrderForm(modal, { product: product, shop: shop,
          options: optRes.data || [], cover: cover, occs: occs,
          occurrenceId: occurrenceId, user: user });
      })
      .catch(function (err) {
        modal.close();
        CC.s4Honest("Couldn't start the order",
          "<p>" + esc(err.message || "Something went wrong loading this listing.") + "</p>");
      });
  }

  function soldOutModal(product) {
    CC.s4Honest("Sold out",
      "<p><strong>" + esc(product.name) + "</strong> is sold out right now, so new order requests are paused for it.</p>" +
      "<p>Message the seller to ask when the next batch is coming — or browse similar listings.</p>" +
      '<div class="cc-modal-actions">' +
        '<a class="cc-btn cc-btn-secondary" href="explore.html">Browse listings</a>' +
      "</div>");
  }

  function renderOrderForm(modal, ctx) {
    var product = ctx.product, shop = ctx.shop;
    var baseCents = product.price_cents || 0;
    var methods = productFulfillment(product, shop);
    var tz = shop.timezone || "America/Chicago";

    /* Preselect a passed occurrence when it's still bookable. */
    var preOcc = null;
    if (ctx.occurrenceId) {
      for (var pi = 0; pi < ctx.occs.length; pi++) {
        if (ctx.occs[pi].id === ctx.occurrenceId) { preOcc = ctx.occs[pi]; break; }
      }
      if (!preOcc) {
        modal.close();
        soldOutModal(product);
        return;
      }
    }

    var unit = product.portion ? " <small>/ " + esc(product.portion) + "</small>" : "";
    var head =
      '<div class="s4-modal-product">' +
        (ctx.cover ? '<img src="' + esc(ctx.cover) + '" alt="">' : "") +
        '<div class="s4-grow"><strong>' + esc(product.name) + "</strong>" +
        "<span>" + esc(shop.name) + (shop.city ? " · " + esc(shop.city) : "") + "</span></div>" +
        '<div class="s4-money">' + CC.centsToPrice(baseCents) + unit + "</div>" +
      "</div>";

    /* Date / slot picker */
    var dateHtml;
    if (ctx.occs.length) {
      var opts = '<option value="">Ask the seller to suggest a date</option>';
      ctx.occs.forEach(function (o) {
        var sel = (preOcc && preOcc.id === o.id) ? " selected" : "";
        opts += '<option value="' + esc(o.id) + '"' + sel + ">" + esc(CC.occLabel(o, tz)) + "</option>";
      });
      dateHtml =
        '<div class="cc-field"><label class="cc-label" for="s4-occ">Pickup / delivery slot <span class="cc-req">*</span></label>' +
        '<select class="cc-select" id="s4-occ">' + opts + "</select>" +
        '<p class="cc-hint">Slots past their order cutoff are hidden automatically.</p></div>';
    } else {
      var minDate = CC.todayStr();
      if (product.lead_time_days) {
        var d = new Date(); d.setDate(d.getDate() + product.lead_time_days);
        minDate = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
          "-" + String(d.getDate()).padStart(2, "0");
      }
      dateHtml =
        '<div class="cc-field"><label class="cc-label" for="s4-date">Requested date</label>' +
        '<input class="cc-input" type="date" id="s4-date" min="' + esc(minDate) + '">' +
        (product.lead_time_days ?
          '<p class="cc-hint">This seller asks for ' + product.lead_time_days + " day(s) notice.</p>" : "") +
        "</div>";
    }

    /* Product options */
    var optHtml = "";
    ctx.options.forEach(function (opt, ix) {
      var choices = Array.isArray(opt.choices) ? opt.choices : [];
      if (!choices.length) return;
      var copts = opt.required ? "" : '<option value="">None</option>';
      choices.forEach(function (c, cix) {
        var delta = c.price_delta_cents ? " (+" + CC.centsToPrice(c.price_delta_cents) + ")" : "";
        copts += '<option value="' + cix + '"' + (cix === 0 && opt.required ? " selected" : "") + ">" +
          esc(c.label) + esc(delta) + "</option>";
      });
      optHtml +=
        '<div class="cc-field"><label class="cc-label" for="s4-opt-' + ix + '">' + esc(opt.name) +
        (opt.required ? ' <span class="cc-req">*</span>' : "") + "</label>" +
        '<select class="cc-select" id="s4-opt-' + ix + '" data-opt-ix="' + ix + '">' + copts + "</select></div>";
    });

    /* Fulfillment */
    var fHtml = '<div class="cc-field"><span class="cc-label">How do you want to get it? <span class="cc-req">*</span></span>' +
      '<div class="s4-fulfill-grid" role="radiogroup" aria-label="Fulfillment method">';
    methods.forEach(function (m, ix) {
      var meta = FULFILL_META[m];
      fHtml +=
        '<label class="s4-fulfill-opt' + (ix === 0 ? " is-checked" : "") + '">' +
        '<input type="radio" name="s4-fulfill" value="' + esc(m) + '"' + (ix === 0 ? " checked" : "") + ">" +
        CC.icon(meta.icon) +
        '<span class="s4-grow">' + esc(meta.label) + "<small>" + esc(meta.hint) + "</small></span>" +
        "</label>";
    });
    fHtml += "</div></div>";

    modal.el.querySelector(".cc-modal-body").innerHTML = head + dateHtml + optHtml +
      '<div class="cc-field"><label class="cc-label" for="s4-qty-out">Quantity <span class="cc-req">*</span></label>' +
      '<div><span class="s4-qty"><button type="button" id="s4-qty-minus" aria-label="Decrease quantity">−</button>' +
      '<output id="s4-qty-out" aria-live="polite">1</output>' +
      '<button type="button" id="s4-qty-plus" aria-label="Increase quantity">+</button></span></div></div>' +
      fHtml +
      '<div class="cc-field"><label class="cc-label" for="s4-note">Note for the seller <span class="cc-muted">(optional)</span></label>' +
      '<textarea class="cc-textarea" id="s4-note" style="min-height:88px" maxlength="2000" ' +
      'placeholder="Allergies, timing, gift message…"></textarea></div>' +
      '<div class="s4-total-row"><span class="s4-muted">Estimated total</span>' +
      '<span class="s4-money" id="s4-total">' + CC.centsToPrice(baseCents) + "</span></div>" +
      '<div class="cc-alert cc-alert-danger s4-form-error" id="s4-err" role="alert"></div>' +
      '<p class="cc-caption" style="margin-top:.8rem">' + CC.icon("shield") +
      ' <span>No checkout here — if the seller accepts, you arrange payment directly with them using their accepted methods.</span></p>' +
      '<div class="cc-modal-actions">' +
        '<button type="button" class="cc-btn cc-btn-ghost" data-s4-close>Cancel</button>' +
        '<button type="button" class="cc-btn cc-btn-primary" id="s4-submit">Send order request</button>' +
      "</div>";

    var body = modal.el.querySelector(".cc-modal-body");
    var qty = 1;
    var qtyOut = body.querySelector("#s4-qty-out");
    function unitCents() {
      var total = baseCents;
      var sels = body.querySelectorAll("[data-opt-ix]");
      for (var i = 0; i < sels.length; i++) {
        var v = sels[i].value;
        if (v === "") continue;
        var c = (ctx.options[parseInt(sels[i].getAttribute("data-opt-ix"), 10)].choices || [])[parseInt(v, 10)];
        if (c && c.price_delta_cents) total += c.price_delta_cents;
      }
      return total;
    }
    function paintTotal() {
      qtyOut.textContent = String(qty);
      body.querySelector("#s4-total").textContent = CC.centsToPrice(unitCents() * qty);
    }
    body.querySelector("#s4-qty-minus").addEventListener("click", function () {
      if (qty > 1) { qty--; paintTotal(); }
    });
    body.querySelector("#s4-qty-plus").addEventListener("click", function () {
      if (qty < 99) { qty++; paintTotal(); }
    });
    var selList = body.querySelectorAll("[data-opt-ix]");
    for (var si = 0; si < selList.length; si++) selList[si].addEventListener("change", paintTotal);
    var fLabels = body.querySelectorAll(".s4-fulfill-opt");
    for (var fi = 0; fi < fLabels.length; fi++) {
      fLabels[fi].addEventListener("change", function () {
        for (var fj = 0; fj < fLabels.length; fj++) {
          fLabels[fj].classList.toggle("is-checked",
            fLabels[fj].querySelector("input").checked);
        }
      });
    }
    var errBox = body.querySelector("#s4-err");
    function fail(msg) {
      errBox.innerHTML = CC.icon("warning") + "<div>" + esc(msg) + "</div>";
      errBox.classList.add("is-show");
      errBox.scrollIntoView({ block: "nearest" });
    }

    body.querySelector("#s4-submit").addEventListener("click", function () {
      errBox.classList.remove("is-show");
      var chosen = {};
      var ok = true;
      var sels = body.querySelectorAll("[data-opt-ix]");
      for (var i = 0; i < sels.length && ok; i++) {
        var opt = ctx.options[parseInt(sels[i].getAttribute("data-opt-ix"), 10)];
        var v = sels[i].value;
        if (opt.required && v === "") { fail("Please choose: " + opt.name + "."); ok = false; break; }
        if (v !== "") chosen[opt.name] = (opt.choices[parseInt(v, 10)] || {}).label || "";
      }
      if (!ok) return;

      var fSel = body.querySelector('input[name="s4-fulfill"]:checked');
      var fulfillment = fSel ? fSel.value : methods[0];

      var occurrenceId = null, requestedDate = null;
      var occSel = body.querySelector("#s4-occ");
      if (occSel) {
        if (occSel.value) {
          occurrenceId = occSel.value;
          for (var oi = 0; oi < ctx.occs.length; oi++) {
            if (ctx.occs[oi].id === occurrenceId) { requestedDate = ctx.occs[oi].occ_date; break; }
          }
        }
      } else {
        var dateInput = body.querySelector("#s4-date");
        if (dateInput && dateInput.value) requestedDate = dateInput.value;
      }

      var note = body.querySelector("#s4-note").value.trim();
      var subtotal = unitCents() * qty;
      var btn = body.querySelector("#s4-submit");
      btn.disabled = true;
      btn.textContent = "Sending…";

      sb().from("cc_order_requests").insert({
        product_id: product.id,
        buyer_id: ctx.user.id,
        shop_id: shop.id,
        options: chosen,
        qty: qty,
        requested_date: requestedDate,
        occurrence_id: occurrenceId,
        fulfillment: fulfillment,
        customer_note: note || null,
        status: "pending",
        subtotal_cents: subtotal
      }).select("id").single()
        .then(function (ins) {
          if (ins.error) throw new Error(ins.error.message);
          modal.close();
          var orderId = ins.data.id;
          var m = CC.s4Modal("Request sent",
            '<div class="cc-alert cc-alert-success" role="status">' + CC.icon("check") +
            "<div><strong>Your order request is on its way.</strong><br>" +
            "The seller will accept, decline, or propose changes. We'll notify you either way.</div></div>" +
            '<p class="cc-caption">No payment was taken — if the seller accepts, you arrange payment directly with them.</p>' +
            '<div class="cc-modal-actions">' +
              '<a class="cc-btn cc-btn-ghost" href="orders.html?id=' + esc(orderId) + '">View my order</a>' +
              '<button type="button" class="cc-btn cc-btn-secondary" id="s4-msg-seller">Message seller</button>' +
              '<button type="button" class="cc-btn cc-btn-primary" data-s4-close>Done</button>' +
            "</div>");
          m.el.querySelector("#s4-msg-seller").addEventListener("click", function () {
            if (typeof CC.ensureConversation === "function") {
              CC.ensureConversation(shop.id, orderId).then(function (c) {
                window.location.href = "inbox.html?conv=" + encodeURIComponent(c.id);
              }).catch(function (e) {
                window.location.href = "inbox.html?shop=" + encodeURIComponent(shop.id);
              });
            } else {
              window.location.href = "inbox.html?shop=" + encodeURIComponent(shop.id);
            }
          });
        })
        .catch(function (e) {
          btn.disabled = false;
          btn.textContent = "Send order request";
          // Trigger/RLS errors are written in plain English — show them as-is.
          fail(e.message || "Couldn't send the request. Please try again.");
        });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Order detail loading                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Full order context for the detail view. Never throws for missing
   * relations — returns nulls and lets the UI degrade honestly.
   */
  CC.getOrderDetail = function (orderId) {
    var client = sb();
    return client.from("cc_order_requests").select("*").eq("id", orderId).maybeSingle()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        var order = r.data;
        if (!order) throw new Error("Order not found.");
        return Promise.all([
          order,
          client.from("cc_products").select("id, name, price_cents, portion, status")
            .eq("id", order.product_id).maybeSingle().then(function (x) { return x.data || null; }),
          CC.getPublicShop(order.shop_id),
          CC.getProductCover(order.product_id),
          client.from("cc_order_status_history").select("*")
            .eq("order_id", order.id).order("created_at", { ascending: true })
            .then(function (x) { return x.data || []; }),
          client.from("cc_quotes").select("*").eq("order_request_id", order.id)
            .order("created_at", { ascending: false })
            .then(function (x) { return x.data || []; })
        ]);
      })
      .then(function (all) {
        return {
          order: all[0], product: all[1], shop: all[2], cover: all[3],
          history: all[4], quotes: all[5]
        };
      });
  };

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Allowed actions for the viewer. role: 'buyer' | 'seller'.
   * Mirrors the DB guard (cc_guard_order_update): buyers may only cancel a
   * pending request; the status flow belongs to the shop owner.
   */
  CC.orderActions = function (order, role) {
    var st = order.status;
    var actions = [];
    function add(id, label, icon, kind) {
      actions.push({ id: id, label: label, icon: icon, kind: kind || "secondary" });
    }
    if (role === "buyer") {
      if (st === "pending") add("cancel", "Cancel request", "delete", "danger");
      if (st === "awaiting_customer") {
        add("accept-changes", "Accept proposed changes", "check", "primary");
        add("reject-changes", "Decline proposed changes", "delete", "ghost");
      }
      if (st !== "declined" && st !== "canceled") add("message", "Message seller", "message");
      if (!order.payment_note && ["confirmed", "preparing", "ready", "completed"].indexOf(st) !== -1) {
        add("paid-customer", "I've paid the seller", "check", "ghost");
      }
    } else { // seller
      if (st === "pending") {
        add("accept", "Accept order", "check", "primary");
        add("propose", "Propose changes", "edit");
        add("quote", "Send quote", "clipboard");
        add("clarify", "Ask for clarification", "message", "ghost");
        add("decline", "Decline", "delete", "danger");
      } else if (st === "awaiting_customer") {
        add("confirm", "Confirm order", "check", "primary");
        add("propose", "Revise proposal", "edit");
        add("decline", "Decline", "delete", "danger");
        add("message", "Message customer", "message", "ghost");
      } else if (st === "confirmed") {
        add("preparing", "Start preparing", "clipboard", "primary");
        add("message", "Message customer", "message", "ghost");
      } else if (st === "preparing") {
        add("ready", "Mark ready", "shopping-bag", "primary");
        add("message", "Message customer", "message", "ghost");
      } else if (st === "ready") {
        add("complete", "Mark completed", "star", "primary");
        add("message", "Message customer", "message", "ghost");
      } else {
        add("message", "Message customer", "message", "ghost");
      }
      if (!order.payment_note && ["confirmed", "preparing", "ready", "completed"].indexOf(st) !== -1) {
        add("paid-seller", "Mark payment received", "check", "ghost");
      }
    }
    return actions;
  };

  var STATUS_MOVE = {
    accept: "confirmed", confirm: "confirmed", preparing: "preparing",
    ready: "ready", complete: "completed", decline: "declined", cancel: "canceled"
  };

  /**
   * Move an order's status. The DB trigger owns the rules (buyer can only
   * cancel pending; owner moves the flow; auto-mode confirm reserves stock
   * and raises on shortage) — trigger errors are surfaced verbatim.
   */
  CC.setOrderStatus = function (orderId, toStatus) {
    return sb().from("cc_order_requests").update({ status: toStatus }).eq("id", orderId)
      .select("id, status").single()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
  };

  CC.cancelOrder = function (orderId) { return CC.setOrderStatus(orderId, "canceled"); };

  /**
   * Run one named action from CC.orderActions. Returns a promise resolving
   * {refresh: true} when the caller should reload the detail view.
   * `hooks` lets pages inject UI (quote modal, message redirect, confirm).
   */
  CC.runOrderAction = function (actionId, detail, role, hooks) {
    hooks = hooks || {};
    var order = detail.order;
    function needHooks(name) {
      if (typeof hooks[name] !== "function") throw new Error("Missing hook: " + name);
      return hooks[name];
    }
    switch (actionId) {
      case "cancel":
        return needHooks("confirm")("Cancel this order request?",
          "The seller will be notified. This can't be undone.")
          .then(function (yes) {
            if (!yes) return { refresh: false };
            return CC.cancelOrder(order.id).then(function () { return { refresh: true }; });
          });
      case "decline":
        return needHooks("confirm")("Decline this order?",
          "The customer will be notified. Any held inventory is released automatically.")
          .then(function (yes) {
            if (!yes) return { refresh: false };
            return CC.setOrderStatus(order.id, "declined").then(function () { return { refresh: true }; });
          });
      case "accept":
      case "confirm":
      case "preparing":
      case "ready":
      case "complete":
        return CC.setOrderStatus(order.id, STATUS_MOVE[actionId])
          .then(function () { return { refresh: true }; });
      case "clarify":
      case "message":
        return needHooks("message")().then(function () { return { refresh: false }; });
      case "quote":
        return needHooks("quote")({ proposeChanges: false }).then(function () { return { refresh: true }; });
      case "propose":
        return needHooks("quote")({ proposeChanges: true }).then(function () { return { refresh: true }; });
      case "accept-changes": {
        var q = (detail.quotes || []).filter(function (x) { return x.status === "pending"; })[0];
        if (!q) return Promise.reject(new Error("No pending proposal found."));
        return CC.acceptProposedChanges(detail, q).then(function () { return { refresh: true }; });
      }
      case "reject-changes": {
        var q2 = (detail.quotes || []).filter(function (x) { return x.status === "pending"; })[0];
        if (!q2) return Promise.reject(new Error("No pending proposal found."));
        return needHooks("prompt")("Tell the seller what doesn't work (optional):")
          .then(function (note) {
            if (note === null) return { refresh: false };
            return CC.rejectProposedChanges(detail, q2, note).then(function () { return { refresh: true }; });
          });
      }
      case "paid-customer":
        return CC.setPaymentNote(order.id, "customer-reported").then(function () { return { refresh: true }; });
      case "paid-seller":
        return CC.setPaymentNote(order.id, "seller-reported").then(function () { return { refresh: true }; });
      default:
        return Promise.reject(new Error("Unknown action: " + actionId));
    }
  };

  /* ------------------------------------------------------------------ */
  /* Payment honesty                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * payment_note ∈ null | 'seller-reported' | 'customer-reported' (CHECK).
   * This is a REPORT, never a payment confirmation — the UI must label it so.
   */
  CC.setPaymentNote = function (orderId, note) {
    if (note !== null && note !== "seller-reported" && note !== "customer-reported") {
      return Promise.reject(new Error("Invalid payment note."));
    }
    return sb().from("cc_order_requests").update({ payment_note: note }).eq("id", orderId)
      .select("id").single()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return true;
      });
  };

  CC.paymentNoteHtml = function (order, role) {
    var note = order.payment_note;
    var line;
    if (note === "seller-reported") {
      line = "<strong>Payment reported as received by the seller.</strong> " +
        "This is the seller's own report — CraveCorner never processes payments.";
    } else if (note === "customer-reported") {
      line = "<strong>Payment reported as sent by the customer.</strong> " +
        "This is the customer's own report — CraveCorner never processes payments.";
    } else {
      line = "No payment reported yet. Payment is always arranged directly " +
        "between you two — CraveCorner has no checkout and never touches the money.";
    }
    return '<div class="s4-payline">' + CC.icon("shield") + "<div>" + line + "</div></div>";
  };

  /* ------------------------------------------------------------------ */
  /* Quotes                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Seller quote modal. Exactly one of orderRequestId / customOrderId.
   * proposeChanges (order requests): after insert, move order pending ->
   * awaiting_customer so the customer can accept the final terms.
   */
  CC.openQuoteModal = function (opts) {
    opts = opts || {};
    var isOrderQuote = !!opts.orderRequestId;
    var modal = CC.s4Modal(isOrderQuote && opts.proposeChanges ? "Propose changes" : "Send quote",
      '<div class="cc-field"><label class="cc-label" for="s4-q-amount">Total amount <span class="cc-req">*</span></label>' +
      '<input class="cc-input" id="s4-q-amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
      '<div class="cc-field"><label class="cc-label" for="s4-q-deposit">Deposit due upfront <span class="cc-muted">(optional)</span></label>' +
      '<input class="cc-input" id="s4-q-deposit" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></div>' +
      '<div class="cc-field"><label class="cc-label" for="s4-q-details">What\'s included <span class="cc-req">*</span></label>' +
      '<textarea class="cc-textarea" id="s4-q-details" style="min-height:96px" maxlength="2000" ' +
      'placeholder="Sizes, flavors, pickup time…"></textarea></div>' +
      '<div class="cc-field"><label class="cc-label" for="s4-q-valid">Quote valid until <span class="cc-muted">(optional)</span></label>' +
      '<input class="cc-input" type="date" id="s4-q-valid" min="' + esc(CC.todayStr()) + '"></div>' +
      (isOrderQuote ?
        '<label class="s4-fulfill-opt' + (opts.proposeChanges ? " is-checked" : "") + '" style="margin-bottom:1rem">' +
        '<input type="checkbox" id="s4-q-propose"' + (opts.proposeChanges ? " checked" : "") + ">" +
        '<span class="s4-grow">Send as proposed changes<small>Moves the order to “Awaiting customer” — the customer accepts the final terms before you confirm.</small></span></label>' : "") +
      '<div class="cc-alert cc-alert-danger s4-form-error" id="s4-q-err" role="alert"></div>' +
      '<p class="cc-caption">' + CC.icon("shield") +
      ' <span>This quote is sent in chat. Payment stays off-platform — you arrange it directly with the customer.</span></p>' +
      '<div class="cc-modal-actions">' +
        '<button type="button" class="cc-btn cc-btn-ghost" data-s4-close>Cancel</button>' +
        '<button type="button" class="cc-btn cc-btn-primary" id="s4-q-submit">Send quote</button>' +
      "</div>");

    var body = modal.el.querySelector(".cc-modal-body");
    var errBox = body.querySelector("#s4-q-err");
    function fail(msg) {
      errBox.innerHTML = CC.icon("warning") + "<div>" + esc(msg) + "</div>";
      errBox.classList.add("is-show");
    }
    body.querySelector("#s4-q-propose") && body.querySelector("#s4-q-propose").addEventListener("change", function (e) {
      e.target.closest(".s4-fulfill-opt").classList.toggle("is-checked", e.target.checked);
    });

    body.querySelector("#s4-q-submit").addEventListener("click", function () {
      errBox.classList.remove("is-show");
      var amount = dollarsToCents(body.querySelector("#s4-q-amount").value);
      var depRaw = body.querySelector("#s4-q-deposit").value.trim();
      var deposit = depRaw === "" ? 0 : dollarsToCents(depRaw);
      var details = body.querySelector("#s4-q-details").value.trim();
      var validUntil = body.querySelector("#s4-q-valid").value || null;
      var propose = body.querySelector("#s4-q-propose") ? body.querySelector("#s4-q-propose").checked : false;
      if (amount === null) { fail("Enter a valid total amount."); return; }
      if (deposit === null) { fail("Enter a valid deposit (or leave it blank)."); return; }
      if (!details) { fail("Describe what's included in the quote."); return; }

      var btn = body.querySelector("#s4-q-submit");
      btn.disabled = true; btn.textContent = "Sending…";
      var client = sb();
      var payload = {
        seller_id: CC.user.id,
        amount_cents: amount,
        deposit_cents: deposit,
        details: details,
        valid_until: validUntil,
        status: "pending"
      };
      if (isOrderQuote) payload.order_request_id = opts.orderRequestId;
      else payload.custom_order_id = opts.customOrderId;

      client.from("cc_quotes").insert(payload).select("*").single()
        .then(function (ins) {
          if (ins.error) throw new Error(ins.error.message);
          var quote = ins.data;
          var after = Promise.resolve();
          if (isOrderQuote) {
            // Quote card in the order thread + optional status move.
            after = CC.sendQuoteCard(opts.orderRequestId, null, quote).then(function () {
              if (propose) return CC.setOrderStatus(opts.orderRequestId, "awaiting_customer");
            });
          } else {
            after = CC.sendQuoteCard(null, opts.customOrderId, quote)
              .then(function () {
                // Flip open -> quoted so the buyer knows a quote is waiting.
                return client.from("cc_custom_orders").update({ status: "quoted" })
                  .eq("id", opts.customOrderId).eq("status", "open").then(function () {});
              });
          }
          return after.then(function () { return quote; });
        })
        .then(function () {
          modal.close();
          CC.s4Honest("Quote sent",
            "<p>The quote is in your chat thread with the customer, and they've been notified.</p>" +
            (isOrderQuote && body.querySelector("#s4-q-propose") && body.querySelector("#s4-q-propose").checked
              ? "<p>The order is now <strong>Awaiting customer</strong> — it confirms once they accept the terms.</p>"
              : "<p>The custom order is now <strong>Quoted</strong> — it moves forward once the customer accepts.</p>"));
          if (typeof opts.onSent === "function") opts.onSent();
        })
        .catch(function (e) {
          btn.disabled = false; btn.textContent = "Send quote";
          fail(e.message || "Couldn't send the quote.");
        });
    });
    return modal;
  };

  /**
   * Post a quote card message into the right conversation (order thread or
   * the buyer/shop thread). Creates the conversation if needed.
   */
  CC.sendQuoteCard = function (orderRequestId, customOrderId, quote) {
    var ensure = (typeof CC.ensureConversation === "function")
      ? CC.ensureConversation
      : function () { return Promise.reject(new Error("Messaging isn't loaded.")); };
    var shopId, buyerId;
    var client = sb();
    var ctxP = orderRequestId
      ? client.from("cc_order_requests").select("shop_id, buyer_id").eq("id", orderRequestId).single()
          .then(function (r) {
            if (r.error || !r.data) throw new Error("Order not found.");
            shopId = r.data.shop_id; buyerId = r.data.buyer_id;
            return ensure(shopId, orderRequestId);
          })
      : client.from("cc_custom_orders").select("shop_id, buyer_id").eq("id", customOrderId).single()
          .then(function (r) {
            if (r.error || !r.data) throw new Error("Custom order not found.");
            shopId = r.data.shop_id; buyerId = r.data.buyer_id;
            return ensure(shopId, null);
          });
    return ctxP.then(function (conv) {
      return CC.sendMessage(conv.id, {
        body: "Here's my quote: " + CC.centsToPrice(quote.amount_cents) +
          (quote.deposit_cents ? " (" + CC.centsToPrice(quote.deposit_cents) + " deposit)" : "") +
          ". " + (quote.details || ""),
        card_type: "quote",
        card_ref: { quote_id: quote.id }
      });
    });
  };

  /** Seller marks their own quote accepted/rejected/revised (RLS: seller-only). */
  CC.setQuoteStatus = function (quoteId, status) {
    if (["accepted", "rejected", "revised"].indexOf(status) === -1) {
      return Promise.reject(new Error("Invalid quote status."));
    }
    return sb().from("cc_quotes").update({ status: status }).eq("id", quoteId)
      .select("id").single()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return true;
      });
  };

  /**
   * Buyer accepts a proposed-changes quote on an ORDER REQUEST.
   * RLS lets only the seller update cc_quotes, and the DB guard lets the
   * buyer move ONLY pending -> canceled — so acceptance is recorded as a
   * quote-card message. The seller then confirms (awaiting_customer ->
   * confirmed) with one tap. Nothing is faked: the message IS the acceptance.
   */
  CC.acceptProposedChanges = function (detail, quote) {
    var ensure = (typeof CC.ensureConversation === "function")
      ? CC.ensureConversation
      : function () { return Promise.reject(new Error("Messaging isn't loaded.")); };
    return ensure(detail.order.shop_id, detail.order.id).then(function (conv) {
      return CC.sendMessage(conv.id, {
        body: "I accept the proposed changes (" + CC.centsToPrice(quote.amount_cents) + "). Please confirm my order.",
        card_type: "quote",
        card_ref: { quote_id: quote.id, accepted_by_buyer: true }
      });
    });
  };

  CC.rejectProposedChanges = function (detail, quote, note) {
    var ensure = (typeof CC.ensureConversation === "function")
      ? CC.ensureConversation
      : function () { return Promise.reject(new Error("Messaging isn't loaded.")); };
    return ensure(detail.order.shop_id, detail.order.id).then(function (conv) {
      return CC.sendMessage(conv.id, {
        body: "Thanks, but the proposed changes don't work for me." +
          (note ? " " + note : "") + " Can we try something else?",
        card_type: "quote",
        card_ref: { quote_id: quote.id, rejected_by_buyer: true }
      });
    });
  };

  /**
   * Buyer accepts a CUSTOM ORDER quote: flip the custom order to 'accepted'
   * (buyers are participants — allowed) + acceptance message. The seller can
   * then mark their quote row 'accepted' (seller-only update) from the UI.
   */
  CC.acceptCustomQuote = function (customOrder, quote) {
    var ensure = (typeof CC.ensureConversation === "function")
      ? CC.ensureConversation
      : function () { return Promise.reject(new Error("Messaging isn't loaded.")); };
    return sb().from("cc_custom_orders").update({ status: "accepted" })
      .eq("id", customOrder.id).in("status", ["open", "quoted"])
      .select("id").single()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return ensure(customOrder.shop_id, null);
      })
      .then(function (conv) {
        return CC.sendMessage(conv.id, {
          body: "I accept your quote of " + CC.centsToPrice(quote.amount_cents) + ". Let's do it!",
          card_type: "quote",
          card_ref: { quote_id: quote.id, accepted_by_buyer: true }
        });
      });
  };

  /* ------------------------------------------------------------------ */
  /* Timeline                                                              */
  /* ------------------------------------------------------------------ */

  CC.timelineHtml = function (history, order) {
    var items = [];
    items.push({
      status: "pending",
      label: "Order requested",
      time: order.created_at,
      note: order.customer_note ? "“" + order.customer_note + "”" : ""
    });
    (history || []).forEach(function (h) {
      if (!h.to_status || h.to_status === "pending") return;
      var lbl = CC.orderStatusLabel(h.to_status, null);
      items.push({ status: h.to_status, label: "Moved to " + lbl, time: h.created_at, note: h.note || "" });
    });
    // Dedupe consecutive identical statuses (defensive).
    var deduped = [];
    items.forEach(function (it) {
      var last = deduped[deduped.length - 1];
      if (last && last.status === it.status && /Moved to/.test(it.label)) return;
      deduped.push(it);
    });
    var cur = order.status;
    return '<ol class="s4-timeline">' + deduped.map(function (it, ix) {
      var isLast = ix === deduped.length - 1;
      var cls = TERMINAL_BAD[it.status] ? "is-bad" : (isLast ? "is-now" : "is-done");
      var icon = cls === "is-bad" ? "warning" : (cls === "is-now" ? "clock" : "check");
      return '<li class="' + cls + '"><span class="s4-dot">' + CC.icon(icon) + "</span>" +
        '<div class="s4-tl-label">' + esc(it.label) + "</div>" +
        '<div class="s4-tl-time">' + esc(CC.formatDateTime(it.time)) + "</div>" +
        (it.note ? '<div class="s4-tl-note">' + esc(it.note) + "</div>" : "") +
        "</li>";
    }).join("") + "</ol>";
  };
})();
