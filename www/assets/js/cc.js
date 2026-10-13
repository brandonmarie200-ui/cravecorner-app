/* ==========================================================================
   CraveCorner — shared Supabase client (cc.js)
   --------------------------------------------------------------------------
   Include order on every page (before assets/js/app.js):
     <script src="assets/js/supabase.min.js"></script>  <!-- vendored, no CDN -->
     <script src="assets/js/cc.js"></script>

   Extends window.CC (created here if app.js hasn't run yet) with:
     CC.sb        Supabase client (null if supabase.min.js failed to load)
     CC.live      false until the backend probe succeeds
     CC.user      current auth user (null when signed out)
     CC.isAdmin   true when the signed-in user's email is in cc_admins
     CC.ready     Promise resolving { live, user } once boot finishes
                  (probe + session restore). Await it before branching.
     CC.signUp / CC.signIn / CC.signOut / CC.resetPassword / CC.onAuth(cb)
     CC.ensureProfile(user, displayName)   create cc_profiles row if missing
     CC.refreshSession() / CC.refreshAdmin()
     CC.centsToPrice(cents)  1299 -> "$12.99"   (money is integer cents)
     CC.imgUrl(bucket, path) resolve a storage path to a public URL

   LIVE vs DEMO rule:
     On boot cc.js probes cc_categories with .select("id").limit(1)
     (a REAL get — never a head/count probe). If it succeeds, CC.live = true
     and the demo.js sample data is hidden (arrays emptied, demo banner
     removed/suppressed). demo.js stays as the fallback ONLY when the probe
     fails (CC.live stays false).
     Pages MUST branch on CC.live (after awaiting CC.ready): when live,
     query Supabase and never read window.CC_DEMO.
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});

  CC.SUPABASE_URL = "https://ynuokayxwuoxiwsjaetx.supabase.co";
  CC.SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InludW9rYXl4d3VveGl3c2phZXR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMzUzMzMsImV4cCI6MjEwNjkxMTMzM30.kLkVomR-9jNF3z1P81ozvhN722rxAPhUKVYBawPi_Bw";

  CC.live = false;
  CC.user = null;
  CC.isAdmin = false;

  var sb = null;
  try {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      sb = window.supabase.createClient(CC.SUPABASE_URL, CC.SUPABASE_ANON_KEY);
    }
  } catch (e) {
    sb = null;
  }
  CC.sb = sb;

  function noClient() {
    throw new Error("Supabase client failed to load (assets/js/supabase.min.js).");
  }

  /* Hide demo.js sample data once the backend is proven live.
     The CC_DEMO object itself is left in place (Stage 1 pages check for it),
     but its collections are emptied and the demo banner is removed. */
  function hideDemo() {
    try {
      var banner = document.getElementById("cc-demo-banner");
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      try { localStorage.setItem("cc_demo_banner", "dismissed"); } catch (e) {}
      var D = window.CC_DEMO;
      if (D && typeof D === "object") {
        Object.keys(D).forEach(function (k) {
          if (Array.isArray(D[k])) D[k] = [];
        });
      }
      // The footer claims "sample data shown" — no longer true once live.
      // renderFooter may not have run yet when the probe resolves first.
      var swapFooter = function () {
        var fp = document.querySelector(".cc-footer-bottom p");
        if (fp) {
          fp.textContent = "\u00A9 2026 CraveCorner \u00B7 Find your craving. Support someone local.";
          return true;
        }
        return false;
      };
      if (!swapFooter()) document.addEventListener("DOMContentLoaded", swapFooter);
      if (typeof CC.showDemoBanner === "function" && !CC.showDemoBanner._ccWrapped) {
        var orig = CC.showDemoBanner;
        var wrapped = function () {
          if (CC.live) return;
          return orig.apply(this, arguments);
        };
        wrapped._ccWrapped = true;
        CC.showDemoBanner = wrapped;
      }
    } catch (e) {}
  }

  CC.refreshAdmin = function () {
    if (!sb) { CC.isAdmin = false; return Promise.resolve(false); }
    if (!CC.user || !CC.user.email) { CC.isAdmin = false; return Promise.resolve(false); }
    // cc_admins is admin-readable only: non-admins get [] (not an error).
    return sb.from("cc_admins")
      .select("email")
      .eq("email", String(CC.user.email).toLowerCase())
      .limit(1)
      .then(function (r) {
        CC.isAdmin = !r.error && r.data && r.data.length > 0;
        return CC.isAdmin;
      })
      .catch(function () { CC.isAdmin = false; return false; });
  };

  CC.refreshSession = function () {
    if (!sb) { CC.user = null; CC.isAdmin = false; return Promise.resolve(null); }
    return sb.auth.getSession().then(function (s) {
      var u = (s && s.data && s.data.session && s.data.session.user) || null;
      CC.user = u;
      CC.isAdmin = false;
      // Admin check failing must not wipe the session: keep the user, drop the flag.
      return CC.refreshAdmin().catch(function () { CC.isAdmin = false; })
        .then(function () { return u; });
    }).catch(function () { CC.user = null; CC.isAdmin = false; return null; });
  };

  function boot() {
    if (!sb) return Promise.resolve({ live: false, user: null });
    var probe;
    try {
      // Backend probe: a REAL get. If cc_categories answers, the backend is live.
      probe = sb.from("cc_categories").select("id").limit(1);
    } catch (err) {
      probe = Promise.reject(err); // never let boot() throw synchronously
    }
    return Promise.resolve(probe).then(
      function (r) {
        // Probe answered with an error object (unreachable schema, RLS
        // denial, etc.): stay in demo mode. This MUST resolve, not throw —
        // pages branch on CC.ready.then() and a rejection would strand them.
        if (r && r.error) {
          CC.live = false; // demo.js stays as the fallback
          return CC.refreshSession();
        }
        CC.live = true;
        hideDemo();
        return CC.refreshSession();
      },
      function () {
        CC.live = false; // demo.js stays as the fallback
        return CC.refreshSession();
      }
    ).then(function (u) { return { live: CC.live, user: u }; });
  }

  CC.ready = boot();

  if (sb) {
    sb.auth.onAuthStateChange(function () { CC.refreshSession(); });
  }

  /* Create the cc_profiles row for a user if it doesn't exist yet.
     Safe to call on every sign-in. Returns the profile row or null
     (null when email confirmation is still pending — no session yet). */  CC.ensureProfile = function (user, displayName) {
    if (!sb) return Promise.resolve(null);
    if (!user) return Promise.resolve(null);
    return sb.from("cc_profiles").select("user_id").eq("user_id", user.id).limit(1)
      .then(function (r) {
        if (r.data && r.data.length) return r.data[0];
        var name = displayName ||
          (user.email ? String(user.email).split("@")[0] : "") || "Food lover";
        return sb.from("cc_profiles")
          .insert({ user_id: user.id, display_name: name })
          .select().single()
          .then(function (ins) { return ins.error ? null : ins.data; });
      })
      .catch(function () { return null; });
  };

  CC.signUp = function (email, password, displayName) {
    if (!sb) return Promise.reject(noClient());
    return sb.auth.signUp({ email: email, password: password }).then(function (r) {
      if (r.error) throw r.error;
      var user = r.data && r.data.user;
      return CC.ensureProfile(user, displayName).then(function () {
        return CC.refreshSession().then(function () { return r.data; });
      });
    });
  };

  CC.signIn = function (email, password) {
    if (!sb) return Promise.reject(noClient());
    return sb.auth.signInWithPassword({ email: email, password: password })
      .then(function (r) {
        if (r.error) throw r.error;
        return CC.ensureProfile(r.data.user).then(function () {
          return CC.refreshSession().then(function () { return r.data; });
        });
      });
  };

  CC.signOut = function () {
    if (!sb) return Promise.resolve();
    return sb.auth.signOut().then(function () {
      CC.user = null;
      CC.isAdmin = false;
    });
  };

  CC.resetPassword = function (email) {
    if (!sb) return Promise.reject(noClient());
    return sb.auth.resetPasswordForEmail(email).then(function (r) {
      if (r.error) throw r.error;
      return true;
    });
  };

  CC.onAuth = function (cb) {
    if (!sb) return function () {};
    var sub = sb.auth.onAuthStateChange(function (event, session) {
      cb(event, session && session.user ? session.user : null);
    });
    return function () { if (sub && sub.data && sub.data.subscription) sub.data.subscription.unsubscribe(); };
  };

  /* ---- small helpers ---------------------------------------------------- */
  CC.centsToPrice = function (cents) {
    return "$" + (Number(cents || 0) / 100).toFixed(2);
  };

  // DB image columns store bucket-relative PATHS; resolve to a public URL.
  CC.imgUrl = function (bucket, path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    if (!sb) return null;
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  };

  /* ---- Nearby filtering + live-row adapters (bugfix 2026-10-12) ----------
     Root causes fixed:
     1. CC.location was display-only; nothing filtered by it. CC.filterNearby
        now enforces the saved radius with real haversine distance once shops
        carry latitude/longitude (see sql/50_geocode.sql).
     2. Demo sections rendered before the backend probe resolved. Pages must
        branch on CC.ready: live -> Supabase queries via the adapters below;
        probe failure -> demo.js fallback (unchanged, still works). */

  /** Haversine distance in miles between two lat/lng points. */
  CC.geoMiles = function (lat1, lng1, lat2, lng2) {
    function rad(d) { return d * Math.PI / 180; }
    var R = 3958.8; // earth radius, miles
    var dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  // Nominatim (OpenStreetMap) courtesy limit: max 1 request/second.
  var _geoLastAt = 0;
  /** Geocode a free-text query ("Gonzales, TX") -> {lat, lng} | null.
      Never rejects: failure returns null (callers treat as "unknown"). */
  CC.geocode = function (query) {
    query = String(query || "").trim();
    if (!query) return Promise.resolve(null);
    var wait = Math.max(0, 1100 - (Date.now() - _geoLastAt));
    return new Promise(function (res) { setTimeout(res, wait); }).then(function () {
      _geoLastAt = Date.now();
      var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1" +
        "&countrycodes=us&q=" + encodeURIComponent(query);
      return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) {
        if (!r.ok) throw new Error("geocode HTTP " + r.status);
        return r.json();
      }).then(function (arr) {
        if (!arr || !arr.length) return null;
        var lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
        return (isFinite(lat) && isFinite(lng)) ? { lat: lat, lng: lng } : null;
      }).catch(function () { return null; });
    });
  };

  /** Resolve a CC.location ({zip, city, state, label}) to {lat, lng}.
      Result is cached in localStorage per location label. Null when the
      location can't be geocoded (callers fall back to city+state match). */
  CC.resolveLocCoords = function (loc) {
    if (!loc) return Promise.resolve(null);
    var label = loc.label || [loc.zip, loc.city, loc.state].filter(Boolean).join(" ");
    var key = "cc_geocode_" + label;
    try {
      var cached = localStorage.getItem(key);
      if (cached) {
        var c = JSON.parse(cached);
        if (c && isFinite(c.lat) && isFinite(c.lng)) return Promise.resolve(c);
      }
    } catch (e) {}
    var q = loc.zip
      ? [loc.zip, loc.city, loc.state].filter(Boolean).join(", ")
      : [loc.city, loc.state].filter(Boolean).join(", ");
    return CC.geocode(q).then(function (pt) {
      if (pt) { try { localStorage.setItem(key, JSON.stringify(pt)); } catch (e) {} }
      return pt;
    });
  };

  /** Miles from a shop row to a lat/lng. Null when the shop has no
      coordinates (pre-geocode shops) or the point is unknown. */
  CC.shopDistanceMiles = function (shop, lat, lng) {
    if (!shop || shop.latitude == null || shop.longitude == null) return null;
    // NOTE: isFinite(null) is true (null coerces to 0) — check null first.
    if (lat == null || lng == null) return null;
    lat = Number(lat); lng = Number(lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return CC.geoMiles(Number(shop.latitude), Number(shop.longitude), lat, lng);
  };

  function _eqCI(a, b) {
    a = String(a || "").trim().toLowerCase();
    b = String(b || "").trim().toLowerCase();
    return !!(a && b && a === b);
  }

  /* Filter shops to those within the saved location radius.
     - No location set          -> all shops (no filtering).
     - Shop WITH coordinates    -> haversine distance <= radius.
     - Shop WITHOUT coordinates -> exact city+state match. Honest fallback:
       a shop with no coordinates cannot be mile-filtered, so we match the
       finest location we actually know. Documented, not silently widened.
     Radius defaults to 25 when unset/invalid. coords = {lat, lng} | null. */
  CC.filterNearby = function (shops, loc, coords) {
    shops = shops || [];
    if (!loc || (!loc.city && !loc.zip)) return shops.slice();
    var radius = parseFloat(loc.radius);
    if (!isFinite(radius) || radius <= 0) radius = 25;
    var lat = coords && coords.lat, lng = coords && coords.lng;
    return shops.filter(function (s) {
      var d = CC.shopDistanceMiles(s, lat, lng);
      if (d == null) return _eqCI(s.city, loc.city) && _eqCI(s.state, loc.state);
      return d <= radius + 1e-9;
    });
  };

  /** A shop counts as "new" for 30 days after creation. */
  CC.isNewShop = function (created_at) {
    var t = new Date(created_at).getTime();
    return isFinite(t) && (Date.now() - t) < 30 * 864e5;
  };

  /* Map a cc_shops_public row onto the shape CC.shopCard renders.
     coverUrl/logoUrl are resolved storage URLs (or null -> placeholder). */
  CC.adaptShop = function (s) {
    s = s || {};
    var fulfill = [];
    if (s.fulfillment_pickup) fulfill.push("pickup");
    if (s.fulfillment_delivery) fulfill.push("delivery");
    if (s.fulfillment_shipping) fulfill.push("shipping");
    var art = s.banner_url || s.logo_url;
    return {
      id: s.id,
      name: s.name,
      city: s.city,
      state: s.state,
      coverUrl: art ? CC.imgUrl("cc-shop-images", art) : null,
      blurb: s.description || "",
      categories: [],
      fulfillment: fulfill,
      isNew: CC.isNewShop(s.created_at),
      latitude: s.latitude,
      longitude: s.longitude,
      _live: true
    };
  };

  /* Map a cc_products row (+ its cc_shops_public row) onto the shape
     CC.productCard renders. coverUrl = resolved storage URL (optional). */
  CC.adaptProduct = function (p, shop, coverUrl) {
    p = p || {};
    shop = shop || {};
    var fulfill = [];
    var f = p.fulfillment || {};
    if (f.pickup) fulfill.push("pickup");
    if (f.delivery) fulfill.push("delivery");
    if (f.shipping) fulfill.push("shipping");
    return {
      id: p.id,
      name: p.name,
      shopId: p.shop_id,
      _shopName: shop.name || "",
      _shopCity: shop.city || "",
      _shopState: shop.state || "",
      _shopLat: shop.latitude,
      _shopLng: shop.longitude,
      city: shop.city || "",
      state: shop.state || "",
      price: (Number(p.price_cents) || 0) / 100,
      priceUnit: p.portion || "",
      fulfillment: fulfill,
      badge: (Number(p.lead_time_days) || 0) > 0 ? "made" : "ready",
      imgUrl: coverUrl || null,
      description: p.description || "",
      _live: true
    };
  };

  /* Resilient read of the public shops view.
     build(qb) receives the query builder and returns the query promise.
     Falls back to a coordinate-free column list when sql/50_geocode.sql
     hasn't been applied yet (so the page works before AND after the
     migration instead of hard-failing). */
  var SHOP_COLS = "id,name,slug,description,logo_url,banner_url,city,state," +
    "service_area,fulfillment_pickup,fulfillment_delivery,fulfillment_shipping," +
    "hours,timezone,vacation_mode,vacation_until,accent_color,status," +
    "view_count,latitude,longitude,created_at,updated_at";
  var SHOP_COLS_BASIC = SHOP_COLS.replace(",latitude,longitude", "");
  CC.shopsPublic = function (build) {
    function attempt(cols) {
      return Promise.resolve(build(CC.sb.from("cc_shops_public").select(cols)));
    }
    return attempt(SHOP_COLS).then(function (r) {
      var msg = (r && r.error && r.error.message) || "";
      if (r && r.error && /column .* does not exist/i.test(msg)) {
        return attempt(SHOP_COLS_BASIC); // pre-migration backend
      }
      return r;
    });
  };
})();

