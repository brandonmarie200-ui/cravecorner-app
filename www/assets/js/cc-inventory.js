/* ==========================================================================
   CraveCorner — Stage 3: Food Availability (cc-inventory.js)
   --------------------------------------------------------------------------
   Inventory management for sellers: per-occurrence quantity adjustments,
   sold-out marking, and the inventory log.

   DB contract (sql/SCHEMA.md + 00_schema.sql):
     - cc_occurrences.quantity_left ≥ 0 is enforced by the DB with a loud
       trigger error — surface error.message honestly, it was written for
       the seller.
     - Manual adjustments MUST write a cc_inventory_logs row
       (product_id, occurrence_id, change ±, reason, actor_id).
     - cc_inventory_logs.product_id is NOT NULL: for full-menu schedules
       (schedule.product_id NULL) the log is written against the schedule's
       first item product with a "[Full daily menu]" reason prefix.
     - Auto mode: the DB decrements quantity_left on order confirm and
       restores on decline/cancel — sellers do NOT hand-edit quantity_left
       in auto mode (the UI disables it with an explanation).
     - Never reduce below held reservations without an explicit, acknowledged
       confirm dialog (reservations are queried first, right here).

   Requires: assets/js/cc.js (CC), assets/js/cc-menu.js (CC_MENU).
   ========================================================================== */
