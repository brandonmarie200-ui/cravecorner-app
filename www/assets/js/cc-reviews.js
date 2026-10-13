/* ==========================================================================
   CraveCorner — Stage 5 reviews (assets/js/cc-reviews.js)
   --------------------------------------------------------------------------
   Genuine reviews only, tied to completed order requests:

   - cc_reviews: one row per COMPLETED order (order_request_id UNIQUE).
     The DB trigger enforces "order completed AND reviewer is the buyer";
     shop_id/product_id are DERIVED from the order — never sent by the
     client. The insert below sends only order_request_id, reviewer_id,
     stars, body, photos.
   - Rating summary = average of real published rows, or "No reviews yet".
     Nothing is ever fabricated; counts come straight from the query.
   - Reviewers edit words/stars/photos; sellers may only write/edit
     seller_response (trigger-enforced — this UI sends only that field).
   - "Write a review" appears only when the signed-in user has at least one
     completed order for this product/shop with no review yet.
   - Payments are off-platform: never call anything a "verified purchase".

   Requires: cc-community.js (CC5 helpers), cc.js, icons.js, app.js.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var CC5 = (window.CC5 = window.CC5 || {});
  var R = (window.CC5Reviews = window.CC5Reviews || {});

  function esc(s) { return CC.esc(s); }
  function live() { return !!(CC.live && CC.sb); }

  /* ------------------------------------------------------------------ */
  /* Review card                                                          */
  /* ------------------------------------------------------------------ */

  function reviewCard(rv, o) {
    o = o || {};
    var photos = rv.photos || [];
    var thumbs = photos.map(function (p) {
      return '<button type="button" class="cc5r-thumb" data-cc5r-photo="' + esc(CC.imgUrl("cc-review-images", p)) + '" aria-label="View review photo">' +
        '<img src="' + esc(CC.imgUrl("cc-review-images", p)) + '" alt="" loading="lazy"></button>';
    }).join("");
    var name = o.names && o.names[rv.reviewer_id] ? o.names[rv.reviewer_id] : "A CraveCorner customer";

    var responseBlock = "";
    if (rv.seller_response) {
      responseBlock =
        '<div class="cc5r-response">' +
          '<p class="cc5r-response-head">' + CC.icon("store") + "<span>Response from " + esc(o.shopName || "the seller") + "</span></p>" +
          "<p>" + esc(rv.seller_response) + "</p>" +
        "</div>";
    }
    var responseForm = "";
    if (o.isShopOwner && !o.compact) {
      responseForm =
        '<form class="cc5r-respform" data-cc5r-resp="' + esc(rv.id) + '">' +
          '<label class="cc-label" for="cc5r-resp-' + esc(rv.id) + '">' +
            (rv.seller_response ? "Edit your response" : "Respond as the seller") + "</label>" +
          '<textarea class="cc-textarea" id="cc5r-resp-' + esc(rv.id) + '" name="seller_response" rows="2" maxlength="1000">' +
            esc(rv.seller_response || "") + "</textarea>" +
          '<div><button type="submit" class="cc-btn cc-btn-sm cc-btn-secondary">Save response</button></div>' +
          '<div data-cc5r-resp-err></div>' +
        "</form>";
    }

    return '<article class="cc5r-review" data-cc5r-review="' + esc(rv.id) + '">' +
      '<div class="cc5r-review-head">' +
        '<div><strong>' + esc(name) + "</strong> " + CC5.starsHtml(rv.stars) + "</div>" +
        '<span class="cc-caption">' + esc(CC5.timeAgo(rv.created_at)) + "</span>" +
      "</div>" +
      (rv.body ? "<p>" + esc(rv.body) + "</p>" : "") +
      (thumbs ? '<div class="cc5r-photos">' + thumbs + "</div>" : "") +
      responseBlock + responseForm +
      (o.compact ? "" :
        '<div class="cc5r-foot"><button type="button" class="cc-btn cc-btn-sm cc-btn-ghost" ' +
        'data-cc5-report-review="' + esc(rv.id) + '">' + CC.icon("warning") + " Report</button></div>") +
    "</article>";
  }
  R.card = reviewCard;

  /* ------------------------------------------------------------------ */
  /* Write-a-review form                                                  */
  /* ------------------------------------------------------------------ */

  function starInputHtml(selected) {
    var out = '<div class="cc5r-stars-input" role="radiogroup" aria-label="Your rating">';
    for (var i = 5; i >= 1; i--) {
      out += '<label><input type="radio" name="stars" value="' + i + '"' + (selected === i ? " checked" : "") + ">" +
        '<span aria-hidden="true">' + CC.icon("star") + '</span><span class="pg-sr-only">' + i + " star" + (i > 1 ? "s" : "") + "</span></label>";
    }
    return out + "</div>";
  }

  function openReviewForm(order, productLabel, onDone) {
    CC5.requireAuth("write a review").then(function (user) {
      if (!user || !live()) return;
      var m = CC5.modal("Write a review",
        '<p class="cc-small cc-muted">Reviewing your completed order' + (productLabel ? " of <strong>" + esc(productLabel) + "</strong>" : "") + ".</p>" +
        '<div data-cc5rr-err></div>' +
        '<form data-cc5rr-form novalidate>' +
          starInputHtml(5) +
          '<div class="cc-field"><label class="cc-label" for="cc5rr-body">Your review</label>' +
            '<textarea class="cc-textarea" id="cc5rr-body" name="body" rows="4" maxlength="2000" ' +
              'placeholder="What did you love? How was pickup or delivery?"></textarea></div>' +
          '<div class="cc-field"><label class="cc-label" for="cc5rr-photos">Photos <span class="cc-muted">(optional, up to 4)</span></label>' +
            '<input class="cc-input" id="cc5rr-photos" name="photos" type="file" accept="image/*" multiple></div>' +
          '<div class="cc-modal-actions">' +
            '<button type="button" class="cc-btn cc-btn-ghost" data-cc5-cancel>Cancel</button>' +
            '<button type="submit" class="cc-btn cc-btn-primary">Post review</button>' +
          "</div>" +
        "</form>");
      var form = m.el.querySelector("[data-cc5rr-form]");
      var errBox = m.el.querySelector("[data-cc5rr-err]");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        errBox.innerHTML = "";
        var stars = parseInt((form.querySelector('input[name="stars"]:checked') || {}).value || "0", 10);
        if (!stars || stars < 1 || stars > 5) {
          errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">Pick a star rating from 1 to 5.</div>';
          return;
        }
        var btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Posting…";
        var files = form.elements.photos.files;
        CC5.uploadPhotos("cc-review-images", files, user.id, 4).then(function (paths) {
          // shop_id / product_id are derived from the order by the DB trigger.
          return CC.sb.from("cc_reviews").insert({
            order_request_id: order.id,
            reviewer_id: user.id,
            stars: stars,
            body: form.elements.body.value.trim() || null,
            photos: paths
          }).select("id").single();
        }).then(function (r) {
          if (r.error) throw r.error;
          m.el.querySelector(".cc5-modal-body").innerHTML =
            CC.states.success({ title: "Review posted", body: "Thanks for supporting a local kitchen." });
          window.setTimeout(function () { m.close(); if (onDone) onDone(); }, 1400);
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = "Post review";
          var msg = (err && err.message) || "Could not post the review.";
          if (err && err.code === "23505") {
            msg = "You already reviewed this order — one review per order.";
          }
          errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' + esc(msg) + "</div>";
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Section renderer                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Genuine rating summary: average of real published rows, or "" when
   * there are none (callers show the "No reviews yet" empty state).
   */
  R.summaryHtml = function (reviews) {
    reviews = reviews || [];
    var count = reviews.length;
    if (!count) return "";
    var sum = 0;
    reviews.forEach(function (rv) { sum += rv.stars; });
    var avg = sum / count;
    return '<div class="cc5r-summary cc-card">' +
      '<div class="cc5r-avg">' + avg.toFixed(1) + "</div>" +
      "<div>" + CC5.starsHtml(avg) +
      '<p class="cc-small cc-muted">' + count + " review" + (count === 1 ? "" : "s") +
      " · from completed orders only</p></div>" +
    "</div>";
  };

  /**
   * Renders the full reviews section into host.
   * opts: { productId (optional), shopId, shopName, productName (optional),
   *         extrasOnly (summary + CTA, no list), onData }
   */
  R.renderInto = function (host, opts) {
    if (!live() || !CC5 || !host) return;
    opts = opts || {};
    var sectionId = "cc5r-" + Math.random().toString(36).slice(2, 8);

    host.innerHTML =
      '<section class="cc5r-section" aria-labelledby="' + sectionId + '-t">' +
        '<h2 id="' + sectionId + '-t" class="cc-h3">Reviews</h2>' +
        '<div data-cc5rr-body>' + CC.states.skeletonCards(2) + "</div>" +
      "</section>";

    var body = host.querySelector("[data-cc5rr-body]");
    CC5.bindActions(host);

    /* One document-level refresher for every live reviews section on the
       page (visibility + auth changes). Detached hosts skip themselves so
       re-rendered tabs never stack up work. */
    if (!R._refreshers) {
      R._refreshers = [];
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) R._refreshers.forEach(function (fn) { fn(); });
      });
      if (CC.onAuth) CC.onAuth(function () { R._refreshers.forEach(function (fn) { fn(); }); });
    }
    R._refreshers.push(load);

    function load() {
      if (!host.isConnected) return;
      var q = CC.sb.from("cc_reviews")
        .select("id,order_request_id,reviewer_id,shop_id,product_id,stars,body,photos,seller_response,created_at")
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(100);
      if (opts.productId) q = q.eq("product_id", opts.productId);
      else q = q.eq("shop_id", opts.shopId);

      q.then(function (r) {
        if (r.error) throw r.error;
        var reviews = r.data || [];
        var reviewerIds = [];
        reviews.forEach(function (rv) {
          if (reviewerIds.indexOf(rv.reviewer_id) === -1) reviewerIds.push(rv.reviewer_id);
        });
        var names = {};
        var nameJob = reviewerIds.length
          ? CC.sb.from("cc_profiles").select("user_id,display_name").in("user_id", reviewerIds)
              .then(function (nr) { (nr.data || []).forEach(function (p) { names[p.user_id] = p.display_name; }); })
          : Promise.resolve();
        var ownerJob = CC5.myShop().then(function (s) { return !!(s && s.id === opts.shopId); });
        var eligJob = eligibility();
        return Promise.all([nameJob, ownerJob, eligJob]).then(function (res) {
          render(reviews, names, res[1], res[2]);
        });
      }).catch(function (err) {
        body.innerHTML = CC.states.error({
          title: "Could not load reviews",
          body: (err && err.message) || "Check your connection and try again."
        });
      });
    }

    /**
     * Completed orders by this user for this product/shop that have no
     * review yet. Empty when logged out (RLS would return nothing anyway).
     */
    function eligibility() {
      if (!CC.user) return Promise.resolve([]);
      var q = CC.sb.from("cc_order_requests")
        .select("id,product_id,created_at")
        .eq("buyer_id", CC.user.id)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(25);
      if (opts.productId) q = q.eq("product_id", opts.productId);
      else q = q.eq("shop_id", opts.shopId);
      return q.then(function (r) {
        if (r.error || !r.data || !r.data.length) return [];
        var orders = r.data;
        var ids = orders.map(function (o) { return o.id; });
        return CC.sb.from("cc_reviews").select("order_request_id").in("order_request_id", ids)
          .then(function (rr) {
            var reviewed = {};
            (rr.data || []).forEach(function (x) { reviewed[x.order_request_id] = true; });
            var open = orders.filter(function (o) { return !reviewed[o.id]; });
            if (!open.length) return [];
            // Attach product names for the shop-level picker.
            var pids = [];
            open.forEach(function (o) { if (pids.indexOf(o.product_id) === -1) pids.push(o.product_id); });
            return CC.sb.from("cc_products").select("id,name").in("id", pids).then(function (pr) {
              var byId = {};
              (pr.data || []).forEach(function (p) { byId[p.id] = p.name; });
              open.forEach(function (o) { o.product_name = byId[o.product_id] || null; });
              return open;
            });
          });
      }).catch(function () { return []; });
    }

    function ctaHtml(eligible) {
      if (CC.user && eligible.length) {
        var label = eligible.length === 1
          ? "Review your recent order" + (eligible[0].product_name && !opts.productId ? " of " + eligible[0].product_name : "")
          : "Review one of your " + eligible.length + " completed orders";
        return '<div class="cc5r-cta"><button type="button" class="cc-btn cc-btn-primary" data-cc5rr-write>' +
          CC.icon("star") + " " + esc(label) + "</button>" +
          '<p class="cc-hint">One review per completed order.</p></div>';
      }
      if (!CC.user) {
        return '<div class="cc5r-cta">' + CC5.loginWall("write a review") + "</div>";
      }
      return "";
    }

    function wireCta(scope, eligible) {
      var writeBtn = scope.querySelector("[data-cc5rr-write]");
      if (!writeBtn) return;
      writeBtn.addEventListener("click", function () {
        if (eligible.length === 1) {
          openReviewForm(eligible[0], eligible[0].product_name, load);
        } else {
          // Let the buyer pick which completed order to review.
          var m = CC5.modal("Choose an order",
            '<div class="cc5r-orderpick">' + eligible.map(function (o, i) {
              return '<button type="button" class="cc-btn cc-btn-outline cc-btn-block" data-cc5rr-pick="' + i + '">' +
                esc(o.product_name || "Order") + ' · <span class="cc-muted">' + esc(CC5.fmtDate(String(o.created_at).slice(0, 10))) + "</span></button>";
            }).join("") + "</div>");
          m.el.addEventListener("click", function (e) {
            var b = e.target.closest("[data-cc5rr-pick]");
            if (!b) return;
            var o = eligible[parseInt(b.getAttribute("data-cc5rr-pick"), 10)];
            m.close();
            openReviewForm(o, o.product_name, load);
          });
        }
      });
    }

    /* Seller response saves — delegated (bound once per root). */
    function wireRespForms(root) {
      if (!root || root._cc5rRespBound) return;
      root._cc5rRespBound = true;
      root.addEventListener("submit", function (e) {
        var form = e.target.closest("[data-cc5r-resp]");
        if (!form) return;
        e.preventDefault();
        var id = form.getAttribute("data-cc5r-resp");
        var errBox = form.querySelector("[data-cc5r-resp-err]");
        errBox.innerHTML = "";
        var btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        CC.sb.from("cc_reviews").update({ seller_response: form.elements.seller_response.value.trim() || null })
          .eq("id", id).then(function (r) {
            if (r.error) throw r.error;
            CC5.toast("Response saved.");
            load();
          }).catch(function (err) {
            btn.disabled = false;
            errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' +
              esc((err && err.message) || "Could not save the response.") + "</div>";
          });
      });
    }

    /* Review photo lightbox (simple). */
    function wireLightbox(root) {
      if (!root || root._cc5rLightBound) return;
      root._cc5rLightBound = true;
      root.addEventListener("click", function (e) {
        var ph = e.target.closest("[data-cc5r-photo]");
        if (!ph) return;
        CC5.modal("Photo", '<img src="' + esc(ph.getAttribute("data-cc5r-photo")) + '" alt="Review photo" class="cc5r-lightbox">');
      });
    }

    function render(reviews, names, isShopOwner, eligible) {
      var html;
      if (opts.extrasOnly) {
        // Summary + CTA only — the caller already renders the list itself.
        html = R.summaryHtml(reviews);
      } else if (!reviews.length) {
        html = CC.states.empty({
          icon: "star",
          title: "No reviews yet",
          body: "Reviews appear here only after a completed order — they are never fabricated."
        });
      } else {
        html = R.summaryHtml(reviews) +
          '<div class="cc5r-list">' +
            reviews.map(function (rv) {
              return reviewCard(rv, { names: names, isShopOwner: isShopOwner, shopName: opts.shopName });
            }).join("") +
          "</div>";
      }

      body.innerHTML = html + ctaHtml(eligible);
      wireCta(body, eligible);
      if (!opts.extrasOnly) {
        wireRespForms(body);
        wireLightbox(body);
      }
      if (opts.onData) {
        try { opts.onData({ reviews: reviews, names: names, isShopOwner: isShopOwner, eligible: eligible }); }
        catch (e) { /* additive enhancement — never break the host page */ }
      }
    }

    load();
  };

  /**
   * Appends per-review Report buttons (and seller response forms for the
   * shop owner) to an ALREADY-RENDERED review list — e.g. the Stage 2 live
   * shop page's Reviews tab. Rows are paired by index; when the pairing is
   * ambiguous (length mismatch) it bails out safely and returns false.
   */
  R.attachPerReview = function (panel, reviews, o) {
    o = o || {};
    if (!panel || !reviews || !reviews.length || !CC5) return false;
    var arts = panel.querySelectorAll(".pg-posts > article");
    if (arts.length !== reviews.length) return false;
    for (var i = 0; i < arts.length; i++) {
      (function (art, rv) {
        if (art.querySelector("[data-cc5r-perreview]")) return;
        var foot = document.createElement("div");
        foot.setAttribute("data-cc5r-perreview", "1");
        foot.className = "cc5r-foot";
        foot.innerHTML = '<button type="button" class="cc-btn cc-btn-sm cc-btn-ghost" ' +
          'data-cc5-report-review="' + esc(rv.id) + '">' + CC.icon("warning") + " Report</button>";
        art.appendChild(foot);
        if (o.isShopOwner) {
          var form = document.createElement("form");
          form.className = "cc5r-respform";
          form.setAttribute("data-cc5r-resp", rv.id);
          form.innerHTML =
            '<label class="cc-label" for="cc5r-shop-resp-' + esc(rv.id) + '">' +
              (rv.seller_response ? "Edit your response" : "Respond as the seller") + "</label>" +
            '<textarea class="cc-textarea" id="cc5r-shop-resp-' + esc(rv.id) + '" name="seller_response" rows="2" maxlength="1000">' +
              esc(rv.seller_response || "") + "</textarea>" +
            '<div><button type="submit" class="cc-btn cc-btn-sm cc-btn-secondary">Save response</button></div>' +
            '<div data-cc5r-resp-err></div>';
          art.appendChild(form);
        }
      })(arts[i], reviews[i]);
    }
    CC5.bindActions(panel);
    /* Response saves re-render the host page's own review list. */
    if (!panel._cc5rRespBound) {
      panel._cc5rRespBound = true;
      panel.addEventListener("submit", function (e) {
        var form = e.target.closest("[data-cc5r-resp]");
        if (!form) return;
        e.preventDefault();
        var id = form.getAttribute("data-cc5r-resp");
        var errBox = form.querySelector("[data-cc5r-resp-err]");
        errBox.innerHTML = "";
        var btn = form.querySelector('[type="submit"]');
        btn.disabled = true;
        CC.sb.from("cc_reviews").update({ seller_response: form.elements.seller_response.value.trim() || null })
          .eq("id", id).then(function (r) {
            if (r.error) throw r.error;
            CC5.toast("Response saved.");
            window.setTimeout(function () { window.location.reload(); }, 900);
          }).catch(function (err) {
            btn.disabled = false;
            errBox.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' +
              esc((err && err.message) || "Could not save the response.") + "</div>";
          });
      });
    }
    return true;
  };

})();
