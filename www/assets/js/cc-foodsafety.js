/* ==========================================================================
   CraveCorner — food-safety gating snippet (cc-foodsafety.js)
   Stage 6: Admin & Launch.
   --------------------------------------------------------------------------
   INTEGRATION NOTES FOR STAGE 2 (onboarding.html — not built yet at the time
   of writing; wire these calls in when it lands):

   1. ONBOARDING — add a "Food safety" step AFTER the basic shop details step:
        - state           → <select> of US states (required)
        - food category   → <select> from cc_categories (required)
        - fulfillment     → checkboxes: pickup / delivery / shipping (required ≥1)
        - declarations    → checkboxes, ALL required to continue:
            a. "I list known allergens on every product and note cross-contact risk."
            b. "I am responsible for complying with my state's cottage-food law,
                permits, and labeling rules. Rules vary by state."
            c. "I have (or will obtain before selling) any food-handler training
                my state/locality requires."  [allow "not required in my state"]
        - optional document upload (food-handler card, cottage-food registration,
          kitchen photo). NOTE: no dedicated verification bucket exists yet —
          store under cc-shop-images at "<uid>/verification/<file>" (public-read
          bucket; acceptable for seller-supplied docs) OR create a private
          bucket pre-launch (see ops/LAUNCH-CHECKLIST.md).
      On submit:
        const decl = CCFoodSafety.collectDeclarations(formValues);
        await CCFoodSafety.submitVerification(shopId, {
          doc_type: "onboarding-declarations",
          doc_url: uploadedDocPathOrNull,
          declarations: decl
        });
        // → row in cc_shop_verification, status='pending', for admin review.

   2. PRODUCT FORM (create.html / Stage 3 product editor) — after the product
      row is inserted:
        const check = CCFoodSafety.needsReview({
          categorySlug: selectedCategorySlug,
          fulfillment: { pickup, delivery, shipping }   // booleans
        });
        if (check.required) {
          await CCFoodSafety.holdForReview(productId, check.reasons);
          // toast: "This product is held for admin review before it can go live."
        }
      NEVER set a flagged product to 'active' automatically. The holding state
      is status='draft' — there is intentionally NO 'pending' product status in
      the schema; do not invent one client-side.

   3. DISPLAY HONESTY (shop/product pages, any stage):
        - verification row status='pending' → show "Seller-declared — not yet
          reviewed by CraveCorner" (or nothing at all).
        - status='approved' → may show "Declaration reviewed by CraveCorner".
          NEVER "verified safe", "health-inspected", or "certified".
        - no verification row → say nothing; do not imply any review happened.

   4. SELLER-FACING COPY (jurisdiction-neutral, from policies.html):
        "Rules vary by state; you are responsible for complying with your local
         cottage-food laws." Do not name specific state statutes — they change.

   ⚠ HONEST CAVEAT (RLS review finding, Stage 6):
   The current schema lets a seller INSERT a product with status='active'
   directly (cc_products owner-insert policy has no status guard), so this
   client-side gating is voluntary compliance until the insert guard lands.
   ops/LAUNCH-CHECKLIST.md carries the recommended trigger fix — treat it as
   a launch decision, not an afterthought.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var FS = (window.CCFoodSafety = window.CCFoodSafety || {});

  function sb() {
    if (!CC.sb) throw new Error("Supabase client failed to load (assets/js/supabase.min.js).");
    return CC.sb;
  }

  /* ---- review triggers ----------------------------------------------------
     A product is held for admin review when ANY of these are true.
     Conservative on purpose: false positives cost a review; false negatives
     cost trust. The reasons list is shown to the seller and stored for admins.
     Category slugs come from 30_seed.sql; fulfillment booleans mirror
     cc_shops.fulfillment_* / cc_products.fulfillment. */
  var SHIP_SENSITIVE_CATEGORIES = [
    "frozen-treats",    // cold-chain by mail
    "homemade-meals",   // perishable plates
    "catering",         // perishable spreads
    "drinks"            // spill / spoilage risk
  ];

  FS.needsReview = function (opts) {
    opts = opts || {};
    var reasons = [];
    var f = opts.fulfillment || {};
    var slug = String(opts.categorySlug || "");

    if (f.shipping) {
      reasons.push("Product is offered with shipping.");
      if (SHIP_SENSITIVE_CATEGORIES.indexOf(slug) !== -1) {
        reasons.push("Perishable category (" + slug + ") offered with shipping — cold-chain risk.");
      }
    }
    // Ready-to-eat perishables for delivery get a review when the seller's
    // state requires extra permits; we cannot know the state here, so flag
    // the pattern and let the admin check the declaration.
    if (f.delivery && (slug === "homemade-meals" || slug === "catering")) {
      reasons.push("Perishable ready-to-eat food offered for delivery.");
    }
    return { required: reasons.length > 0, reasons: reasons };
  };

  /* ---- declarations builder ------------------------------------------------
     Produces the JSONB stored in cc_shop_verification.declarations.
     Every acknowledgment carries a timestamp — "I agree" without a when is
     worthless in a dispute. */
  FS.collectDeclarations = function (v) {
    v = v || {};
    var now = new Date().toISOString();
    return {
      schema_version: 1,
      state: v.state || null,
      food_category: v.foodCategory || null,
      fulfillment: {
        pickup: !!v.pickup,
        delivery: !!v.delivery,
        shipping: !!v.shipping
      },
      allergen_label_ack: { value: !!v.allergenAck, at: now },
      cottage_food_law_ack: { value: !!v.cottageFoodAck, at: now },
      handler_training: v.handlerTraining || "unknown", // 'have' | 'will-obtain' | 'not-required' | 'unknown'
      kitchen_type: "home",
      honesty_note: "Seller-declared. Not independently verified by CraveCorner."
    };
  };

  FS.declarationsValid = function (decl) {
    return !!(decl && decl.state && decl.foodCategory &&
      (decl.fulfillment && (decl.fulfillment.pickup || decl.fulfillment.delivery || decl.fulfillment.shipping)) &&
      decl.allergen_label_ack && decl.allergen_label_ack.value &&
      decl.cottage_food_law_ack && decl.cottage_food_law_ack.value);
  };

  /* ---- writes ----------------------------------------------------------------
     submitVerification: seller inserts their own declaration row.
       RLS: cc_shop_verification owner-insert requires the shop to belong to
       auth.uid(). Status defaults to 'pending' (DB default) — never set
       'approved' client-side.
     holdForReview: admin-review hold for a flagged product.
       Sets status='draft' (the schema's holding state) and records WHY in a
       linked verification row so the admin queue has context. */
  FS.submitVerification = function (shopId, payload) {
    payload = payload || {};
    return sb().from("cc_shop_verification").insert({
      shop_id: shopId,
      doc_type: payload.doc_type || "onboarding-declarations",
      doc_url: payload.doc_url || null,
      declarations: payload.declarations || {}
      // status defaults to 'pending' — do NOT set approved here, ever.
    }).select().single().then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  };

  FS.holdForReview = function (productId, reasons) {
    return sb().from("cc_products").update({ status: "draft" }).eq("id", productId)
      .then(function (r) {
        if (r.error) throw r.error;
        return sb().from("cc_products").select("shop_id,name").eq("id", productId).single();
      })
      .then(function (pr) {
        if (pr.error || !pr.data) return true;
        return FS.submitVerification(pr.data.shop_id, {
          doc_type: "product-review-request",
          declarations: {
            schema_version: 1,
            product_id: productId,
            product_name: pr.data.name,
            held_for_review: true,
            review_reasons: reasons || [],
            held_at: new Date().toISOString(),
            honesty_note: "Auto-held by food-safety gating. Seller-declared, not verified."
          }
        }).then(function () { return true; });
      });
  };
})();
