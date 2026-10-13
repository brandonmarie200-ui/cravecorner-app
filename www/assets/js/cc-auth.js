/* ==========================================================================
   CraveCorner — Stage 2 shared auth/shop/product helpers (cc-auth.js)
   --------------------------------------------------------------------------
   Loaded AFTER assets/js/cc.js on Stage 2 pages (auth, profile, onboarding,
   shop, dashboard). Extends window.CC with the CC.Auth namespace:

     CC.Auth.requireAuth(nextUrl)  redirect to auth.html?next=... unless signed in
     CC.Auth.getProfile()          Promise -> cc_profiles row for CC.user (or null)
     CC.Auth.getMyShop()           Promise -> cc_shops row owned by CC.user (or null)
     CC.Auth.loadCategories()      Promise -> cc_categories rows (cached)
     CC.Auth.uploadImage(bucket, file, folder)
                                   Promise -> bucket-relative storage path
                                   (<uid>/<folder>/<timestamp>-<safe-name>).
                                   Validates image type + 8MB limit.
     CC.Auth.slugify(text)         "Marisol's Kitchen!" -> "marisols-kitchen"
     CC.Auth.randomId()            short random hex for storage filenames
     CC.Auth.setFieldError(input, msg) / CC.Auth.clearFieldError(input)
     CC.Auth.formError(form, msg)  show a form-level error banner
     CC.Auth.formSuccess(form, msg) show a form-level success banner
     CC.Auth.US_TIMEZONES          [{value, label}] for shop timezone picker
     CC.Auth.FULFILL_LABELS        {pickup, delivery, shipping} labels
     CC.Auth.SHOP_STATUS_LABELS    {draft, pending, published, rejected, suspended}
     CC.Auth.PRODUCT_STATUS_LABELS {draft, active, paused, sold_out, archived}
     CC.Auth.escapeHtml            alias of CC.esc for convenience
   ========================================================================== */