/* ------------------------------------------------------------------ */
/* Web Push notifications                                              */
/* ------------------------------------------------------------------ */
(function () {
  'use strict';
  /* VAPID public key (the private key lives only on the push server). */
  var VAPID_PUBLIC = 'BKZZfnYvLYlmb6l6yc-HP1vtXMHBswwtdxtBhrrJn5JRP1hpc_R6yxH3hNlo_9FJLOqnvbYBIqKArOZfYWVe3yg';

  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  CC.push = {
    supported: function () {
      return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
    },
    permission: function () {
      if (!('Notification' in window)) return 'denied';
      return Notification.permission;
    },
    /* Returns the current subscription, or null. */
    getSubscription: function () {
      if (!this.supported()) return Promise.resolve(null);
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription();
      }).catch(function () { return null; });
    },
    /* Ask permission + subscribe. Saves the subscription to the DB. */
    subscribe: function () {
      var self = this;
      if (!this.supported()) return Promise.reject(new Error('Push notifications are not supported on this browser.'));
      if (!CC.sb || !CC.user) return Promise.reject(new Error('Log in first.'));
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
        });
      }).then(function (sub) {
        var json = sub.toJSON();
        return CC.sb.from('cc_push_subscriptions').upsert({
          user_id: CC.user.id,
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
          user_agent: navigator.userAgent.slice(0, 255)
        }, { onConflict: 'user_id,endpoint' }).then(function (r) {
          if (r.error) throw r.error;
          return sub;
        });
      });
    },
    unsubscribe: function () {
      return this.getSubscription().then(function (sub) {
        if (!sub) return null;
        var endpoint = sub.endpoint;
        return sub.unsubscribe().then(function () {
          if (CC.sb && CC.user) {
            return CC.sb.from('cc_push_subscriptions')
              .delete().eq('user_id', CC.user.id).eq('endpoint', endpoint);
          }
          return null;
        });
      });
    },
    /* Queue a push for another user (the server cron sends it). */
    queue: function (userId, title, body, url) {
      if (!CC.sb || !CC.user || !userId) return Promise.resolve(null);
      if (userId === CC.user.id) return Promise.resolve(null); /* don't notify self */
      return CC.sb.from('cc_push_queue').insert({
        user_id: userId, title: title, body: body, url: url || null
      }).then(function (r) {
        /* best effort — a failed queue insert never blocks the action */
        return null;
      });
    }
  };
})();
