/* ==========================================================================
   CraveCorner — Stage 5 cravings board (assets/js/cc-cravings.js)
   --------------------------------------------------------------------------
   Live "I want …" board backed by cc_cravings / cc_craving_replies.

   Schema rules honored here:
   - Public reads see status='open' rows; authors also see their own
     found/closed rows (RLS). Found/Closed tabs are therefore the author's
     own resolved cravings — the empty copy says so honestly.
   - needed_by is a plain date: open cravings with needed_by < today are
     "past" — they leave the active list and show under the Past filter.
   - UNIQUE(craving_id, seller_id): one initial public reply per seller.
     A 23505 on insert is surfaced honestly, not retried.
   - Replies are only accepted while the craving is open (RLS).
   - Only city/state are ever shown. No private addresses exist here.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var CC5 = (window.CC5 = window.CC5 || {});
  var M = (window.CC5Cravings = window.CC5Cravings || {});

  function esc(s) { return CC.esc(s); }
  function live() { return !!(CC.live && CC.sb); }

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
  M.stateOptions = function (selected) {
    return ['<option value="">State</option>'].concat(US_STATES.map(function (s) {
      return '<option value="' + s[0] + '"' + (selected === s[0] ? " selected" : "") + ">" + s[1] + "</option>";
    })).join("");
  };

  /* ------------------------------------------------------------------ */
  /* Status chips                                                        */
  /* ------------------------------------------------------------------ */

  M.statusChip = function (c) {
    if (CC5.isExpired(c)) return '<span class="cc-badge cc-badge-warn">Past due</span>';
    if (c.status === "found") return '<span class="cc-badge cc-badge-ready">Found</span>';
    if (c.status === "closed") return '<span class="cc-badge cc-badge-soldout">Closed</span>';
    return '<span class="cc-badge cc-badge-info">Open</span>';
  };

  /* ------------------------------------------------------------------ */
  /* Craving card                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * c: cc_cravings row.
   * o: { replies: [{reply..., shop}], isAuthor, myShop, products: [{id,name}],
   *      compact (homepage preview: no reply forms / threads) }
   */
  M.card = function (c, o) {
    o = o || {};
    var replies = o.replies || [];
    var photo = c.photo_url ? CC.imgUrl("cc-craving-images", c.photo_url) : null;
    var expired = CC5.isExpired(c);
    var meta = '<ul class="ccx-craving-meta">' +
      "<li>" + CC.icon("location") + "<span>" + esc([c.city, c.state].filter(Boolean).join(", ") || "Location not set") + "</span></li>" +
      (c.needed_by ? "<li>" + CC.icon("calendar") + "<span>Needed by " + esc(CC5.fmtDate(c.needed_by)) + "</span></li>" : "") +
      (c.budget_cents != null ? "<li>" + CC.icon("clipboard") + "<span>Budget " + esc(CC.centsToPrice(c.budget_cents)) + "</span></li>" : "") +
      "<li>" + CC.icon("clock") + "<span>Posted " + esc(CC5.timeAgo(c.created_at)) + "</span></li>" +
    "</ul>";

    var thread = "";
    if (!o.compact) {
      var replyItems = replies.map(function (r) {
        var shop = r.shop || {};
        var prod = r.product_id && o.productsById ? o.productsById[r.product_id] : null;
        return '<div class="cc5r-reply">' +
          '<div class="cc5r-reply-head">' +
            (shop.id
              ? '<a href="shop.html?id=' + esc(shop.id) + '"><strong>' + esc(shop.name || "Seller") + "</strong></a>"
              : "<strong>" + esc(shop.name || "Seller") + "</strong>") +
            '<span class="cc-caption">' + esc(CC5.timeAgo(r.created_at)) + "</span>" +
          "</div>" +
          '<p>' + esc(r.body) + "</p>" +
          (prod ? '<a class="cc5-prod-link" href="product.html?id=' + esc(prod.id) + '">' + CC.icon("shopping-bag") +
            "<span>" + esc(prod.name) + "</span></a>" : "") +
          '<div><a class="cc-btn cc-btn-sm cc-btn-ghost" href="inbox.html">Message privately</a></div>' +
        "</div>";
      }).join("");

      var replyBlock = "";
      if (c.status === "open" && !expired) {
        var alreadyReplied = o.myShop && replies.some(function (r) { return r.seller_id === (CC.user && CC.user.id); });
        if (o.myShop && !alreadyReplied) {
          var prodOpts = '<option value="">No linked product</option>' + (o.products || []).map(function (p) {
            return '<option value="' + esc(p.id) + '">' + esc(p.name) + "</option>";
          }).join("");
          replyBlock =
            '<form class="cc5r-form" data-cc5r-form="' + esc(c.id) + '">' +
              '<label class="cc-label" for="cc5r-body-' + esc(c.id) + '">Reply as ' + esc(o.myShop.name) + "</label>" +
              '<textarea class="cc-textarea" id="cc5r-body-' + esc(c.id) + '" name="body" rows="2" maxlength="600" required ' +
                'placeholder="Yes, I can make this — here\u2019s how…"></textarea>' +
              '<div class="cc5r-form-row">' +
                '<select class="cc-select" name="product_id" aria-label="Link a product (optional)">' + prodOpts + "</select>" +
                '<button type="submit" class="cc-btn cc-btn-primary cc-btn-sm">Post reply</button>' +
              "</div>" +
              '<p class="cc-hint">One public reply per seller — follow-ups go to private messages.</p>' +
              '<div data-cc5r-err></div>' +
            "</form>";
        } else if (o.myShop && alreadyReplied) {
          replyBlock = '<p class="cc-small cc-muted">' + CC.icon("check") +
            ' You already replied to this craving — continue over <a href="inbox.html">private messages</a>.</p>';
        } else if (CC.user) {
          replyBlock = '<p class="cc-small cc-muted">Only sellers with a shop can reply publicly. ' +
            '<a href="create.html">Become a seller</a> to answer cravings.</p>';
        } else {
          replyBlock = '<p class="cc-small cc-muted"><button type="button" class="cc-btn cc-btn-sm cc-btn-outline" data-cc5-open-auth>Sellers: sign in to reply</button></p>';
        }
      }

      thread =
        '<details class="cc5r-thread" data-cc5r-thread="' + esc(c.id) + '">' +
          "<summary>Replies (" + replies.length + ")</summary>" +
          '<div class="cc5r-thread-body">' +
            (replyItems || '<p class="cc-small cc-muted">No replies yet — be the first seller to answer.</p>') +
            replyBlock +
          "</div>" +
        "</details>";
    }

    var authorActions = "";
    if (o.isAuthor && !o.compact && (c.status === "open")) {
      authorActions =
        '<div class="cc5r-author-actions">' +
          '<button type="button" class="cc-btn cc-btn-sm cc-btn-secondary" data-cc5r-status="' + esc(c.id) + '" data-cc5r-to="found">Mark as found</button>' +
          '<button type="button" class="cc-btn cc-btn-sm cc-btn-ghost" data-cc5r-status="' + esc(c.id) + '" data-cc5r-to="closed">Close</button>' +
          '<button type="button" class="cc-btn cc-btn-sm cc-btn-ghost" data-cc5r-delete="' + esc(c.id) + '">Delete</button>' +
        "</div>";
    }

    return '<article class="ccx-craving-card cc-card" data-cc5r-craving="' + esc(c.id) + '">' +
      '<div class="ccx-craving-top"><h3>' + esc(c.title) + "</h3>" + M.statusChip(c) + "</div>" +
      (photo ? '<div class="cc5r-photo"><img src="' + esc(photo) + '" alt="" loading="lazy"></div>' : "") +
      (c.description ? '<p class="ccx-craving-desc">' + esc(c.description) + "</p>" : "") +
      meta + thread + authorActions +
      (o.compact ? "" :
        '<div class="cc5r-foot"><button type="button" class="cc-btn cc-btn-sm cc-btn-ghost" ' +
        'data-cc5-report-craving="' + esc(c.id) + '">' + CC.icon("warning") + " Report</button></div>") +
    "</article>";
  };

  /* ------------------------------------------------------------------ */
  /* Post-a-craving form                                                 */
  /* ------------------------------------------------------------------ */

  function openCravingForm(onDone) {
    CC5.requireAuth("post a craving").then(function (user) {
      if (!user || !live()) return;
      var m = CC5.modal("Post a craving",
        '<div data-cc5r-err></div>' +
        '<form data-cc5r-new novalidate>' +
          '<div class="cc-field"><label class="cc-label" for="cc5r-title">What are you craving? <span class="cc-req" aria-hidden="true">*</span></label>' +
            '<input class="cc-input" id="cc5r-title" name="title" maxlength="120" required ' +
              'placeholder="e.g. Tres leches cake for Saturday"></div>' +
          '<div class="cc-field"><label class="cc-label" for="cc5r-desc">Details</label>' +
            '<textarea class="cc-textarea" id="cc5r-desc" name="description" rows="3" maxlength="1000" ' +
              'placeholder="Servings, flavors, dietary needs — anything a cook should know."></textarea></div>' +
          '<div class="cc-loc-grid">' +
            '<div class="cc-field"><label class="cc-label" for="cc5r-city">City <span class="cc-req" aria-hidden="true">*</span></label>' +
              '<input class="cc-input" id="cc5r-city" name="city" maxlength="80" required></div>' +
            '<div class="cc-field"><label class="cc-label" for="cc5r-state">State <span class="cc-req" aria-hidden="true">*</span></label>' +
              '<select class="cc-select" id="cc5r-state" name="state" required>' + M.stateOptions("") + "</select></div>" +
          "</div>" +
          '<div class="cc-loc-grid">' +
            '<div class="cc-field"><label class="cc-label" for="cc5r-needed">Needed by</label>' +
              '<input class="cc-input" id="cc5r-needed" name="needed_by" type="date" min="' + CC5.todayStr() + '"></div>' +
            '<div class="cc-field"><label class="cc-label" for="cc5r-budget">Budget (USD, optional)</label>' +
              '<input class="cc-input" id="cc5r-budget" name="budget" type="number" min="0" step="0.01" inputmode="decimal" placeholder="25.00"></div>' +
          "</div>" +
          '<div class="cc-field"><label class="cc-label" for="cc5r-photo">Photo <span class="cc-muted">(optional)</span></label>' +
            '<input class="cc-input" id="cc5r-photo" name="photo" type="file" accept="image/*">' +
            '<p class="cc-hint">Only your city and state are shown — never a street address.</p></div>' +
          '<div class="cc-modal-actions">' +
            '<button type="button" class="cc-btn cc-btn-ghost" data-cc5-cancel>Cancel</button>' +
            '<button type="submit" class="cc-btn cc-btn-primary">Post craving</button>' +
          "</div>" +
        "</form>");
      var form = m.el.querySelector("[data-cc5r-new]");
      var errBox = m.el.querySelector("[data-cc5r-err]");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        errBox.innerHTML = "";
        var title = form.elements.title.value.trim();
        var city = form.elements.city.value.trim();
        var state = form.elements.state.value;
        if (!title || !city || !state) {
          errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">Tell us what you want, plus your city and state.</div>';
          return;
        }
        var neededBy = form.elements.needed_by.value || null;
        var budgetRaw = (form.elements.budget.value || "").trim();
        var budgetCents = null;
        if (budgetRaw !== "") {
          var dollars = Number(budgetRaw);
          if (isNaN(dollars) || dollars < 0) {
            errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">Budget must be a positive number.</div>';
            return;
          }
          budgetCents = Math.round(dollars * 100);
        }
        var btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Posting…";
        var files = form.elements.photo.files;
        var upload = files.length
          ? CC5.uploadPhotos("cc-craving-images", files, user.id, 1)
          : Promise.resolve([]);
        upload.then(function (paths) {
          return CC.sb.from("cc_cravings").insert({
            author_id: user.id,
            title: title,
            description: form.elements.description.value.trim() || null,
            city: city,
            state: state,
            needed_by: neededBy,
            budget_cents: budgetCents,
            photo_url: paths[0] || null
          }).select("id").single();
        }).then(function (r) {
          if (r.error) throw r.error;
          m.el.querySelector(".cc5-modal-body").innerHTML =
            CC.states.success({ title: "Craving posted", body: "Local cooks can now reply to it." });
          window.setTimeout(function () { m.close(); if (onDone) onDone(); }, 1400);
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = "Post craving";
          errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' +
            esc((err && err.message) || "Could not post the craving.") + "</div>";
        });
      });
    });
  }
  M.openForm = openCravingForm;

  /* ------------------------------------------------------------------ */
  /* Board                                                               */
  /* ------------------------------------------------------------------ */

  var FILTERS = ["open", "found", "closed", "past"];

  /**
   * opts: { listEl, pillsEl, newBtn } — existing Stage 1 DOM nodes.
   * Takes over the board in live mode; no-ops when not live.
   */
  M.initBoard = function (opts) {
    if (!live() || !CC5) return;
    var listEl = opts.listEl, pillsEl = opts.pillsEl, newBtn = opts.newBtn;
    var filter = "open";
    var cravings = [];
    var repliesByCraving = {};
    var shopsById = {};
    var myShop = null;
    var myProducts = [];
    var productsById = {};

    CC5.bindActions(listEl);

    /* The Stage 1 "Post a craving" button has a direct honest-modal binding;
       swap the node so the live form owns it. */
    if (newBtn) {
      var freshBtn = newBtn.cloneNode(true);
      newBtn.parentNode.replaceChild(freshBtn, newBtn);
      freshBtn.addEventListener("click", function () { openCravingForm(load); });
      if (window.location.hash === "#new") {
        CC.ready.then(function () { openCravingForm(load); });
      }
    }

    function counts() {
      var c = { open: 0, found: 0, closed: 0, past: 0 };
      cravings.forEach(function (cr) {
        if (CC5.isExpired(cr)) { c.past++; return; }
        if (cr.status === "open") c.open++;
        else if (cr.status === "found") c.found++;
        else if (cr.status === "closed") c.closed++;
      });
      return c;
    }

    function renderPills() {
      var c = counts();
      var labels = { open: "Open", found: "Found", closed: "Closed", past: "Past" };
      pillsEl.innerHTML = FILTERS.map(function (f) {
        return '<button type="button" class="cc-pill" data-cc5r-filter="' + f + '" aria-pressed="' + (filter === f) + '">' +
          esc(labels[f]) + ' <span class="cc-caption" aria-hidden="true">(' + c[f] + ")</span></button>";
      }).join("");
    }

    function visibleList() {
      return cravings.filter(function (cr) {
        var expired = CC5.isExpired(cr);
        if (filter === "past") return expired;
        if (expired) return false;
        return cr.status === filter;
      });
    }

    function render() {
      renderPills();
      var list = visibleList();
      if (!list.length) {
        var empty = {
          open:   { icon: "clipboard", title: "No open cravings", body: "Nothing the neighborhood is hunting for right now — post the first craving." },
          found:  { icon: "check", title: "No found cravings", body: "Found cravings are only visible to the person who posted them." },
          closed: { icon: "clipboard", title: "No closed cravings", body: "Closed cravings are only visible to the person who posted them." },
          past:   { icon: "clock", title: "Nothing past due", body: "Open cravings whose needed-by date passed will land here instead of the active list." }
        }[filter];
        listEl.innerHTML = CC.states.empty(empty);
        return;
      }
      var uid = CC.user && CC.user.id;
      listEl.innerHTML = list.map(function (cr) {
        return M.card(cr, {
          replies: repliesByCraving[cr.id] || [],
          shopsById: shopsById,
          isAuthor: !!(uid && cr.author_id === uid),
          myShop: myShop,
          products: myProducts,
          productsById: productsById
        });
      }).join("");
    }

    function load() {
      listEl.innerHTML = '<div class="cc-grid-products">' +
        '<div class="cc-product-card" aria-hidden="true"><div class="cc-product-media cc-skeleton"></div>' +
        '<div class="cc-product-body"><div class="cc-skeleton" style="height:18px;width:82%"></div>' +
        '<div class="cc-skeleton" style="height:14px;width:55%"></div></div></div></div>';
      var q = CC.sb.from("cc_cravings")
        .select("id,author_id,title,description,city,state,needed_by,budget_cents,photo_url,status,created_at")
        .order("created_at", { ascending: false }).limit(100);
      q.then(function (r) {
        if (r.error) throw r.error;
        cravings = r.data || [];
        var ids = cravings.map(function (c) { return c.id; });
        var jobs = [];
        if (ids.length) {
          jobs.push(CC.sb.from("cc_craving_replies")
            .select("id,craving_id,seller_id,shop_id,body,product_id,created_at")
            .in("craving_id", ids).order("created_at", { ascending: true }));
        }
        jobs.push(CC5.myShop());
        return Promise.all(jobs).then(function (res) {
          // jobs = [repliesResult?, shopRow]; replies query is skipped when there are no cravings.
          var replyRows = [], shopRow = null;
          if (ids.length) { replyRows = (res[0] && res[0].data) || []; shopRow = res[1]; }
          else { shopRow = res[0]; }
          myShop = shopRow || null;
          repliesByCraving = {};
          var shopIds = [], productIds = [];
          replyRows.forEach(function (rp) {
            (repliesByCraving[rp.craving_id] = repliesByCraving[rp.craving_id] || []).push(rp);
            if (shopIds.indexOf(rp.shop_id) === -1) shopIds.push(rp.shop_id);
            if (rp.product_id && productIds.indexOf(rp.product_id) === -1) productIds.push(rp.product_id);
          });
          var lookups = [];
          if (shopIds.length) {
            lookups.push(CC.sb.from("cc_shops_public").select("id,name").in("id", shopIds)
              .then(function (sr) {
                (sr.data || []).forEach(function (s) {
                  shopsById[s.id] = s;
                  Object.keys(repliesByCraving).forEach(function (cid) {
                    repliesByCraving[cid].forEach(function (rp) {
                      if (rp.shop_id === s.id) rp.shop = s;
                    });
                  });
                });
              }));
          }
          if (productIds.length) {
            lookups.push(CC.sb.from("cc_products").select("id,name").in("id", productIds)
              .then(function (pr) { (pr.data || []).forEach(function (p) { productsById[p.id] = p; }); }));
          }
          if (myShop) {
            lookups.push(CC.sb.from("cc_products").select("id,name")
              .eq("shop_id", myShop.id).in("status", ["active", "paused", "sold_out"]).order("name")
              .then(function (pr) { myProducts = pr.data || []; }));
          }
          return Promise.all(lookups).then(render);
        });
      }).catch(function (err) {
        listEl.innerHTML = CC.states.error({
          title: "Could not load cravings",
          body: (err && err.message) || "Check your connection and try again."
        });
      });
    }

    pillsEl.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cc5r-filter]");
      if (!btn) return;
      filter = btn.getAttribute("data-cc5r-filter");
      render();
    });

    /* Reply submit / status / delete — delegated on the list. */
    listEl.addEventListener("submit", function (e) {
      var form = e.target.closest("[data-cc5r-form]");
      if (!form) return;
      e.preventDefault();
      var cravingId = form.getAttribute("data-cc5r-form");
      var body = form.elements.body.value.trim();
      var errBox = form.querySelector("[data-cc5r-err]");
      errBox.innerHTML = "";
      if (!body) { errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">Write a reply first.</div>'; return; }
      CC5.requireAuth("reply to cravings").then(function (user) {
        if (!user || !myShop || !live()) return;
        var btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        CC.sb.from("cc_craving_replies").insert({
          craving_id: cravingId,
          seller_id: user.id,
          shop_id: myShop.id,
          body: body,
          product_id: form.elements.product_id.value || null
        }).then(function (r) {
          if (r.error) throw r.error;
          CC5.toast("Reply posted.");
          load();
        }).catch(function (err) {
          btn.disabled = false;
          var msg = (err && err.message) || "Could not post the reply.";
          if (err && err.code === "23505") {
            // UNIQUE(craving_id, seller_id): one initial public reply per seller.
            msg = "You already posted a public reply here — continue over private messages instead.";
          }
          errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' + esc(msg) + "</div>";
        });
      });
    });

    listEl.addEventListener("click", function (e) {
      var t = e.target;
      var stBtn = t.closest("[data-cc5r-status]");
      if (stBtn) {
        var id = stBtn.getAttribute("data-cc5r-status");
        var to = stBtn.getAttribute("data-cc5r-to");
        var label = to === "found" ? "Mark this craving as found?" : "Close this craving?";
        CC5.confirmModal(label,
          to === "found"
            ? "Sellers will see it is resolved. You can reopen it by posting again."
            : "This removes it from the board.",
          to === "found" ? "Mark found" : "Close craving").then(function (ok) {
          if (!ok || !live()) return;
          CC.sb.from("cc_cravings").update({ status: to }).eq("id", id).then(function (r) {
            if (r.error) throw r.error;
            CC5.toast(to === "found" ? "Marked as found." : "Craving closed.");
            load();
          }).catch(function (err) {
            CC5.toast((err && err.message) || "Could not update the craving.");
          });
        });
        return;
      }
      var delBtn = t.closest("[data-cc5r-delete]");
      if (delBtn) {
        var delId = delBtn.getAttribute("data-cc5r-delete");
        CC5.confirmModal("Delete this craving?", "It will be removed from the board.", "Delete").then(function (ok) {
          if (!ok || !live()) return;
          CC.sb.from("cc_cravings").delete().eq("id", delId).then(function (r) {
            if (r.error) throw r.error;
            CC5.toast("Craving deleted.");
            load();
          }).catch(function (err) {
            CC5.toast((err && err.message) || "Could not delete the craving.");
          });
        });
        return;
      }
    });

    document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
    /* A seller signing in from the board's own prompts unlocks the reply
       forms without a manual refresh. */
    if (CC.onAuth) CC.onAuth(function () { CC5.clearShopCache(); load(); });

    load();
  };

})();