(function () {
  'use strict';

  var CC = (window.CC = window.CC || {});
  var Auth = (CC.Auth = CC.Auth || {});

  Auth.escapeHtml = CC.esc || function (s) { return String(s == null ? '' : s); };

  /* ---- auth gating ------------------------------------------------------- */
  Auth.requireAuth = function (nextUrl) {
    return CC.ready.then(function (r) {
      if (!r.live) return { live: false, user: null };
      if (!r.user) {
        var next = nextUrl || (window.location.pathname.split('/').pop() + window.location.search);
        window.location.replace('auth.html?next=' + encodeURIComponent(next));
        return { live: true, user: null, redirected: true };
      }
      return { live: true, user: r.user };
    });
  };

  /* ---- profile / shop reads ---------------------------------------------- */
  Auth.getProfile = function () {
    if (!CC.sb || !CC.user) return Promise.resolve(null);
    return CC.sb.from('cc_profiles').select('*').eq('user_id', CC.user.id).limit(1)
      .then(function (r) {
        if (r.error) throw r.error;
        return (r.data && r.data[0]) || null;
      });
  };

  /* Owner reads their own FULL row from cc_shops (private_address included —
     never render it on public pages). */
  Auth.getMyShop = function () {
    if (!CC.sb || !CC.user) return Promise.resolve(null);
    return CC.sb.from('cc_shops').select('*').eq('user_id', CC.user.id).limit(1)
      .then(function (r) {
        if (r.error) throw r.error;
        return (r.data && r.data[0]) || null;
      });
  };

  var _categories = null;
  Auth.loadCategories = function () {
    if (_categories) return Promise.resolve(_categories);
    if (!CC.sb) return Promise.resolve([]);
    return CC.sb.from('cc_categories').select('id, slug, name').order('sort_order')
      .then(function (r) {
        if (r.error) throw r.error;
        _categories = r.data || [];
        return _categories;
      });
  };

  /* ---- storage uploads ---------------------------------------------------- */
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  Auth.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;

  function safeName(name) {
    return String(name || 'image')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'image';
  }

  Auth.randomId = function () {
    return Math.random().toString(16).slice(2, 10);
  };

  /* Uploads a File to a bucket. Storage RLS requires the first path folder
     to be auth.uid(), so paths are always <uid>/<folder>/<ts>-<id>-<name>. */
  Auth.uploadImage = function (bucket, file, folder) {
    if (!CC.sb) return Promise.reject(new Error('Supabase client failed to load.'));
    if (!CC.user) return Promise.reject(new Error('You must be signed in to upload.'));
    if (!file) return Promise.reject(new Error('Choose a file first.'));
    if (file.type && file.type.indexOf('image/') !== 0) {
      return Promise.reject(new Error('That file is not an image. Please choose a JPG, PNG, or WebP image.'));
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return Promise.reject(new Error('That image is over 8MB. Please choose a smaller file.'));
    }
    var path = CC.user.id + '/' + (folder || 'uploads') + '/' +
      Date.now() + '-' + Auth.randomId() + '-' + safeName(file.name);
    return CC.sb.storage.from(bucket).upload(path, file, { upsert: false })
      .then(function (r) {
        if (r.error) throw r.error;
        return path;
      });
  };

  Auth.deleteImage = function (bucket, path) {
    if (!CC.sb || !path) return Promise.resolve();
    return CC.sb.storage.from(bucket).remove([path]).then(function () { /* best effort */ });
  };

  /* ---- slug --------------------------------------------------------------- */
  Auth.slugify = function (text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  };

  /* ---- form UX helpers ---------------------------------------------------- */
  function errorElFor(input) {
    var id = input.getAttribute('aria-describedby');
    if (id) {
      var el = document.getElementById(id);
      if (el) return el;
    }
    var wrap = input.closest('.cc-field');
    if (!wrap) return null;
    var el2 = wrap.querySelector('.cc-error-text');
    return el2 || null;
  }

  Auth.setFieldError = function (input, msg) {
    if (!input) return;
    input.setAttribute('aria-invalid', 'true');
    var el = errorElFor(input);
    if (!el) {
      var wrap = input.closest('.cc-field');
      if (!wrap) return;
      el = document.createElement('p');
      el.className = 'cc-error-text';
      el.id = 'cc-err-' + Math.random().toString(16).slice(2, 8);
      input.setAttribute('aria-describedby', el.id);
      wrap.appendChild(el);
    }
    el.innerHTML = CC.icon('warning') + '<span>' + Auth.escapeHtml(msg) + '</span>';
  };

  Auth.clearFieldError = function (input) {
    if (!input) return;
    input.removeAttribute('aria-invalid');
    var el = errorElFor(input);
    if (el) el.textContent = '';
  };

  Auth.clearAllErrors = function (form) {
    if (!form) return;
    var inputs = form.querySelectorAll('[aria-invalid="true"]');
    for (var i = 0; i < inputs.length; i++) Auth.clearFieldError(inputs[i]);
    var banner = form.querySelector('[data-form-banner]');
    if (banner) banner.innerHTML = '';
  };

  Auth.formError = function (form, msg) {
    var banner = form && form.querySelector('[data-form-banner]');
    if (!banner && form) {
      /* Never swallow errors silently: create the banner if it's missing. */
      banner = document.createElement('div');
      banner.setAttribute('data-form-banner', '');
      banner.setAttribute('aria-live', 'polite');
      form.insertBefore(banner, form.firstChild);
    }
    if (!banner) return;
    banner.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert">' +
      CC.icon('warning') + '<div>' + Auth.escapeHtml(msg) + '</div></div>';
    banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  Auth.formSuccess = function (form, msg) {
    var banner = form && form.querySelector('[data-form-banner]');
    if (!banner && form) {
      banner = document.createElement('div');
      banner.setAttribute('data-form-banner', '');
      banner.setAttribute('aria-live', 'polite');
      form.insertBefore(banner, form.firstChild);
    }
    if (!banner) return;
    banner.innerHTML = '<div class="cc-alert cc-alert-success" role="status">' +
      CC.icon('check') + '<div>' + Auth.escapeHtml(msg) + '</div></div>';
  };

  Auth.friendlyAuthError = function (err) {
    var m = String((err && err.message) || '');
    if (/invalid login credentials/i.test(m)) return 'That email and password do not match. Double-check and try again.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first — check your inbox for the confirmation link.';
    if (/user already registered/i.test(m)) return 'An account with this email already exists. Try logging in instead.';
    if (/password/i.test(m) && /at least|weak|short/i.test(m)) return 'Your password needs to be at least 6 characters.';
    if (/rate limit/i.test(m)) return 'Too many attempts — wait a minute and try again.';
    return m || 'Something went wrong. Please try again.';
  };

  /* ---- constants ---------------------------------------------------------- */
  Auth.US_TIMEZONES = [
    { value: 'America/New_York', label: 'Eastern (New York)' },
    { value: 'America/Chicago', label: 'Central (Chicago)' },
    { value: 'America/Denver', label: 'Mountain (Denver)' },
    { value: 'America/Phoenix', label: 'Mountain — Arizona (no DST)' },
    { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
    { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
    { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' }
  ];

  Auth.FULFILL_LABELS = { pickup: 'Pickup', delivery: 'Delivery', shipping: 'Shipping' };

  Auth.SHOP_STATUS_LABELS = {
    draft: 'Draft', pending: 'Pending review', published: 'Published',
    rejected: 'Needs corrections', suspended: 'Suspended'
  };

  Auth.PRODUCT_STATUS_LABELS = {
    draft: 'Draft', active: 'Active', paused: 'Paused',
    sold_out: 'Sold out', archived: 'Archived'
  };

  Auth.ACCENT_COLORS = ['#F45B83', '#FFC65B', '#A8DDB5', '#B9A6E8', '#FFF9F3', '#342B32'];

  Auth.DAYS = [
    { v: 0, label: 'Mon' }, { v: 1, label: 'Tue' }, { v: 2, label: 'Wed' },
    { v: 3, label: 'Thu' }, { v: 4, label: 'Fri' }, { v: 5, label: 'Sat' },
    { v: 6, label: 'Sun' }
  ];

  Auth.SAFETY_DECLARATIONS = [
    { key: 'cottage_food_awareness', label: 'I understand my state\u2019s cottage food law and what I\u2019m allowed to sell from home.' },
    { key: 'safe_handling', label: 'I follow safe food-handling practices (clean hands, surfaces, and equipment).' },
    { key: 'allergen_labeling', label: 'I will list ingredients and common allergens on every product.' },
    { key: 'accurate_listing', label: 'My listings will describe the food accurately — no misleading photos or claims.' }
  ];

  Auth.PAYMENT_METHODS_HINT = 'e.g. CashApp, Venmo, Zelle, cash on pickup';

  /* Public avatar placeholder: initials on a brand-tinted circle. */
  Auth.initialsAvatar = function (name) {
    var initials = String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?';
    return '<span class="cc-avatar" aria-hidden="true">' + Auth.escapeHtml(initials) + '</span>';
  };
})();
