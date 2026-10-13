/* ==========================================================================
   CraveCorner — Stage 4: Messaging (cc-messages.js)
   Private buyer <-> seller conversations: text, product/quote/order cards,
   image attachments, block/report, realtime.

   Exposes:
     CC.ensureConversation(shopId, orderRequestId) -> conversation row
     CC.getConversations()        my threads, newest first
     CC.getConversation(id)       one thread (RLS: participants only)
     CC.getMessages(convId, limit)  oldest -> newest
     CC.sendMessage(convId, {body, attachments, card_type, card_ref})
     CC.uploadMessageImages(files) -> [storage paths] (cc-message-images)
     CC.setBlock(convId, blocked)  block/unblock the thread for the other side
     CC.canISend(conv)             false when the other side blocked me
     CC.iBlocked(conv)             whether *I* blocked this thread
     CC.reportUser(otherUserId, convId)
     CC.pickShop(cb)               shop search modal -> cb(shop row)
     CC.subscribeConversation(convId, onMessage) -> unsubscribe()
     CC.subscribeInbox(onEvent)    -> unsubscribe()
     CC.msgMarkRead(convId, iso) / CC.msgLastRead(convId)
     CC.messageCardHtml(msg)       placeholder; CC.enrichMessageCards(root)
     CC.formatMsgTime(iso) / CC.dayLabel(iso)
     CC.otherParty(conv)           {id, kind: 'shop'|'buyer', name}

   HONEST READ STATE: cc_messages.read_at is NOT client-writable (messages are
   immutable per RLS — no user UPDATE policy), so unread tracking is kept in
   localStorage per device. Unread indicators work on this device only.

   Requires: assets/js/cc.js. Include after app.js, before page scripts.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  function sb() { return CC.sb || null; }
  function esc(s) { return CC.esc(s); }
  function me() { return CC.user ? CC.user.id : null; }

  var MSG_BUCKET = "cc-message-images";
  var MAX_IMAGES = 4;
  var MAX_BYTES = 5 * 1024 * 1024; // 5 MB per image

  /* ------------------------------------------------------------------ */
  /* Conversations                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Get-or-create my thread with a shop. orderRequestId links the thread to
   * a specific order; otherwise it's the single buyer/shop thread (the DB's
   * partial unique index enforces one thread per buyer+shop).
   */
  CC.ensureConversation = function (shopId, orderRequestId) {
    var client = sb();
    var uid = me();
    if (!client || !uid) return Promise.reject(new Error("Sign in to message a seller."));
    var q = client.from("cc_conversations").select("*")
      .eq("shop_id", shopId).eq("buyer_id", uid);
    q = orderRequestId ? q.eq("order_request_id", orderRequestId)
                       : q.is("order_request_id", null);
    return q.maybeSingle().then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (r.data) return r.data;
      // Need the shop owner's user id for seller_id (buyer-insert policy).
      return CC.getPublicShop
        ? CC.getPublicShop(shopId)
        : client.from("cc_shops_public").select("id, user_id").eq("id", shopId).maybeSingle()
            .then(function (s) { return s.data; });
    }).then(function (shopOrConv) {
      if (shopOrConv && shopOrConv.buyer_id) return shopOrConv; // already a conversation
      var shop = shopOrConv;
      if (!shop || !shop.user_id) throw new Error("Couldn't find that shop.");
      if (shop.user_id === uid) throw new Error("You can't message your own shop.");
      return client.from("cc_conversations").insert({
        shop_id: shopId, buyer_id: uid, seller_id: shop.user_id,
        order_request_id: orderRequestId || null
      }).select("*").single().then(function (ins) {
        if (ins.error) {
          // Lost a race with another tab: re-read the thread (fresh query —
          // PostgREST builders are single-shot).
          if (/duplicate|unique/i.test(ins.error.message)) {
            var rq = client.from("cc_conversations").select("*")
              .eq("shop_id", shopId).eq("buyer_id", uid);
            rq = orderRequestId ? rq.eq("order_request_id", orderRequestId)
                                : rq.is("order_request_id", null);
            return rq.maybeSingle().then(function (r2) {
              if (r2.data) return r2.data;
              throw new Error(ins.error.message);
            });
          }
          throw new Error(ins.error.message);
        }
        return ins.data;
      });
    });
  };

  CC.getConversations = function () {
    var uid = me();
    if (!sb() || !uid) return Promise.resolve([]);
    return sb().from("cc_conversations").select("*")
      .or("buyer_id.eq." + uid + ",seller_id.eq." + uid)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(60)
      .then(function (r) { return r.error ? [] : (r.data || []); })
      .catch(function () { return []; });
  };

  CC.getConversation = function (id) {
    if (!sb() || !me()) return Promise.resolve(null);
    return sb().from("cc_conversations").select("*").eq("id", id).maybeSingle()
      .then(function (r) { return r.error ? null : r.data; })
      .catch(function () { return null; });
  };

  /** Who am I talking to? Buyers see the shop; sellers see the buyer. */
  CC.otherParty = function (conv) {
    var uid = me();
    if (!conv) return { id: null, kind: "shop", name: "Conversation" };
    if (conv.buyer_id === uid) return { id: conv.seller_id, kind: "shop", shopId: conv.shop_id, name: null };
    return { id: conv.buyer_id, kind: "buyer", name: null };
  };

  CC.getShopForConv = function (conv) {
    var get = CC.getPublicShop
      ? CC.getPublicShop(conv.shop_id)
      : sb().from("cc_shops_public").select("id, name, city").eq("id", conv.shop_id).maybeSingle()
          .then(function (r) { return r.data; });
    return Promise.resolve(get).catch(function () { return null; });
  };

  CC.getDisplayName = function (userId) {
    if (!userId || !sb()) return Promise.resolve(null);
    return sb().from("cc_profiles").select("display_name").eq("user_id", userId).maybeSingle()
      .then(function (r) { return (r.data && r.data.display_name) || null; })
      .catch(function () { return null; });
  };

  /* ------------------------------------------------------------------ */
  /* Messages                                                            */
  /* ------------------------------------------------------------------ */

  CC.getMessages = function (convId, limit) {
    if (!sb() || !me()) return Promise.resolve([]);
    return sb().from("cc_messages").select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(limit || 80)
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return (r.data || []).reverse(); // oldest -> newest
      });
  };

  CC.sendMessage = function (convId, opts) {
    opts = opts || {};
    var uid = me();
    if (!sb() || !uid) return Promise.reject(new Error("Sign in to send messages."));
    var atts = opts.attachments || [];
    var body = (opts.body || "").trim();
    if (!body && !atts.length) return Promise.reject(new Error("Write a message first."));
    if (!body && atts.length) {
      body = atts.length === 1 ? "Shared a photo." : "Shared " + atts.length + " photos.";
    }
    if (body.length > 4000) return Promise.reject(new Error("Messages are limited to 4000 characters."));
    var cardType = opts.card_type || "none";
    if (["none", "product", "quote", "order"].indexOf(cardType) === -1) cardType = "none";
    return sb().from("cc_messages").insert({
      conversation_id: convId,
      sender_id: uid,
      body: body,
      attachments: atts,
      card_type: cardType,
      card_ref: opts.card_ref || null
    }).select("*").single()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
  };

  /* ------------------------------------------------------------------ */
  /* Image attachments (cc-message-images bucket)                        */
  /* ------------------------------------------------------------------ */

  function cleanName(name) {
    return String(name || "photo.jpg").toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-").replace(/^\.+/, "").slice(0, 60) || "photo.jpg";
  }

  CC.uploadMessageImages = function (files) {
    var uid = me();
    if (!sb() || !uid) return Promise.reject(new Error("Sign in to attach photos."));
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return Promise.resolve([]);
    if (files.length > MAX_IMAGES) {
      return Promise.reject(new Error("Attach up to " + MAX_IMAGES + " photos per message."));
    }
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.type && f.type.indexOf("image/") !== 0) {
        return Promise.reject(new Error("Only image files can be attached."));
      }
      if (f.size > MAX_BYTES) {
        return Promise.reject(new Error("Each photo must be under 5 MB."));
      }
    }
    var uploads = files.map(function (f, ix) {
      var path = uid + "/" + Date.now() + "-" + ix + "-" + cleanName(f.name);
      return sb().storage.from(MSG_BUCKET).upload(path, f, { contentType: f.type || "image/jpeg" })
        .then(function (r) {
          if (r.error) throw new Error(r.error.message || "Upload failed.");
          return path; // DB stores the bucket-relative path, never a full URL
        });
    });
    return Promise.all(uploads);
  };

  CC.msgImgUrl = function (path) { return CC.imgUrl(MSG_BUCKET, path); };

  /* ------------------------------------------------------------------ */
  /* Block / report                                                      */
  /* ------------------------------------------------------------------ */

  /** I blocked this thread (stops the OTHER side from sending). */
  CC.iBlocked = function (conv) {
    var uid = me();
    if (!conv || !uid) return false;
    if (conv.buyer_id === uid) return !!conv.buyer_blocked;
    if (conv.seller_id === uid) return !!conv.seller_blocked;
    return false;
  };

  /** The other side blocked me -> I can't send. */
  CC.canISend = function (conv) {
    var uid = me();
    if (!conv || !uid) return false;
    if (conv.buyer_id === uid) return !conv.seller_blocked;
    if (conv.seller_id === uid) return !conv.buyer_blocked;
    return false;
  };

  CC.blockLabel = function (conv) {
    var uid = me();
    if (!conv || !uid) return null;
    if (conv.buyer_id === uid && conv.seller_blocked) return "You've been blocked by this seller — you can't send messages here, but you can still read the history.";
    if (conv.seller_id === uid && conv.buyer_blocked) return "You've been blocked by this customer — you can't send messages here, but you can still read the history.";
    return null;
  };

  CC.setBlock = function (conv, blocked) {
    var uid = me();
    if (!sb() || !uid) return Promise.reject(new Error("Sign in first."));
    var patch = {};
    if (conv.buyer_id === uid) patch.buyer_blocked = !!blocked;
    else if (conv.seller_id === uid) patch.seller_blocked = !!blocked;
    else return Promise.reject(new Error("You're not part of this conversation."));
    // Participants may only toggle block flags (DB guard) — history stays readable.
    return sb().from("cc_conversations").update(patch).eq("id", conv.id)
      .select("*").single()
      .then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
  };

  CC.reportUser = function (otherUserId, convId) {
    var uid = me();
    if (!sb() || !uid) return Promise.reject(new Error("Sign in to report."));
    var modal = CC.s4Modal("Report user",
      '<div class="cc-field"><label class="cc-label" for="s4-rep-reason">What\'s wrong? <span class="cc-req">*</span></label>' +
      '<select class="cc-select" id="s4-rep-reason">' +
      "<option>Spam or scam</option><option>Harassment or abuse</option>" +
      "<option>Inappropriate content</option><option>Fraudulent listing or order</option>" +
      "<option>Something else</option></select></div>" +
      '<div class="cc-field"><label class="cc-label" for="s4-rep-details">Details <span class="cc-muted">(optional)</span></label>' +
      '<textarea class="cc-textarea" id="s4-rep-details" style="min-height:88px" maxlength="2000" ' +
      'placeholder="What happened?"></textarea></div>' +
      '<div class="cc-alert cc-alert-danger s4-form-error" id="s4-rep-err" role="alert"></div>' +
      '<div class="cc-modal-actions">' +
        '<button type="button" class="cc-btn cc-btn-ghost" data-s4-close>Cancel</button>' +
        '<button type="button" class="cc-btn cc-btn-danger" id="s4-rep-submit">Send report</button>' +
      "</div>");
    var body = modal.el.querySelector(".cc-modal-body");
    body.querySelector("#s4-rep-submit").addEventListener("click", function () {
      var reason = body.querySelector("#s4-rep-reason").value;
      var details = body.querySelector("#s4-rep-details").value.trim();
      var btn = body.querySelector("#s4-rep-submit");
      btn.disabled = true; btn.textContent = "Sending…";
      sb().from("cc_reports").insert({
        reporter_id: uid,
        target_type: "user",
        target_id: otherUserId,
        reason: reason,
        details: (details ? details + " " : "") + "(Reported from a conversation.)"
      }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        modal.close();
        CC.s4Honest("Report sent",
          "<p>Thanks — our moderation team will review this user. " +
          "You can block them to stop further messages.</p>");
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = "Send report";
        var eb = body.querySelector("#s4-rep-err");
        eb.innerHTML = CC.icon("warning") + "<div>" + esc(e.message) + "</div>";
        eb.classList.add("is-show");
      });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Read state (localStorage — read_at is not client-writable)          */
  /* ------------------------------------------------------------------ */

  var READ_KEY = "cc_msg_read_v1";
  function readMap() {
    try { return JSON.parse(localStorage.getItem(READ_KEY) || "{}"); } catch (e) { return {}; }
  }
  CC.msgLastRead = function (convId) {
    return readMap()[convId] || null;
  };
  CC.msgMarkRead = function (convId, iso) {
    try {
      var m = readMap();
      var prev = m[convId];
      if (!prev || (iso && iso > prev)) { m[convId] = iso; localStorage.setItem(READ_KEY, JSON.stringify(m)); }
    } catch (e) {}
  };
  /** Count of messages not from me newer than my last-read mark. */
  CC.unreadIn = function (convId, messages) {
    var uid = me();
    var last = CC.msgLastRead(convId);
    var n = 0;
    (messages || []).forEach(function (m) {
      if (m.sender_id === uid) return;
      if (!last || (m.created_at && m.created_at > last)) n++;
    });
    return n;
  };

  /* ------------------------------------------------------------------ */
  /* Realtime                                                            */
  /* ------------------------------------------------------------------ */

  CC.subscribeConversation = function (convId, onMessage) {
    if (!sb()) return function () {};
    var ch = sb().channel("conv-" + convId)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "cc_messages",
          filter: "conversation_id=eq." + convId },
        function (payload) { if (payload && payload.new) onMessage(payload.new); })
      .subscribe();
    return function () { try { sb().removeChannel(ch); } catch (e) {} };
  };

  CC.subscribeInbox = function (onEvent) {
    if (!sb() || !me()) return function () {};
    var uid = me();
    var ch = sb().channel("inbox-" + uid)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "cc_messages" },
        function (payload) { if (payload && payload.new) onEvent("message", payload.new); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "cc_conversations" },
        function (payload) { onEvent("conversation", payload); })
      .subscribe();
    return function () { try { sb().removeChannel(ch); } catch (e) {} };
  };

  /* ------------------------------------------------------------------ */
  /* Time formatting                                                     */
  /* ------------------------------------------------------------------ */

  CC.formatMsgTime = function (iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  };

  CC.dayLabel = function (iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      var now = new Date();
      var startOf = function (x) { var c = new Date(x); c.setHours(0, 0, 0, 0); return c; };
      var diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
      if (diffDays === 0) return "Today";
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) { return ""; }
  };

  /* ------------------------------------------------------------------ */
  /* Message cards (product / quote / order)                             */
  /* ------------------------------------------------------------------ */

  /**
   * Placeholder card HTML; call CC.enrichMessageCards(root) afterwards to
   * fill in live data. Keeps first paint fast and degrades honestly.
   */
  CC.messageCardHtml = function (msg) {
    var ref = msg.card_ref || {};
    var id = ref.product_id || ref.quote_id || ref.order_id || "";
    return '<div class="s4-mcard" data-mcard-type="' + esc(msg.card_type) + '" data-mcard-ref="' + esc(id) + '">' +
      '<div class="s4-mcard-top"><span class="s4-conv-avatar">' + CC.icon(
        msg.card_type === "product" ? "shopping-bag" : msg.card_type === "quote" ? "edit" : "clipboard"
      ) + "</span><div><strong>Loading…</strong><span></span></div></div></div>";
  };

  function cardLink(href, label) {
    return '<a class="s4-mcard-link" href="' + esc(href) + '">' + esc(label) + " " + CC.icon("share") + "</a>";
  }

  CC.enrichMessageCards = function (root) {
    if (!sb()) return;
    var cards = root.querySelectorAll("[data-mcard-type]:not([data-mcard-done])");
    var byType = { product: [], quote: [], order: [] };
    Array.prototype.forEach.call(cards, function (c) {
      var t = c.getAttribute("data-mcard-type");
      var id = c.getAttribute("data-mcard-ref");
      if (byType[t] && id) { c.setAttribute("data-mcard-done", "1"); byType[t].push({ el: c, id: id }); }
    });
    function fill(list, fn) {
      list.forEach(function (item) {
        fn(item.id).then(function (html) {
          if (html) item.el.innerHTML = html;
          else item.el.querySelector("strong").textContent = "Unavailable";
        }).catch(function () {
          var s = item.el.querySelector("strong");
          if (s) s.textContent = "Unavailable";
        });
      });
    }
    fill(byType.product, function (id) {
      return sb().from("cc_products").select("id, name, price_cents").eq("id", id).maybeSingle()
        .then(function (r) {
          if (!r.data) return null;
          var p = r.data;
          return sb().from("cc_product_images").select("storage_path").eq("product_id", id)
            .order("is_cover", { ascending: false }).limit(1)
            .then(function (im) {
              var img = (im.data && im.data[0])
                ? '<img src="' + esc(CC.imgUrl("cc-product-images", im.data[0].storage_path)) + '" alt="">' : "";
              return '<div class="s4-mcard-top">' + img +
                "<div><strong>" + esc(p.name) + "</strong><span>" + esc(CC.centsToPrice(p.price_cents)) + "</span></div></div>" +
                cardLink("product.html?id=" + encodeURIComponent(id), "View listing");
            });
        });
    });
    fill(byType.quote, function (id) {
      return sb().from("cc_quotes").select("*").eq("id", id).maybeSingle()
        .then(function (r) {
          if (!r.data) return null;
          var q = r.data;
          var href = q.custom_order_id
            ? "custom-order.html?id=" + encodeURIComponent(q.custom_order_id)
            : "orders.html?id=" + encodeURIComponent(q.order_request_id);
          return '<div class="s4-mcard-top"><span class="s4-conv-avatar">' + CC.icon("edit") + "</span>" +
            "<div><strong>Quote: " + esc(CC.centsToPrice(q.amount_cents)) + "</strong>" +
            "<span>" + (q.deposit_cents ? esc(CC.centsToPrice(q.deposit_cents)) + " deposit · " : "") +
            (q.valid_until ? "Valid until " + esc(CC.formatDate(q.valid_until)) : "Quote") + "</span></div></div>" +
            (q.details ? '<p class="s4-small s4-muted" style="margin:.5rem 0 0">' + esc(q.details) + "</p>" : "") +
            '<div style="margin-top:.4rem">' + (CC.quoteChip ? CC.quoteChip(q.status) : esc(q.status)) + "</div>" +
            cardLink(href, q.custom_order_id ? "View custom order" : "View order");
        });
    });
    fill(byType.order, function (id) {
      return sb().from("cc_order_requests").select("id, status, qty, subtotal_cents, product_id").eq("id", id).maybeSingle()
        .then(function (r) {
          if (!r.data) return null;
          var o = r.data;
          return sb().from("cc_products").select("name").eq("id", o.product_id).maybeSingle()
            .then(function (pr) {
              var name = (pr.data && pr.data.name) || "Order";
              return '<div class="s4-mcard-top"><span class="s4-conv-avatar">' + CC.icon("clipboard") + "</span>" +
                "<div><strong>" + esc(name) + "</strong><span>" +
                esc(o.qty) + " × " + esc(CC.centsToPrice(o.subtotal_cents)) + "</span></div></div>" +
                '<div style="margin-top:.4rem">' + CC.orderChip(o.status, null) + "</div>" +
                cardLink("orders.html?id=" + encodeURIComponent(id), "View order");
            });
        });
    });
  };

  /* ------------------------------------------------------------------ */
  /* Shop picker modal (start a new thread)                              */
  /* ------------------------------------------------------------------ */

  CC.pickShop = function (cb) {
    var modal = CC.s4Modal("Message a shop",
      '<div class="cc-field"><label class="cc-label" for="s4-shop-q">Search shops</label>' +
      '<input class="cc-input" id="s4-shop-q" placeholder="Shop name or city…" autocomplete="off"></div>' +
      '<div id="s4-shop-results" aria-live="polite"><p class="cc-caption">Type to search published shops.</p></div>');
    var body = modal.el.querySelector(".cc-modal-body");
    var input = body.querySelector("#s4-shop-q");
    var results = body.querySelector("#s4-shop-results");
    var timer = null;
    function search() {
      var q = input.value.trim();
      if (q.length < 2) {
        results.innerHTML = '<p class="cc-caption">Type at least 2 characters.</p>';
        return;
      }
      results.innerHTML = '<div class="cc-loading" role="status">Searching…</div>';
      sb().from("cc_shops_public").select("id, name, city, state, logo_url")
        .or("name.ilike.%" + q + "%,city.ilike.%" + q + "%")
        .limit(12)
        .then(function (r) {
          var rows = r.error ? [] : (r.data || []);
          if (!rows.length) {
            results.innerHTML = '<p class="cc-caption">No published shops match “' + esc(q) + ".”</p>";
            return;
          }
          results.innerHTML = rows.map(function (s) {
            return '<button type="button" class="s4-shop-pick" data-shop="' + esc(s.id) + '" style="margin-bottom:.5rem">' +
              (s.logo_url ? '<img src="' + esc(CC.imgUrl("cc-shop-images", s.logo_url)) + '" alt="">'
                          : '<span class="s4-conv-avatar">' + CC.icon("store") + "</span>") +
              '<span class="s4-grow"><strong>' + esc(s.name) + "</strong>" +
              "<span>" + esc([s.city, s.state].filter(Boolean).join(", ")) + "</span></span></button>";
          }).join("");
          Array.prototype.forEach.call(results.querySelectorAll("[data-shop]"), function (btn) {
            btn.addEventListener("click", function () {
              var id = btn.getAttribute("data-shop");
              var shop = null;
              for (var i = 0; i < rows.length; i++) if (rows[i].id === id) shop = rows[i];
              modal.close();
              cb(shop);
            });
          });
        })
        .catch(function (e) {
          results.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' + esc(e.message) + "</div>";
        });
    }
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(search, 300);
    });
    input.focus();
  };
})();
