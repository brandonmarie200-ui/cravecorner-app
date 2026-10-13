/* ==========================================================================
   CraveCorner — Stage 2 seller onboarding wizard (cc-onboarding.js)
   --------------------------------------------------------------------------
   6-step wizard: Shop Identity → Location → Fulfillment & Hours →
   Business Info → First Product → Preview & Publish.

   Data contract (exact Supabase columns — see sql/SCHEMA.md):
     cc_shops: name, slug, description, logo_url, banner_url, accent_color,
       city, state, service_area, private_address, fulfillment_pickup,
       fulfillment_delivery, fulfillment_shipping, hours (jsonb),
       timezone, vacation_mode, vacation_until, status (draft/pending/…)
     cc_shop_verification: shop_id, doc_type, doc_url, declarations (jsonb)
     cc_products / cc_product_images / cc_product_options /
       cc_menu_sections / cc_product_sections
     Storage: cc-shop-images (logo/banner/docs), cc-product-images (photos)
       — upload paths are always <auth-uid>/… (RLS requirement).

   Sellers may only move a shop draft <-> pending; only an admin can publish
   (DB trigger raises otherwise). So "Publish" here = submit for review.

   Honest-data notes:
   - The schema has no shop<->categories link table and no payment-methods /
     fulfillment-notes column on cc_shops. The wizard's primary category is
     applied to the seller's first product (cc_products.category_id); shop
     category chips are derived from the shop's products. Payment methods and
     fulfillment notes are collected and kept in the seller's draft (and shown
     in the Step-6 preview labeled as draft) until the schema gains columns.
   - All food-safety declarations are labeled self-declared; CraveCorner
     never claims to have verified compliance.
   ========================================================================== */