(function () {
  "use strict";

  var CC = (window.CC = window.CC || {});
  var M = window.CC_MENU || {};
  var INV = (window.CC_INV = window.CC_INV || {});

  function needSb() {
    if (typeof M.needSb === "function") return M.needSb();
    if (!CC.live || !CC.sb) throw new Error("The live backend is not connected yet.");
    return CC.sb;
  }

  /**
   * Inventory overview: products joined to their upcoming occurrences
   * (next 21 days). Returns [{ product, occurrence, schedule }] sorted by date.
   */
  INV.getOverview = function (shopId) {
    var sb = needSb();
    return M.getProducts(shopId).then(function (products) {
      return M.getSchedules(shopId).then(function (schedules) {
        var shopTz = null;
        return M.getMyShop().then(function (shop) {
          shopTz = shop ? shop.timezone : "UTC";
          var today = M.todayInTz(shopTz);
          return M.getOccurrences(schedules, today, M.addDays(today, 21))
            .then(function (occs) {
              var prodById = {};
              products.forEach(function (p) { prodById[p.id] = p; });
              var rows = [];
              occs.forEach(function (o) {
                var s = o._schedule;
                if (!s) return;
                var pids = s.product_id ? [s.product_id]
                  : (s._items || []).map(function (it) { return it.product_id; });
                pids.forEach(function (pid) {
                  if (prodById[pid]) rows.push({ product: prodById[pid], occurrence: o, schedule: s });
                });
              });
              return rows;
            });
        });
      });
    });
  };

  /** Recent inventory log entries for a product (newest first). */
  INV.getLogs = function (productId, limit) {
    var sb = needSb();
    return sb.from("cc_inventory_logs")
      .select("id,change,reason,actor_id,created_at,occurrence_id")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(50, +limit || 20)))
      .then(function (r) {
        if (r.error) throw r.error;
        var logs = r.data || [];
        var oids = logs.filter(function (l) { return l.occurrence_id; })
          .map(function (l) { return l.occurrence_id; });
        if (!oids.length) return logs;
        return sb.from("cc_occurrences").select("id,occ_date").in("id", oids)
          .then(function (r2) {
            if (r2.error) throw r2.error;
            var byId = {};
            (r2.data || []).forEach(function (o) { byId[o.id] = o.occ_date; });
            logs.forEach(function (l) { l._occ_date = byId[l.occurrence_id] || null; });
            return logs;
          });
      });
  };

  /**
   * Manually set an occurrence's quantity_left (manual inventory_mode only).
   * - Warns (acknowledged confirm) before dropping below held reservations.
   * - quantity_left = 0 flips status to sold_out; raising above 0 revives.
   * - Always writes a cc_inventory_logs row with the seller's reason.
   * Returns { status: 'done' } or { status: 'cancelled' }.
   */
  INV.adjustOccurrence = function (occId, newQty, reason) {
    var sb = needSb();
    if (!CC.user) return Promise.reject(new Error("Please sign in first."));
    newQty = (newQty === "" || newQty == null) ? null : Math.floor(+newQty);
    if (newQty !== null && (isNaN(newQty) || newQty < 0)) {
      return Promise.reject(new Error("Quantity can't be negative."));
    }
    if (!reason || !String(reason).trim()) {
      return Promise.reject(new Error("Add a reason — it's written to the inventory log."));
    }
    reason = String(reason).trim();
    return sb.from("cc_occurrences")
      .select("id,schedule_id,occ_date,quantity,quantity_left,status")
      .eq("id", occId).single()
      .then(function (r) {
        if (r.error) throw r.error;
        var occ = r.data;
        return sb.from("cc_schedules")
          .select("id,product_id,inventory_mode,cc_schedule_items(product_id)")
          .eq("id", occ.schedule_id).single()
          .then(function (rs) {
            if (rs.error) throw rs.error;
            var sched = rs.data;
            if (sched.inventory_mode === "auto") {
              throw new Error("This schedule uses Auto inventory — the quantity updates " +
                "itself when you confirm or decline orders. Switch the schedule to " +
                "Manual to adjust quantities by hand.");
            }
            return M.getHeldQty(occId).then(function (held) {
              var go = Promise.resolve(true);
              if (newQty !== null && newQty < held) {
                go = M.confirmDialog({
                  title: "Below confirmed reservations",
                  bodyHtml: "<p><strong>" + held + " unit(s)</strong> on " +
                    CC.esc(M.fmtDateLong(occ.occ_date)) +
                    " are already held for confirmed orders.</p>" +
                    "<p>Setting the quantity to <strong>" + newQty + "</strong> goes below " +
                    "that. The held reservations stay untouched — confirmed orders are " +
                    "never changed silently — and the slot will show as oversold until " +
                    "you work it out with the customer.</p>",
                  confirmLabel: "Set below held anyway",
                  danger: true,
                  requireAcknowledge: true,
                  acknowledgeLabel: "I understand " + held + " confirmed order(s) are affected"
                });
              }
              return go.then(function (ok) {
                if (!ok) return { status: "cancelled" };
                var oldLeft = occ.quantity_left;
                var patch = { quantity_left: newQty };
                if (newQty === 0) patch.status = "sold_out";
                else if (occ.status === "sold_out" && newQty !== null && newQty > 0) {
                  patch.status = "active";
                }
                return sb.from("cc_occurrences").update(patch).eq("id", occId)
                  .then(function (r3) {
                    // DB trigger raises a clear error if this would go negative.
                    if (r3.error) throw r3.error;
                    var logProduct = sched.product_id ||
                      (sched.cc_schedule_items && sched.cc_schedule_items[0] &&
                        sched.cc_schedule_items[0].product_id) || null;
                    if (!logProduct) {
                      // Full-menu schedule with no items (shouldn't happen) — skip the log.
                      return { status: "done" };
                    }
                    var change = (newQty === null || oldLeft === null) ? 0 : (newQty - oldLeft);
                    var logReason = (sched.product_id ? "" : "[Full daily menu] ") +
                      reason + " (" + occ.occ_date + ": " +
                      (oldLeft === null ? "unlimited" : oldLeft) + " → " +
                      (newQty === null ? "unlimited" : newQty) + ")";
                    return sb.from("cc_inventory_logs").insert({
                      product_id: logProduct,
                      occurrence_id: occId,
                      change: change,
                      reason: logReason,
                      actor_id: CC.user.id
                    }).then(function (r4) {
                      if (r4.error) throw r4.error;
                      return { status: "done" };
                    });
                  });
              });
            });
          });
      });
  };

  /**
   * Mark an occurrence sold out / back in stock (manual mode).
   * Sold-out is a status flip; the log records change 0 with a clear reason.
   */
  INV.setSoldOut = function (occId, soldOut) {
    var sb = needSb();
    if (!CC.user) return Promise.reject(new Error("Please sign in first."));
    return sb.from("cc_occurrences")
      .select("id,schedule_id,occ_date,quantity_left,status")
      .eq("id", occId).single()
      .then(function (r) {
        if (r.error) throw r.error;
        var occ = r.data;
        var st = soldOut ? "sold_out" : (occ.quantity_left === 0 ? "sold_out" : "active");
        if (!soldOut && occ.quantity_left === 0) {
          throw new Error("Quantity is 0 — raise the quantity first, then mark it back in stock.");
        }
        return sb.from("cc_occurrences").update({ status: st }).eq("id", occId)
          .then(function (r2) {
            if (r2.error) throw r2.error;
            return sb.from("cc_schedules").select("product_id,cc_schedule_items(product_id)")
              .eq("id", occ.schedule_id).single();
          })
          .then(function (rs) {
            var logProduct = (rs.data && (rs.data.product_id ||
              (rs.data.cc_schedule_items && rs.data.cc_schedule_items[0] &&
                rs.data.cc_schedule_items[0].product_id))) || null;
            if (!logProduct) return { status: "done" };
            return sb.from("cc_inventory_logs").insert({
              product_id: logProduct,
              occurrence_id: occId,
              change: 0,
              reason: (soldOut ? "Marked sold out" : "Marked back in stock") +
                " (" + occ.occ_date + ")",
              actor_id: CC.user.id
            }).then(function (r3) {
              if (r3.error) throw r3.error;
              return { status: "done" };
            });
          });
      });
  };

  /** Copy for the made-to-order / manual capacity note shown in the UI. */
  INV.MANUAL_NOTE =
    "Manual mode: you track capacity yourself. Set each date's quantity to the " +
    "most orders you can take — made-to-order items sell out when they hit your cap. " +
    "Every change is written to the inventory log with your reason.";
  INV.AUTO_NOTE =
    "Auto mode: confirming an order reserves stock automatically (and raises a " +
    "clear error if there isn't enough left). Declining or canceling releases " +
    "the reservation. You don't hand-edit quantities in auto mode.";

})();
