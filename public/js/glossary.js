/* Grimoire glossary (#301).
   ==============================================================
   One list of terms, used two ways:
   - Help > Glossary draws its A-Z list from TERMS (help.page.js).
   - On every other page, UI.boot() calls Glossary.linkPage(), which wraps
     glossary words in Grimoire's own static page text in a dotted-underline
     link, with a hover/focus/tap preview of the definition.

   The matcher and the skip rules are plain functions with no browser
   dependency, so test/glossary.test.js runs them in Node.

   What is linked: text the page was written with (intros, hints, headings,
   labels, column headers). What never is: buttons, inputs, selects, existing
   links, the nav and header, table body cells, code, and anything drawn after
   the page boots (that is where card, location and customer names appear).
   The scan runs once per page load, so redraws and keystrokes cost nothing. */
"use strict";
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Glossary = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* id: anchor suffix (help.html#g-<id>).
     forms: words that link; each also matches its plural.
     fixed: words that link exactly as written (no plural added).
     full: true = about a feature Simple mode hides (not linked, not listed).
     Keep definitions to one to three plain sentences, and check them against
     the code. Words that are also everyday verbs ("set", "store", "ask") are
     listed only by the longer phrase that names the thing. */
  const TERMS = [
    { id: "ask-price", term: "Ask price", full: true, forms: ["ask price", "asking price"],
      def: "The price you ask for a listing on Manapool. Grimoire works it out from your Bulk Price rules and the latest market price each time, and never saves it." },
    { id: "bin", term: "Bin", forms: ["bin"],
      def: "Another word for a location that holds cards, such as a box or binder. Putaway and Cycle Count say \"bin\"." },
    { id: "bulk-price-rule", term: "Bulk Price rule", full: true, forms: ["bulk price rule", "bulk price"],
      def: "A rule, on the Card pricing tab of Listings, that sets the asking price for a group of listings: a percent of a base price, a set amount more or less, a flat price, or an exclusion. When rules overlap, the highest priority wins." },
    { id: "buy-list", term: "Buy List", forms: ["buy list"],
      def: "The page for finding cards to buy and watching their prices. It shows what you already own. You still buy on Manapool." },
    { id: "collector-number", term: "Collector number", forms: ["collector number"],
      def: "The number that identifies a card within its set, printed in small type on the card, like 191/280." },
    { id: "condition", term: "Condition", forms: ["condition"],
      def: "How worn a physical card is: Near Mint, Lightly Played, Moderately Played, Heavily Played or Damaged. You judge it by eye and pick one. When a card sits between two, pick the lower." },
    { id: "consolidate", term: "Consolidate", full: true, forms: ["consolidate"], fixed: ["consolidating"],
      def: "Gathering copies of a card spread over several locations into one. Putaway picks the location that already holds the most, and you can change it." },
    { id: "cost-basis", term: "Cost basis", fixed: ["cost basis", "cost bases"],
      def: "What you paid for a card. It is optional, so it is often blank. Gain and profit figures only count cards that have one." },
    { id: "chase-pick", term: "Chase pick", forms: ["chase pick"],
      def: "Going after a card a picker couldn't find where Grimoire said it was: the stack is corrected and the pull moves to the next bin. A line that finished short on a picked ticket can be chased too, from another bin or from the bin the short was a mistake in." },
    { id: "cycle-count", term: "Cycle Count", full: true, forms: ["cycle count"],
      def: "A spot-check of a bin against what Grimoire says it holds. Floor to Book starts from cards you pull off the shelf. Book to Floor goes through the bin card by card." },
    { id: "deck-list", term: "Deck List", forms: ["deck list"],
      def: "A page where you paste a deck and see which copies you own and where they are, plus what you are missing." },
    { id: "finish", term: "Finish", forms: ["finish"], fixed: ["finishes", "foil", "foils", "nonfoil", "etched"],
      def: "Nonfoil (flat), foil (shiny) or etched (foil with a textured pattern). Finish is part of what separates two printings, and it changes the price." },
    { id: "listed", term: "Listed", fixed: ["listed"],
      def: "How many copies are marked to list for sale in Grimoire. This is not necessarily sent to Manapool or any other marketplace yet. A stack's listed quantity can be lower than the quantity you own." },
    { id: "location", term: "Location", forms: ["location"],
      def: "A place your cards are kept, such as a binder, box or shelf. You name your own locations." },
    { id: "lot-receipt", term: "Lot receipt", forms: ["lot receipt"],
      def: "Entering a box bought as one purchase. You give the total you paid and Grimoire spreads it over the lines by market value, or evenly. Nothing reaches inventory until you post the receipt." },
    { id: "manapool", term: "Manapool", fixed: ["manapool"],
      def: "The marketplace Grimoire connects to for selling cards, receiving orders and checking prices." },
    { id: "market-value", term: "Market value", forms: ["market value", "market price"],
      def: "What a card sells for around now, from price data Grimoire refreshes daily. Your own asking price can differ." },
    { id: "organization", term: "Organization", full: true, forms: ["organization", "organisation"],
      def: "A group account for a business with more than one person or shop. Each store in it has its own inventory, and each employee has their own login." },
    { id: "pick-list", term: "Pick list", forms: ["pick list"],
      def: "The list of stacks to pull from your locations to ship an order. Copies on a pick list count as allocated until the order ships." },
    { id: "printing", term: "Printing", forms: ["printing"],
      def: "One specific version of a card: a particular set, collector number and language. The same card can have many printings with different art and prices, and Grimoire tracks each separately." },
    { id: "putaway", term: "Putaway", full: true, forms: ["putaway"],
      def: "Deciding where a card goes when it arrives. Do it by hand, or set rules on your locations and let Putaway suggest the spot or move the cards." },
    { id: "putaway-rotation", term: "Putaway rotation", full: true, forms: ["putaway rotation"],
      def: "The locations that have putaway turned on. Putaway only files cards into locations in the rotation." },
    { id: "sealed-product", term: "Sealed product", full: true, forms: ["sealed product", "sku"],
      def: "Boxes, bundles and other unopened product. Each product is tracked by name and count, with no condition, finish or language. One product line is a SKU." },
    { id: "set-code", term: "Set and set code", fixed: ["set code", "set codes"],
      def: "A set is a group of cards released together. Its short code, usually three letters like MH3, is printed on each card." },
    { id: "simple-mode", term: "Simple mode", forms: ["simple mode"],
      def: "A setting that hides the business pages, such as Putaway, Listings, Sealed and Accounting. Turn it on or off in Settings." },
    { id: "sorting-tray", term: "Sorting tray", forms: ["sorting tray"],
      def: "A location where cards wait until you file them elsewhere. A tray is never a putaway destination." },
    { id: "stack", term: "Stack", forms: ["stack"],
      def: "A pile of identical copies: same printing, finish, condition, language and location. Change any one of those and it is a different stack." },
    { id: "unrealised-gain", term: "Unrealised gain", fixed: ["unrealised gain", "unrealized gain"],
      def: "What your cards that have a cost are worth now, minus what you paid for them. It stays unrealised until you sell. Cards with no cost are left out." },
    { id: "wantlist", term: "Wantlist", full: true, forms: ["wantlist", "want list"],
      def: "The cards a customer wants. Grimoire tells you when stock for one comes in." },
    { id: "watch-list", term: "Watch list", forms: ["watch list", "price target"],
      def: "Cards you track on the Buy List, owned or not. Set a target price and Grimoire flags the card when it reaches it." },
    // Linked only as "What's new tutorial(s)": plain "what's new" is everyday words (the digest's "what's new in the app").
    { id: "whats-new", term: "What's new", fixed: ["what's new tutorial", "what's new tutorials"],
      def: "A few short step cards that show a newly added feature, once, the next time you open Grimoire after it arrives. Replay them in Help, Guide tab, under Your first ten minutes." }
  ];

  /* ------------------------------ matching ------------------------------ */
  function plural(w) {
    if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + "ies";
    if (/(s|x|z|ch|sh)$/.test(w)) return w + "es";
    return w + "s";
  }
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Every word that links for one term, lower case.
  function formsOf(t) {
    const out = [];
    (t.forms || []).forEach(f => {
      const parts = f.split(" ");
      const last = parts.pop();
      out.push(f, parts.concat(plural(last)).join(" "));
    });
    (t.fixed || []).forEach(f => out.push(f));
    return out;
  }

  // One regex for a list of terms. The leading character class stands in for
  // a look-behind (older Safari lacks it): a form must not touch a letter,
  // digit, underscore or hyphen on either side, so "non-foil" and
  // "restacking" never match. An apostrophe is fine: "stack's" links.
  function buildMatcher(terms) {
    const byForm = new Map();
    terms.forEach(t => formsOf(t).forEach(f => { if (!byForm.has(f)) byForm.set(f, t); }));
    const forms = Array.from(byForm.keys()).sort((a, b) => b.length - a.length);
    if (!forms.length) return { re: null, byForm };
    const alt = forms.map(f => reEsc(f).replace(/ /g, "\\s+")).join("|");
    return { re: new RegExp("(^|[^\\w-])(" + alt + ")(?![\\w-])", "gi"), byForm };
  }

  // Terms that apply right now. Full-only terms drop out in Simple mode.
  function termsFor(simple) { return simple ? TERMS.filter(t => !t.full) : TERMS; }

  // [{ start, end, term }] for every glossary word in `text`.
  function findMatches(text, matcher) {
    const out = [];
    if (!matcher.re || !text) return out;
    matcher.re.lastIndex = 0;
    let m;
    while ((m = matcher.re.exec(text))) {
      const start = m.index + m[1].length;
      const term = matcher.byForm.get(m[2].toLowerCase().replace(/\s+/g, " "));
      if (term) out.push({ start, end: start + m[2].length, term });
      if (m[0] === "") matcher.re.lastIndex++;
    }
    return out;
  }

  /* ------------------------------ skip rules ------------------------------ */
  // Whole subtrees that are never scanned.
  const SKIP_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "OPTION", "OPTGROUP", "TEXTAREA", "SCRIPT",
    "STYLE", "NOSCRIPT", "SVG", "CODE", "PRE", "KBD", "NAV", "HEADER", "FOOTER", "H1", "SUMMARY", "TBODY", "TFOOT",
    "TD", "TEMPLATE", "IFRAME", "CANVAS", "TITLE", "DATALIST", "OUTPUT"]);
  const SKIP_ROLES = new Set(["button", "link", "tab", "menu", "menuitem", "option", "listbox", "tooltip", "dialog"]);

  function skipElement(el, ctx) {
    const tag = String(el.tagName || "").toUpperCase();
    if (SKIP_TAGS.has(tag)) return true;
    const has = n => typeof el.hasAttribute === "function" && el.hasAttribute(n);
    if (has("data-no-gloss") || has("contenteditable") || has("aria-hidden")) return true;
    if (ctx && ctx.simple && has("data-full-only")) return true;
    const role = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
    if (role && SKIP_ROLES.has(role)) return true;
    return false;
  }

  /* ------------------------------ linking ------------------------------ */
  function hrefFor(t) { return "/help.html#g-" + t.id; }

  // Wraps the glossary words in one text node. Returns how many were linked.
  // preview: inside a link, a form label or a sortable header a real <a> would
  // navigate (or steal the click), so the word gets a preview-only <span>: same
  // popover on hover or tap, no href, not a Tab stop, and the click passes through.
  function linkTextNode(node, matcher, doc, preview) {
    const text = node.nodeValue;
    const hits = findMatches(text, matcher);
    if (!hits.length) return 0;
    const frag = doc.createDocumentFragment();
    let at = 0;
    hits.forEach(h => {
      if (h.start > at) frag.appendChild(doc.createTextNode(text.slice(at, h.start)));
      const a = doc.createElement(preview ? "span" : "a");
      a.className = "gloss";
      if (!preview) a.setAttribute("href", hrefFor(h.term));
      a.setAttribute("data-gloss", h.term.id);
      a.appendChild(doc.createTextNode(text.slice(h.start, h.end)));
      frag.appendChild(a);
      at = h.end;
    });
    if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
    node.parentNode.replaceChild(frag, node);
    return hits.length;
  }

  // Links glossary words under `root`. opts: { simple, doc, preview }. Returns the count.
  // preview: true when root itself sits inside a link, label or sortable header.
  // links: also scan inside links (as preview spans); the page scan leaves links alone.
  function linkTree(root, opts) {
    opts = opts || {};
    const doc = opts.doc || (typeof document !== "undefined" ? document : null);
    const matcher = buildMatcher(termsFor(!!opts.simple));
    if (!doc || !matcher.re) return 0;
    const textNodes = [];   // [node, preview]
    (function walk(node, ctx) {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k.nodeType === 3) {
          // Cheap pre-check: nothing under 3 letters can be a term.
          if (k.nodeValue && k.nodeValue.length > 2) textNodes.push([k, ctx.preview]);
        } else if (k.nodeType === 1) {
          const tag = String(k.tagName || "").toUpperCase();
          if (tag === "A" && opts.links) { walk(k, { simple: ctx.simple, sortTable: ctx.sortTable, preview: true }); continue; }
          if (skipElement(k, ctx)) continue;
          const sortTable = ctx.sortTable || (tag === "TABLE" && typeof k.hasAttribute === "function" && k.hasAttribute("data-sort"));
          const preview = ctx.preview || tag === "LABEL" || (tag === "TH" && sortTable);
          walk(k, (sortTable === ctx.sortTable && preview === ctx.preview) ? ctx : { simple: ctx.simple, sortTable, preview });
        }
      }
    })(root, { simple: !!opts.simple, sortTable: !!opts.sortTable, preview: !!opts.preview });
    let n = 0;
    textNodes.forEach(t => { n += linkTextNode(t[0], matcher, doc, t[1]); });
    return n;
  }

  /* ------------------------------ preview popover ------------------------------ */
  let tip = null, tipFor = null, showTimer = 0, hideTimer = 0, lastPointer = "mouse";
  const byId = id => TERMS.find(t => t.id === id);

  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.id = "glossTip";
    tip.className = "gloss-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    tip.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    tip.addEventListener("mouseleave", () => scheduleHide(150));
    document.body.appendChild(tip);
    return tip;
  }

  function place(a) {
    const r = a.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
    let top = r.bottom + 6;
    if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    // A word inside a form label sits right above its own input: never cover it.
    const lab = a.closest && a.closest("label");
    if (lab && lab.querySelector("select, input, textarea")) {
      if (r.top - h - 6 > 8) top = r.top - h - 6;
      else top = lab.getBoundingClientRect().bottom + 6;
    }
    tip.style.left = left + "px";
    tip.style.top = Math.max(8, top) + "px";
  }

  function show(a) {
    const t = byId(a.getAttribute("data-gloss"));
    if (!t) return;
    clearTimeout(hideTimer);
    ensureTip();
    if (tipFor && tipFor !== a) tipFor.removeAttribute("aria-describedby");
    tip.innerHTML = "";
    const h = document.createElement("div"); h.className = "gloss-tip-term"; h.textContent = t.term;
    const p = document.createElement("div"); p.className = "gloss-tip-def"; p.textContent = t.def;
    const open = document.createElement("a"); open.className = "gloss-tip-open"; open.href = hrefFor(t);
    open.textContent = "Open in glossary";
    tip.appendChild(h); tip.appendChild(p); tip.appendChild(open);
    tip.hidden = false;
    tipFor = a;
    a.setAttribute("aria-describedby", "glossTip");
    place(a);
  }

  function hide() {
    clearTimeout(showTimer); clearTimeout(hideTimer);
    if (tipFor) tipFor.removeAttribute("aria-describedby");
    tipFor = null;
    if (tip) tip.hidden = true;
  }
  function scheduleHide(ms) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, ms); }

  let wired = false;
  function wirePopover() {
    if (wired || typeof document === "undefined") return;
    wired = true;
    const linkOf = e => (e.target && e.target.closest) ? e.target.closest(".gloss") : null;
    document.addEventListener("pointerdown", e => { lastPointer = e.pointerType || "mouse"; }, true);
    document.addEventListener("mouseover", e => {
      const a = linkOf(e);
      if (!a || lastPointer === "touch") return;
      clearTimeout(hideTimer); clearTimeout(showTimer);
      showTimer = setTimeout(() => show(a), 200);
    });
    document.addEventListener("mouseout", e => {
      const a = linkOf(e);
      if (!a) return;
      clearTimeout(showTimer);
      scheduleHide(150);
    });
    document.addEventListener("keydown", () => { lastPointer = "key"; }, true);
    document.addEventListener("focusin", e => { const a = linkOf(e); if (a && a.tagName === "A" && lastPointer !== "touch") show(a); });
    document.addEventListener("focusout", e => { if (linkOf(e)) scheduleHide(150); });
    // Touch: the first tap shows the preview; the link inside it opens the glossary.
    document.addEventListener("click", e => {
      const a = linkOf(e);
      if (!a || lastPointer !== "touch" || a.tagName !== "A") return;   // a preview span lets the click through
      if (tipFor === a && tip && !tip.hidden) return;   // second tap: follow the link
      e.preventDefault();
      show(a);
    }, true);
    document.addEventListener("click", e => {
      const a = linkOf(e);
      if (a && a.tagName !== "A" && lastPointer === "touch") show(a);
    });
    // Tap anywhere else (or press Esc) to close it.
    document.addEventListener("pointerdown", e => {
      if (!tip || tip.hidden) return;
      if (e.target.closest && (e.target.closest(".gloss") || e.target.closest("#glossTip"))) return;
      hide();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && tip && !tip.hidden) hide(); });
    window.addEventListener("scroll", () => { if (tip && !tip.hidden) hide(); }, { passive: true });
  }

  // Links one element's own text right after a page draws it (Dashboard tile labels,
  // the Inventory grid header). Only for text Grimoire wrote, never user data.
  // Words inside a link, label or sortable header become preview-only spans.
  function link(el, opts) {
    if (!el) return 0;
    opts = opts || {};
    const inside = typeof el.closest === "function" ? el.closest("a, label, table[data-sort] th") : null;
    const sortTable = typeof el.closest === "function" && !!el.closest("table[data-sort]");
    return linkTree(el, { simple: !!opts.simple, doc: document, links: true, preview: !!inside, sortTable });
  }

  // The one call from UI.boot(): link the page's own text, once, and wire the preview.
  function linkPage(opts) {
    opts = opts || {};
    const n = linkTree(document.body, { simple: !!opts.simple, doc: document });
    wirePopover();
    return n;
  }

  return { TERMS, buildMatcher, findMatches, termsFor, skipElement, linkTree, link, linkPage, formsOf, hrefFor };
});
