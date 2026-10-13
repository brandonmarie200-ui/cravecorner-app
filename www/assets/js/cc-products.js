/* ==========================================================================
   CraveCorner — Stage 2 product management (cc-products.js)
   --------------------------------------------------------------------------
   CC.Products.persist(productId, payload) — the single implementation of
   product saving used by the dashboard editor (and the onboarding wizard):
     1. updates cc_products (money in cents)
     2. syncs cc_product_images (positions, cover, ai_generated; deletes
        removed rows AND their storage files)
     3. replaces cc_product_options (delete-all + insert)
     4. replaces cc_product_sections links
   Deletion rule: archive (status='archived') to delist; hard DELETE is
   attempted only on explicit request and the DB blocks it with a loud
   error when order history exists (ON DELETE RESTRICT) — surfaced honestly.

   CC.Products.openEditor(container, opts) — full product editor form:
     opts: { shopId, productId (null = new), categories, sections,
             onSaved(product), onCancel() }
   ========================================================================== */
(function () {
  'use strict';

  var P = (window.CC = window.CC || {});
  var Products = (P.Products = P.Products || {});
  var CC, Auth, esc;

  function ensure() { CC = window.CC; Auth = CC.Auth; esc = Auth.escapeHtml; }

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

  /* ------------------------------------------------------------------ */
  /* persist — one implementation of the product save                     */
  /* ------------------------------------------------------------------ */
  Products.persist = function (productId, payload) {
    ensure();
    var fields = payload.fields || {};
    var photos = payload.photos || [];
    var removed = payload.removedPhotos || [];
    var options = payload.options || [];
    var sectionIds = payload.sectionIds || [];

    return CC.sb.from('cc_products').update(fields).eq('id', productId)
      .then(function (r) {
        if (r.error) throw r.error;
        var chain = Promise.resolve();
        removed.forEach(function (gone) {
          chain = chain.then(function () {
            return CC.sb.from('cc_product_images').delete().eq('id', gone.id)
              .then(function () { return Auth.deleteImage('cc-product-images', gone.path); });
          });
        });
        return chain;
      })
      .then(function () {
        var chain = Promise.resolve();
        photos.forEach(function (ph, i) {
          chain = chain.then(function () {
            if (ph.id) {
              return CC.sb.from('cc_product_images').update({
                position: i, is_cover: !!ph.is_cover, ai_generated: !!ph.ai_generated
              }).eq('id', ph.id).then(function (r) { if (r.error) throw r.error; });
            }
            return CC.sb.from('cc_product_images').insert({
              product_id: productId, storage_path: ph.path, position: i,
              is_cover: !!ph.is_cover, ai_generated: !!ph.ai_generated
            }).select().single().then(function (r) {
              if (r.error) throw r.error;
              ph.id = r.data.id;
            });
          });
        });
        return chain;
      })
      .then(function () {
        return CC.sb.from('cc_product_options').delete().eq('product_id', productId);
      })
      .then(function (r) {
        if (r.error) throw r.error;
        var chain = Promise.resolve();
        options.forEach(function (opt, i) {
          chain = chain.then(function () {
            return CC.sb.from('cc_product_options').insert({
              product_id: productId, name: opt.name, choices: opt.choices || [],
              required: !!opt.required, position: i
            }).then(function (rr) { if (rr.error) throw rr.error; });
          });
        });
        return chain;
      })
      .then(function () {
        return CC.sb.from('cc_product_sections').delete().eq('product_id', productId);
      })
      .then(function (r) {
        if (r.error) throw r.error;
        var chain = Promise.resolve();
        sectionIds.forEach(function (sid) {
          chain = chain.then(function () {
            return CC.sb.from('cc_product_sections').insert({ product_id: productId, section_id: sid })
              .then(function (rr) { if (rr.error) throw rr.error; });
          });
        });
        return chain;
      });
  };

  Products.archive = function (productId) {
    ensure();
    return CC.sb.from('cc_products').update({ status: 'archived' }).eq('id', productId)
      .then(function (r) { if (r.error) throw r.error; });
  };

  /* Hard delete — the DB blocks this with a loud error when order history
     exists. We surface that message honestly instead of hiding it. */
  Products.hardDelete = function (productId) {
    ensure();
    return CC.sb.from('cc_products').delete().eq('id', productId)
      .then(function (r) { if (r.error) throw r.error; });
  };

  Products.loadFull = function (productId) {
    ensure();
    var out = { product: null, photos: [], options: [], sectionIds: [] };
    return CC.sb.from('cc_products').select('*').eq('id', productId).single()
      .then(function (r) {
        if (r.error) throw r.error;
        out.product = r.data;
        return CC.sb.from('cc_product_images').select('*').eq('product_id', productId).order('position');
      })
      .then(function (r2) {
        if (!r2.error) out.photos = r2.data || [];
        return CC.sb.from('cc_product_options').select('*').eq('product_id', productId).order('position');
      })
      .then(function (r3) {
        if (!r3.error) out.options = r3.data || [];
        return CC.sb.from('cc_product_sections').select('section_id').eq('product_id', productId);
      })
      .then(function (r4) {
        if (!r4.error) out.sectionIds = (r4.data || []).map(function (x) { return x.section_id; });
        return out;
      });
  };

  /* ------------------------------------------------------------------ */
  /* Editor UI                                                            */
  /* ------------------------------------------------------------------ */
  var STATUS_ORDER = ['draft', 'active', 'paused', 'sold_out', 'archived'];

  Products.openEditor = function (container, opts) {
    ensure();
    var shopId = opts.shopId;
    var categories = opts.categories || [];
    var sections = opts.sections || [];
    var onSaved = opts.onSaved || function () {};
    var onCancel = opts.onCancel || function () {};

    var ed = {
      productId: opts.productId || null,
      fields: { name: '', price: '', description: '', categoryId: '', status: 'draft', portion: '', ingredients: '', allergens: '', prep_time: '', lead_time_days: '0', fulfillment: null },
      photos: [], removedPhotos: [], options: [], sectionIds: []
    };

    function banner() { return '<div data-ed-banner aria-live="polite"></div>'; }

    function showError(msg) {
      var b = container.querySelector('[data-ed-banner]');
      b.innerHTML = '<div class="cc-alert cc-alert-danger" role="alert" style="margin-bottom:var(--cc-space-4);">' +
        CC.icon('warning') + '<div>' + esc(msg) + '</div></div>';
      hydrateIcons(b);
      b.scrollIntoView({ block: 'nearest' });
    }
    function showSuccess(msg) {
      var b = container.querySelector('[data-ed-banner]');
      b.innerHTML = '<div class="cc-alert cc-alert-success" role="status" style="margin-bottom:var(--cc-space-4);">' +
        CC.icon('check') + '<div>' + esc(msg) + '</div></div>';
      hydrateIcons(b);
    }

    function render() {
      var f = ed.fields;
      var catOpts = categories.map(function (c) {
        return '<option value="' + c.id + '"' + (f.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('');
      var statusOpts = STATUS_ORDER.map(function (s) {
        return '<option value="' + s + '"' + (f.status === s ? ' selected' : '') + '>' + esc(Auth.PRODUCT_STATUS_LABELS[s]) + '</option>';
      }).join('');
      var ff = f.fulfillment || {};
      var photosHtml = ed.photos.length
        ? '<div class="ob-photo-grid">' + ed.photos.map(function (ph, i) {
            return '<div class="ob-photo" data-cover="' + !!ph.is_cover + '">' +
              '<img src="' + esc(CC.imgUrl('cc-product-images', ph.path)) + '" alt="Product photo ' + (i + 1) + '">' +
              (ph.is_cover ? '<span class="ob-cover-tag">Cover</span>' : '') +
              (ph.ai_generated ? '<span class="ob-ai-tag">AI</span>' : '') +
              '<div class="ob-photo-tools">' +
              '<button type="button" data-ph-act="cover" data-ph="' + i + '"' + (ph.is_cover ? ' disabled' : '') + '>Cover</button>' +
              '<button type="button" data-ph-act="left" data-ph="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move left">←</button>' +
              '<button type="button" data-ph-act="right" data-ph="' + i + '"' + (i === ed.photos.length - 1 ? ' disabled' : '') + ' aria-label="Move right">→</button>' +
              '<button type="button" data-ph-act="del" data-ph="' + i + '" aria-label="Delete photo">✕</button>' +
              '</div></div>';
          }).join('') + '</div>'
        : '<p class="cc-hint">No photos yet — add up to 20.</p>';
      var aiHtml = ed.photos.map(function (ph, i) {
        return '<label class="cc-check" style="margin-bottom:var(--cc-space-2);"><input type="checkbox" data-ai="' + i + '" ' +
          (ph.ai_generated ? 'checked' : '') + '> <span>Photo ' + (i + 1) + ' is AI-generated</span></label>';
      }).join('');
      var optionsHtml = ed.options.map(function (opt, oi) {
        var choices = (opt.choices || []).map(function (ch, ci) {
          return '<div class="ob-choice-row">' +
            '<input class="cc-input" data-opt="' + oi + '" data-choice-label="' + ci + '" value="' + esc(ch.label || '') + '" placeholder="Choice label" aria-label="Choice label">' +
            '<input class="cc-input" data-opt="' + oi + '" data-choice-delta="' + ci + '" value="' + esc(ch.price_delta_cents != null ? (ch.price_delta_cents / 100).toFixed(2) : '') + '" placeholder="+$0.00" inputmode="decimal" aria-label="Price change in dollars">' +
            '<button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-choice-del="' + oi + ':' + ci + '" aria-label="Remove choice">✕</button></div>';
        }).join('');
        return '<div class="ob-option-card"><div class="ob-choice-row">' +
          '<input class="cc-input" data-opt-name="' + oi + '" value="' + esc(opt.name) + '" placeholder="Option name — e.g. Size" aria-label="Option name">' +
          '<button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-opt-del="' + oi + '">Remove</button></div>' +
          '<label class="cc-check" style="margin-bottom:var(--cc-space-2);"><input type="checkbox" data-opt-req="' + oi + '" ' + (opt.required ? 'checked' : '') + '> <span>Required</span></label>' +
          choices +
          '<button type="button" class="cc-btn cc-btn-outline cc-btn-sm" data-choice-add="' + oi + '">' + CC.icon('plus') + ' Add choice</button></div>';
      }).join('');
      var sectionsHtml = sections.map(function (sec) {
        return '<label class="cc-check" style="margin-bottom:var(--cc-space-2);"><input type="checkbox" data-sec="' + sec.id + '" ' +
          (ed.sectionIds.indexOf(sec.id) !== -1 ? 'checked' : '') + '> <span>' + esc(sec.name) + '</span></label>';
      }).join('');

      container.innerHTML = banner() +
        '<h2 class="cc-h2">' + (ed.productId ? 'Edit product' : 'New product') + '</h2>' +
        '<div class="cc-field"><label class="cc-label" for="ed-name">Product name <span class="cc-req" aria-hidden="true">*</span></label>' +
        '<input class="cc-input" id="ed-name" maxlength="120" value="' + esc(f.name) + '"><div data-err="ed-name"></div></div>' +
        '<div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--cc-space-3);">' +
        '<div class="cc-field"><label class="cc-label" for="ed-price">Price (USD) <span class="cc-req" aria-hidden="true">*</span></label>' +
        '<input class="cc-input" id="ed-price" inputmode="decimal" value="' + esc(f.price) + '" placeholder="12.00"><div data-err="ed-price"></div></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-cat">Category <span class="cc-req" aria-hidden="true">*</span></label>' +
        '<select class="cc-select" id="ed-cat"><option value="">Choose…</option>' + catOpts + '</select><div data-err="ed-cat"></div></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-status">Status</label>' +
        '<select class="cc-select" id="ed-status">' + statusOpts + '</select>' +
        '<p class="cc-hint">Only Active / Paused / Sold out items show on your storefront.</p></div></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-desc">Description</label>' +
        '<textarea class="cc-textarea" id="ed-desc" maxlength="2000">' + esc(f.description) + '</textarea></div>' +
        '<div class="cc-field"><span class="cc-label">Photos <span class="cc-caption">(' + ed.photos.length + '/20)</span></span>' +
        photosHtml +
        (ed.photos.length < 20
          ? '<label class="cc-btn cc-btn-outline cc-btn-sm" for="ed-photo" style="cursor:pointer; align-self:flex-start;">' + CC.icon('upload') + ' Add photos</label>' +
            '<input type="file" id="ed-photo" accept="image/*" multiple class="pg-sr-only">'
          : '<p class="cc-hint">You\u2019ve reached 20 photos — the maximum.</p>') +
        '<div data-err="ed-photo"></div>' +
        (aiHtml ? '<div style="margin-top:var(--cc-space-2);"><span class="cc-label">AI-generated images</span>' +
          '<p class="cc-hint">Check any photo that was AI-generated. We never present AI images as real photos.</p>' + aiHtml + '</div>' : '') +
        '</div>' +
        '<div class="cc-field"><span class="cc-label">Variants / options</span>' + optionsHtml +
        '<button type="button" class="cc-btn cc-btn-outline cc-btn-sm" id="ed-opt-add">' + CC.icon('plus') + ' Add option group</button></div>' +
        '<div style="display:grid; grid-template-columns: 1fr 1fr; gap: var(--cc-space-3);">' +
        '<div class="cc-field"><label class="cc-label" for="ed-portion">Portion</label>' +
        '<input class="cc-input" id="ed-portion" maxlength="60" value="' + esc(f.portion) + '" placeholder="per dozen"></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-lead">Lead time (days)</label>' +
        '<input class="cc-input" id="ed-lead" type="number" min="0" max="60" value="' + esc(f.lead_time_days) + '"></div></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-ing">Ingredients</label>' +
        '<textarea class="cc-textarea" id="ed-ing" maxlength="2000" style="min-height:80px;">' + esc(f.ingredients) + '</textarea></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-alg">Allergens</label>' +
        '<input class="cc-input" id="ed-alg" maxlength="300" value="' + esc(f.allergens) + '" placeholder="e.g. Contains: milk, wheat, eggs"></div>' +
        '<div class="cc-field"><label class="cc-label" for="ed-prep">Prep time</label>' +
        '<input class="cc-input" id="ed-prep" maxlength="120" value="' + esc(f.prep_time) + '"></div>' +
        '<div class="cc-field"><span class="cc-label">Fulfillment for this product</span>' +
        '<label class="cc-check"><input type="checkbox" id="ed-f-pickup" ' + (ff.pickup ? 'checked' : '') + '> <span>Pickup</span></label>' +
        '<label class="cc-check"><input type="checkbox" id="ed-f-delivery" ' + (ff.delivery ? 'checked' : '') + '> <span>Delivery</span></label>' +
        '<label class="cc-check"><input type="checkbox" id="ed-f-shipping" ' + (ff.shipping ? 'checked' : '') + '> <span>Shipping</span></label></div>' +
        '<div class="cc-field"><span class="cc-label">Menu sections</span>' +
        (sectionsHtml || '<p class="cc-hint">No sections yet — create your first below.</p>') +
        '<div style="display:flex; gap:var(--cc-space-2); margin-top:var(--cc-space-2);">' +
        '<input class="cc-input" id="ed-newsec" maxlength="60" placeholder="New section — e.g. Tamales">' +
        '<button type="button" class="cc-btn cc-btn-outline" id="ed-sec-add">Add</button></div></div>' +
        '<div class="ob-nav">' +
        '<button type="button" class="cc-btn cc-btn-outline" id="ed-cancel">Cancel</button>' +
        '<button type="button" class="cc-btn cc-btn-primary" id="ed-save">Save product</button></div>' +
        (ed.productId ?
          '<div style="margin-top:var(--cc-space-5); border-top:1px solid var(--cc-border); padding-top:var(--cc-space-4);">' +
          '<p class="cc-label" style="color:var(--cc-danger-ink);">Danger zone</p>' +
          '<div style="display:flex; gap:var(--cc-space-2); flex-wrap:wrap;">' +
          '<button type="button" class="cc-btn cc-btn-outline" id="ed-archive">Archive (delist)</button>' +
          '<button type="button" class="cc-btn cc-btn-danger" id="ed-del">Delete permanently…</button></div>' +
          '<p class="cc-hint">Archiving hides the product from your storefront. Permanent deletion is blocked by the database when the product has order history.</p></div>'
          : '');

      hydrateIcons(container);
      wire();
    }

    function fieldErr(inputId, msg) {
      var box = container.querySelector('[data-err="' + inputId + '"]');
      if (box) {
        box.innerHTML = '<p class="cc-error-text" role="alert">' + CC.icon('warning') + '<span>' + esc(msg) + '</span></p>';
        hydrateIcons(box);
      }
      var input = document.getElementById(inputId);
      if (input) input.setAttribute('aria-invalid', 'true');
    }

    function collect() {
      var f = ed.fields;
      var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
      f.name = g('ed-name'); f.price = g('ed-price'); f.description = g('ed-desc');
      f.categoryId = g('ed-cat'); f.status = g('ed-status');
      f.portion = g('ed-portion'); f.ingredients = g('ed-ing');
      f.allergens = g('ed-alg'); f.prep_time = g('ed-prep');
      f.lead_time_days = g('ed-lead');
      f.fulfillment = {
        pickup: document.getElementById('ed-f-pickup').checked,
        delivery: document.getElementById('ed-f-delivery').checked,
        shipping: document.getElementById('ed-f-shipping').checked
      };
      var opts = [];
      container.querySelectorAll('[data-opt-name]').forEach(function (nameEl) {
        var oi = parseInt(nameEl.getAttribute('data-opt-name'), 10);
        var reqEl = container.querySelector('[data-opt-req="' + oi + '"]');
        var choices = [];
        container.querySelectorAll('[data-choice-label]').forEach(function (labEl) {
          if (parseInt(labEl.getAttribute('data-opt'), 10) !== oi) return;
          var ci = labEl.getAttribute('data-choice-label');
          var deltaEl = container.querySelector('[data-choice-delta="' + ci + '"][data-opt="' + oi + '"]');
          var delta = 0;
          if (deltaEl && deltaEl.value.trim() !== '') {
            var dv = parseFloat(deltaEl.value.replace(/[$,]/g, ''));
            if (!isNaN(dv)) delta = Math.round(dv * 100);
          }
          choices.push({ label: labEl.value.trim(), price_delta_cents: delta });
        });
        opts[oi] = { name: nameEl.value.trim(), required: !!(reqEl && reqEl.checked), choices: choices };
      });
      ed.options = opts.filter(function (o) { return o && o.name; });
      ed.sectionIds = [];
      container.querySelectorAll('[data-sec]').forEach(function (cb) {
        if (cb.checked) ed.sectionIds.push(cb.getAttribute('data-sec'));
      });
      container.querySelectorAll('[data-ai]').forEach(function (cb) {
        var i = parseInt(cb.getAttribute('data-ai'), 10);
        if (ed.photos[i]) ed.photos[i].ai_generated = cb.checked;
      });
    }

    function save() {
      collect();
      var f = ed.fields, errs = 0;
      if (f.name.trim().length < 2) { fieldErr('ed-name', 'Give your product a name.'); errs++; }
      var priceNum = parseFloat(String(f.price).replace(/[$,]/g, ''));
      if (isNaN(priceNum) || priceNum < 0) { fieldErr('ed-price', 'Enter a valid price (0 or more).'); errs++; }
      if (!f.categoryId) { fieldErr('ed-cat', 'Choose a category.'); errs++; }
      if (errs) return;
      var btn = document.getElementById('ed-save');
      btn.disabled = true; btn.textContent = 'Saving…';

      var payload = {
        fields: {
          name: f.name.trim(), price_cents: Math.round(priceNum * 100),
          description: f.description.trim() || null, category_id: f.categoryId,
          status: f.status, portion: f.portion.trim() || null,
          ingredients: f.ingredients.trim() || null, allergens: f.allergens.trim() || null,
          prep_time: f.prep_time.trim() || null,
          lead_time_days: Math.max(0, parseInt(f.lead_time_days, 10) || 0),
          fulfillment: f.fulfillment
        },
        photos: ed.photos, removedPhotos: ed.removedPhotos,
        options: ed.options, sectionIds: ed.sectionIds
      };
      var chain = ed.productId
        ? Promise.resolve(ed.productId)
        : CC.sb.from('cc_products').insert({
            shop_id: shopId, name: f.name.trim() || 'Untitled product', price_cents: 0,
            category_id: f.categoryId || null, status: 'draft', fulfillment: f.fulfillment
          }).select().single().then(function (r) {
            if (r.error) throw r.error;
            ed.productId = r.data.id;
            return ed.productId;
          });
      chain.then(function (pid) { return Products.persist(pid, payload); })
        .then(function () {
          ed.removedPhotos = [];
          showSuccess('Product saved.');
          onSaved(ed.productId);
        })
        .catch(function (err) { showError(err.message); })
        .then(function () { btn.disabled = false; btn.textContent = 'Save product'; });
    }

    function wire() {
      document.getElementById('ed-cancel').addEventListener('click', function () { collect(); onCancel(); });
      document.getElementById('ed-save').addEventListener('click', save);

      var photoInput = document.getElementById('ed-photo');
      if (photoInput) photoInput.addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files || []);
        if (!files.length) return;
        var remaining = 20 - ed.photos.length;
        if (files.length > remaining) {
          fieldErr('ed-photo', 'You can add ' + remaining + ' more photo(s) — 20 max.');
          files = files.slice(0, Math.max(0, remaining));
        }
        if (!files.length) return;
        /* Ensure the product row exists before uploading (path needs productId). */
        var ready = ed.productId ? Promise.resolve(ed.productId) :
          CC.sb.from('cc_products').insert({
            shop_id: shopId, name: ed.fields.name.trim() || 'Untitled product', price_cents: 0,
            category_id: ed.fields.categoryId || null, status: 'draft', fulfillment: ed.fields.fulfillment || {}
          }).select().single().then(function (r) {
            if (r.error) throw r.error;
            ed.productId = r.data.id;
            return ed.productId;
          });
        ready.then(function () {
          var chain = Promise.resolve();
          files.forEach(function (file) {
            chain = chain.then(function () {
              return Auth.uploadImage('cc-product-images', file, 'products/' + ed.productId)
                .then(function (path) {
                  ed.photos.push({ path: path, name: file.name, is_cover: ed.photos.length === 0, ai_generated: false });
                });
            });
          });
          return chain;
        }).then(function () { collect(); render(); })
          .catch(function (err) { fieldErr('ed-photo', err.message); });
      });

      container.querySelectorAll('[data-ph-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var i = parseInt(this.getAttribute('data-ph'), 10);
          var act = this.getAttribute('data-ph-act');
          if (act === 'cover') ed.photos.forEach(function (p, k) { p.is_cover = k === i; });
          else if (act === 'left' && i > 0) { var t = ed.photos[i - 1]; ed.photos[i - 1] = ed.photos[i]; ed.photos[i] = t; }
          else if (act === 'right' && i < ed.photos.length - 1) { var t2 = ed.photos[i + 1]; ed.photos[i + 1] = ed.photos[i]; ed.photos[i] = t2; }
          else if (act === 'del') {
            var gone = ed.photos.splice(i, 1)[0];
            if (gone && gone.id) ed.removedPhotos.push(gone);
            else if (gone && gone.path) Auth.deleteImage('cc-product-images', gone.path);
            if (gone && gone.is_cover && ed.photos.length) ed.photos[0].is_cover = true;
          }
          collect(); render();
        });
      });

      document.getElementById('ed-opt-add').addEventListener('click', function () {
        collect();
        ed.options.push({ name: '', required: false, choices: [{ label: '', price_delta_cents: 0 }] });
        render();
      });
      container.querySelectorAll('[data-opt-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          collect(); ed.options.splice(parseInt(this.getAttribute('data-opt-del'), 10), 1); render();
        });
      });
      container.querySelectorAll('[data-choice-add]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          collect();
          ed.options[parseInt(this.getAttribute('data-choice-add'), 10)].choices.push({ label: '', price_delta_cents: 0 });
          render();
        });
      });
      container.querySelectorAll('[data-choice-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          collect();
          var parts = this.getAttribute('data-choice-del').split(':');
          ed.options[parseInt(parts[0], 10)].choices.splice(parseInt(parts[1], 10), 1);
          render();
        });
      });

      document.getElementById('ed-sec-add').addEventListener('click', function () {
        var nameEl = document.getElementById('ed-newsec');
        var name = nameEl.value.trim();
        if (!name) return;
        collect();
        CC.sb.from('cc_menu_sections').insert({ shop_id: shopId, name: name, position: sections.length })
          .select().single().then(function (r) {
            if (r.error) {
              if (String(r.error.code) === '23505') {
                return CC.sb.from('cc_menu_sections').select('*').eq('shop_id', shopId).eq('name', name).single()
                  .then(function (r2) { if (r2.error) throw r2.error; return r2.data; });
              }
              throw r.error;
            }
            return r.data;
          }).then(function (sec) {
            if (!sections.some(function (s) { return s.id === sec.id; })) sections.push(sec);
            if (ed.sectionIds.indexOf(sec.id) === -1) ed.sectionIds.push(sec.id);
            render();
          }).catch(function (err) { showError(err.message); });
      });

      var archBtn = document.getElementById('ed-archive');
      if (archBtn) archBtn.addEventListener('click', function () {
        if (!window.confirm('Archive this product? It will be hidden from your storefront. You can re-activate it later.')) return;
        archBtn.disabled = true;
        collect();
        var done = ed.productId ? Products.archive(ed.productId) : Promise.resolve();
        done.then(function () { showSuccess('Product archived.'); onSaved(ed.productId); })
          .catch(function (err) { showError(err.message); archBtn.disabled = false; });
      });

      var delBtn = document.getElementById('ed-del');
      if (delBtn) delBtn.addEventListener('click', function () {
        if (!window.confirm('Permanently delete this product? This cannot be undone.')) return;
        if (!window.confirm('Last chance — really delete "' + (ed.fields.name || 'this product') + '" forever?')) return;
        delBtn.disabled = true; delBtn.textContent = 'Deleting…';
        Products.hardDelete(ed.productId).then(function () {
          onSaved(null);
        }).catch(function (err) {
          delBtn.disabled = false; delBtn.textContent = 'Delete permanently…';
          /* The DB blocks this when order history exists — show its message honestly. */
          showError('Could not delete: ' + err.message + ' Archive the product instead to hide it from your storefront.');
        });
      });
    }

    /* Load existing product (if any), then render. */
    if (ed.productId) {
      container.innerHTML = '<p class="cc-muted">Loading product…</p>';
      Products.loadFull(ed.productId).then(function (full) {
        var p = full.product;
        ed.fields = {
          name: p.name || '', price: (p.price_cents / 100).toFixed(2),
          description: p.description || '', categoryId: p.category_id || '',
          status: p.status || 'draft', portion: p.portion || '',
          ingredients: p.ingredients || '', allergens: p.allergens || '',
          prep_time: p.prep_time || '', lead_time_days: String(p.lead_time_days || 0),
          fulfillment: p.fulfillment || {}
        };
        ed.photos = (full.photos || []).map(function (img) {
          return { id: img.id, path: img.storage_path, name: img.storage_path.split('/').pop(), is_cover: img.is_cover, ai_generated: img.ai_generated };
        });
        ed.options = (full.options || []).map(function (o) {
          return { id: o.id, name: o.name, required: o.required, choices: o.choices || [] };
        });
        ed.sectionIds = full.sectionIds || [];
        render();
      }).catch(function (err) {
        container.innerHTML = CC.states.error({ title: 'Could not load product', body: err.message });
      });
    } else {
      render();
    }
  };

  /* ------------------------------------------------------------------ */
  /* Product list (dashboard "My Products")                               */
  /* ------------------------------------------------------------------ */
  Products.listWithCovers = function (shopId) {
    ensure();
    return CC.sb.from('cc_products').select('*').eq('shop_id', shopId).order('updated_at', { ascending: false })
      .then(function (r) {
        if (r.error) throw r.error;
        var products = r.data || [];
        var ids = products.map(function (p) { return p.id; });
        if (!ids.length) return products;
        return CC.sb.from('cc_product_images').select('product_id, storage_path')
          .in('product_id', ids).eq('is_cover', true)
          .then(function (ri) {
            var covers = {};
            (ri.data || []).forEach(function (img) {
              if (!covers[img.product_id]) covers[img.product_id] = img.storage_path;
            });
            products.forEach(function (p) { p._cover = covers[p.id] || null; });
            return products;
          });
      });
  };

  Products.renderList = function (container, products, callbacks) {
    ensure();
    callbacks = callbacks || {};
    if (!products.length) {
      container.innerHTML = CC.states.empty({
        icon: 'shopping-bag', title: 'No products yet',
        body: 'Add your first product to start building your menu.'
      });
      hydrateIcons(container);
      return;
    }
    container.innerHTML = '<div style="display:grid; gap:var(--cc-space-3);">' + products.map(function (p) {
      var label = Auth.PRODUCT_STATUS_LABELS[p.status] || p.status;
      var badgeCls = p.status === 'active' ? 'cc-badge-ready' : p.status === 'sold_out' ? 'cc-badge-soldout' : p.status === 'archived' ? 'cc-badge' : 'cc-badge-warn';
      var img = p._cover ? CC.imgUrl('cc-product-images', p._cover) : 'assets/img/placeholder-food.jpg';
      return '<div class="cc-card" style="display:flex; gap:var(--cc-space-3); align-items:center; padding:var(--cc-space-3);">' +
        '<img src="' + esc(img) + '" alt="" style="width:64px; height:64px; object-fit:cover; border-radius:var(--cc-radius-md); flex:none;">' +
        '<div style="flex:1; min-width:0;">' +
        '<p style="font-weight:700; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(p.name) + '</p>' +
        '<p class="cc-small cc-muted" style="margin:0;">' + esc(CC.centsToPrice(p.price_cents)) +
        (p.total_orders ? ' · ' + p.total_orders + ' order' + (p.total_orders === 1 ? '' : 's') : '') + '</p>' +
        '<span class="cc-badge ' + badgeCls + '">' + esc(label) + '</span></div>' +
        '<div style="display:flex; gap:var(--cc-space-2); flex:none;">' +
        '<button type="button" class="cc-btn cc-btn-outline cc-btn-sm" data-p-edit="' + p.id + '">' + CC.icon('edit') + ' Edit</button>' +
        (p.status !== 'archived'
          ? '<button type="button" class="cc-btn cc-btn-ghost cc-btn-sm" data-p-archive="' + p.id + '">Archive</button>'
          : '') +
        '</div></div>';
    }).join('') + '</div>';
    hydrateIcons(container);
    container.querySelectorAll('[data-p-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { (callbacks.onEdit || function () {})(this.getAttribute('data-p-edit')); });
    });
    container.querySelectorAll('[data-p-archive]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!window.confirm('Archive this product? It will be hidden from your storefront.')) return;
        var id = this.getAttribute('data-p-archive');
        Products.archive(id).then(function () { (callbacks.onChanged || function () {})(); })
          .catch(function (err) { window.alert(err.message); });
      });
    });
  };
})();