(function () {
  'use strict';

  var OB = (window.CC = window.CC || {});
  var Onboarding = (OB.Onboarding = OB.Onboarding || {});
  var CC, Auth, esc;

  var STEP_LABELS = [
    'Shop identity', 'Location', 'Fulfillment & hours',
    'Business info', 'First product', 'Preview & publish'
  ];

  var state = {
    root: null, shop: null, categories: [], sections: [],
    draft: null, uid: null, productImages: []
  };

  function D() { return state.draft; }

  /* ------------------------------------------------------------------ */
  /* Draft (localStorage, per user — never shared, never public)         */
  /* ------------------------------------------------------------------ */
  function draftKey() { return 'cc_onboarding_draft_' + state.uid; }

  function blankDraft() {
    return {
      step: 1, done: {}, shopId: null,
      s1: { name: '', slug: '', slugTouched: false, description: '', logoPath: '', bannerPath: '', categoryId: '', accentColor: '#F45B83' },
      s2: { city: '', state: '', service_area: '', private_address: '', fulfill_notes: '' },
      s3: { pickup: true, delivery: false, shipping: false, shipping_legal: false, hours: {}, vacation_mode: false, vacation_until: '', timezone: 'America/Chicago' },
      s4: { declarations: {}, payment_methods: '', docs: [] },
      s5: { productId: null, name: '', price: '', description: '', categoryId: '', portion: '', ingredients: '', allergens: '', prep_time: '', lead_time_days: '0', fulfillment: null, photos: [], options: [], sectionIds: [], newSection: '' }
    };
  }

  function saveDraft() {
    try { localStorage.setItem(draftKey(), JSON.stringify(state.draft)); } catch (e) {}
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(draftKey());
      if (raw) {
        var d = JSON.parse(raw);
        var b = blankDraft();
        Object.keys(b).forEach(function (k) { if (d[k] !== undefined) b[k] = d[k]; });
        return b;
      }
    } catch (e) {}
    return blankDraft();
  }

  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) {} }

  /* ------------------------------------------------------------------ */
  /* Small DOM helpers                                                   */
  /* ------------------------------------------------------------------ */
  function h(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

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

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }

  function fieldErrorHtml(msg) {
    return '<p class="cc-error-text" role="alert">' + CC.icon('warning') + '<span>' + esc(msg) + '</span></p>';
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  Onboarding.boot = function (rootEl) {
    CC = window.CC; Auth = CC.Auth; esc = Auth.escapeHtml;
    state.root = rootEl;

    CC.ready.then(function (r) {
      if (!r.live) { renderNotLive(); return; }
      if (!r.user) {
        window.location.replace('auth.html?next=' + encodeURIComponent('onboarding.html'));
        return;
      }
      state.uid = r.user.id;
      state.draft = loadDraft();
      return Auth.loadCategories().then(function (cats) {
        state.categories = cats;
        return Auth.getMyShop();
      }).then(function (shop) {
        state.shop = shop;
        if (shop) {
          state.draft.shopId = shop.id;
          prefillFromShop(shop);
          return loadShopExtras(shop);
        }
        return null;
      }).then(function () {
        if (state.shop && state.shop.status === 'published') { renderPublished(); return; }
        if (state.shop && state.shop.status === 'suspended') { renderSuspended(); return; }
        render();
      }).catch(function (err) {
        state.root.innerHTML = '<div class="cc-card">' + CC.states.error({ body: (err && err.message) || '' }) + '</div>';
        hydrateIcons(state.root);
      });
    });
  };

  function renderNotLive() {
    state.root.innerHTML = '<div class="cc-card"><div class="cc-empty">' +
      '<div class="cc-empty-art">' + CC.icon('store') + '</div>' +
      '<p class="cc-eyebrow">Seller onboarding isn\u2019t open yet</p>' +
      '<p class="cc-empty-title">Shops launch with the backend</p>' +
      '<p class="cc-empty-text">CraveCorner\u2019s database isn\u2019t connected yet, so seller onboarding can\u2019t run right now. ' +
      'When it launches it\u2019s a guided 6-step setup: shop identity, location, fulfillment &amp; hours, business info, your first product, then preview &amp; publish.</p>' +
      '<div class="cc-empty-actions"><a class="cc-btn cc-btn-secondary" href="create.html">How selling will work</a></div>' +
      '</div></div>';
    hydrateIcons(state.root);
  }

  function renderPublished() {
    var s = state.shop;
    state.root.innerHTML =
      '<p class="cc-eyebrow">Seller onboarding</p><h1 class="cc-h1">Your shop is live</h1>' +
      '<div class="cc-card"><div class="cc-empty">' +
      '<div class="cc-empty-art">' + CC.icon('check') + '</div>' +
      '<p class="cc-empty-title">' + esc(s.name) + ' is published</p>' +
      '<p class="cc-empty-text">Your storefront is on the marketplace. Manage it from your dashboard.</p>' +
      '<div class="cc-empty-actions">' +
      '<a class="cc-btn cc-btn-primary" href="dashboard.html">Open dashboard</a>' +
      '<a class="cc-btn cc-btn-outline" href="shop.html?slug=' + esc(s.slug) + '">View storefront</a>' +
      '<button type="button" class="cc-btn cc-btn-ghost" id="ob-edit">Edit shop info</button>' +
      '</div></div></div>';
    hydrateIcons(state.root);
    document.getElementById('ob-edit').addEventListener('click', function () {
      state.draft.step = 1; saveDraft(); render();
    });
  }

  function renderSuspended() {
    state.root.innerHTML = '<div class="cc-card"><div class="cc-empty">' +
      '<div class="cc-empty-art">' + CC.icon('shield') + '</div>' +
      '<p class="cc-empty-title">This shop is suspended</p>' +
      '<p class="cc-empty-text">Your shop was suspended by a CraveCorner admin. Contact support if you think this is a mistake.</p>' +
      '<div class="cc-empty-actions"><a class="cc-btn cc-btn-secondary" href="contact.html">Contact support</a></div>' +
      '</div></div>';
    hydrateIcons(state.root);
  }

  /* Prefill the draft from the existing shop row (edit / resume). */
  function prefillFromShop(shop) {
    var d = state.draft, s1 = d.s1, s2 = d.s2, s3 = d.s3;
    if (!d._prefilled) {
      s1.name = shop.name || ''; s1.slug = shop.slug || ''; s1.slugTouched = true;
      s1.description = shop.description || ''; s1.logoPath = shop.logo_url || '';
      s1.bannerPath = shop.banner_url || ''; s1.accentColor = shop.accent_color || '#F45B83';
      s2.city = shop.city || ''; s2.state = shop.state || '';
      s2.service_area = shop.service_area || ''; s2.private_address = shop.private_address || '';
      s3.pickup = !!shop.fulfillment_pickup; s3.delivery = !!shop.fulfillment_delivery;
      s3.shipping = !!shop.fulfillment_shipping;
      s3.hours = shop.hours || {}; s3.timezone = shop.timezone || 'America/Chicago';
      s3.vacation_mode = !!shop.vacation_mode; s3.vacation_until = shop.vacation_until || '';
      d._prefilled = true;
      saveDraft();
    }
  }

  function loadShopExtras(shop) {
    /* verification declarations + docs, menu sections, existing products */
    return CC.sb.from('cc_shop_verification').select('*').eq('shop_id', shop.id)
      .then(function (r) {
        if (!r.error && r.data) {
          r.data.forEach(function (v) {
            if (v.doc_type === 'self-declarations' && v.declarations) {
              Object.keys(v.declarations).forEach(function (k) {
                state.draft.s4.declarations[k] = !!v.declarations[k];
              });
            } else if (v.doc_url) {
              var exists = state.draft.s4.docs.some(function (x) { return x.path === v.doc_url; });
              if (!exists) state.draft.s4.docs.push({ doc_type: v.doc_type, path: v.doc_url, name: v.doc_type, id: v.id });
            }
          });
        }
        return CC.sb.from('cc_menu_sections').select('*').eq('shop_id', shop.id).order('position');
      })
      .then(function (r2) {
        if (!r2.error) state.sections = r2.data || [];
        return CC.sb.from('cc_products').select('id').eq('shop_id', shop.id).order('created_at').limit(1);
      })
      .then(function (r3) {
        if (!r3.error && r3.data && r3.data[0] && !state.draft.s5.productId) {
          state.draft.s5.productId = r3.data[0].id;
        }
        saveDraft();
      });
  }

  /* ------------------------------------------------------------------ */
  /* Shell: progress indicator + step panel + nav                        */
  /* ------------------------------------------------------------------ */
  function render() {
    var d = D();
    var step = Math.min(6, Math.max(1, d.step));
    /* A draft can point past step 1 while no shop row exists (e.g. a stale
       draft from an interrupted session). Steps 2-6 all need the shop —
       without it renderStep5 crashes on state.shop.id. Reset to step 1. */
    if (!state.shop && step > 1) {
      d.step = 1; d.done = {}; saveDraft(); step = 1;
    }

    var stepsHtml = STEP_LABELS.map(function (label, i) {
      var n = i + 1;
      var done = !!d.done[n];
      var current = n === step;
      return '<li><button type="button" class="ob-step-btn" data-goto="' + n + '"' +
        (current ? ' aria-current="step"' : '') + ' data-done="' + done + '"' +
        ' aria-label="Step ' + n + ': ' + esc(label) + (done ? ' (completed)' : '') + '">' +
        '<span class="ob-dot">' + (done ? CC.icon('check') : n) + '</span>' +
        '<span class="ob-step-label">' + esc(label) + '</span></button></li>';
    }).join('');

    state.root.innerHTML =
      '<p class="cc-eyebrow">Seller onboarding</p>' +
      '<h1 class="cc-h1">Open your shop</h1>' +
      (state.shop && state.shop.status === 'rejected'
        ? '<div class="cc-alert cc-alert-warn" role="alert">' + CC.icon('warning') +
          '<div><strong>Needs corrections.</strong><br>' + esc(state.shop.rejection_reason || 'An admin asked for changes before your shop can go live.') + '</div></div>'
        : '') +
      '<div class="ob-bar" aria-hidden="true"><div class="ob-bar-fill" style="width:' + Math.round(step / 6 * 100) + '%"></div></div>' +
      '<ol class="ob-steps">' + stepsHtml + '</ol>' +
      '<div class="cc-card" id="ob-panel" aria-live="polite"></div>' +
      '<div class="ob-nav">' +
      (step > 1 ? '<button type="button" class="cc-btn cc-btn-outline" id="ob-back">Back</button>' : '') +
      '<button type="button" class="cc-btn cc-btn-primary" id="ob-next">' + (step === 6 ? 'Finish' : 'Save &amp; continue') + '</button>' +
      '</div>' +
      '<p style="text-align:center; margin-top: var(--cc-space-4);"><button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" id="ob-exit">Save draft &amp; exit</button></p>';

    hydrateIcons(state.root);

    var panel = document.getElementById('ob-panel');
    [renderStep1, renderStep2, renderStep3, renderStep4, renderStep5, renderStep6][step - 1](panel);

    var goBtns = state.root.querySelectorAll('[data-goto]');
    for (var g = 0; g < goBtns.length; g++) {
      goBtns[g].addEventListener('click', function () {
        collectStep(step);
        state.draft.step = parseInt(this.getAttribute('data-goto'), 10);
        saveDraft(); render();
        state.root.scrollIntoView({ block: 'start' });
      });
    }
    var back = document.getElementById('ob-back');
    if (back) back.addEventListener('click', function () {
      collectStep(step); state.draft.step = step - 1; saveDraft(); render();
      state.root.scrollIntoView({ block: 'start' });
    });
    document.getElementById('ob-next').addEventListener('click', function () { saveAndContinue(step); });
    document.getElementById('ob-exit').addEventListener('click', function () {
      collectStep(step); saveDraft();
      window.location.href = 'profile.html';
    });
  }

  /* Read current panel inputs back into the draft (so Back/Exit keep edits). */
  function collectStep(step) {
    var d = D();
    try {
      if (step === 1) {
        d.s1.name = val('ob-name'); d.s1.description = val('ob-desc');
        if (!d.s1.slugTouched) d.s1.slug = Auth.slugify(d.s1.name);
        else d.s1.slug = val('ob-slug');
        d.s1.categoryId = val('ob-cat'); d.s1.accentColor = val('ob-accent-hidden') || d.s1.accentColor;
      } else if (step === 2) {
        d.s2.city = val('ob-city'); d.s2.state = val('ob-state');
        d.s2.service_area = val('ob-area'); d.s2.private_address = val('ob-privaddr');
        d.s2.fulfill_notes = val('ob-fnotes');
      } else if (step === 3) {
        collectHours();
        d.s3.timezone = val('ob-tz'); d.s3.vacation_until = val('ob-vacuntil');
      } else if (step === 4) {
        d.s4.payment_methods = val('ob-paymethods');
      } else if (step === 5) {
        collectProductForm();
      }
    } catch (e) {}
    saveDraft();
  }

  function saveAndContinue(step) {
    collectStep(step);
    var savers = [saveStep1, saveStep2, saveStep3, saveStep4, saveStep5, saveStep6];
    var btn = document.getElementById('ob-next');
    btn.disabled = true; btn.textContent = 'Saving…';
    function restoreBtn() { btn.disabled = false; btn.textContent = step === 6 ? 'Finish' : 'Save & continue'; }
    savers[step - 1]().then(function (res) {
      res = res || {};
      if (res.blocked) {
        /* Validation failed: the saver already showed field errors — do NOT
           re-render (that would wipe them). Just restore the button. */
        restoreBtn();
        return;
      }
      state.draft.done[step] = true;
      if (step < 6) { state.draft.step = step + 1; }
      saveDraft();
      render();
      state.root.scrollIntoView({ block: 'start' });
    }).catch(function (err) {
      var panel = document.getElementById('ob-panel');
      var div = document.createElement('div');
      div.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert" style="margin-bottom:var(--cc-space-4);">' +
        CC.icon('warning') + '<div>' + esc((err && err.message) || 'Could not save. Please try again.') + '</div></div>';
      panel.insertBefore(div.firstChild, panel.firstChild);
      hydrateIcons(panel);
      restoreBtn();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Slug availability (public view is world-readable)                   */
  /* ------------------------------------------------------------------ */
  function ensureUniqueSlug(baseSlug) {
    var slug = baseSlug;
    function trySlug(s, attempt) {
      return CC.sb.from('cc_shops_public').select('id').eq('slug', s).limit(1)
        .then(function (r) {
          var taken = !r.error && r.data && r.data.length > 0 &&
            !(state.shop && r.data[0].id === state.shop.id);
          if (!taken) return s;
          return trySlug(baseSlug + '-' + (attempt + 1), attempt + 1);
        });
    }
    return trySlug(slug, 1);
  }

  /* ------------------------------------------------------------------ */
  /* STEP 1 — Shop identity                                              */
  /* ------------------------------------------------------------------ */
  function renderStep1(panel) {
    var s1 = D().s1;
    var catOpts = state.categories.map(function (c) {
      return '<option value="' + c.id + '"' + (s1.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
    var accents = Auth.ACCENT_COLORS.map(function (col) {
      return '<button type="button" class="ob-accent" data-accent="' + col + '" aria-pressed="' + (s1.accentColor === col) + '"' +
        ' style="background:' + col + '" aria-label="Accent color ' + col + '"></button>';
    }).join('');

    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Shop identity</h2>' +
      '<p class="cc-muted">This is how customers will recognize you on the marketplace.</p>' +
      '<div class="cc-field"><label class="cc-label" for="ob-name">Shop name <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<input class="cc-input" id="ob-name" maxlength="80" required value="' + esc(s1.name) + '" placeholder="e.g. Marisol\u2019s Kitchen">' +
      '<div data-err="ob-name"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-slug">Shop URL</label>' +
      '<div style="display:flex; align-items:center; gap:var(--cc-space-2);"><span class="cc-muted cc-small">cravecorner.shop/</span>' +
      '<input class="cc-input" id="ob-slug" maxlength="60" value="' + esc(s1.slug) + '" placeholder="marisols-kitchen" style="font-family:monospace;"></div>' +
      '<p class="cc-hint">Letters, numbers, and dashes only. Generated from your shop name unless you edit it.</p>' +
      '<div data-err="ob-slug"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-desc">Description <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<textarea class="cc-textarea" id="ob-desc" maxlength="2000" placeholder="What do you make? What makes it special?">' + esc(s1.description) + '</textarea>' +
      '<p class="cc-hint"><span id="ob-desc-count">' + s1.description.length + '</span>/2000 — aim for at least a sentence or two.</p>' +
      '<div data-err="ob-desc"></div></div>' +
      '<div class="cc-field"><span class="cc-label">Logo</span>' +
      '<div style="display:flex; gap:var(--cc-space-3); align-items:center;">' +
      '<div id="ob-logo-prev" style="width:72px;height:72px;border-radius:var(--cc-radius-md);overflow:hidden;background:var(--cc-pink-50);flex:none;display:flex;align-items:center;justify-content:center;">' +
      (s1.logoPath ? '<img src="' + esc(CC.imgUrl('cc-shop-images', s1.logoPath)) + '" alt="Shop logo" style="width:100%;height:100%;object-fit:cover;">' : CC.icon('store')) +
      '</div>' +
      '<div><label class="cc-btn cc-btn-outline cc-btn-sm" for="ob-logo" style="cursor:pointer;">' + CC.icon('upload') + ' Upload logo</label>' +
      '<input type="file" id="ob-logo" accept="image/*" class="pg-sr-only"><p class="cc-hint">Square works best. JPG/PNG/WebP, up to 8MB.</p></div>' +
      '</div><div data-err="ob-logo"></div></div>' +
      '<div class="cc-field"><span class="cc-label">Banner</span>' +
      '<div id="ob-banner-prev" style="height:96px;border-radius:var(--cc-radius-md);overflow:hidden;background:var(--cc-pink-50);display:flex;align-items:center;justify-content:center;margin-bottom:var(--cc-space-2);">' +
      (s1.bannerPath ? '<img src="' + esc(CC.imgUrl('cc-shop-images', s1.bannerPath)) + '" alt="Shop banner" style="width:100%;height:100%;object-fit:cover;">' : CC.icon('store')) +
      '</div>' +
      '<label class="cc-btn cc-btn-outline cc-btn-sm" for="ob-banner" style="cursor:pointer;">' + CC.icon('upload') + ' Upload banner</label>' +
      '<input type="file" id="ob-banner" accept="image/*" class="pg-sr-only">' +
      '<p class="cc-hint">Wide photo of your food or kitchen. JPG/PNG/WebP, up to 8MB.</p><div data-err="ob-banner"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-cat">Primary food category <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<select class="cc-select" id="ob-cat"><option value="">Choose a category…</option>' + catOpts + '</select>' +
      '<p class="cc-hint">Applied to your first product. As you add more products, your shop\u2019s categories grow from your menu.</p>' +
      '<div data-err="ob-cat"></div></div>' +
      '<div class="cc-field"><span class="cc-label" id="ob-accent-label">Accent color</span>' +
      '<input type="hidden" id="ob-accent-hidden" value="' + esc(s1.accentColor) + '">' +
      '<div class="ob-accent-row" role="group" aria-labelledby="ob-accent-label">' + accents + '</div>' +
      '<p class="cc-hint">Used sparingly on your storefront, inside the CraveCorner design system.</p></div>';

    hydrateIcons(panel);

    document.getElementById('ob-name').addEventListener('input', function () {
      if (!D().s1.slugTouched) document.getElementById('ob-slug').value = Auth.slugify(this.value);
      document.getElementById('ob-desc-count').textContent = document.getElementById('ob-desc').value.length;
    });
    document.getElementById('ob-slug').addEventListener('input', function () { D().s1.slugTouched = true; });
    document.getElementById('ob-desc').addEventListener('input', function () {
      document.getElementById('ob-desc-count').textContent = this.value.length;
    });

    var accBtns = panel.querySelectorAll('[data-accent]');
    for (var i = 0; i < accBtns.length; i++) {
      accBtns[i].addEventListener('click', function () {
        for (var k = 0; k < accBtns.length; k++) accBtns[k].setAttribute('aria-pressed', 'false');
        this.setAttribute('aria-pressed', 'true');
        document.getElementById('ob-accent-hidden').value = this.getAttribute('data-accent');
        D().s1.accentColor = this.getAttribute('data-accent');
      });
    }

    function uploadTo(inputId, errKey, folder, onPath) {
      document.getElementById(inputId).addEventListener('change', function () {
        var file = this.files && this.files[0];
        if (!file) return;
        var errBox = panel.querySelector('[data-err="' + errKey + '"]');
        errBox.innerHTML = '<p class="cc-hint">Uploading…</p>';
        Auth.uploadImage('cc-shop-images', file, folder).then(function (path) {
          errBox.innerHTML = '';
          onPath(path);
          saveDraft();
        }).catch(function (err2) {
          errBox.innerHTML = fieldErrorHtml(err2.message);
          hydrateIcons(errBox);
        });
      });
    }
    uploadTo('ob-logo', 'ob-logo', 'shop/logo', function (path) {
      D().s1.logoPath = path;
      document.getElementById('ob-logo-prev').innerHTML =
        '<img src="' + esc(CC.imgUrl('cc-shop-images', path)) + '" alt="Shop logo" style="width:100%;height:100%;object-fit:cover;">';
    });
    uploadTo('ob-banner', 'ob-banner', 'shop/banner', function (path) {
      D().s1.bannerPath = path;
      document.getElementById('ob-banner-prev').innerHTML =
        '<img src="' + esc(CC.imgUrl('cc-shop-images', path)) + '" alt="Shop banner" style="width:100%;height:100%;object-fit:cover;">';
    });
  }

  function stepErr(inputId, msg) {
    var panel = document.getElementById('ob-panel');
    var box = panel.querySelector('[data-err="' + inputId + '"]');
    if (box) { box.innerHTML = fieldErrorHtml(msg); hydrateIcons(box); }
    var input = document.getElementById(inputId);
    if (input) input.setAttribute('aria-invalid', 'true');
  }

  function saveStep1() {
    var d = D(), s1 = d.s1;
    var errs = 0;
    if (s1.name.trim().length < 2) { stepErr('ob-name', 'Give your shop a name (2+ characters).'); errs++; }
    var slug = (s1.slugTouched ? s1.slug : Auth.slugify(s1.name)).trim();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { stepErr('ob-slug', 'Use lowercase letters, numbers, and dashes only.'); errs++; }
    if (s1.description.trim().length < 10) { stepErr('ob-desc', 'Add a short description (at least 10 characters).'); errs++; }
    if (!s1.categoryId) { stepErr('ob-cat', 'Choose your primary food category.'); errs++; }
    if (errs) return Promise.resolve({ blocked: true });

    return ensureUniqueSlug(slug).then(function (finalSlug) {
      s1.slug = finalSlug;
      var row = {
        name: s1.name.trim(), slug: finalSlug, description: s1.description.trim(),
        logo_url: s1.logoPath || null, banner_url: s1.bannerPath || null,
        accent_color: s1.accentColor
      };
      if (state.shop) {
        return CC.sb.from('cc_shops').update(row).eq('id', state.shop.id).select().single()
          .then(function (r) { if (r.error) throw r.error; state.shop = r.data; });
      }
      row.user_id = state.uid;
      return CC.sb.from('cc_shops').insert(row).select().single()
        .then(function (r) {
          if (r.error) {
            /* Rare slug race: retry once with a suffix. */
            if (String(r.error.code) === '23505') {
              row.slug = finalSlug + '-' + Auth.randomId().slice(0, 4);
              return CC.sb.from('cc_shops').insert(row).select().single()
                .then(function (r2) { if (r2.error) throw r2.error; state.shop = r2.data; });
            }
            throw r.error;
          }
          state.shop = r.data;
        });
    }).then(function () {
      d.shopId = state.shop.id; saveDraft();
    });
  }

  /* ------------------------------------------------------------------ */
  /* STEP 2 — Location                                                   */
  /* ------------------------------------------------------------------ */
  function renderStep2(panel) {
    var s2 = D().s2;
    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Location</h2>' +
      '<p class="cc-muted">Customers see your <strong>general area only</strong> — never your street address.</p>' +
      '<div style="display:grid; grid-template-columns: 1fr 120px; gap: var(--cc-space-3);">' +
      '<div class="cc-field"><label class="cc-label" for="ob-city">City <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<input class="cc-input" id="ob-city" maxlength="80" value="' + esc(s2.city) + '" placeholder="Gonzales"><div data-err="ob-city"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-state">State <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<input class="cc-input" id="ob-state" maxlength="2" value="' + esc(s2.state) + '" placeholder="TX"><div data-err="ob-state"></div></div>' +
      '</div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-area">General service area</label>' +
      '<input class="cc-input" id="ob-area" maxlength="160" value="' + esc(s2.service_area) + '" placeholder="e.g. Gonzales County + 25 miles">' +
      '<p class="cc-hint">Where your food can be picked up or delivered.</p></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-fnotes">Fulfillment notes</label>' +
      '<textarea class="cc-textarea" id="ob-fnotes" maxlength="500" placeholder="e.g. Pickup Fridays 4–7pm; delivery within 10 miles is $3.">' + esc(s2.fulfill_notes) + '</textarea>' +
      '<p class="cc-hint">Saved with your draft and shown on your storefront preview.</p></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-privaddr">' + CC.icon('shield') + ' Private address <span class="cc-badge cc-badge-info">Private</span></label>' +
      '<textarea class="cc-textarea" id="ob-privaddr" maxlength="300" placeholder="Street address, for your records">' + esc(s2.private_address) + '</textarea>' +
      '<p class="cc-hint"><strong>Private — never shown publicly.</strong> Only you (and CraveCorner admins) can see this. Customers only ever see your city, state, and service area.</p></div>';
    hydrateIcons(panel);
  }

  function saveStep2() {
    var d = D(), s2 = d.s2, errs = 0;
    if (s2.city.trim().length < 2) { stepErr('ob-city', 'Enter your city.'); errs++; }
    if (!/^[A-Za-z]{2}$/.test(s2.state.trim())) { stepErr('ob-state', 'Enter your 2-letter state code.'); errs++; }
    if (errs) return Promise.resolve({ blocked: true });
    return CC.sb.from('cc_shops').update({
      city: s2.city.trim(), state: s2.state.trim().toUpperCase(),
      service_area: s2.service_area.trim() || null,
      private_address: s2.private_address.trim() || null
    }).eq('id', state.shop.id).select().single().then(function (r) {
      if (r.error) throw r.error; state.shop = r.data;
      /* Best-effort geocode for nearby search (sql/50_geocode.sql adds the
         columns). A failed geocode simply leaves them null and the shop
         still saves — the nearby filter falls back to city+state matching. */
      if (typeof CC.geocode !== 'function') return null;
      var q = s2.city.trim() + ', ' + s2.state.trim().toUpperCase();
      return CC.geocode(q).then(function (pt) {
        if (!pt || !isFinite(pt.lat) || !isFinite(pt.lng)) return null;
        return CC.sb.from('cc_shops')
          .update({ latitude: pt.lat, longitude: pt.lng })
          .eq('id', state.shop.id).then(function () { return null; });
      }).catch(function () { return null; });
    });
  }

  /* ------------------------------------------------------------------ */
  /* STEP 3 — Fulfillment & hours                                         */
  /* ------------------------------------------------------------------ */
  function renderStep3(panel) {
    var s3 = D().s3;
    var tzOpts = Auth.US_TIMEZONES.map(function (t) {
      return '<option value="' + t.value + '"' + (s3.timezone === t.value ? ' selected' : '') + '>' + esc(t.label) + '</option>';
    }).join('');
    var hoursRows = Auth.DAYS.map(function (day) {
      var he = s3.hours[day.v] || null;
      return '<div class="ob-hours-row">' +
        '<label class="cc-check"><input type="checkbox" data-day="' + day.v + '" ' + (he ? 'checked' : '') + '> <span>' + day.label + '</span></label>' +
        '<input type="time" class="cc-input" data-open="' + day.v + '" value="' + (he ? he.open : '09:00') + '" aria-label="' + day.label + ' opens" ' + (he ? '' : 'disabled') + ' style="width:auto;">' +
        '<span class="cc-muted">–</span>' +
        '<input type="time" class="cc-input" data-close="' + day.v + '" value="' + (he ? he.close : '17:00') + '" aria-label="' + day.label + ' closes" ' + (he ? '' : 'disabled') + ' style="width:auto;">' +
        '</div>';
    }).join('');

    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Fulfillment &amp; hours</h2>' +
      '<p class="cc-muted">How customers get your food. Payments are always arranged off-platform — CraveCorner has no checkout.</p>' +
      '<div class="cc-field"><span class="cc-label">Fulfillment methods <span class="cc-req" aria-hidden="true">*</span></span>' +
      '<label class="cc-check"><input type="checkbox" id="ob-f-pickup" ' + (s3.pickup ? 'checked' : '') + '> <span>Pickup — customers collect from you</span></label>' +
      '<label class="cc-check"><input type="checkbox" id="ob-f-delivery" ' + (s3.delivery ? 'checked' : '') + '> <span>Local delivery — you deliver nearby</span></label>' +
      '<label class="cc-check"><input type="checkbox" id="ob-f-shipping" ' + (s3.shipping ? 'checked' : '') + '> <span>Shipping — you mail food</span></label>' +
      '<div data-err="ob-f"></div></div>' +
      '<div class="cc-field" id="ob-ship-decl" style="' + (s3.shipping ? '' : 'display:none;') + '">' +
      '<div class="ob-check-item"><label class="cc-check"><input type="checkbox" id="ob-ship-legal" ' + (s3.shipping_legal ? 'checked' : '') + '>' +
      ' <span><strong>Shipping legality declaration (required for shipping).</strong> I confirm that shipping my food complies with applicable state and federal laws. ' +
      '<em class="cc-hint">Self-declared — CraveCorner does not verify legal compliance.</em></span></label></div>' +
      '<div data-err="ob-ship-legal"></div></div>' +
      '<div class="cc-field"><span class="cc-label">Operating hours</span>' + hoursRows +
      '<p class="cc-hint">Leave days unchecked when you\u2019re closed.</p><div data-err="ob-hours"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-tz">Timezone</label>' +
      '<select class="cc-select" id="ob-tz">' + tzOpts + '</select></div>' +
      '<div class="cc-field"><span class="cc-label">Vacation mode</span>' +
      '<label class="cc-check"><input type="checkbox" id="ob-vacmode" ' + (s3.vacation_mode ? 'checked' : '') + '> <span>Pause my shop until a date</span></label>' +
      '<div style="margin-top:var(--cc-space-2);' + (s3.vacation_mode ? '' : 'display:none;') + '" id="ob-vacuntil-wrap">' +
      '<label class="cc-label" for="ob-vacuntil">Paused until</label>' +
      '<input type="date" class="cc-input" id="ob-vacuntil" value="' + esc(s3.vacation_until) + '" style="max-width:220px;"></div></div>';
    hydrateIcons(panel);

    document.getElementById('ob-f-shipping').addEventListener('change', function () {
      document.getElementById('ob-ship-decl').style.display = this.checked ? '' : 'none';
    });
    document.getElementById('ob-vacmode').addEventListener('change', function () {
      document.getElementById('ob-vacuntil-wrap').style.display = this.checked ? '' : 'none';
    });
    var dayBoxes = panel.querySelectorAll('[data-day]');
    for (var i = 0; i < dayBoxes.length; i++) {
      dayBoxes[i].addEventListener('change', function () {
        var v = this.getAttribute('data-day');
        panel.querySelector('[data-open="' + v + '"]').disabled = !this.checked;
        panel.querySelector('[data-close="' + v + '"]').disabled = !this.checked;
      });
    }
  }

  function collectHours() {
    var s3 = D().s3;
    s3.pickup = document.getElementById('ob-f-pickup').checked;
    s3.delivery = document.getElementById('ob-f-delivery').checked;
    s3.shipping = document.getElementById('ob-f-shipping').checked;
    var sl = document.getElementById('ob-ship-legal');
    s3.shipping_legal = sl ? sl.checked : s3.shipping_legal;
    s3.vacation_mode = document.getElementById('ob-vacmode').checked;
    var hours = {};
    var boxes = document.querySelectorAll('#ob-panel [data-day]');
    for (var i = 0; i < boxes.length; i++) {
      var v = boxes[i].getAttribute('data-day');
      if (boxes[i].checked) {
        hours[v] = {
          open: document.querySelector('#ob-panel [data-open="' + v + '"]').value || '09:00',
          close: document.querySelector('#ob-panel [data-close="' + v + '"]').value || '17:00'
        };
      }
    }
    s3.hours = hours;
  }

  function saveStep3() {
    var d = D(), s3 = d.s3, errs = 0;
    if (!s3.pickup && !s3.delivery && !s3.shipping) { stepErr('ob-f', 'Choose at least one fulfillment method.'); errs++; }
    if (s3.shipping && !s3.shipping_legal) { stepErr('ob-ship-legal', 'Shipping requires the legality declaration above.'); errs++; }
    Object.keys(s3.hours).forEach(function (k) {
      var he = s3.hours[k];
      if (he.open >= he.close) { stepErr('ob-hours', 'Closing time must be after opening time for each day.'); errs++; }
    });
    if (errs) return Promise.resolve({ blocked: true });

    return CC.sb.from('cc_shops').update({
      fulfillment_pickup: s3.pickup, fulfillment_delivery: s3.delivery, fulfillment_shipping: s3.shipping,
      hours: s3.hours, timezone: s3.timezone,
      vacation_mode: s3.vacation_mode, vacation_until: s3.vacation_until || null
    }).eq('id', state.shop.id).select().single().then(function (r) {
      if (r.error) throw r.error; state.shop = r.data;
      /* Shipping legality declaration lives with the food-safety declarations. */
      return upsertDeclarations({ shipping_legality: s3.shipping });
    });
  }

  function upsertDeclarations(decls) {
    var d = D().s4;
    Object.keys(decls).forEach(function (k) { d.declarations[k] = decls[k]; });
    return CC.sb.from('cc_shop_verification').select('id').eq('shop_id', state.shop.id).eq('doc_type', 'self-declarations').limit(1)
      .then(function (r) {
        if (r.error) throw r.error;
        if (r.data && r.data[0]) {
          return CC.sb.from('cc_shop_verification').update({ declarations: d.declarations }).eq('id', r.data[0].id);
        }
        return CC.sb.from('cc_shop_verification').insert({
          shop_id: state.shop.id, doc_type: 'self-declarations', declarations: d.declarations
        });
      }).then(function (r2) { if (r2 && r2.error) throw r2.error; });
  }

  /* ------------------------------------------------------------------ */
  /* STEP 4 — Business info                                              */
  /* ------------------------------------------------------------------ */
  function renderStep4(panel) {
    var s4 = D().s4;
    var declHtml = Auth.SAFETY_DECLARATIONS.map(function (dec) {
      return '<div class="ob-check-item"><label class="cc-check"><input type="checkbox" data-decl="' + dec.key + '" ' +
        (s4.declarations[dec.key] ? 'checked' : '') + '> <span>' + esc(dec.label) + '</span></label></div>';
    }).join('');
    var docsHtml = s4.docs.length
      ? '<ul style="list-style:none; padding:0; margin: var(--cc-space-2) 0;">' + s4.docs.map(function (doc, i) {
          return '<li style="display:flex; align-items:center; gap:var(--cc-space-2); margin-bottom:var(--cc-space-2);">' +
            '<span class="cc-badge">' + esc(doc.doc_type) + '</span>' +
            '<span class="cc-small">' + esc(doc.name || doc.path.split('/').pop()) + '</span>' +
            '<button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-doc-del="' + i + '">Remove</button></li>';
        }).join('') + '</ul>'
      : '<p class="cc-hint">No documents uploaded yet.</p>';

    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Business info</h2>' +
      '<p class="cc-muted">Selling homemade food is a real responsibility. Everything below is <strong>self-declared</strong> — CraveCorner does not verify compliance.</p>' +
      '<div class="cc-field"><span class="cc-label">Food-safety declarations <span class="cc-req" aria-hidden="true">*</span></span>' +
      declHtml + '<div data-err="ob-decl"></div></div>' +
      '<div class="cc-field"><span class="cc-label">Documentation <span class="cc-caption">(optional)</span></span>' +
      '<p class="cc-hint">Food handler card, cottage food registration, or kitchen photos — whatever applies to you.</p>' +
      '<div style="display:flex; gap:var(--cc-space-2); flex-wrap:wrap; margin-bottom:var(--cc-space-2);">' +
      '<select class="cc-select" id="ob-doctype" style="flex:1; min-width:180px;">' +
      '<option value="food-handler-card">Food handler card</option>' +
      '<option value="cottage-food-registration">Cottage food registration</option>' +
      '<option value="kitchen-photo">Kitchen photo</option>' +
      '<option value="other">Other</option></select>' +
      '<label class="cc-btn cc-btn-outline" for="ob-doc" style="cursor:pointer;">' + CC.icon('upload') + ' Upload document</label>' +
      '<input type="file" id="ob-doc" accept="image/*,.pdf" class="pg-sr-only"></div>' +
      '<div id="ob-docs-list">' + docsHtml + '</div><div data-err="ob-doc"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="ob-paymethods">Accepted payment methods</label>' +
      '<input class="cc-input" id="ob-paymethods" maxlength="200" value="' + esc(s4.payment_methods) + '" placeholder="' + esc(Auth.PAYMENT_METHODS_HINT) + '">' +
      '<p class="cc-hint">Payments are always arranged off-platform — there is no checkout on CraveCorner. ' +
      '<em>Saved with your draft for now; it will appear on your shop once this field is added to the database.</em></p></div>';
    hydrateIcons(panel);

    var delBtns = panel.querySelectorAll('[data-doc-del]');
    for (var i = 0; i < delBtns.length; i++) {
      delBtns[i].addEventListener('click', function () {
        var idx = parseInt(this.getAttribute('data-doc-del'), 10);
        var doc = D().s4.docs[idx];
        D().s4.docs.splice(idx, 1);
        if (doc && doc.path) Auth.deleteImage('cc-shop-images', doc.path);
        if (doc && doc.id) CC.sb.from('cc_shop_verification').delete().eq('id', doc.id);
        saveDraft(); renderStep4(panel);
      });
    }

    document.getElementById('ob-doc').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var errBox = panel.querySelector('[data-err="ob-doc"]');
      errBox.innerHTML = '<p class="cc-hint">Uploading…</p>';
      Auth.uploadImage('cc-shop-images', file, 'shop/docs').then(function (path) {
        var docType = document.getElementById('ob-doctype').value;
        return CC.sb.from('cc_shop_verification').insert({
          shop_id: state.shop.id, doc_type: docType, doc_url: path, declarations: {}
        }).select().single().then(function (r) {
          if (r.error) throw r.error;
          D().s4.docs.push({ doc_type: docType, path: path, name: file.name, id: r.data.id });
          saveDraft(); renderStep4(panel);
        });
      }).catch(function (err) {
        errBox.innerHTML = fieldErrorHtml(err.message); hydrateIcons(errBox);
      });
    });
  }

  function saveStep4() {
    var d = D(), s4 = d.s4;
    var missing = Auth.SAFETY_DECLARATIONS.filter(function (dec) {
      var box = document.querySelector('#ob-panel [data-decl="' + dec.key + '"]');
      var checked = box ? box.checked : !!s4.declarations[dec.key];
      s4.declarations[dec.key] = checked;
      return !checked;
    });
    if (missing.length) { stepErr('ob-decl', 'Please confirm all four declarations to continue. They are self-declared.'); return Promise.resolve({ blocked: true }); }
    return upsertDeclarations(s4.declarations);
  }

  /* ------------------------------------------------------------------ */
  /* STEP 5 — First product                                              */
  /* ------------------------------------------------------------------ */
  function ensureProductRow() {
    var d = D(), s5 = d.s5;
    if (s5.productId) return Promise.resolve(s5.productId);
    if (!state.shop) return Promise.reject(new Error('Please finish Step 1 (your shop info) first.'));
    return CC.sb.from('cc_products').insert({
      shop_id: state.shop.id,
      name: s5.name.trim() || 'Untitled product',
      price_cents: 0,
      category_id: s5.categoryId || d.s1.categoryId || null,
      status: 'draft',
      fulfillment: {
        pickup: d.s3.pickup, delivery: d.s3.delivery, shipping: d.s3.shipping
      }
    }).select().single().then(function (r) {
      if (r.error) throw r.error;
      s5.productId = r.data.id;
      saveDraft();
      return s5.productId;
    });
  }

  function loadProductIntoDraft(productId) {
    var d = D(), s5 = d.s5;
    return CC.sb.from('cc_products').select('*').eq('id', productId).single()
      .then(function (r) {
        if (r.error) throw r.error;
        var p = r.data;
        s5.productId = p.id; s5.name = p.name || ''; s5.price = (p.price_cents / 100).toFixed(2);
        s5.description = p.description || ''; s5.categoryId = p.category_id || d.s1.categoryId || '';
        s5.portion = p.portion || ''; s5.ingredients = p.ingredients || '';
        s5.allergens = p.allergens || ''; s5.prep_time = p.prep_time || '';
        s5.lead_time_days = String(p.lead_time_days || 0);
        s5.fulfillment = p.fulfillment || null;
        return CC.sb.from('cc_product_images').select('*').eq('product_id', productId).order('position');
      })
      .then(function (r2) {
        if (!r2.error) {
          s5.photos = (r2.data || []).map(function (img) {
            return { id: img.id, path: img.storage_path, name: img.storage_path.split('/').pop(), is_cover: img.is_cover, ai_generated: img.ai_generated };
          });
        }
        return CC.sb.from('cc_product_options').select('*').eq('product_id', productId).order('position');
      })
      .then(function (r3) {
        if (!r3.error) {
          s5.options = (r3.data || []).map(function (o) {
            return { id: o.id, name: o.name, required: o.required, choices: o.choices || [] };
          });
        }
        return CC.sb.from('cc_product_sections').select('section_id').eq('product_id', productId);
      })
      .then(function (r4) {
        if (!r4.error) s5.sectionIds = (r4.data || []).map(function (x) { return x.section_id; });
        saveDraft();
      });
  }

  function renderStep5(panel) {
    var d = D(), s5 = d.s5;
    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Your first product</h2>' +
      '<p class="cc-muted">List one thing you make. You can add your full menu from the dashboard later.</p>' +
      '<p class="cc-hint" id="ob-p5-loading">Loading product editor…</p>';
    hydrateIcons(panel);

    var chain = s5.productId ? loadProductIntoDraft(s5.productId) : ensureProductRow().then(loadProductIntoDraft);
    chain.then(function () { renderProductForm(panel); })
      .catch(function (err) {
        panel.innerHTML = '<div data-step-banner></div>' + CC.states.error({ title: 'Could not load the product editor', body: err.message });
        hydrateIcons(panel);
      });
  }

  function renderProductForm(panel) {
    var d = D(), s5 = d.s5;
    var catOpts = state.categories.map(function (c) {
      return '<option value="' + c.id + '"' + (s5.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
    var ff = s5.fulfillment || { pickup: d.s3.pickup, delivery: d.s3.delivery, shipping: d.s3.shipping };
    var photosHtml = s5.photos.length
      ? '<div class="ob-photo-grid">' + s5.photos.map(function (ph, i) {
          return '<div class="ob-photo" data-cover="' + !!ph.is_cover + '">' +
            '<img src="' + esc(CC.imgUrl('cc-product-images', ph.path)) + '" alt="Product photo ' + (i + 1) + '">' +
            (ph.is_cover ? '<span class="ob-cover-tag">Cover</span>' : '') +
            (ph.ai_generated ? '<span class="ob-ai-tag">AI</span>' : '') +
            '<div class="ob-photo-tools">' +
            '<button type="button" data-ph-act="cover" data-ph="' + i + '" ' + (ph.is_cover ? 'disabled' : '') + '>Cover</button>' +
            '<button type="button" data-ph-act="left" data-ph="' + i + '" ' + (i === 0 ? 'disabled' : '') + ' aria-label="Move photo left">←</button>' +
            '<button type="button" data-ph-act="right" data-ph="' + i + '" ' + (i === s5.photos.length - 1 ? 'disabled' : '') + ' aria-label="Move photo right">→</button>' +
            '<button type="button" data-ph-act="del" data-ph="' + i + '" aria-label="Delete photo">✕</button>' +
            '</div></div>';
        }).join('') + '</div>'
      : '<p class="cc-hint">No photos yet — add up to 20.</p>';
    var aiHtml = s5.photos.length
      ? s5.photos.map(function (ph, i) {
          return '<label class="cc-check" style="margin-bottom:var(--cc-space-2);"><input type="checkbox" data-ai="' + i + '" ' +
            (ph.ai_generated ? 'checked' : '') + '> <span>Photo ' + (i + 1) + ' is AI-generated</span></label>';
        }).join('')
      : '';
    var optionsHtml = s5.options.map(function (opt, oi) {
      var choices = opt.choices.map(function (ch, ci) {
        return '<div class="ob-choice-row">' +
          '<input class="cc-input" data-opt="' + oi + '" data-choice-label="' + ci + '" value="' + esc(ch.label || '') + '" placeholder="Choice label" aria-label="Choice label">' +
          '<input class="cc-input" data-opt="' + oi + '" data-choice-delta="' + ci + '" value="' + esc(ch.price_delta_cents != null ? (ch.price_delta_cents / 100).toFixed(2) : '') + '" placeholder="+$0.00" inputmode="decimal" aria-label="Price change in dollars">' +
          '<button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-choice-del="' + oi + ':' + ci + '" aria-label="Remove choice">✕</button></div>';
      }).join('');
      return '<div class="ob-option-card"><div class="ob-choice-row">' +
        '<input class="cc-input" data-opt-name="' + oi + '" value="' + esc(opt.name) + '" placeholder="Option name — e.g. Size" aria-label="Option name">' +
        '<button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-opt-del="' + oi + '">Remove</button></div>' +
        '<label class="cc-check" style="margin-bottom:var(--cc-space-2);"><input type="checkbox" data-opt-req="' + oi + '" ' + (opt.required ? 'checked' : '') + '> <span>Required — customer must choose</span></label>' +
        choices +
        '<button type="button" class="cc-btn cc-btn-outline cc-btn-sm" data-choice-add="' + oi + '">' + CC.icon('plus') + ' Add choice</button></div>';
    }).join('');
    var sectionsHtml = state.sections.map(function (sec) {
      return '<label class="cc-check" style="margin-bottom:var(--cc-space-2);"><input type="checkbox" data-sec="' + sec.id + '" ' +
        (s5.sectionIds.indexOf(sec.id) !== -1 ? 'checked' : '') + '> <span>' + esc(sec.name) + '</span></label>';
    }).join('');

    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Your first product</h2>' +
      '<p class="cc-muted">List one thing you make. You can add your full menu from the dashboard later.</p>' +
      '<div class="cc-field"><label class="cc-label" for="obp-name">Product name <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<input class="cc-input" id="obp-name" maxlength="120" value="' + esc(s5.name) + '" placeholder="e.g. Dozen tamales"><div data-err="obp-name"></div></div>' +
      '<div style="display:grid; grid-template-columns: 1fr 1fr; gap: var(--cc-space-3);">' +
      '<div class="cc-field"><label class="cc-label" for="obp-price">Price (USD) <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<input class="cc-input" id="obp-price" inputmode="decimal" value="' + esc(s5.price) + '" placeholder="12.00"><div data-err="obp-price"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="obp-cat">Category <span class="cc-req" aria-hidden="true">*</span></label>' +
      '<select class="cc-select" id="obp-cat"><option value="">Choose…</option>' + catOpts + '</select><div data-err="obp-cat"></div></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="obp-desc">Description</label>' +
      '<textarea class="cc-textarea" id="obp-desc" maxlength="2000" placeholder="What\u2019s in it? What makes it special?">' + esc(s5.description) + '</textarea></div>' +
      '<div class="cc-field"><span class="cc-label">Photos <span class="cc-caption">(' + s5.photos.length + '/20)</span></span>' +
      photosHtml +
      (s5.photos.length < 20
        ? '<label class="cc-btn cc-btn-outline cc-btn-sm" for="obp-photo" style="cursor:pointer; align-self:flex-start;">' + CC.icon('upload') + ' Add photos</label>' +
          '<input type="file" id="obp-photo" accept="image/*" multiple class="pg-sr-only">'
        : '<p class="cc-hint">You\u2019ve reached 20 photos — the maximum.</p>') +
      '<div data-err="obp-photo"></div>' +
      (aiHtml ? '<div style="margin-top:var(--cc-space-2);"><span class="cc-label">AI-generated images</span><p class="cc-hint">Check any photo that was AI-generated. We never present AI images as real photos.</p>' + aiHtml + '</div>' : '') +
      '</div>' +
      '<div class="cc-field"><span class="cc-label">Variants / options</span>' + optionsHtml +
      '<button type="button" class="cc-btn cc-btn-outline cc-btn-sm" id="obp-opt-add">' + CC.icon('plus') + ' Add option group</button>' +
      '<p class="cc-hint">e.g. Size → Small (+$0), Large (+$4.00).</p></div>' +
      '<div style="display:grid; grid-template-columns: 1fr 1fr; gap: var(--cc-space-3);">' +
      '<div class="cc-field"><label class="cc-label" for="obp-portion">Portion</label>' +
      '<input class="cc-input" id="obp-portion" maxlength="60" value="' + esc(s5.portion) + '" placeholder="per dozen"></div>' +
      '<div class="cc-field"><label class="cc-label" for="obp-lead">Lead time (days)</label>' +
      '<input class="cc-input" id="obp-lead" type="number" min="0" max="60" value="' + esc(s5.lead_time_days) + '"></div></div>' +
      '<div class="cc-field"><label class="cc-label" for="obp-ing">Ingredients</label>' +
      '<textarea class="cc-textarea" id="obp-ing" maxlength="2000" style="min-height:80px;" placeholder="List everything in it.">' + esc(s5.ingredients) + '</textarea></div>' +
      '<div class="cc-field"><label class="cc-label" for="obp-alg">Allergens</label>' +
      '<input class="cc-input" id="obp-alg" maxlength="300" value="' + esc(s5.allergens) + '" placeholder="e.g. Contains: milk, wheat, eggs">' +
      '<p class="cc-hint">List the major allergens honestly — customers with allergies depend on this.</p></div>' +
      '<div class="cc-field"><label class="cc-label" for="obp-prep">Prep time</label>' +
      '<input class="cc-input" id="obp-prep" maxlength="120" value="' + esc(s5.prep_time) + '" placeholder="e.g. Made fresh the morning of pickup"></div>' +
      '<div class="cc-field"><span class="cc-label">Fulfillment for this product</span>' +
      '<label class="cc-check"><input type="checkbox" id="obp-f-pickup" ' + (ff.pickup ? 'checked' : '') + '> <span>Pickup</span></label>' +
      '<label class="cc-check"><input type="checkbox" id="obp-f-delivery" ' + (ff.delivery ? 'checked' : '') + '> <span>Delivery</span></label>' +
      '<label class="cc-check"><input type="checkbox" id="obp-f-shipping" ' + (ff.shipping ? 'checked' : '') + '> <span>Shipping</span></label></div>' +
      '<div class="cc-field"><span class="cc-label">Menu sections</span>' + (sectionsHtml || '<p class="cc-hint">No sections yet — create your first below.</p>') +
      '<div style="display:flex; gap:var(--cc-space-2); margin-top:var(--cc-space-2);">' +
      '<input class="cc-input" id="obp-newsec" maxlength="60" placeholder="New section — e.g. Tamales">' +
      '<button type="button" class="cc-btn cc-btn-outline" id="obp-sec-add">Add</button></div></div>';
    hydrateIcons(panel);

    /* photo upload */
    var photoInput = document.getElementById('obp-photo');
    if (photoInput) photoInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      if (!files.length) return;
      var remaining = 20 - D().s5.photos.length;
      if (files.length > remaining) {
        var eb = panel.querySelector('[data-err="obp-photo"]');
        eb.innerHTML = fieldErrorHtml('You can add ' + remaining + ' more photo(s) — 20 max.'); hydrateIcons(eb);
        files = files.slice(0, remaining);
      }
      var chain = Promise.resolve();
      files.forEach(function (file) {
        chain = chain.then(function () {
          return Auth.uploadImage('cc-product-images', file, 'products/' + D().s5.productId)
            .then(function (path) {
              D().s5.photos.push({ path: path, name: file.name, is_cover: D().s5.photos.length === 0, ai_generated: false });
            });
        });
      });
      chain.then(function () { collectProductForm(); saveDraft(); renderProductForm(panel); })
        .catch(function (err) {
          var eb2 = panel.querySelector('[data-err="obp-photo"]');
          eb2.innerHTML = fieldErrorHtml(err.message); hydrateIcons(eb2);
        });
    });

    /* photo tools */
    var phBtns = panel.querySelectorAll('[data-ph-act]');
    for (var pb = 0; pb < phBtns.length; pb++) {
      phBtns[pb].addEventListener('click', function () {
        var i = parseInt(this.getAttribute('data-ph'), 10);
        var act = this.getAttribute('data-ph-act');
        var photos = D().s5.photos;
        if (act === 'cover') photos.forEach(function (p, k) { p.is_cover = k === i; });
        else if (act === 'left' && i > 0) { var t = photos[i - 1]; photos[i - 1] = photos[i]; photos[i] = t; }
        else if (act === 'right' && i < photos.length - 1) { var t2 = photos[i + 1]; photos[i + 1] = photos[i]; photos[i] = t2; }
        else if (act === 'del') {
          var gone = photos.splice(i, 1)[0];
          if (gone && gone.path && !gone.id) Auth.deleteImage('cc-product-images', gone.path);
          /* persisted images are deleted on save */
          if (gone && gone.id) gone._deleted = true, photos._trash = (photos._trash || []).concat([gone]);
          if (gone && gone.is_cover && photos.length) photos[0].is_cover = true;
        }
        collectProductForm(); saveDraft(); renderProductForm(panel);
      });
    }
    var aiBoxes = panel.querySelectorAll('[data-ai]');
    for (var ab = 0; ab < aiBoxes.length; ab++) {
      aiBoxes[ab].addEventListener('change', function () {
        D().s5.photos[parseInt(this.getAttribute('data-ai'), 10)].ai_generated = this.checked;
        saveDraft();
      });
    }

    /* options editor */
    document.getElementById('obp-opt-add').addEventListener('click', function () {
      collectProductForm(); D().s5.options.push({ name: '', required: false, choices: [{ label: '', price_delta_cents: 0 }] });
      saveDraft(); renderProductForm(panel);
    });
    var optDels = panel.querySelectorAll('[data-opt-del]');
    for (var od = 0; od < optDels.length; od++) {
      optDels[od].addEventListener('click', function () {
        collectProductForm(); D().s5.options.splice(parseInt(this.getAttribute('data-opt-del'), 10), 1);
        saveDraft(); renderProductForm(panel);
      });
    }
    var chAdds = panel.querySelectorAll('[data-choice-add]');
    for (var ca = 0; ca < chAdds.length; ca++) {
      chAdds[ca].addEventListener('click', function () {
        collectProductForm();
        D().s5.options[parseInt(this.getAttribute('data-choice-add'), 10)].choices.push({ label: '', price_delta_cents: 0 });
        saveDraft(); renderProductForm(panel);
      });
    }
    var chDels = panel.querySelectorAll('[data-choice-del]');
    for (var cd = 0; cd < chDels.length; cd++) {
      chDels[cd].addEventListener('click', function () {
        collectProductForm();
        var parts = this.getAttribute('data-choice-del').split(':');
        D().s5.options[parseInt(parts[0], 10)].choices.splice(parseInt(parts[1], 10), 1);
        saveDraft(); renderProductForm(panel);
      });
    }

    /* new menu section */
    document.getElementById('obp-sec-add').addEventListener('click', function () {
      var name = document.getElementById('obp-newsec').value.trim();
      if (!name) return;
      collectProductForm();
      CC.sb.from('cc_menu_sections').insert({ shop_id: state.shop.id, name: name, position: state.sections.length })
        .select().single().then(function (r) {
          if (r.error) {
            if (String(r.error.code) === '23505') {
              /* section name already exists for this shop — link the existing one */
              return CC.sb.from('cc_menu_sections').select('*').eq('shop_id', state.shop.id).eq('name', name).single()
                .then(function (r2) { if (r2.error) throw r2.error; return r2.data; });
            }
            throw r.error;
          }
          return r.data;
        }).then(function (sec) {
          if (!state.sections.some(function (s) { return s.id === sec.id; })) state.sections.push(sec);
          if (D().s5.sectionIds.indexOf(sec.id) === -1) D().s5.sectionIds.push(sec.id);
          saveDraft(); renderProductForm(panel);
        }).catch(function (err) {
          var eb3 = panel.querySelector('[data-step-banner]');
          eb3.innerHTML = fieldErrorHtml(err.message); hydrateIcons(eb3);
        });
    });
  }

  function collectProductForm() {
    var d = D(), s5 = d.s5;
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    s5.name = g('obp-name'); s5.price = g('obp-price'); s5.description = g('obp-desc');
    s5.categoryId = g('obp-cat'); s5.portion = g('obp-portion');
    s5.ingredients = g('obp-ing'); s5.allergens = g('obp-alg');
    s5.prep_time = g('obp-prep'); s5.lead_time_days = g('obp-lead');
    var fp = document.getElementById('obp-f-pickup');
    if (fp) s5.fulfillment = { pickup: fp.checked, delivery: document.getElementById('obp-f-delivery').checked, shipping: document.getElementById('obp-f-shipping').checked };
    /* options */
    var panel = document.getElementById('ob-panel');
    var opts = [];
    panel.querySelectorAll('[data-opt-name]').forEach(function (nameEl) {
      var oi = parseInt(nameEl.getAttribute('data-opt-name'), 10);
      var reqEl = panel.querySelector('[data-opt-req="' + oi + '"]');
      var choices = [];
      panel.querySelectorAll('[data-choice-label]').forEach(function (labEl) {
        if (parseInt(labEl.getAttribute('data-opt'), 10) !== oi) return;
        var ci = labEl.getAttribute('data-choice-label');
        var deltaEl = panel.querySelector('[data-choice-delta="' + ci + '"][data-opt="' + oi + '"]');
        var delta = 0;
        if (deltaEl && deltaEl.value.trim() !== '') {
          var dv = parseFloat(deltaEl.value.replace(/[$,]/g, ''));
          if (!isNaN(dv)) delta = Math.round(dv * 100);
        }
        choices.push({ label: labEl.value.trim(), price_delta_cents: delta });
      });
      var prev = s5.options[oi] || {};
      opts[oi] = { id: prev.id, name: nameEl.value.trim(), required: !!(reqEl && reqEl.checked), choices: choices };
    });
    s5.options = opts.filter(function (o) { return o && o.name; });
    /* sections */
    s5.sectionIds = [];
    panel.querySelectorAll('[data-sec]').forEach(function (cb) {
      if (cb.checked) s5.sectionIds.push(cb.getAttribute('data-sec'));
    });
    /* AI flags */
    panel.querySelectorAll('[data-ai]').forEach(function (cb) {
      var i = parseInt(cb.getAttribute('data-ai'), 10);
      if (s5.photos[i]) s5.photos[i].ai_generated = cb.checked;
    });
    saveDraft();
  }

  function saveStep5() {
    var d = D(), s5 = d.s5, errs = 0;
    if (s5.name.trim().length < 2) { stepErr('obp-name', 'Give your product a name.'); errs++; }
    var priceNum = parseFloat(String(s5.price).replace(/[$,]/g, ''));
    if (isNaN(priceNum) || priceNum < 0) { stepErr('obp-price', 'Enter a valid price (0 or more).'); errs++; }
    if (!s5.categoryId) { stepErr('obp-cat', 'Choose a category.'); errs++; }
    if (errs) return Promise.resolve({ blocked: true });

    var priceCents = Math.round(priceNum * 100);
    var leadDays = Math.max(0, parseInt(s5.lead_time_days, 10) || 0);
    var ff = s5.fulfillment || { pickup: d.s3.pickup, delivery: d.s3.delivery, shipping: d.s3.shipping };

    /* Single shared persistence implementation lives in cc-products.js. */
    return CC.Products.persist(s5.productId, {
      fields: {
        name: s5.name.trim(), price_cents: priceCents,
        description: s5.description.trim() || null,
        category_id: s5.categoryId, portion: s5.portion.trim() || null,
        ingredients: s5.ingredients.trim() || null, allergens: s5.allergens.trim() || null,
        prep_time: s5.prep_time.trim() || null, lead_time_days: leadDays,
        fulfillment: ff
      },
      photos: s5.photos,
      removedPhotos: s5.photos._trash || [],
      options: s5.options,
      sectionIds: s5.sectionIds
    }).then(function () {
      delete s5.photos._trash;
      saveDraft();
    });
  }

  /* ------------------------------------------------------------------ */
  /* STEP 6 — Preview & publish                                          */
  /* ------------------------------------------------------------------ */
  function fmtHours(hours) {
    var parts = [];
    Auth.DAYS.forEach(function (day) {
      var he = (hours || {})[day.v];
      if (he) parts.push(day.label + ' ' + he.open + '–' + he.close);
    });
    return parts.length ? parts.join(', ') : 'Hours not set';
  }

  function runChecks() {
    var d = D(), s = state.shop;
    var required = [
      { label: 'Shop name', pass: !!(s && s.name && s.name.trim().length >= 2), step: 1 },
      { label: 'Shop description (a sentence or two)', pass: !!(s && s.description && s.description.trim().length >= 10), step: 1 },
      { label: 'City and state', pass: !!(s && s.city && s.state), step: 2 },
      { label: 'At least one fulfillment method', pass: !!(s && (s.fulfillment_pickup || s.fulfillment_delivery || s.fulfillment_shipping)), step: 3 },
      { label: 'At least one product', pass: !!d.s5.productId, step: 5 },
      { label: 'All four food-safety declarations confirmed', pass: Auth.SAFETY_DECLARATIONS.every(function (dec) { return !!d.s4.declarations[dec.key]; }), step: 4 }
    ];
    var blockers = [];
    if (s && s.fulfillment_shipping && !d.s4.declarations.shipping_legality && !d.s3.shipping_legal) {
      blockers.push({ label: 'Shipping is enabled but the shipping legality declaration is not confirmed.', step: 3 });
    }
    var warnings = [];
    if (s && !s.logo_url) warnings.push('No logo — shops with a logo get more trust.');
    return { required: required, blockers: blockers, warnings: warnings };
  }

  function renderStep6(panel) {
    var d = D(), s = state.shop;
    var checks = runChecks();
    var missing = checks.required.filter(function (c) { return !c.pass; });
    var status = s ? s.status : 'draft';

    if (status === 'pending') {
      panel.innerHTML = '<div data-step-banner></div>' +
        '<h2 class="cc-h2">Under review</h2>' +
        '<div class="cc-alert cc-alert-success" role="status">' + CC.icon('check') +
        '<div><strong>Submitted for review.</strong><br>Your shop, <strong>' + esc(s.name) + '</strong>, ' +
        'is waiting for a CraveCorner admin to approve it. We\u2019ll take it from here — you can keep editing your menu in the meantime.</div></div>' +
        '<div class="cc-empty-actions" style="justify-content:flex-start; margin-top:var(--cc-space-4);">' +
        '<a class="cc-btn cc-btn-secondary" href="dashboard.html">Open dashboard</a>' +
        '<button type="button" class="cc-btn cc-btn-outline" id="ob-withdraw">Withdraw submission</button></div>';
      hydrateIcons(panel);
      document.getElementById('ob-withdraw').addEventListener('click', function () {
        if (!window.confirm('Withdraw your shop from review? It will go back to draft.')) return;
        CC.sb.from('cc_shops').update({ status: 'draft' }).eq('id', s.id).select().single()
          .then(function (r) { if (r.error) throw r.error; state.shop = r.data; render(); })
          .catch(function (err) { window.alert(err.message); });
      });
      var nextBtn = document.getElementById('ob-next');
      if (nextBtn) nextBtn.style.display = 'none';
      return;
    }

    var accent = (s && s.accent_color) || '#F45B83';
    var logoUrl = s && s.logo_url ? CC.imgUrl('cc-shop-images', s.logo_url) : null;
    var bannerUrl = s && s.banner_url ? CC.imgUrl('cc-shop-images', s.banner_url) : null;
    var s5 = d.s5;
    var ff = [];
    if (s && s.fulfillment_pickup) ff.push('Pickup');
    if (s && s.fulfillment_delivery) ff.push('Delivery');
    if (s && s.fulfillment_shipping) ff.push('Shipping');

    var checkList = checks.required.map(function (c) {
      return '<li style="display:flex; gap:var(--cc-space-2); align-items:flex-start; margin-bottom:var(--cc-space-2);">' +
        '<span style="color:' + (c.pass ? 'var(--cc-success, #2e7d32)' : 'var(--cc-danger)') + ';">' + CC.icon(c.pass ? 'check' : 'warning') + '</span>' +
        '<span>' + esc(c.label) + (c.pass ? '' : ' — <button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-fix-step="' + c.step + '">Fix</button>') + '</span></li>';
    }).join('');
    var blockerList = checks.blockers.map(function (b) {
      return '<li style="margin-bottom:var(--cc-space-2);">' + esc(b.label) + ' <button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-fix-step="' + b.step + '">Fix</button></li>';
    }).join('');
    var warnList = checks.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');

    var canSubmit = missing.length === 0 && checks.blockers.length === 0;

    panel.innerHTML = '<div data-step-banner></div>' +
      '<h2 class="cc-h2">Preview &amp; publish</h2>' +
      '<p class="cc-muted">This is what customers will see. Review it, then submit your shop for approval.</p>' +

      '<div class="cc-card" style="padding:0; overflow:hidden; margin-bottom: var(--cc-space-5); border-top: 6px solid ' + esc(accent) + ';">' +
      '<div style="height:140px; background: var(--cc-pink-50);">' +
      (bannerUrl ? '<img src="' + esc(bannerUrl) + '" alt="" style="width:100%; height:100%; object-fit:cover;">' : '') + '</div>' +
      '<div style="padding: var(--cc-space-4);">' +
      '<div style="display:flex; gap:var(--cc-space-3); align-items:center; margin-top:-52px; margin-bottom:var(--cc-space-3);">' +
      '<div style="width:72px; height:72px; border-radius:var(--cc-radius-md); overflow:hidden; background:#fff; border:3px solid #fff; box-shadow: var(--cc-shadow-sm); flex:none; display:flex; align-items:center; justify-content:center;">' +
      (logoUrl ? '<img src="' + esc(logoUrl) + '" alt="" style="width:100%; height:100%; object-fit:cover;">' : CC.icon('store')) + '</div></div>' +
      '<h3 class="cc-h2" style="margin-bottom:0;">' + esc(s ? s.name : s5.name) + '</h3>' +
      '<p class="cc-muted">' + esc([s && s.city, s && s.state].filter(Boolean).join(', ') || 'Location not set') + '</p>' +
      '<p>' + esc(s && s.description ? s.description.slice(0, 220) : '') + '</p>' +
      (ff.length ? '<p>' + ff.map(function (f) { return '<span class="cc-badge">' + esc(f) + '</span>'; }).join(' ') + '</p>' : '') +
      '<p class="cc-small cc-muted">' + esc(fmtHours(s && s.hours)) + ' · ' + esc((function () { var tz = Auth.US_TIMEZONES.filter(function (t) { return t.value === (s && s.timezone); })[0]; return tz ? tz.label : (s && s.timezone); })()) + '</p>' +
      (d.s2.fulfill_notes ? '<p class="cc-small"><strong>Fulfillment notes (draft):</strong> ' + esc(d.s2.fulfill_notes) + '</p>' : '') +
      (d.s4.payment_methods ? '<p class="cc-small"><strong>Accepts (draft):</strong> ' + esc(d.s4.payment_methods) + '</p>' : '') +
      (s5.productId && s5.name ? '<div style="border-top:1px solid var(--cc-border); margin-top:var(--cc-space-3); padding-top:var(--cc-space-3);">' +
        '<p class="cc-label">First product</p>' +
        '<p><strong>' + esc(s5.name) + '</strong> — ' + esc(CC.centsToPrice(Math.round((parseFloat(String(s5.price).replace(/[$,]/g, '')) || 0) * 100))) + '</p>' +
        (s5.photos.length ? '<div style="display:flex; gap:var(--cc-space-2); flex-wrap:wrap;">' +
          s5.photos.slice(0, 4).map(function (ph) {
            return '<img src="' + esc(CC.imgUrl('cc-product-images', ph.path)) + '" alt="" style="width:72px; height:72px; object-fit:cover; border-radius:var(--cc-radius-md);">' +
              (ph.ai_generated ? '<span class="cc-badge cc-badge-warn">AI-generated</span>' : '');
          }).join('') + '</div>' : '<p class="cc-hint">No photos yet.</p>') +
        '</div>' : '') +
      '</div></div>' +

      '<h3 class="cc-h3">Automated checks</h3>' +
      '<ul style="list-style:none; padding:0;">' + checkList + '</ul>' +
      (checks.blockers.length ? '<div class="cc-alert cc-alert-danger" role="alert" style="margin: var(--cc-space-3) 0;">' + CC.icon('warning') +
        '<div><strong>Needs corrections before submitting:</strong><ul style="margin:var(--cc-space-2) 0 0; padding-left:var(--cc-space-4);">' + blockerList + '</ul></div></div>' : '') +
      (checks.warnings.length ? '<div class="cc-alert cc-alert-warn" role="alert" style="margin: var(--cc-space-3) 0;">' + CC.icon('warning') +
        '<div><strong>Suggestions:</strong><ul style="margin:var(--cc-space-2) 0 0; padding-left:var(--cc-space-4);">' + warnList + '</ul></div></div>' : '') +
      (canSubmit
        ? '<div class="cc-alert cc-alert-info" role="status" style="margin: var(--cc-space-4) 0;">' + CC.icon('shield') +
          '<div>Ready to submit. A CraveCorner admin reviews every shop before it goes live — that usually takes a day or two.</div></div>' +
          '<button type="button" class="cc-btn cc-btn-primary cc-btn-lg cc-btn-block" id="ob-submit">Submit for review</button>'
        : '<p class="cc-muted">Finish the items above, then come back here to submit.</p>');

    hydrateIcons(panel);

    var fixBtns = panel.querySelectorAll('[data-fix-step]');
    for (var f = 0; f < fixBtns.length; f++) {
      fixBtns[f].addEventListener('click', function () {
        state.draft.step = parseInt(this.getAttribute('data-fix-step'), 10);
        saveDraft(); render();
        state.root.scrollIntoView({ block: 'start' });
      });
    }
    var submitBtn = document.getElementById('ob-submit');
    if (submitBtn) submitBtn.addEventListener('click', function () {
      submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';
      CC.sb.from('cc_shops').update({ status: 'pending' }).eq('id', state.shop.id).select().single()
        .then(function (r) {
          if (r.error) throw r.error;
          state.shop = r.data;
          clearDraft();
          render();
        })
        .catch(function (err) {
          submitBtn.disabled = false; submitBtn.textContent = 'Submit for review';
          var eb = panel.querySelector('[data-step-banner]');
          eb.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert" style="margin-bottom:var(--cc-space-4);">' +
            CC.icon('warning') + '<div>' + esc(err.message) + '</div></div>';
          hydrateIcons(eb);
        });
    });
    var nextBtn2 = document.getElementById('ob-next');
    if (nextBtn2) nextBtn2.style.display = 'none';
  }

  function saveStep6() {
    /* Step 6 has no form data — "Finish" just exits to the dashboard/shop. */
    if (state.shop && state.shop.status === 'published') window.location.href = 'dashboard.html';
    else if (state.shop && state.shop.status === 'pending') window.location.href = 'dashboard.html';
    return Promise.resolve({ blocked: true });
  }
})();
