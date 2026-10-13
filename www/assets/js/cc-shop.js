/* ==========================================================================
   CraveCorner — Stage 2 live storefront logic (cc-shop.js)
   --------------------------------------------------------------------------
   Used by shop.html when CC.live is true. Public reads go through the
   cc_shops_public materialized view (never private_address); owners preview
   their own draft via the cc_shops owner-read policy.

   CC.ShopPage.boot(rootEl, mountEl):
     - resolves ?id= (uuid) or ?slug= against cc_shops_public
       (falls back to the owner's own cc_shops row for drafts/pending)
     - bumps the view counter via the cc_bump_shop_view RPC
     - renders cover/logo/name/location/description/categories/fulfillment/
       hours + Follow / Message / Report actions
     - tabs: Menu (menu sections), Posts, Reviews (real only), About
   ========================================================================== */
(function () {
  'use strict';

  var SP = (window.CC = window.CC || {});
  var ShopPage = (SP.ShopPage = SP.ShopPage || {});
  var CC, Auth, esc;

  function hydrateIcons(scope) {
    var slots = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < slots.length; i++) {
      (function (el) {
        var tmp = document.createElement('span');
        tmp.innerHTML = CC.icon(el.getAttribute('data-icon'));
        if (tmp.firstChild) el.parentNode.replaceChild(tmp.firstChild, el);
      })(slots[i]);
    }
  }

  function isUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
  }

  /* Public shop read. Owners also get their own full row (draft preview)
     — the private_address column is NEVER rendered. */
  function loadShop(key) {
    var byId = isUuid(key);
    var q = CC.sb.from('cc_shops_public').select('*');
    q = byId ? q.eq('id', key) : q.eq('slug', key);
    return q.limit(1).then(function (r) {
      if (r.error) throw r.error;
      if (r.data && r.data[0]) return { shop: r.data[0], isOwner: false };
      /* Not public — maybe the owner's own draft/pending shop. */
      if (!CC.user) return { shop: null, isOwner: false };
      var q2 = CC.sb.from('cc_shops').select('*');
      q2 = byId ? q2.eq('id', key) : q2.eq('slug', key);
      return q2.limit(1).then(function (r2) {
        if (r2.error) throw r2.error;
        return { shop: (r2.data && r2.data[0]) || null, isOwner: !!(r2.data && r2.data[0]) };
      });
    });
  }

  function loadProducts(shopId) {
    return CC.sb.from('cc_products')
      .select('id, name, description, price_cents, portion, status, category_id, cc_categories(name)')
      .eq('shop_id', shopId).in('status', ['active', 'paused', 'sold_out'])
      .order('created_at')
      .then(function (r) {
        if (r.error) throw r.error;
        var ids = (r.data || []).map(function (p) { return p.id; });
        if (!ids.length) return { products: r.data || [], covers: {}, sections: [] };
        return CC.sb.from('cc_product_images').select('product_id, storage_path, ai_generated')
          .in('product_id', ids).eq('is_cover', true)
          .then(function (ri) {
            var covers = {};
            (ri.data || []).forEach(function (img) {
              if (!covers[img.product_id]) covers[img.product_id] = img;
            });
            return CC.sb.from('cc_menu_sections').select('id, name')
              .eq('shop_id', shopId).order('position')
              .then(function (rs) {
                if (rs.error) return { products: r.data, covers: covers, sections: [] };
                return CC.sb.from('cc_product_sections').select('product_id, section_id')
                  .in('product_id', ids)
                  .then(function (rl) {
                    return { products: r.data, covers: covers, sections: rs.data || [], links: rl.data || [] };
                  });
              });
          });
      });
  }

  function loadPosts(shopId) {
    return CC.sb.from('cc_posts').select('id, kind, body, photos, like_count, created_at')
      .eq('shop_id', shopId).order('created_at', { ascending: false }).limit(20)
      .then(function (r) { return r.error ? [] : (r.data || []); });
  }

  function loadReviews(shopId) {
    return CC.sb.from('cc_reviews')
      .select('id, stars, body, photos, seller_response, created_at, reviewer_id')
      .eq('shop_id', shopId).eq('status', 'published')
      .order('created_at', { ascending: false }).limit(20)
      .then(function (r) { return r.error ? [] : (r.data || []); });
  }

  function loadFollowState(shopId) {
    if (!CC.user) return Promise.resolve(false);
    return CC.sb.from('cc_follows').select('shop_id')
      .eq('follower_id', CC.user.id).eq('shop_id', shopId).limit(1)
      .then(function (r) { return !r.error && r.data && r.data.length > 0; });
  }

  function loadFollowerCount(shopId) {
    return CC.sb.from('cc_follows').select('shop_id', { count: 'exact', head: true })
      .eq('shop_id', shopId)
      .then(function (r) { return r.error ? 0 : (r.count || 0); });
  }

  function fmtHours(hours, tzLabel) {
    var parts = [];
    (Auth.DAYS || []).forEach(function (day) {
      var he = (hours || {})[day.v];
      if (he) parts.push(day.label + ' ' + he.open + '–' + he.close);
    });
    var s = parts.length ? parts.join(' · ') : 'Hours not listed';
    if (tzLabel) s += ' (' + tzLabel + ')';
    return s;
  }

  function tzLabel(tz) {
    var found = (Auth.US_TIMEZONES || []).filter(function (t) { return t.value === tz; })[0];
    return found ? found.label : (tz || '');
  }

  function starsHtml(n) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<span aria-hidden="true" style="color:' + (i <= n ? 'var(--cc-mango)' : 'var(--cc-border)') + ';">' + CC.icon('star') + '</span>';
    }
    return '<span role="img" aria-label="' + n + ' out of 5 stars" style="display:inline-flex; gap:2px;">' + out + '</span>';
  }

  function productCardLive(p, covers) {
    var cover = covers[p.id];
    var img = cover ? CC.imgUrl('cc-product-images', cover.storage_path) : 'assets/img/placeholder-food.jpg';
    var statusChip = p.status === 'active' ? '' :
      ' <span class="cc-badge">' + esc(Auth.PRODUCT_STATUS_LABELS[p.status] || p.status) + '</span>';
    return '<a class="cc-product-card" href="product.html?id=' + encodeURIComponent(p.id) + '">' +
      '<div class="cc-product-media"><img src="' + esc(img) + '" alt="' + esc(p.name) + '" loading="lazy">' +
      (cover && cover.ai_generated ? '<span class="cc-badge cc-badge-warn" style="position:absolute;top:8px;right:8px;">AI image</span>' : '') + '</div>' +
      '<div class="cc-product-body">' +
      '<p class="cc-product-title">' + esc(p.name) + statusChip + '</p>' +
      (p.cc_categories ? '<p class="cc-caption">' + esc(p.cc_categories.name) + '</p>' : '') +
      '<p class="cc-price">' + esc(CC.centsToPrice(p.price_cents)) + (p.portion ? ' <span class="cc-caption">' + esc(p.portion) + '</span>' : '') + '</p>' +
      '</div></a>';
  }

  ShopPage.boot = function (rootEl) {
    CC = window.CC; Auth = CC.Auth; esc = Auth.escapeHtml;
    var params = new URLSearchParams(window.location.search);
    var key = params.get('id') || params.get('slug');

    function notFound() {
      rootEl.innerHTML = '<div class="cc-section">' +
        CC.states.empty({ icon: 'warning', title: 'Shop not found', body: 'This shop does not exist or is not published yet.', actionLabel: 'Explore all food', actionHref: 'explore.html' }) +
        '</div>';
      hydrateIcons(rootEl);
    }

    if (!key) { notFound(); return; }

    rootEl.innerHTML = '<div class="cc-section">' + CC.states.skeletonCards(3) + '</div>';

    loadShop(key).then(function (res) {
      if (!res.shop) { notFound(); return; }
      var shop = res.shop;
      var isOwner = res.isOwner;
      document.title = shop.name + ' — CraveCorner';

      /* View counter — fire and forget via the RPC (the only allowed way). */
      if (!isOwner && shop.status === 'published') {
        CC.sb.rpc('cc_bump_shop_view', { sid: shop.id }).then(function () {}, function () {});
      }

      return Promise.all([
        loadProducts(shop.id), loadPosts(shop.id), loadReviews(shop.id),
        loadFollowState(shop.id), loadFollowerCount(shop.id)
      ]).then(function (all) {
        renderShop(rootEl, shop, isOwner, all[0], all[1], all[2], all[3], all[4]);
      });
    }).catch(function (err) {
      rootEl.innerHTML = '<div class="cc-section">' + CC.states.error({ body: (err && err.message) || '' }) + '</div>';
      hydrateIcons(rootEl);
    });
  };

  function renderShop(rootEl, shop, isOwner, prodData, posts, reviews, following, followerCount) {
    var accent = shop.accent_color || '#F45B83';
    var logoUrl = shop.logo_url ? CC.imgUrl('cc-shop-images', shop.logo_url) : null;
    var bannerUrl = shop.banner_url ? CC.imgUrl('cc-shop-images', shop.banner_url) : null;
    var ff = [];
    if (shop.fulfillment_pickup) ff.push('Pickup');
    if (shop.fulfillment_delivery) ff.push('Delivery');
    if (shop.fulfillment_shipping) ff.push('Shipping');
    var catNames = {};
    (prodData.products || []).forEach(function (p) {
      if (p.cc_categories && p.cc_categories.name) catNames[p.cc_categories.name] = true;
    });
    var chips = Object.keys(catNames).map(function (n) {
      return '<span class="ccx-chip">' + esc(n) + '</span>';
    }).join('');
    var statusBanner = '';
    if (isOwner && shop.status !== 'published') {
      var label = Auth.SHOP_STATUS_LABELS[shop.status] || shop.status;
      statusBanner = '<div class="cc-alert cc-alert-info" role="status" style="margin-bottom:var(--cc-space-4);">' + CC.icon('store') +
        '<div><strong>Owner preview</strong> — your shop is "' + esc(label) + '" and not visible to the public yet.</div></div>';
    }
    if (shop.vacation_mode) {
      statusBanner += '<div class="cc-alert cc-alert-warn" role="status" style="margin-bottom:var(--cc-space-4);">' + CC.icon('calendar') +
        '<div><strong>On a break</strong>' + (shop.vacation_until ? ' — back after ' + esc(shop.vacation_until) : '') + '.</div></div>';
    }

    rootEl.innerHTML = '<div class="cc-section">' + statusBanner +
      '<article class="pg-shop" style="border-top: 6px solid ' + esc(accent) + ';">' +
      '<div class="pg-shop-cover">' +
      (bannerUrl ? '<img src="' + esc(bannerUrl) + '" alt="">'
                 : '<div style="width:100%;height:100%;background:linear-gradient(135deg,var(--cc-pink-50),var(--cc-mango-100, #FFF3D6));"></div>') +
      '</div>' +
      '<div class="pg-shop-body">' +
      '<div class="pg-shop-top">' +
      '<div style="display:flex; gap:var(--cc-space-3); align-items:center;">' +
      (logoUrl ? '<img src="' + esc(logoUrl) + '" alt="' + esc(shop.name) + ' logo" style="width:64px;height:64px;border-radius:var(--cc-radius-md);object-fit:cover;">' : '') +
      '<div><h1>' + esc(shop.name) + '</h1>' +
      '<p class="cc-muted">' + esc([shop.city, shop.state].filter(Boolean).join(', ')) +
      (followerCount ? ' · ' + followerCount + ' follower' + (followerCount === 1 ? '' : 's') : '') + '</p></div>' +
      '</div></div>' +
      (shop.description ? '<p class="pg-shop-blurb">' + esc(shop.description) + '</p>' : '') +
      (chips ? '<div class="ccx-chips">' + chips + '</div>' : '') +
      '<div class="pg-shop-actions">' +
      '<button type="button" class="cc-btn ' + (following ? 'cc-btn-secondary' : 'cc-btn-primary') + '" id="sp-follow" aria-pressed="' + following + '">' +
      (following ? 'Following' : 'Follow') + '</button>' +
      '<button type="button" class="cc-btn cc-btn-outline" id="sp-message">' + CC.icon('message') + ' Message</button>' +
      (isOwner
        ? '<a class="cc-btn cc-btn-outline" href="dashboard.html">' + CC.icon('settings') + ' Manage</a>'
        : '<button type="button" class="cc-btn cc-btn-ghost" id="sp-report">Report shop</button>') +
      '</div></div></article>' +
      '<div class="pg-tabs" role="tablist" aria-label="Shop sections">' +
      '<button type="button" class="pg-tab" role="tab" aria-selected="true" data-tab="menu">Menu</button>' +
      '<button type="button" class="pg-tab" role="tab" aria-selected="false" data-tab="posts">Posts</button>' +
      '<button type="button" class="pg-tab" role="tab" aria-selected="false" data-tab="reviews">Reviews</button>' +
      '<button type="button" class="pg-tab" role="tab" aria-selected="false" data-tab="about">About</button>' +
      '</div>' +
      '<div id="sp-panel" role="tabpanel" aria-live="polite"></div>' +
      '</div>';

    hydrateIcons(rootEl);

    var panel = document.getElementById('sp-panel');
    var tabs = rootEl.querySelectorAll('.pg-tab');

    function renderTab(which) {
      var html = '';
      if (which === 'menu') {
        html = renderMenu(shop, prodData);
      } else if (which === 'posts') {
        html = posts.length
          ? '<div class="pg-posts">' + posts.map(renderPostLive).join('') + '</div>'
          : CC.states.empty({ icon: 'message', title: 'No posts yet', body: 'This shop has not shared any updates yet.' });
      } else if (which === 'reviews') {
        html = reviews.length
          ? '<div class="pg-posts">' + reviews.map(renderReviewLive).join('') + '</div>'
          : CC.states.empty({
              icon: 'star', title: 'No reviews yet',
              body: 'Reviews only come from completed orders — and they are never fabricated.'
            });
      } else {
        html = renderAbout(shop, ff, prodData);
      }
      panel.innerHTML = html;
      hydrateIcons(panel);
    }

    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener('click', function () {
        for (var k = 0; k < tabs.length; k++) tabs[k].setAttribute('aria-selected', 'false');
        this.setAttribute('aria-selected', 'true');
        renderTab(this.getAttribute('data-tab'));
      });
    }

    /* --- Follow --- */
    document.getElementById('sp-follow').addEventListener('click', function () {
      var btn = this;
      if (!CC.user) { window.location.href = 'auth.html?next=' + encodeURIComponent('shop.html?slug=' + shop.slug); return; }
      btn.disabled = true;
      var isFollowing = btn.getAttribute('aria-pressed') === 'true';
      var op = isFollowing
        ? CC.sb.from('cc_follows').delete().eq('follower_id', CC.user.id).eq('shop_id', shop.id)
        : CC.sb.from('cc_follows').insert({ follower_id: CC.user.id, shop_id: shop.id });
      op.then(function (r) {
        if (r.error) throw r.error;
        btn.setAttribute('aria-pressed', String(!isFollowing));
        btn.textContent = isFollowing ? 'Follow' : 'Following';
        btn.className = 'cc-btn ' + (isFollowing ? 'cc-btn-primary' : 'cc-btn-secondary');
      }).catch(function (err) {
        CC.honestModal('Could not update follow', '<p>' + esc(err.message) + '</p>');
      }).then(function () { btn.disabled = false; });
    });

    /* --- Message: find-or-create the buyer/shop thread, then open the inbox. --- */
    document.getElementById('sp-message').addEventListener('click', function () {
      var btn = this;
      if (!CC.user) { window.location.href = 'auth.html?next=' + encodeURIComponent('shop.html?slug=' + shop.slug); return; }
      if (CC.user.id === shop.user_id) {
        CC.honestModal('This is your shop', '<p>You can\u2019t message your own shop. Your customer messages live in the inbox.</p>');
        return;
      }
      btn.disabled = true;
      CC.sb.from('cc_conversations').select('id')
        .eq('shop_id', shop.id).eq('buyer_id', CC.user.id).is('order_request_id', null).limit(1)
        .then(function (r) {
          if (r.error) throw r.error;
          if (r.data && r.data[0]) return r.data[0].id;
          return CC.sb.from('cc_conversations').insert({
            shop_id: shop.id, buyer_id: CC.user.id, seller_id: shop.user_id
          }).select().single().then(function (r2) {
            if (r2.error) throw r2.error;
            return r2.data.id;
          });
        })
        .then(function (convoId) { window.location.href = 'inbox.html?conv=' + encodeURIComponent(convoId); })
        .catch(function (err) {
          btn.disabled = false;
          CC.honestModal('Could not start the conversation', '<p>' + esc(err.message) + '</p>');
        });
    });

    /* --- Report --- */
    var reportBtn = document.getElementById('sp-report');
    if (reportBtn) reportBtn.addEventListener('click', function () { openReportDialog(shop); });

    renderTab('menu');
  }

  function renderMenu(shop, prodData) {
    var products = prodData.products || [];
    if (!products.length) {
      return CC.states.empty({ icon: 'shopping-bag', title: 'No menu items yet', body: 'This shop has not listed any food yet.', actionLabel: 'Explore all food', actionHref: 'explore.html' });
    }
    var bySection = {};
    var unsectioned = [];
    (prodData.links || []).forEach(function (l) {
      (bySection[l.section_id] = bySection[l.section_id] || []).push(l.product_id);
    });
    products.forEach(function (p) {
      var placed = false;
      Object.keys(bySection).forEach(function (sid) {
        if (bySection[sid].indexOf(p.id) !== -1) placed = true;
      });
      if (!placed) unsectioned.push(p);
    });
    var html = '';
    (prodData.sections || []).forEach(function (sec) {
      var ids = bySection[sec.id] || [];
      var items = products.filter(function (p) { return ids.indexOf(p.id) !== -1; });
      if (!items.length) return;
      html += '<h2 class="cc-h2" style="margin-top: var(--cc-space-5);">' + esc(sec.name) + '</h2>' +
        '<div class="cc-grid-products">' + items.map(function (p) { return productCardLive(p, prodData.covers); }).join('') + '</div>';
    });
    if (unsectioned.length) {
      html += ((prodData.sections || []).length ? '<h2 class="cc-h2" style="margin-top: var(--cc-space-5);">More from this shop</h2>' : '') +
        '<div class="cc-grid-products">' + unsectioned.map(function (p) { return productCardLive(p, prodData.covers); }).join('') + '</div>';
    }
    return html || CC.states.empty({ icon: 'shopping-bag', title: 'No menu items yet', body: 'This shop has not listed any food yet.' });
  }

  function renderPostLive(post) {
    var photos = (post.photos || []).map(function (ph) {
      return '<img src="' + esc(CC.imgUrl('cc-post-images', ph)) + '" alt="" loading="lazy" style="width:100%;border-radius:var(--cc-radius-md);margin-top:var(--cc-space-2);">';
    }).join('');
    return '<article class="cc-post-card"><div class="cc-post-body">' +
      '<p>' + esc(post.body || '') + '</p>' + photos +
      '<p class="cc-caption" style="margin-top:var(--cc-space-2);">' +
      esc(new Date(post.created_at).toLocaleDateString()) +
      (post.like_count ? ' · ' + post.like_count + ' like' + (post.like_count === 1 ? '' : 's') : '') + '</p>' +
      '</div></article>';
  }

  function renderReviewLive(rev) {
    var photos = (rev.photos || []).map(function (ph) {
      return '<img src="' + esc(CC.imgUrl('cc-review-images', ph)) + '" alt="Review photo" loading="lazy" style="width:72px;height:72px;object-fit:cover;border-radius:var(--cc-radius-md);">';
    }).join('');
    return '<article class="cc-post-card"><div class="cc-post-body">' +
      starsHtml(rev.stars) +
      (rev.body ? '<p style="margin-top:var(--cc-space-2);">' + esc(rev.body) + '</p>' : '') +
      (photos ? '<div style="display:flex;gap:var(--cc-space-2);margin-top:var(--cc-space-2);">' + photos + '</div>' : '') +
      '<p class="cc-caption" style="margin-top:var(--cc-space-2);">' + esc(new Date(rev.created_at).toLocaleDateString()) +
      ' · Verified order review</p>' +
      (rev.seller_response ? '<div style="margin-top:var(--cc-space-3); padding:var(--cc-space-3); background:var(--cc-pink-50); border-radius:var(--cc-radius-md);">' +
        '<p class="cc-small"><strong>Response from the seller:</strong></p><p class="cc-small">' + esc(rev.seller_response) + '</p></div>' : '') +
      '</div></article>';
  }

  function renderAbout(shop, ff, prodData) {
    var fulfillItems = ff.map(function (f) {
      return '<li><span data-icon="check"></span>' + esc(f) + '</li>';
    }).join('') || '<li class="cc-muted">Not listed</li>';
    return '<div class="cc-card pg-about">' +
      '<h2>About ' + esc(shop.name) + '</h2>' +
      (shop.description ? '<p>' + esc(shop.description) + '</p>' : '') +
      '<h3>Fulfillment</h3><ul class="pg-about-list">' + fulfillItems + '</ul>' +
      (shop.service_area ? '<h3>Service area</h3><p>' + esc(shop.service_area) + '</p>' : '') +
      '<h3>Hours</h3><p>' + esc(fmtHours(shop.hours, tzLabel(shop.timezone))) + '</p>' +
      '<h3>Location</h3><p class="cc-muted">' + esc([shop.city, shop.state].filter(Boolean).join(', ') || 'Not listed') + ' (general area only)</p>' +
      '<p class="cc-small cc-muted">CraveCorner never shows a seller\u2019s private residential address.</p>' +
      '<p class="cc-small cc-muted">Payments are arranged directly with the seller — CraveCorner has no checkout.</p>' +
      '</div>';
  }

  var REPORT_REASONS = [
    'Spam or scam', 'Inaccurate listing', 'Food safety concern',
    'Prohibited item', 'Harassment or abuse', 'Something else'
  ];

  function openReportDialog(shop) {
    if (!CC.user) { window.location.href = 'auth.html?next=' + encodeURIComponent('shop.html?slug=' + shop.slug); return; }
    var body = '<form id="sp-report-form">' +
      '<div class="cc-field"><label class="cc-label" for="sp-rep-reason">Reason</label>' +
      '<select class="cc-select" id="sp-rep-reason">' +
      REPORT_REASONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="cc-field"><label class="cc-label" for="sp-rep-details">Details <span class="cc-caption">(optional)</span></label>' +
      '<textarea class="cc-textarea" id="sp-rep-details" maxlength="1000" style="min-height:90px;" placeholder="What did you notice?"></textarea></div>' +
      '<p class="cc-small cc-muted">Reports go to CraveCorner admins for review. False reports may affect your account.</p>' +
      '</form>';
    CC.honestModal('Report this shop', body);
    /* honestModal renders into the shared modal; attach submit via a footer button swap */
    var modal = document.querySelector('.cc-modal');
    if (!modal) return;
    var actions = modal.querySelector('.cc-modal-actions') || modal;
    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'cc-btn cc-btn-primary';
    submit.textContent = 'Send report';
    submit.addEventListener('click', function () {
      submit.disabled = true;
      var reason = document.getElementById('sp-rep-reason').value;
      var details = document.getElementById('sp-rep-details').value.trim();
      CC.sb.from('cc_reports').insert({
        reporter_id: CC.user.id, target_type: 'shop', target_id: shop.id,
        reason: reason, details: details || null
      }).then(function (r) {
        if (r.error) throw r.error;
        CC.closeModal();
        CC.honestModal('Report sent', '<p>Thanks — a CraveCorner admin will review this shop.</p>');
      }).catch(function (err) {
        submit.disabled = false;
        CC.honestModal('Could not send the report', '<p>' + esc(err.message) + '</p>');
      });
    });
    actions.appendChild(submit);
  }
})();
