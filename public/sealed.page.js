
"use strict";
(function () {
  const $ = UI.$;

  /* Not a UI.Grid mode - that widget is card-specific (WMS/ERP/storefront
     columns baked in), and sealed rows have nothing in common with a card
     stack (no condition/finish/language tiers), so this is its own plain
     hand-rolled table over `G.state.sealed`, same convention as e.g.
     bulk-price.page.js's plan table. See receive.page.js (its Sealed switch) for how
     rows get added. */
  const stat = (big, lbl, cls) =>
    '<div class="stat"><span class="big ' + (cls || "") + '">' + big + '</span><span class="lbl">' + lbl + "</span></div>";

  // The Location column holds a <select>, whose textContent is every option
  // run together, so it gives the generic column sort the location's name
  // as data-vs (a text sort key) instead (#79). Blank (sinks) for a location that's gone.
  const locSortKey = id => { const l = G.locById(id); return l ? l.name : ""; };

  function filteredRows() {
    const q = $("search").value.trim().toLowerCase();
    const loc = $("filterLoc").value;
    return G.state.sealed
      .filter(r => !loc || r.locationId === loc)
      .filter(r => !q || (r.name + " " + r.setCode).toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderSummary(rows) {
    const qty = rows.reduce((s, r) => s + r.quantity, 0);
    const value = rows.reduce((s, r) => s + (r.price == null ? 0 : r.price * r.quantity), 0);
    const locs = new Set(rows.map(r => r.locationId)).size;
    $("summary").innerHTML =
      stat(rows.length.toLocaleString(), "SKUs") +
      stat(qty.toLocaleString(), "Total quantity") +
      stat(G.money(value), "Market value", "val") +
      stat(locs.toLocaleString(), "Locations");
  }

  function renderSealedTable() {
    // Only the tbody is redrawn; the <table> (and with it the user's column
    // sort, which UI.reapplySorts() looks up by table element) stays put.
    const body = $("sealedBody");
    const rows = filteredRows();
    renderSummary(rows);
    $("sealedTable").hidden = !rows.length;
    $("sealedEmpty").hidden = !!rows.length;
    if (!rows.length) {
      body.innerHTML = "";
      $("sealedEmpty").innerHTML = G.state.sealed.length
        ? UI.emptyBlock({ icon: "search", title: "No sealed product matches that filter." })
        : UI.emptyBlock({ icon: "orders", title: "No sealed product yet.", hint: "Add some from Receive (switch it to Sealed)." });
      return;
    }
    body.innerHTML =
      rows.map(r =>
        '<tr data-id="' + r.id + '">' +
          '<td class="card-name">' + G.esc(r.name) + "</td>" +
          '<td class="muted hide-sm">' + G.esc(String(r.setCode || "").toUpperCase()) + "</td>" +
          '<td class="num" data-v="' + r.quantity + '"><input type="number" min="0" class="sldQtyInput" value="' + r.quantity + '" style="width:70px"></td>' +
          '<td data-vs="' + G.esc(locSortKey(r.locationId)) + '"><select class="sldLocSelect">' + UI.locOptions(r.locationId) + "</select></td>" +
          '<td class="num hide-sm">' + (r.price == null ? '<span class="muted">—</span>' : G.money(r.price)) + "</td>" +
          '<td class="num hide-sm">' + (r.avgCost == null ? '<span class="muted">—</span>' : G.money(r.avgCost)) + "</td>" +
          '<td class="num" data-v="' + r.listedQty + '"><input type="number" min="0" max="' + r.quantity + '" class="sldListedInput" value="' + r.listedQty + '" style="width:70px" title="How many are actually for sale - drives the Sealed pricing section on Bulk Price"></td>' +
          '<td class="num hide-sm">' + (r.askPrice == null ? '<span class="muted">—</span>' : G.money(r.askPrice)) + "</td>" +
          '<td><button class="small ghost sldDel">Delete</button></td>' +
        "</tr>").join("");
    body.querySelectorAll("tr[data-id]").forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector(".sldQtyInput").addEventListener("change", e => {
        G.setSealedQuantity(id, e.target.value);
        G.persist();
        renderSealedTable();
      });
      tr.querySelector(".sldListedInput").addEventListener("change", e => {
        G.setSealedListedQty(id, e.target.value);
        G.persist();
        renderSealedTable();
      });
      tr.querySelector(".sldLocSelect").addEventListener("change", e => {
        e.target.closest("td").dataset.vs = locSortKey(e.target.value);
        G.moveSealedLocation(id, e.target.value);
        G.persist();
        renderSealedTable();
      });
      tr.querySelector(".sldDel").onclick = async () => {
        const rec = G.state.sealed.find(x => x.id === id);
        const ok = await UI.confirmDialog('Delete "' + (rec ? rec.name : "this row") + '"?', { title: "Delete sealed row?", danger: true });
        if (!ok) return;
        G.deleteSealedRow(id);
        G.persist();
        renderSealedTable();
      };
    });
    UI.reapplySorts();
  }

  /* ============================== Wire up ============================== */
  UI.boot(async function () {
    UI.fillLocationSelect($("filterLoc"), "", { anyLabel: "All locations" });
    const wantLoc = new URLSearchParams(location.search).get("loc");
    if (wantLoc && G.locById(wantLoc)) $("filterLoc").value = wantLoc;

    renderSealedTable();
    $("search").addEventListener("input", G.debounce(renderSealedTable, 180));
    $("filterLoc").onchange = renderSealedTable;
    $("btnClear").onclick = () => {
      $("search").value = "";
      $("filterLoc").value = "";
      renderSealedTable();
    };
    $("btnRefresh").onclick = async () => {
      $("btnRefresh").disabled = true;
      try {
        const out = await G.refreshSealedPrices();
        UI.toast(out.rows
          ? "Refreshed " + out.rows + " item(s): " + out.updated + " price change(s)" +
            (out.missing ? ", " + out.missing + " no longer in the catalog" : "") + "."
          : "Nothing to refresh yet.", "ok");
        renderSealedTable();
      } catch (e) {
        UI.toast("Refresh failed: " + e.message, "err");
      }
      $("btnRefresh").disabled = false;
    };

    G.on("change", renderSealedTable);
  });
})();
