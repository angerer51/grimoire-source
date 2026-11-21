/* Grimoire v0.08 - shared engine.
   ==============================================================
   Everything that is not a specific page lives here: the collection document,
   autosave to the server, undo, the audit trail, cost basis, the putaway rule
   engine, the query engine and the exports. Pages import this, subscribe to
   "change", and render.

   The one structural change from v0.07: the browser is no longer the system of
   record. There is no localStorage copy and no Save button - the server holds
   the collection and this autosaves to it. That is what makes the same
   collection open on a phone and a desktop, and what makes more than one person
   possible at all. */
"use strict";

window.G = (function () {

  const SAVE_VERSION = 7;
  const APP_NAME = "Grimoire";
  /* v0.07 files say "Grimoire"; anything older says "MTG Inventory". Both open. */
  const LEGACY_APP_NAMES = ["MTG Inventory"];

  /* ============================== State ============================== */
  /* DEFAULT_SETTINGS has to be declared before `state`, because state's
     initialiser calls freshSettings() - a `const` read before its declaration is
     a ReferenceError, not undefined. */
  const DEFAULT_SETTINGS = {
    chime: false, chimeMin: 20,
    lotAllocation: "market",
    autoPutaway: true,
    // Whether the Set code box in Receive's "Set + number" mode keeps its value
    // after adding a card, so a run of cards from the same set doesn't need it
    // retyped each time. On by default; the collector # still clears every add.
    stickySetCode: true,
    moversDays: 7,
    listingDefaultKeep: 0,
    // "Never list below my minimum profit" (#377, #390): Evaluate gives a stack
    // whose price misses the account's minimum profit a target of 0. Off by default.
    // The minimum itself (minProfitPct) deliberately has NO default here: a
    // default merged in on load would hide "none stored", which keeps accounts
    // that had this switch on before #390 at 0%. Read it through minProfitPct().
    neverListAtLoss: false,
    // Cycle counting defaults (public/cycle-count.html) - how many stacks a
    // sample check pulls, and the mismatch-rate (percent) that triggers a
    // "run a full cycle count" prompt.
    cycleCountSampleSize: 10,
    cycleCountErrorThreshold: 10,
    // Warehouse Mode: must each stop be scanned (or keyed with a reason)? Off:
    // a tap confirms it, so the QR labels aren't required. See logBinCheck.
    requireBinScan: false,
    // What condition a newly-added card defaults to - Receive's "Add a card"
    // form, CSV/TCGplayer import fallbacks when a row doesn't say, and Cycle
    // Count's "found, not in the book" entry all read this instead of
    // hardcoding NM. "NM" here keeps every existing account's behavior
    // unchanged until they deliberately set this in Settings.
    defaultCondition: "NM",
    // Hides business/power-seller nav and page sections (Putaway, Listings,
    // Bulk price, Movers, Lists & Orders, the rule-builder-adjacent bits of
    // Receive/Inventory/Dashboard) for a casual, cards-in-a-binder user.
    // Off by default for every existing account - see ui.js/receive.page.js/
    // inventory.page.js/index.page.js for what actually reads this.
    simpleMode: false,
    // Set true once the first-run tutorial (tutorial.html) is finished or
    // skipped - it's the tutorial's only real write. False here means
    // "hasn't been through it," same for a brand-new account as for an
    // existing account whose settings doc predates this field; the
    // difference is login.page.js only ever *redirects* to the tutorial
    // right after a fresh registration, never on an ordinary login, so an
    // existing account never gets routed there against its will.
    tutorialSeen: false,
    // One copy of the default, shared with the server's scheduled run (#228).
    conditionPricing: Object.assign({}, window.RuleEngine.DEFAULT_CONDITION_PRICING),
    // frequency: "daily" | "weekly". hourLocal 0-23. weekday 0(Sun)-6(Sat), only
    // used when frequency is "weekly". autoPush live-updates Manapool listing
    // prices on every scheduled run with nobody watching - off until the user
    // deliberately turns it on from the Bulk price page.
    bulkPriceSchedule: { enabled: false, frequency: "daily", hourLocal: 6, weekday: 1, autoPush: false }
  };
  function freshSettings() { return Object.assign({}, DEFAULT_SETTINGS); }

  const state = {
    locations: [],
    cards: [],
    receipts: [],
    returns: [],
    pickList: [],
    pickLists: [],
    deckList: [],
    // Saved decks (#309): see "Saved decks" below.
    decks: [],
    // Trades made in person (#335): see "Trades made in person" below.
    trades: [],
    listingRules: [],
    listingKeepExceptions: [],
    priceRules: [],
    watchList: [],
    sealed: [],
    sealedPriceRules: [],
    // Customer wantlists (#50) - see "Customers & wants" below.
    customers: [],
    customerWants: [],
    restockMatches: [],
    customerTombstones: [],
    customerAliases: [],
    // Receipts open on the floor (#388): see "Receiving on the floor" below.
    receiving: [],
    receivingLines: [],
    history: [],
    audit: [],
    settings: freshSettings()
  };

  let rev = 0;                 // server revision this browser last saw
  let savedAt = null;
  let dirty = false;
  let saving = false;
  let saveError = null;
  let loaded = false;
  let me = null;
  let mpBanner = null;   // #499: /api/auth/me's "Reconnect Mana Pool" banner, or null
  /* Simple mode and the chime are per person (#159). A personal account
     keeps them in state.settings, its own document, as before. An org
     member's document is the Store's, shared with every coworker, so theirs
     live in their own account (`personal`, from /api/auth/me) and pref()
     reads them from there. null for a personal account.
     nextStepsDismissed (#244): the Dashboard's "Next steps" list, so one
     coworker hiding it doesn't hide it for the whole Store.
     dashTiles (#298): the Dashboard's tile layout, see dashLayout().
     whatsNewDone (#455): ids of the "What's new" tutorials this person has
     finished (UI.whatsNew), so each plays once per person, on any device. */
  const PERSONAL_KEYS = ["simpleMode", "chime", "chimeMin", "nextStepsDismissed", "dashTiles", "whatsNewDone"];
  let personal = null;

  const LANG_NAMES = {
    en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
    ja: "Japanese", ko: "Korean", ru: "Russian", zhs: "Chinese (S)", zht: "Chinese (T)",
    he: "Hebrew", la: "Latin", grc: "Ancient Greek", ar: "Arabic", sa: "Sanskrit", ph: "Phyrexian",
    dw: "Dwarvish"
  };

  // Phyrexian isn't a real script - Scryfall's printed_name for a "ph" print is
  // the name re-spelled letter-for-letter through the invented Phyrexian glyph
  // alphabet, meant to be read with a special font. Rendered in plain text it's
  // just noise ("Island" -> "|hWZFGK."), so unlike every other print language
  // here it should never be preferred over the oracle name.
  const cardName = card => (card && card.lang !== "ph" && card.printedName) || (card && card.name) || "";

  /* Physical grade. Not from Scryfall - it has no concept of condition, and
     r.price always means the market/NM price regardless of what this says.
     Existing rows default to NM (see normalizeCard) rather than being left
     blank, because every card sitting in inventory already has SOME grade;
     an unfilled pick-list request is a different case - see pickKey. */
  const CONDITION_NAMES = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
  const CONDITIONS = Object.keys(CONDITION_NAMES);

  // A card's finish - nonfoil/foil/etched are three independent Scryfall
  // treatments (their own `usd`/`usdFoil`/`usdEtched` prices, their own
  // `finishes` array entry), not "etched" nested under "foil" - so this
  // is a 3-way enum, not a foil boolean plus a bolt-on flag. Every stack
  // has exactly one. normalizeCard() below migrates any pre-finish row
  // (old data only ever had `foil: true/false`) the first time it loads.
  const FINISH_NAMES = { nonfoil: "Non-foil", foil: "Foil", etched: "Etched foil" };
  const FINISHES = Object.keys(FINISH_NAMES);
  const normalizeFinish = v => FINISHES.includes(v) ? v : null;

  // Matches server/lib/integrations.js's own MP_LIST_BATCH_SIZE. A bulk
  // Manapool push (Listings' "Push to Manapool", Delist all, Bulk price's
  // pushes) is split client-side into calls of this many listings, sent one
  // at a time and each confirmed before the next goes out, so progress shows
  // and a stop loses little. Manapool's spec allows up to 2000 items per
  // request (manapool.json); 100 keeps each request small and quick and its
  // server log line whole, while cutting round trips fivefold from the old
  // 20 (#480: a 7,419-listing push took 372 requests and ~50 s).
  const MANAPOOL_BATCH_SIZE = 100;

  /* Tolerant text -> condition code, for a TCGplayer CSV column, a CSV
     import, or a Manapool order line - none of them are guaranteed to spell
     it the way Grimoire does. Unrecognised text is left blank rather than
     guessed at: a blank condition on a pick-list item means "any grade will
     do" (see pickKey/allocatePick below), which is the safe default when the
     source data does not actually say. */
  function conditionCode(v) {
    v = String(v || "").trim().toLowerCase();
    if (!v) return "";
    if (CONDITIONS.includes(v.toUpperCase())) return v.toUpperCase();
    for (const [code, nm] of Object.entries(CONDITION_NAMES)) if (nm.toLowerCase() === v) return code;
    if (/damaged|^dmg/.test(v)) return "DMG";
    if (/heavily.?played|^hp$/.test(v)) return "HP";
    if (/moderately.?played|^mp$/.test(v)) return "MP";
    if (/lightly.?played|^lp$/.test(v)) return "LP";
    if (/near.?mint|^nm$|^mint$/.test(v)) return "NM";
    return "";
  }

  /* The account's configured "what condition do I receive cards in" default
     (Settings -> Preferences) - falls back to NM if never set or set to
     something no longer valid. Read by Receive's add-a-card form, CSV/
     TCGplayer import fallbacks, and Cycle Count's "found, not in the book"
     entry, so a change in Settings reaches every place a new stack's
     condition gets defaulted instead of just one of them. */
  function defaultCondition() {
    const v = state.settings.defaultCondition;
    return CONDITIONS.includes(v) ? v : "NM";
  }

  const LOC_TYPES = ["Binder", "Deck Box", "Bulk Box", "Trade Binder", "Box", "Safe", "Display", "Other"];

  /* ============================== Helpers ============================== */
  const uid = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // Sign goes before the $, not after it - "$" + (-42.1) via toLocaleString
  // would otherwise read "$-42.10" instead of the conventional "-$42.10".
  const money = n => {
    if (n == null || n === "" || isNaN(n)) return "—";
    const num = Number(n);
    return (num < 0 ? "-" : "") + "$" +
      Math.abs(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const pct = n => (n == null || isNaN(n)) ? "—" : (n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const rowTotal = r => (r.price == null ? 0 : r.price * r.quantity);
  const rowCost = r => (Number(r.costTotal) || 0);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const normNum = n => String(n == null ? "" : n).trim().toLowerCase().replace(/^0+(?=.)/, "");
  const printKey = (set, num, lang) =>
    String(set || "").toLowerCase() + "|" + normNum(num) + "|" + String(lang || "en").toLowerCase();

  const locById = id => state.locations.find(l => l.id === id);
  const locName = id => { const l = locById(id); return l ? l.name : "(unknown)"; };
  const locType = id => { const l = locById(id); return l ? l.type : ""; };
  const pickPriorityOf = id => { const l = locById(id); return l ? (l.pickPriority || 0) : 0; };
  /* The same two per-location answers as a map, built once, for a caller
     that looks up thousands of stacks (listingPlan, the Manapool sync). A
     stack whose location is gone counts as not sold from, the same as
     pickableStacks. */
  function locationFlags() {
    const byId = new Map(state.locations.map(l => [l.id, l]));
    return {
      sellFrom: id => { const l = byId.get(id); return !!(l && l.sellFrom); },
      pickPriority: id => { const l = byId.get(id); return l ? (l.pickPriority || 0) : 0; },
      name: id => { const l = byId.get(id); return l ? l.name : ""; }
    };
  }
  // A stack held on an open receipt (#388) never merges with free copies: it
  // joins them when the desk closes the receipt (closeReceiving).
  const idKey = r => [r.set, r.collector, r.lang, r.finish, r.condition || "NM", r.locationId].join("|") + (r.held ? "|held:" + r.held : "");
  const sortedLocations = () => state.locations.slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  function printingLabel(setCode, collector, setName) {
    const parts = [String(setCode || "").toUpperCase(), "#" + String(collector || "")];
    if (setName) parts.push(setName);
    return parts.join(" – ");
  }
  const recPrinting = r => printingLabel(r.set, r.collector, r.setName);
  /* Scryfall's own CDN only ever stores one pre-rendered size per card
     record (cards.js's imageOf() picks normal/large/small, in that order -
     see its own header), but every size lives at the same path with only
     the size segment differing (".../<size>/front/<c1>/<c2>/<uuid>.jpg").
     A thumbnail-sized inline table cell has no business downloading a full
     "normal"/"large" card image just to shrink it with CSS - swap in
     art_crop (illustration only, no border/text, exactly what a quick
     visual identifier next to the card's own name needs) instead of asking
     the server to also start storing a second URL per card for this. */
  function artCropUrl(imageUrl) {
    return imageUrl ? imageUrl.replace(/\/(normal|large|small)\//, "/art_crop/") : "";
  }
  /* For a dropdown of printings, not just a single card: a set can print the
     same collector number in several languages (common on Secret Lairs,
     Commander sets and older core sets), and printingLabel() alone does not
     say which language a row is, so those rows read as duplicates. Only the
     "all_cards" bulk file surfaces this - "default_cards" is mostly one
     language per printing - but the label should disambiguate either way. */
  function printingOptionLabel(c) {
    const label = printingLabel(c.set, c.collector, c.setName);
    const lang = c.lang || "en";
    return lang === "en" ? label : label + " · " + (LANG_NAMES[lang] || lang);
  }

  // One entry per (set, collector) - a name can print the same number in several
  // languages; which language is wanted is the Language field's job.
  function groupPrintings(list) {
    const map = new Map();
    for (const c of list) {
      const key = c.set + "|" + normNum(c.collector);
      let g = map.get(key);
      if (!g) { g = { set: c.set, collector: c.collector, setName: c.setName, cards: [] }; map.set(key, g); }
      g.cards.push(c);
    }
    return [...map.values()];
  }
  const englishOf = g => g.cards.find(c => (c.lang || "en") === "en") || g.cards[0];

  /* Newest release first for the Receive / tour printing pickers (#324); ties
     (and cards with no date, which sink to the end) fall back to set, then
     collector number, so the order is stable. */
  function sortPrintingsNewest(list, cardOf) {
    const of = cardOf || (x => x);
    const date = x => String(of(x).releasedAt || "");
    return list.slice().sort((a, b) => {
      const da = date(a), db = date(b);
      if (da !== db) return da < db ? 1 : -1;
      const ca = of(a), cb = of(b);
      if (ca.set !== cb.set) return String(ca.set) < String(cb.set) ? -1 : 1;
      return String(ca.collector).localeCompare(String(cb.collector), undefined, { numeric: true });
    });
  }

  /* Does a printing match what was typed in the picker's filter box? Every
     word must appear in the set name, set code, collector number or year. */
  function printingMatches(c, text) {
    const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [c.setName, c.set, c.collector, String(c.releasedAt || "").slice(0, 4)].join(" ").toLowerCase();
    return words.every(w => hay.includes(w));
  }

  /* The label in the "Printing" pick list (Receive and the tour): set, number,
     set name, release year and the price already on the card record, so the
     list says enough to tell a $400 original from a $2 reprint. */
  function printingChoiceLabel(c) {
    const parts = [printingLabel(c.set, c.collector, c.setName)];
    const year = String(c.releasedAt || "").slice(0, 4);
    if (/^\d{4}$/.test(year)) parts.push(year);
    const p = [priceOf(c, "nonfoil"), priceOf(c, "foil"), priceOf(c, "etched")].find(x => x != null);
    if (p != null) parts.push(money(p));
    return parts.join(" · ");
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  /* Only the newest of several overlapping async requests may act on its
     result (#103). `const begin = latestOnly()` once; then per request
     `const isCurrent = begin()`, and after every await, `if (!isCurrent())
     return`. Starting a newer request makes every older isCurrent() false,
     so a slow "bol" search can't land on top of the "bolt" one typed after. */
  function latestOnly() {
    let seq = 0;
    return function begin() {
      const mine = ++seq;
      return () => mine === seq;
    };
  }

  /* A computed plan plus a text filter over it (#99). Building a Listings or
     Bulk Price plan walks every stack (~230 ms at 70k stacks), so a page
     builds it once per real change and the filter box only searches it. Each
     line's search text is worked out once here, not on every keystroke. */
  function planView(lines, hayOf) {
    const hay = lines.map(l => String(hayOf(l) || "").toLowerCase());
    return {
      lines,
      filter(q) {
        q = String(q || "").trim().toLowerCase();
        if (!q) return lines;
        const out = [];
        for (let i = 0; i < lines.length; i++) if (hay[i].includes(q)) out.push(lines[i]);
        return out;
      }
    };
  }
  // How many plan rows a table draws at once; "Show more" adds this many again.
  const PLAN_ROW_CAP = 500;

  /* Sort data rows the way ui.js sortTable sorts drawn table rows, for a
     table that draws only the first PLAN_ROW_CAP of them (UI.dataSort), so a
     column sort orders the whole plan, not just the drawn rows. `key(row)`
     gives a number, a string, or null/"" for blank. Blanks sink either way,
     any number in the column makes it a numeric sort, ties keep their order. */
  const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function sortRows(rows, key, dir) {
    const keyed = rows.map((row, i) => {
      const v = key(row);
      const empty = v == null || v === "" || (typeof v === "number" && isNaN(v));
      return { row, i, v, empty };
    });
    const numeric = keyed.some(k => !k.empty && typeof k.v === "number");
    keyed.sort((a, b) => {
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      let cmp = numeric ? (Number(a.v) || 0) - (Number(b.v) || 0) : SORT_COLLATOR.compare(String(a.v), String(b.v));
      if (cmp === 0) cmp = a.i - b.i;
      return cmp * (dir < 0 ? -1 : 1);
    });
    return keyed.map(k => k.row);
  }

  /* What acting on these plan lines would do, as one comparable string: each
     stack id with its target (and `extra(line)`, e.g. the price a push
     sends). A page keeps its plan between real changes (#99), so before
     Apply or Push it rebuilds from live data and compares fingerprints: a
     mismatch means the stacks moved on (Fetch listings, undo, another
     device's save merged in, an order picked) and the stale plan must not
     be acted on. */
  function planFingerprint(lines, extra) {
    return lines.map(l => l.record.id + ":" + l.target + (extra ? ":" + extra(l) : "")).join("|");
  }

  /* What this collection owns, by oracle id, from one pass over the stacks
     (#103), for a page that asks per result row. qty(oracleId) is the copies
     owned across every printing; inSet(set, oracleId) is whether any stack
     of that card in that set exists (even at 0 copies, as before). */
  function ownedIndex(rows) {
    const qty = new Map(), inSet = new Set(), setQty = new Map();
    for (const r of rows || state.cards) {
      const id = r.oracleId || "";
      if (id) qty.set(id, (qty.get(id) || 0) + (Number(r.quantity) || 0));
      inSet.add(id + "|" + r.set);
      if (id) setQty.set(id + "|" + r.set, (setQty.get(id + "|" + r.set) || 0) + (Number(r.quantity) || 0));
    }
    return {
      qty: id => (id ? qty.get(id) || 0 : 0),
      inSet: (set, id) => inSet.has((id || "") + "|" + set),
      qtyInSet: (set, id) => (id ? setQty.get(id + "|" + set) || 0 : 0)
    };
  }

  /* Stacks by printing and finish (#115): set|normNum(collector)|finish ->
     the first stack in collection order, the same one the old per-line
     find() returned. Statistics' Spend by receipt builds it once per render
     instead of scanning every stack for every receipt line. */
  const printFinishKey = (set, collector, finish) => set + "|" + normNum(collector) + "|" + finish;
  function printFinishIndex(rows) {
    const idx = new Map();
    for (const r of rows || state.cards) {
      const k = printFinishKey(r.set, r.collector, r.finish);
      if (!idx.has(k)) idx.set(k, r);
    }
    return idx;
  }
  // What a receipt's lines are worth now: each line at its stack's current
  // price, or the market price captured on the line when no stack matches.
  // `priced` counts the copies that had a price either way.
  function receiptMarket(receipt, idx) {
    let market = 0, priced = 0;
    for (const l of (receipt.lines || [])) {
      const rec = idx.get(printFinishKey(l.set, l.collector, l.finish));
      const p = rec ? rec.price : l.market;
      if (p != null) { market += p * l.qty; priced += l.qty; }
    }
    return { market, priced };
  }
  // Two key sets hold the same keys (#115: refetch only when they differ).
  function sameKeySet(a, b) {
    if (!a || !b || a.size !== b.size) return false;
    for (const k of a) if (!b.has(k)) return false;
    return true;
  }

  function findOrCreateLocation(name, type) {
    name = String(name || "Unsorted").trim() || "Unsorted";
    let l = state.locations.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (l) return l.id;
    l = createLocation({ name, type: type || "Other" });
    state.locations.push(l);
    return l.id;
  }

  // A brand-new location (not one being re-read from saved data): stamps
  // createdAt so a never-counted location isn't "overdue for a count" the
  // minute it exists (#248). newLocation alone is also the load normalizer,
  // so it must not stamp - an old location's real age is unknown.
  function createLocation(seed) {
    return newLocation(Object.assign({}, seed, { createdAt: new Date().toISOString() }));
  }

  function newLocation(seed) {
    const s = seed || {};
    const cap = v => (v == null || v === "" ? null : Math.max(0, parseInt(v, 10) || 0));
    return {
      id: s.id || uid(),
      name: s.name || "Unnamed",
      type: s.type || "Other",
      // Total cards this place holds.
      maxCards: cap(s.maxCards),
      // How many copies of the SAME card (by oracle id, so across printings and
      // languages) this place will take. A binder that wants one of each sets
      // this to 1 and everything beyond that overflows to the next location.
      maxPerName: cap(s.maxPerName),
      priority: Number(s.priority) || 0,
      pickPriority: Number(s.pickPriority) || 0,
      // A sorting tray. Never a putaway destination - it is where cards land
      // when they come in, and the whole point is to empty it afterwards.
      staging: !!s.staging,
      // Whether stock here is offered for sale (Manapool listings pull from
      // here, and an incoming order can be auto-matched against it). Off by
      // default - a fresh location is not sellable until someone says so.
      sellFrom: !!s.sellFrom,
      notes: String(s.notes || ""),
      // How the cards inside physically sit (#267): ordered sort levels
      // [{ field, dir }], or null when not set. Pick lists and Inventory
      // list this location's cards in that order (locSortComparator).
      sortMethod: normalizeSortMethod(s.sortMethod),
      // Pockets per binder page (#293), for Putaway's "where it goes"
      // picture. null = not set, which reads as 9 (binderPageSize). Kept on
      // any type, so switching a binder to a box and back loses nothing.
      cardsPerPage: normalizePageSize(s.cardsPerPage),
      // Stamped only when a FULL cycle count of this bin completes (not by a
      // sample check) - drives book-to-floor's "most overdue bin" selection.
      lastCycleCountAt: s.lastCycleCountAt || null,
      // When the location was made (createLocation). Null on locations from
      // before #248 - their age is unknown.
      createdAt: s.createdAt || null,
      // Sealed stock's own full-count stamp (applySealedCycleCountAdjustments),
      // kept separate so counting one kind of stock doesn't make the bin look
      // freshly checked for the other. Drives sealed "Pick a bin for me".
      lastSealedCycleCountAt: s.lastSealedCycleCountAt || null,
      // On the count list (#386): { at, by, reason } when something on the
      // floor says this bin's book is wrong (a short pick). A full count of
      // the bin clears it. See requestBinCount().
      countWanted: s.countWanted && typeof s.countWanted === "object" ? s.countWanted : null,
      countWantedSealed: s.countWantedSealed && typeof s.countWantedSealed === "object" ? s.countWantedSealed : null,
      // Where this bin falls on the pick path (#386), separate from its name.
      // Null: it follows the numbered bins, in natural name order. See walkCompare.
      walkSeq: normalizeWalkSeq(s.walkSeq),
      putaway: {
        enabled: !!(s.putaway && s.putaway.enabled),
        rules: normalizeCriteriaBox(s.putaway && s.putaway.rules)
      }
    };
  }

  function normalizeWalkSeq(v) {
    if (v == null || v === "") return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  /* The pick path: numbered bins in number order, then the rest by name
     (natural order, so bin 2 before bin 10). Same bin number: by name. */
  function walkCompare(aId, bId) {
    const seq = id => { const l = locById(id); return l && l.walkSeq != null ? l.walkSeq : Infinity; };
    const a = seq(aId), b = seq(bId);
    if (a !== b) return a < b ? -1 : 1;
    return String(locName(aId)).localeCompare(String(locName(bId)), undefined, { numeric: true, sensitivity: "base" });
  }

  /* ============================== Location sorting method (#267) ============================== */
  /* How the cards inside one location physically sit: an ordered list of
     sort levels, each { field, dir } with dir "asc" or "desc". Level 1 is
     the grouping, later levels break its ties ("grouped by set code, ordered
     by color identity" is set asc, then colorIdentity asc). One comparator
     serves pick lists, Inventory and Putaway (#293), so they never disagree.
     Keys come straight off the stack record (no card lookups), worked out
     once per row by sortInLocationOrder, so a 70k-stack location sorts in
     one pass. A blank key (no price, no mana value on file) sinks to the end
     in either direction, the same as a blank cell in a sorted table. */
  const WUBRG = "WUBRG";
  // W, U, B, R, G (0-4), then multicolor (5.x, the same combination kept
  // together, fewer colors first), then colorless (6).
  function colorRank(cs) {
    if (!Array.isArray(cs)) return null;
    const idx = [...new Set(cs.map(c => WUBRG.indexOf(String(c).toUpperCase())).filter(i => i >= 0))].sort();
    if (!idx.length) return 6;
    if (idx.length === 1) return idx[0];
    return 5 + idx.length / 10 + Number(idx.join("")) / 1e6;
  }
  const RARITY_ORDER = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
  // The card type it would be filed under: Artifact Creature is a creature,
  // Artifact Land a land. Only the front face counts.
  const MAIN_TYPES = ["Creature", "Planeswalker", "Battle", "Land", "Instant", "Sorcery", "Artifact", "Enchantment", "Kindred", "Tribal"];
  function mainType(typeLine) {
    const words = new Set(String(typeLine || "").split("//")[0].split("—")[0].trim().split(/\s+/));
    for (const t of MAIN_TYPES) if (words.has(t)) return t === "Tribal" ? "Kindred" : t;
    return null;
  }
  // Collector numbers: 2 < 10 < 101a (natural order), then the specials that
  // don't start with a digit (★, S1, A-12).
  function compareCollector(a, b) {
    const da = /^\d/.test(a), db = /^\d/.test(b);
    if (da !== db) return da ? -1 : 1;
    return SORT_COLLATOR.compare(a, b);
  }
  const AZ = ["A to Z", "Z to A"], LOHI = ["low to high", "high to low"];
  // dirs: what each direction reads as in the editor. short: how a level
  // reads in the location's summary pill (desc only says its direction,
  // except text, which always does: "Set code A–Z › Collector #").
  const LOC_SORT_FIELDS = [
    { id: "set", label: "Set code", short: "Set code", dirs: AZ, text: true, key: r => r.set ? String(r.set).toUpperCase() : null },
    { id: "setName", label: "Set name", short: "Set name", dirs: AZ, text: true, key: r => r.setName || null },
    { id: "released", label: "Set release date", short: "Release date", dirs: ["oldest first", "newest first"], key: r => r.releasedAt || null },
    { id: "collector", label: "Collector number", short: "Collector #", dirs: LOHI, key: r => (r.collector == null ? null : String(r.collector)), cmp: compareCollector },
    { id: "name", label: "Card name", short: "Name", dirs: AZ, text: true, key: r => r.name || null },
    { id: "cmc", label: "Mana value", short: "Mana value", dirs: LOHI, key: r => (r.cmc == null || r.cmc === "" ? null : Number(r.cmc)) },
    { id: "color", label: "Color", short: "Color", dirs: ["W, U, B, R, G, multicolor, colorless", "colorless, multicolor, G, R, B, U, W"], key: r => colorRank(r.colors) },
    { id: "colorIdentity", label: "Color identity", short: "Color identity", dirs: ["W, U, B, R, G, multicolor, colorless", "colorless, multicolor, G, R, B, U, W"], key: r => colorRank(r.colorIdentity) },
    { id: "rarity", label: "Rarity", short: "Rarity", dirs: ["common to mythic", "mythic to common"], key: r => { const i = RARITY_ORDER.indexOf(String(r.rarity || "").toLowerCase()); return i < 0 ? null : i; } },
    { id: "type", label: "Card type", short: "Type", dirs: AZ, text: true, key: r => mainType(r.typeLine) },
    { id: "finish", label: "Finish", short: "Finish", dirs: ["non-foil, foil, etched", "etched, foil, non-foil"], key: r => { const i = FINISHES.indexOf(r.finish); return i < 0 ? null : i; } },
    { id: "condition", label: "Condition", short: "Condition", dirs: ["Near Mint to Damaged", "Damaged to Near Mint"], key: r => { const i = CONDITIONS.indexOf(r.condition); return i < 0 ? null : i; } },
    { id: "lang", label: "Language", short: "Language", dirs: AZ, text: true, key: r => (r.lang ? LANG_NAMES[r.lang] || r.lang : null) },
    { id: "price", label: "Price", short: "Price", dirs: LOHI, key: r => (r.price == null || r.price === "" ? null : Number(r.price)) }
  ];
  const LOC_SORT_FIELD_BY_ID = new Map(LOC_SORT_FIELDS.map(f => [f.id, f]));
  // The editor's ready-made setups (the owner's list, #267).
  const LOC_SORT_PRESETS = [
    { id: "setCollector", label: "Set code A–Z, then collector #", levels: [{ field: "set", dir: "asc" }, { field: "collector", dir: "asc" }] },
    { id: "colorName", label: "Color, then name", levels: [{ field: "color", dir: "asc" }, { field: "name", dir: "asc" }] },
    { id: "identitySet", label: "Color identity, then set code", levels: [{ field: "colorIdentity", dir: "asc" }, { field: "set", dir: "asc" }] },
    { id: "cmcName", label: "Mana value high→low, then name", levels: [{ field: "cmc", dir: "desc" }, { field: "name", dir: "asc" }] },
    { id: "name", label: "Name A–Z", levels: [{ field: "name", dir: "asc" }] }
  ];
  const LOC_SORT_MAX_LEVELS = 8;

  // A saved sort method, cleaned: unknown fields and repeats dropped, dir
  // defaults to "asc", null when nothing is left (= not set).
  function normalizeSortMethod(v) {
    if (!Array.isArray(v)) return null;
    const out = [], seen = new Set();
    for (const l of v) {
      const f = l && LOC_SORT_FIELD_BY_ID.get(l.field);
      if (!f || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ field: f.id, dir: l.dir === "desc" ? "desc" : "asc" });
      if (out.length >= LOC_SORT_MAX_LEVELS) break;
    }
    return out.length ? out : null;
  }

  // The preset these levels match exactly, or null (= Custom).
  function locSortPresetOf(sortMethod) {
    const lv = normalizeSortMethod(sortMethod);
    if (!lv) return null;
    const s = JSON.stringify(lv);
    return LOC_SORT_PRESETS.find(p => JSON.stringify(p.levels) === s) || null;
  }

  // One line for the location card: "Set code A–Z › Color identity › Collector #".
  function locSortSummary(sortMethod) {
    const lv = normalizeSortMethod(sortMethod);
    if (!lv) return "";
    return lv.map(l => {
      const f = LOC_SORT_FIELD_BY_ID.get(l.field);
      if (f.text) return f.short + (l.dir === "desc" ? " Z–A" : " A–Z");
      return f.short + (l.dir === "desc" ? " (" + f.dirs[1] + ")" : "");
    }).join(" › ");
  }

  /* The comparator for a location's sort method, over stack records (or
     anything shaped like one: a pick-list line works, with fewer fields).
     null when the method is empty. It also carries keyOf(rec) and
     compareKeys(ka, kb) so a caller sorting many rows, or placing one card
     among a location's sorted contents (#293), works out each row's keys
     once instead of on every comparison. */
  function locSortComparator(sortMethod) {
    const levels = normalizeSortMethod(sortMethod);
    if (!levels) return null;
    const defs = levels.map(l => ({ f: LOC_SORT_FIELD_BY_ID.get(l.field), sign: l.dir === "desc" ? -1 : 1 }));
    const keyOf = rec => defs.map(d => {
      const v = rec ? d.f.key(rec) : null;
      return v == null || v === "" || (typeof v === "number" && isNaN(v)) ? null : v;
    });
    const compareKeys = (ka, kb) => {
      for (let i = 0; i < defs.length; i++) {
        const a = ka[i], b = kb[i];
        if (a == null || b == null) {
          if (a == null && b == null) continue;
          return a == null ? 1 : -1;      // blanks sink either way
        }
        const f = defs[i].f;
        const c = f.cmp ? f.cmp(a, b) : typeof a === "number" ? a - b : SORT_COLLATOR.compare(String(a), String(b));
        if (c) return c < 0 ? -defs[i].sign : defs[i].sign;
      }
      return 0;
    };
    const cmp = (a, b) => compareKeys(keyOf(a), keyOf(b));
    cmp.keyOf = keyOf;
    cmp.compareKeys = compareKeys;
    cmp.levels = levels;
    return cmp;
  }

  /* rows in a location's sort-method order: keys worked out once per row,
     ties keep their incoming order. recOf(row) gives the record to read
     (default: the row itself). An empty method returns a copy unchanged. */
  function sortInLocationOrder(rows, sortMethod, recOf) {
    const c = locSortComparator(sortMethod);
    if (!c) return rows.slice();
    const keyed = rows.map((row, i) => ({ row, i, k: c.keyOf(recOf ? recOf(row) : row) }));
    keyed.sort((a, b) => c.compareKeys(a.k, b.k) || a.i - b.i);
    return keyed.map(x => x.row);
  }

  /* ============================== Position inside a location (#293) ============================== */
  /* Where a card goes (Putaway) or sits (pick lists / Inventory, #295)
     inside a location that has a sorting method, counted in physical copies:
     position 1 is the front of a box, or the first pocket of a binder's
     page 1. Each side of a binder sheet is one page.

     locationLayouts() is the per-plan cache: the first get() groups every
     stack by location in one pass, and each sorted location is then keyed
     and sorted once (sortInLocationOrder's order: ties keep their order in
     the collection). A layout answers:
       place(rec, qty)  - where qty copies of rec would go, AFTER every copy
                          already there and every copy an earlier place()
                          on this layout reserved (several plan lines into
                          one location stack up). Reserves them.
       locate(rec)      - where a stack already in the location sits.
       sectionsAt(seq)  - the location split into level-1 sections
                          [{ label, from, to, cards }], as of one placement
                          (seq) - for the picture.
     Both return a placement:
       { locationId, name, type, cap, perPage (binders only), total, from,
         to, prev, next, section: { label, from, to, isNew }, seq }
     from..to are this stack's copies; prev/next are the neighbouring
     stacks ({ name, set, collector }, null at an end); section is the run
     of cards sharing level 1's value, these copies included. */
  const BINDER_TYPES = ["Binder", "Trade Binder"];
  const DEFAULT_PAGE_SIZE = 9;
  function normalizePageSize(v) {
    const n = parseInt(v, 10);
    return n >= 1 && n <= 100 ? n : null;
  }
  const isBinderType = type => BINDER_TYPES.includes(type);
  // A binder's pockets per page (its own setting, or 9); null for anything
  // that isn't a binder.
  function binderPageSize(loc) {
    if (!loc || !isBinderType(loc.type)) return null;
    return normalizePageSize(loc.cardsPerPage) || DEFAULT_PAGE_SIZE;
  }
  // Position (1 = first pocket of page 1) -> { page, pocket }.
  function binderSpot(pos, perPage) {
    const n = Math.max(1, Number(pos) || 1), per = Math.max(1, Number(perPage) || DEFAULT_PAGE_SIZE);
    return { page: Math.ceil(n / per), pocket: ((n - 1) % per) + 1 };
  }

  const COLOR_WORDS = ["White", "Blue", "Black", "Red", "Green"];
  // What a level-1 section is called on the picture: "ELD", "Red", "Rare".
  function sectionLabel(fieldId, key, rec) {
    const f = LOC_SORT_FIELD_BY_ID.get(fieldId);
    if (key == null) return "No " + (f ? f.short.toLowerCase() : "value");
    switch (fieldId) {
      case "collector": return "#" + key;
      case "cmc": return "MV " + key;
      case "price": return money(key);
      case "rarity": { const r = RARITY_ORDER[key] || ""; return r.charAt(0).toUpperCase() + r.slice(1); }
      case "finish": return FINISH_NAMES[FINISHES[key]] || "";
      case "condition": return CONDITIONS[key] || "";
      case "color": case "colorIdentity": {
        if (key < 5) return COLOR_WORDS[key];
        if (key >= 6) return "Colorless";
        const cs = rec && rec[fieldId === "color" ? "colors" : "colorIdentity"];
        const letters = Array.isArray(cs) ? WUBRG.split("").filter(c => cs.some(x => String(x).toUpperCase() === c)).join("") : "";
        return letters || "Multicolor";
      }
      default: return String(key);
    }
  }
  const neighbourOf = rec => rec ? { name: rec.name || "", set: rec.set ? String(rec.set).toUpperCase() : "", collector: rec.collector == null ? "" : String(rec.collector) } : null;

  // opts.leaving: ids of stacks a plan moves out (Whole collection, Rule
  // breakers) - not counted where they sit now, so "after X" never names one.
  function locationLayouts(opts) {
    const leaving = (opts && opts.leaving) || null;
    let byLoc = null;
    const cache = new Map();
    function rowsByLocation() {
      if (byLoc) return byLoc;
      byLoc = new Map();
      const sorted = new Set(state.locations.filter(l => l.sortMethod).map(l => l.id));
      for (const r of state.cards) {
        if (!sorted.has(r.locationId) || (leaving && leaving.has(r.id))) continue;
        let a = byLoc.get(r.locationId);
        if (!a) byLoc.set(r.locationId, a = []);
        a.push(r);
      }
      return byLoc;
    }
    return {
      // The layout for one location, or null when it has no sorting method.
      get(locationId) {
        if (cache.has(locationId)) return cache.get(locationId);
        const loc = locById(locationId);
        const lay = loc && loc.sortMethod ? buildLayout(loc, rowsByLocation().get(loc.id) || []) : null;
        cache.set(locationId, lay);
        return lay;
      }
    };
  }
  // One location's layout over the given stacks (exported for tests and for
  // a caller that already has them).
  function buildLayout(loc, rows) {
    const c = locSortComparator(loc.sortMethod);
    if (!c) return null;
    const cmp0 = (a, b) => c.compareKeys([a[0]], [b[0]]);
    const base = rows.map((rec, i) => ({ rec, i, k: c.keyOf(rec), q: Math.max(0, Number(rec.quantity) || 0) }));
    base.sort((a, b) => c.compareKeys(a.k, b.k) || a.i - b.i);
    const cum = [0];
    for (const e of base) cum.push(cum[cum.length - 1] + e.q);
    let indexById = null;
    let seqNext = 0;
    // First index in arr whose key compares > k (upper) or >= k (lower).
    const bound = (arr, k, f, strict) => {
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const d = f(arr[mid].k, k);
        if (strict ? d > 0 : d >= 0) hi = mid; else lo = mid + 1;
      }
      return lo;
    };
    /* Copies reserved by earlier place() calls, kept sorted in runs of a few
       hundred, each with its copy count: a lookup or insert costs about
       (lines / run) + run, so Fill a bin sending 70k stacks into one sorted
       box stays fast instead of rescanning every earlier line each time.
       A position is { b: run, i: index in run }. */
    const RUN = 256;
    const runs = [];           // [{ items: [{ rec, k, q, seq }], q }]
    let pendingTotal = 0;
    const pBound = (k, f, strict) => {
      const past = e => { const d = f(e.k, k); return strict ? d > 0 : d >= 0; };
      let lo = 0, hi = runs.length;
      while (lo < hi) { const m = (lo + hi) >> 1, it = runs[m].items; if (past(it[it.length - 1])) hi = m; else lo = m + 1; }
      if (lo === runs.length) return { b: lo, i: 0 };
      const it = runs[lo].items;
      let a = 0, z = it.length;
      while (a < z) { const m = (a + z) >> 1; if (past(it[m])) z = m; else a = m + 1; }
      return { b: lo, i: a };
    };
    const pQ = pos => {
      let n = 0;
      for (let j = 0; j < pos.b && j < runs.length; j++) n += runs[j].q;
      if (pos.b < runs.length) for (let j = 0; j < pos.i; j++) n += runs[pos.b].items[j].q;
      return n;
    };
    const pAt = pos => (pos.b < runs.length ? runs[pos.b].items[pos.i] || null : null);
    const pBefore = pos => {
      if (pos.b < runs.length && pos.i > 0) return runs[pos.b].items[pos.i - 1];
      const b = Math.min(pos.b, runs.length) - 1;
      return b >= 0 ? runs[b].items[runs[b].items.length - 1] : null;
    };
    const pInsert = (pos, e) => {
      pendingTotal += e.q;
      if (!runs.length) { runs.push({ items: [e], q: e.q }); return; }
      let b = pos.b, i = pos.i;
      if (b >= runs.length) { b = runs.length - 1; i = runs[b].items.length; }
      const r = runs[b];
      r.items.splice(i, 0, e);
      r.q += e.q;
      if (r.items.length > 2 * RUN) {
        const right = r.items.splice(RUN);
        const rq = right.reduce((t, x) => t + x.q, 0);
        r.q -= rq;
        runs.splice(b + 1, 0, { items: right, q: rq });
      }
    };
    const perPage = binderPageSize(loc);
    const cap = loc.maxCards == null ? null : Number(loc.maxCards);
    // sections(): the level-1 sections as this placement saw them, for the picture.
    const shape = o => {
      const out = Object.assign({ locationId: loc.id, name: loc.name, type: loc.type, cap, perPage }, o);
      out.sections = () => sectionsAt(out.seq);
      return out;
    };

    function place(rec, qty) {
      const q = Math.max(1, Number(qty == null ? rec.quantity : qty) || 1);
      const k = c.keyOf(rec);
      const seq = seqNext++;
      const bU = bound(base, k, c.compareKeys, true), pU = pBound(k, c.compareKeys, true);
      const before = cum[bU] + pQ(pU);
      // Among equal keys the copies already there come first, then earlier
      // plan lines in plan order - so the last of those is the one before.
      const bPrev = bU > 0 ? base[bU - 1] : null, pPrev = pBefore(pU);
      const prev = pPrev && (!bPrev || c.compareKeys(pPrev.k, bPrev.k) >= 0) ? pPrev : bPrev;
      const bNext = base[bU] || null, pNext = pAt(pU);
      const next = bNext && (!pNext || c.compareKeys(bNext.k, pNext.k) <= 0) ? bNext : pNext;
      const bL0 = bound(base, k, cmp0, false), bU0 = bound(base, k, cmp0, true);
      const pL0 = pBound(k, cmp0, false), pU0 = pBound(k, cmp0, true);
      const pFrom = pQ(pL0), pTo = pQ(pU0);
      const out = shape({
        mode: "put", seq,
        total: cum[base.length] + pendingTotal + q,
        from: before + 1, to: before + q,
        prev: neighbourOf(prev && prev.rec), next: neighbourOf(next && next.rec),
        section: {
          label: sectionLabel(c.levels[0].field, k[0], rec),
          from: cum[bL0] + pFrom + 1,
          to: cum[bU0] + pTo + q,
          isNew: bL0 === bU0 && pFrom === pTo
        }
      });
      pInsert(pU, { rec, k, q, seq });
      return out;
    }

    function locate(rec) {
      if (!indexById) { indexById = new Map(); base.forEach((e, j) => indexById.set(e.rec.id, j)); }
      const j = rec ? indexById.get(rec.id) : undefined;
      if (j == null) return null;
      const e = base[j];
      const bL0 = bound(base, e.k, cmp0, false), bU0 = bound(base, e.k, cmp0, true);
      return shape({
        mode: "here", seq: -1,
        total: cum[base.length],
        from: cum[j] + 1, to: cum[j] + Math.max(1, e.q),
        prev: neighbourOf(j > 0 ? base[j - 1].rec : null), next: neighbourOf(base[j + 1] ? base[j + 1].rec : null),
        section: { label: sectionLabel(c.levels[0].field, e.k[0], e.rec), from: cum[bL0] + 1, to: cum[bU0], isNew: false }
      });
    }

    // Level-1 sections as of placement seq (-1 = only what's there now).
    function sectionsAt(seq) {
      const out = [];
      let pos = 0, i = 0, j = 0;
      const pend = [];
      for (const r of runs) for (const e of r.items) if (e.seq <= seq) pend.push(e);
      while (i < base.length || j < pend.length) {
        // Same merge rule as place(): on equal keys the base copy goes first.
        const takeBase = j >= pend.length || (i < base.length && c.compareKeys(base[i].k, pend[j].k) <= 0);
        const e = takeBase ? base[i++] : pend[j++];
        const last = out[out.length - 1];
        if (last && cmp0(last.k, e.k) === 0) { last.to += e.q; last.cards += e.q; }
        else out.push({ k: e.k, label: sectionLabel(c.levels[0].field, e.k[0], e.rec), from: pos + 1, to: pos + e.q, cards: e.q });
        pos += e.q;
      }
      return out.filter(s => s.cards > 0).map(s => ({ label: s.label, from: s.from, to: s.to, cards: s.cards }));
    }

    return { location: loc, levels: c.levels, cards: cum[base.length], place, locate, sectionsAt };
  }

  // "after Lightning Bolt · M10 #146" - the neighbouring stack, in words.
  const neighbourText = n => n.name + (n.set ? " · " + n.set : "") + (n.collector ? " #" + n.collector : "");
  function placementNeighbourText(p) {
    if (!p) return "";
    if (!p.prev && !p.next) return p.mode === "here" ? "the only card in here" : "first card in here";
    if (!p.prev) return "at the start, before " + neighbourText(p.next);
    if (!p.next) return "at the end, after " + neighbourText(p.prev);
    return "after " + neighbourText(p.prev);
  }
  // "ELD section: cards 234–284, this one about #251", or pages for a binder.
  function placementSectionText(p) {
    if (!p) return "";
    const s = p.section, n = p.to - p.from + 1;
    const one = n === 1 ? "this one" : "these " + n;
    if (p.perPage) {
      const a = binderSpot(p.from, p.perPage), b = binderSpot(p.to, p.perPage);
      const sa = binderSpot(s.from, p.perPage).page, sb = binderSpot(s.to, p.perPage).page;
      const where = a.page === b.page ? "page " + a.page + ", pocket " + a.pocket + (n > 1 ? "–" + b.pocket : "")
        : "pages " + a.page + "–" + b.page;
      if (s.isNew) return "new " + s.label + " section, " + where;
      return s.label + " section: " + (sa === sb ? "page " + sa : "pages " + sa + "–" + sb) + ", " + one + " about " + where;
    }
    const where = "#" + p.from + (n > 1 ? "–" + p.to : "");
    if (s.isNew) return "new " + s.label + " section at " + where;
    return s.label + " section: cards " + s.from + "–" + s.to + ", " + one + " about " + where;
  }

  /* ============================== Event bus ============================== */
  const listeners = {};
  function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => off(ev, fn); }
  function off(ev, fn) { const a = listeners[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  function emit(ev, payload) { for (const fn of (listeners[ev] || []).slice()) { try { fn(payload); } catch (e) { console.error(e); } } }

  /* ============================== API ============================== */
  /* opts.gzip compresses a JSON body with the browser's own CompressionStream
     before sending it, Content-Encoding: gzip, matched by a gunzip on the
     server side (server/lib/http.js's readJsonBody). Only worth doing for the
     one body big enough to matter (the whole-collection autosave PUT) -
     small bodies elsewhere just pass opts.gzip unset and go over the wire
     exactly as before. Falls back to a plain body on any browser/error, so
     a compression hiccup degrades to "sends more bytes", never "fails". */
  async function maybeGzip(json) {
    if (typeof CompressionStream !== "function") return null;
    try {
      const cs = new CompressionStream("gzip");
      const writer = cs.writable.getWriter();
      writer.write(new TextEncoder().encode(json));
      writer.close();
      return await new Response(cs.readable).arrayBuffer();
    } catch (e) { return null; }
  }
  /* opts.keepalive (#174): the save made as the page is hidden or left asks
     the browser to finish the request even if the page goes away. Browsers
     allow keepalive requests 64 KiB of body in flight, for the whole page,
     and refuse one past that, so a body is only sent that way when it fits
     what is left of the budget; otherwise it goes as a normal request (a
     whole collection is megabytes, but a patch save, #181, is usually a
     few KB, so the save made on leaving normally fits). A keepalive
     body goes unzipped: compressing is asynchronous, and a page being left
     may not get to run anything after the event that started the save. */
  const KEEPALIVE_MAX = 60000;
  let keepaliveBytes = 0;
  function keepaliveSize(body) {
    if (typeof body !== "string") return Infinity;
    // A UTF-8 byte count is never smaller than the string's length.
    return body.length > KEEPALIVE_MAX ? Infinity : new TextEncoder().encode(body).length;
  }
  function leaveForKiosk() {
    leaveWithoutSaving();
    if (location.pathname !== "/kiosk.html") location.replace("/kiosk.html");
  }
  async function api(path, opts) {
    const o = opts || {};
    let body = o.body ? JSON.stringify(o.body) : undefined;
    const headers = Object.assign({ Accept: "application/json" }, o.body ? { "Content-Type": "application/json" } : {});
    let keep = 0;
    if (o.keepalive && body) {
      const n = keepaliveSize(body);
      if (keepaliveBytes + n <= KEEPALIVE_MAX) keep = n;
    }
    if (o.gzip && body && !keep) {
      const gz = await maybeGzip(body);
      if (gz) { body = gz; headers["Content-Encoding"] = "gzip"; }
    }
    const init = { method: o.method || "GET", headers, body, credentials: "same-origin" };
    if (keep) init.keepalive = true;
    keepaliveBytes += keep;
    let res;
    try { res = await fetch(path, init); }
    finally { keepaliveBytes -= keep; }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text.slice(0, 300) }; }
    if (res.status === 401) {
      // The session went away - send them to sign in rather than throwing a
      // dozen confusing errors behind a dead page.
      if (!/\/login\.html/.test(location.pathname)) {
        location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
      }
      throw Object.assign(new Error("Your session expired. Sign in again."), { status: 401 });
    }
    // This device is the store's kiosk now (#433): the server refuses every
    // desk route to it. A desk page still here (another tab, or one back from
    // the browser's history) leaves for the kiosk screen rather than keep
    // showing what it drew before.
    if (res.status === 403 && data && data.kiosk === true) {
      leaveForKiosk();
      throw Object.assign(new Error("This device is the store's kiosk."), { status: 403, kiosk: true });
    }
    if (!res.ok) {
      throw Object.assign(new Error((data && data.error) || ("HTTP " + res.status)),
        { status: res.status, data });
    }
    return data;
  }

  /* ============================== Card data (server-backed) ============================== */
  /* v0.07 sent every keystroke to api.scryfall.com from the browser, could not
     set the User-Agent Scryfall asks for, and shared one rate limit with every
     other tab. All of that now happens once, on the server, against a daily
     bulk download. These calls hit our own host and are effectively free. */
  const cardCache = new Map();      // printKey -> card object | null

  const cardsApi = {
    status: () => api("/api/cards/status"),
    autocomplete: q => api("/api/cards/autocomplete?q=" + encodeURIComponent(q)).then(d => d.data || []),
    printings: name => api("/api/cards/printings?name=" + encodeURIComponent(name)).then(d => d.data || []),
    sets: () => api("/api/cards/sets").then(d => d.data || []),
    search: params => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) if (v) qs.set(k, v);
      return api("/api/cards/search?" + qs.toString()).then(d => d.data || []);
    },
    async one(set, num, lang) {
      const key = printKey(set, num, lang);
      if (cardCache.has(key)) return cardCache.get(key);
      try {
        const d = await api("/api/cards/one?set=" + encodeURIComponent(set) +
          "&num=" + encodeURIComponent(num) + "&lang=" + encodeURIComponent(lang || "en"));
        cardCache.set(key, d.card);
        return d.card;
      } catch (e) {
        if (e.status === 404) { cardCache.set(key, null); return null; }
        throw e;
      }
    },
    collection: identifiers => api("/api/cards/collection", { method: "POST", body: { identifiers } }),
    // Oracle tags (otag, e.g. "removal") and illustration/art tags (art, e.g.
    // "dragon") are Scryfall's Tagger data, cached server-side from its own
    // separate bulk files (not the main card database). Returns oracle ids
    // (otag) or exact scryfall ids (art), since an oracle tag applies to
    // every printing of a card but an art tag is specific to one printing's
    // artwork - and `found:false` when the text isn't a real tag slug/alias
    // at all, as distinct from a real tag with zero matches in Scryfall.
    tagSearch: (kind, q) => api("/api/cards/tag-search?kind=" + encodeURIComponent(kind) + "&q=" + encodeURIComponent(q))
      .then(d => ({ ids: d.ids || [], found: d.found !== false }))
  };

  const priceOf = (card, finish) => {
    if (!card) return null;
    const p = finish === "etched" ? card.usdEtched : finish === "foil" ? card.usdFoil : card.usd;
    return p == null ? null : Number(p);
  };

  /* The finish to use for a printing: the asked-for one, unless the printing
     doesn't come in it (a foil-only card asked for as non-foil), then the
     first finish it does come in (#326). */
  const fitFinish = (card, finish) => {
    const f = ((card && card.finishes) || []).filter(x => FINISHES.includes(x));
    return f.length && !f.includes(finish) ? f[0] : finish;
  };

  /* A catalog printing shaped like an inventory row for the rule engine: its
     Finish field reads `finish` (a "nonfoil"/"foil"/"etched" string) and its
     Price field reads `price`, so both must follow the finish picked. Used by
     Locations' "Test a card" box. */
  const shapeForRuleTest = (card, finish, quantity) => {
    const f = finish === "foil" || finish === "etched" ? finish : "nonfoil";
    return Object.assign({}, card, { finish: f, price: priceOf(card, f), quantity: quantity == null ? 1 : quantity });
  };

  /* oracleId is in here so "the same card" can be counted across printings and
     languages - a Japanese Lightning Bolt and a 2X2 Lightning Bolt share an
     oracle id but not a name. The per-name cap on a location depends on it. */
  const META_KEYS = ["oracleId", "typeLine", "oracle", "manaCost", "cmc", "colors", "colorIdentity",
    "keywords", "artist", "releasedAt", "setType", "promo", "fullArt", "reserved", "borderColor",
    "layout", "power", "toughness", "edhrecRank", "imageUrl"];

  function pickMeta(card) {
    const out = {};
    for (const k of META_KEYS) if (card[k] !== undefined) out[k] = card[k];
    // A card shown by its printed (foreign) name also carries the English one (#334).
    out.englishName = card.lang !== "ph" && card.printedName && card.name && card.printedName !== card.name ? card.name : "";
    return out;
  }

  /* The shape the add/edit paths want, from a server card object. */
  async function lookupCard(set, num, lang, finish) {
    set = String(set).trim().toLowerCase();
    num = String(num).trim();
    lang = String(lang || "en").trim().toLowerCase();
    finish = normalizeFinish(finish) || "nonfoil";
    if (!set || !num) throw new Error("Set code and collector number are required.");
    const card = await cardsApi.one(set, num, lang);
    if (!card) throw new Error('Not found: set "' + set + '" #' + num);

    const collector = String(card.collector == null ? num : card.collector);
    let note = card.langFallback && lang !== "en" ? " (that language isn't on Scryfall; used the default print)" : "";
    if (normNum(collector) !== normNum(num)) note += ' (collector # stored as "' + collector + '")';
    let price = priceOf(card, finish);
    let priceNote = "";
    if (price == null) {
      priceNote = "no-" + finish + "-price";
      const anyOther = FINISHES.some(f => f !== finish && priceOf(card, f) != null);
      if (anyOther) note += " (no " + FINISH_NAMES[finish].toLowerCase() + " price on file for this printing)";
    }
    return {
      name: cardName(card),
      collector,
      setName: card.setName || set.toUpperCase(),
      rarity: card.rarity || "",
      tcgplayerId: card.tcgplayerId || "",
      scryfallId: card.id || "",
      price, priceNote, note,
      card,
      meta: pickMeta(card)
    };
  }

  /* ============================== Load / normalise ============================== */
  function normalizeVendorPrices(vp) {
    if (!vp || typeof vp !== "object") return null;
    const out = {};
    for (const k of ["tcg", "ck", "mp"]) {
      const n = Number(vp[k]);
      if (vp[k] != null && Number.isFinite(n) && n > 0) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  /* A quantity read back from a saved document or a file (#73). Any real
     number, 0 included, is kept as it is: a stack saved at 0 loads as 0 and
     normalizeMerge() drops it, instead of coming back as 1 copy. Only a
     missing or non-numeric value (an old import, a hand-made transfer file)
     falls back to 1, which is what those files have always meant. */
  function storedQty(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : 1;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 1;
    }
    return 1;
  }
  /* ============================== Lending (#336) ==============================
     Lent copies stay in their stack: `quantity` is still every copy you own
     (so totals and value don't move), and `loans` says how many of them are
     out and with whom: [{ id, qty, to, due: "YYYY-MM-DD" or "", at }]. Anything
     asking what's free to use reads availableQty(), never `quantity`.
     The key is left off a stack with no loans (~70k stacks save no extra bytes). */
  function normalizeLoans(raw, quantity) {
    if (!Array.isArray(raw) || !raw.length) return null;
    const out = [], byKey = new Map();
    let room = Math.max(0, Number(quantity) || 0);
    for (const l of raw) {
      const to = String((l && l.to) || "").trim().slice(0, 80);
      const qty = Math.min(room, Math.floor(Number(l && l.qty)) || 0);
      if (!to || !(qty > 0)) continue;
      room -= qty;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(l.due || "")) ? l.due : "";
      // Same person, same give-back date: one line, however it came to be two.
      const key = to.toLowerCase() + "|" + due;
      const had = byKey.get(key);
      if (had) { had.qty += qty; continue; }
      const loan = { id: String(l.id || uid()), qty, to, due, at: l.at || null };
      byKey.set(key, loan);
      out.push(loan);
    }
    return out.length ? out : null;
  }
  // Writes a stack's loans, never more copies than it holds (the newest go first).
  function setLoans(r, loans) {
    const clean = normalizeLoans(loans, r.quantity);
    if (clean) r.loans = clean; else delete r.loans;
  }
  function lentQty(r) {
    if (!r || !r.loans) return 0;
    return r.loans.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  }
  // Copies actually here, free to pick, list, trade or move into a deck.
  // A stack held on an open receipt (#388, `held`) has none free until the
  // desk closes it: it can be put away and moved (shelfQty), nothing else.
  function availableQty(r) {
    if (r && r.held) return 0;
    return Math.max(0, (Number(r && r.quantity) || 0) - lentQty(r));
  }
  /* A move just split `clone` off `rec` (rec.quantity is already lowered, and
     the clone was copied from rec, loans and all). The free copies are the ones
     that moved; only copies `rec` no longer has room for take their loan along,
     so a loan is never lost or counted twice. */
  function splitLoans(rec, clone) {
    delete clone.loans;
    if (!rec.loans) return;
    let room = rec.quantity;
    const keep = [], carry = [];
    for (const l of rec.loans) {
      const k = Math.min(room, l.qty);
      room -= k;
      if (k > 0) keep.push(Object.assign({}, l, { qty: k }));
      if (l.qty > k) carry.push(Object.assign({}, l, { qty: l.qty - k, id: k > 0 ? uid() : l.id }));
    }
    setLoans(rec, keep);
    setLoans(clone, carry);
  }
  /* Lend copies of one stack. Only free copies can go: not ones already lent,
     nor ones an open pick list has set aside. Throws a message for the person.
     stillListed: copies now lent that Manapool still shows for sale (lending
     pushes nothing; Listings offers to take them down). */
  function lendCopies(rec, o) {
    const to = String(o.to || "").trim().slice(0, 80);
    const qty = Math.floor(Number(o.qty)) || 0;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(o.due || "")) ? o.due : "";
    if (!to) throw new Error("Type who you're lending to.");
    if (qty < 1) throw new Error("Lend at least 1 copy.");
    const held = pickAllocations().get(rec.id) || 0;
    const free = Math.max(0, availableQty(rec) - held);
    if (qty > free) {
      throw new Error("Only " + free + " free to lend" +
        (lentQty(rec) ? ", " + lentQty(rec) + " already lent" : "") +
        (held ? ", " + held + " set aside for an open pick list" : "") + ".");
    }
    setLoans(rec, (rec.loans || []).concat({ id: uid(), qty, to, due, at: new Date().toISOString() }));
    logAudit({ action: "lend", ...auditCard(rec), qty: 0, oldQty: rec.quantity, newQty: rec.quantity,
      from: locName(rec.locationId),
      note: "Lent " + qty + " to " + to + (due ? ", give back by " + due : "") });
    return { qty, to, due, stillListed: Math.max(0, (Number(rec.listedQty) || 0) - availableQty(rec)) };
  }
  // Some or all of one loan came back. Returns { qty, to }, or null if it's gone.
  function returnLoan(rec, loanId, qty) {
    const loan = rec && (rec.loans || []).find(l => l.id === loanId);
    if (!loan) return null;
    const back = Math.max(1, Math.min(loan.qty, Math.floor(Number(qty)) || loan.qty));
    setLoans(rec, rec.loans.map(l => l === loan ? Object.assign({}, l, { qty: l.qty - back }) : l));
    logAudit({ action: "lend", ...auditCard(rec), qty: 0, oldQty: rec.quantity, newQty: rec.quantity,
      from: locName(rec.locationId), note: "Returned " + back + " by " + loan.to });
    return { qty: back, to: loan.to };
  }
  // Past its give-back date: the day after, not the day itself.
  function loanOverdue(loan, today) {
    return !!(loan && loan.due) && loan.due < (today || localDay(Date.now()));
  }
  // Every loan with its stack: overdue first, then soonest due, then no date.
  function allLoans() {
    const today = localDay(Date.now());
    const out = [];
    for (const record of state.cards) {
      for (const loan of record.loans || []) out.push({ record, loan, overdue: loanOverdue(loan, today) });
    }
    return out.sort((a, b) => (b.overdue - a.overdue) ||
      ((a.loan.due || "9999") < (b.loan.due || "9999") ? -1 : (a.loan.due || "9999") > (b.loan.due || "9999") ? 1 : 0) ||
      a.loan.to.localeCompare(b.loan.to) || a.record.name.localeCompare(b.record.name));
  }
  // Names for the "lend to" box: friends first, then anyone lent to before.
  function loanNameSuggestions(friendNames) {
    const seen = new Set(), out = [];
    const add = n => {
      const name = String(n || "").trim(), k = name.toLowerCase();
      if (name && !seen.has(k)) { seen.add(k); out.push(name); }
    };
    (friendNames || []).forEach(add);
    state.cards.forEach(r => (r.loans || []).forEach(l => add(l.to)));
    return out;
  }

  function normalizeCard(c) {
    let locationId = c.locationId;
    if (!locationId || !locById(locationId)) {
      locationId = findOrCreateLocation(c.location || c.locationName || "Unsorted", c.locationType || "Other");
    }
    const costQty = Math.max(0, Number(c.costQty) || 0);
    const costTotal = round2(Number(c.costTotal) || 0);
    const quantity = storedQty(c.quantity);
    const loans = normalizeLoans(c.loans, quantity);
    return {
      id: c.id || uid(),
      set: String(c.set || "").toLowerCase(),
      collector: String(c.collector || c.number || ""),
      lang: c.lang || "en",
      // Migration: a pre-finish row only ever had `foil: true/false` - reads
      // as "foil"/"nonfoil" the first time it loads under this version.
      // Never both keys going forward; `foil` is dropped entirely below.
      finish: normalizeFinish(c.finish) || (c.foil ? "foil" : "nonfoil"),
      condition: CONDITIONS.includes(c.condition) ? c.condition : "NM",
      name: c.name || "",
      setName: c.setName || "",
      rarity: c.rarity || "",
      tcgplayerId: c.tcgplayerId || "",
      scryfallId: c.scryfallId || "",
      price: c.price == null ? null : Number(c.price),
      // The price last sent to Manapool for this stack's listing (or read
      // back from it). Display only (#228): the ask a push sends is worked
      // out live from the Bulk Price rules (manapoolListingAsks), never read
      // from here. Distinct from `price`, the Scryfall market price.
      askPrice: c.askPrice == null ? null : Number(c.askPrice),
      // Alternative pricing bases a price rule can target instead of
      // Scryfall's market price - Manapool's own algorithmic estimate, and
      // the lowest price actually being asked for this printing/condition on
      // Manapool right now. Refreshed alongside `price` (see refreshPrices).
      mpLow: c.mpLow == null ? null : Number(c.mpLow),
      mpMarket: c.mpMarket == null ? null : Number(c.mpMarket),
      // Today's TCGplayer/Card Kingdom/Manapool prices, {tcg, ck, mp},
      // for the vendor price-rule bases (BACKLOG #78b). Same refresh path.
      vp: normalizeVendorPrices(c.vp),
      locationId,
      quantity,
      listedQty: Number(c.listedQty) || 0,
      priceUpdated: c.priceUpdated || null,
      // Cost basis. costQty is how many of these copies have a known acquisition
      // cost - it is deliberately allowed to be lower than quantity, because
      // cards you already owned before you started tracking spend genuinely have
      // no cost basis and pretending they cost $0 would understate every margin.
      costQty: Math.min(costQty, Math.max(0, quantity)),
      costTotal,
      avgCost: costQty > 0 ? round2(costTotal / costQty) : null,
      lastReceiptId: c.lastReceiptId || "",
      acquiredAt: c.acquiredAt || null,
      oracleId: c.oracleId || "",
      englishName: c.englishName || "",
      typeLine: c.typeLine || "", oracle: c.oracle || "", manaCost: c.manaCost || "",
      cmc: c.cmc == null ? null : Number(c.cmc),
      colors: Array.isArray(c.colors) ? c.colors : [],
      colorIdentity: Array.isArray(c.colorIdentity) ? c.colorIdentity : [],
      keywords: Array.isArray(c.keywords) ? c.keywords : [],
      artist: c.artist || "", releasedAt: c.releasedAt || "", setType: c.setType || "",
      promo: !!c.promo, fullArt: !!c.fullArt, reserved: !!c.reserved,
      borderColor: c.borderColor || "", layout: c.layout || "",
      power: c.power == null ? "" : c.power, toughness: c.toughness == null ? "" : c.toughness,
      edhrecRank: c.edhrecRank == null ? null : Number(c.edhrecRank),
      imageUrl: c.imageUrl || "",
      lookupFail: (c.lookupFail && typeof c.lookupFail === "object") ? c.lookupFail : null,
      priceNote: c.priceNote || "",
      ...(loans ? { loans } : null),
      // The open receipt these copies came in on (#388), until the desk closes it.
      ...(c.held ? { held: String(c.held) } : null)
    };
  }

  /* Sealed product (booster boxes, bundles, etc) - a parallel, much flatter
     inventory type to cards: no oracle id, no condition/finish/language
     tiers, just a fungible quantity per SKU. Identity is Manapool's own
     `tcgplayer_product_id` (see BACKLOG.md #16/#24 for why: Scryfall has no
     sealed data at all, so Manapool's sealed catalog - server/lib/sealed.js
     - IS the catalog, identity and price both, not a price source layered
     on an existing one the way it is for singles). */
  function normalizeSealedItem(s) {
    const src = s || {};
    let locationId = src.locationId;
    if (!locationId || !locById(locationId)) locationId = findOrCreateLocation(src.location || "Unsorted", "Other");
    const costQty = Math.max(0, Number(src.costQty) || 0);
    const costTotal = round2(Number(src.costTotal) || 0);
    return {
      id: src.id || uid(),
      tcgplayerProductId: String(src.tcgplayerProductId || ""),
      manapoolProductId: src.manapoolProductId || "",
      name: src.name || "",
      setCode: String(src.setCode || "").toLowerCase(),
      locationId,
      quantity: Math.max(0, Number(src.quantity) || 0),
      // Cost basis - same "costQty can trail quantity" reasoning as cards'
      // own costQty/costTotal/avgCost (see normalizeCard above).
      costQty: Math.min(costQty, Math.max(0, Number(src.quantity) || 0)),
      costTotal,
      avgCost: costQty > 0 ? round2(costTotal / costQty) : null,
      // Manapool market price snapshotted at intake time - no live refresh
      // in this first slice, see BACKLOG.md #16's "what's left".
      price: src.price == null ? null : Number(src.price),
      priceUpdated: src.priceUpdated || null,
      // How many of this SKU are actually for sale, and what Grimoire asks
      // for them - same distinct-from-market-price split cards' listedQty/
      // askPrice have, backing the Sealed pricing section on Bulk Price.
      // Manually edited (no separate keep-vs-list rule engine for sealed -
      // overkill for a box that's either for sale or not, see BACKLOG #16).
      listedQty: Math.min(Math.max(0, Number(src.listedQty) || 0), Math.max(0, Number(src.quantity) || 0)),
      askPrice: src.askPrice == null ? null : Number(src.askPrice),
      createdAt: src.createdAt || new Date().toISOString(),
      // The open receipt this came in on (#388), as on a card stack.
      ...(src.held ? { held: String(src.held) } : null)
    };
  }

  function adoptState(doc) {
    const d = doc || {};
    state.locations = Array.isArray(d.locations) ? d.locations.map(newLocation) : [];
    state.cards = (Array.isArray(d.cards) ? d.cards : []).map(normalizeCard);
    state.receipts = Array.isArray(d.receipts) ? d.receipts : [];
    state.returns = Array.isArray(d.returns) ? d.returns : [];
    // pickLists is left undefined when the doc has none yet (pre-migration
    // data) so the lazy accessor in pickLists() below knows to migrate the
    // old flat pickList array the first time anything asks for it.
    state.pickLists = Array.isArray(d.pickLists) ? d.pickLists : undefined;
    state.pickList = Array.isArray(d.pickList) ? d.pickList : [];
    state.deckList = Array.isArray(d.deckList) ? d.deckList : [];
    state.decks = Array.isArray(d.decks) ? d.decks.map(normalizeDeck) : [];
    state.trades = Array.isArray(d.trades) ? d.trades.map(normalizeTrade) : [];
    state.listingRules = Array.isArray(d.listingRules) ? d.listingRules.map(normalizeListingRule) : [];
    state.listingKeepExceptions = Array.isArray(d.listingKeepExceptions)
      ? d.listingKeepExceptions.map(normalizeKeepException) : [];
    state.priceRules = Array.isArray(d.priceRules) ? d.priceRules.map(normalizePriceRule) : [];
    state.watchList = Array.isArray(d.watchList) ? d.watchList.map(normalizeWatchItem) : [];
    state.sealed = Array.isArray(d.sealed) ? d.sealed.map(normalizeSealedItem) : [];
    state.sealedPriceRules = Array.isArray(d.sealedPriceRules) ? d.sealedPriceRules.map(normalizeSealedPriceRule) : [];
    state.customers = Array.isArray(d.customers) ? d.customers.map(normalizeCustomer) : [];
    state.customerWants = Array.isArray(d.customerWants) ? d.customerWants.map(normalizeWant) : [];
    state.restockMatches = Array.isArray(d.restockMatches) ? d.restockMatches.map(normalizeRestockMatch) : [];
    state.customerTombstones = Array.isArray(d.customerTombstones) ? d.customerTombstones.map(normalizeTombstone) : [];
    state.customerAliases = Array.isArray(d.customerAliases) ? d.customerAliases.map(normalizeAlias).filter(a => a.id && a.keepId && a.id !== a.keepId) : [];
    state.receiving = Array.isArray(d.receiving) ? d.receiving.filter(x => x && x.id) : [];
    state.receivingLines = Array.isArray(d.receivingLines) ? d.receivingLines.filter(x => x && x.id) : [];
    state.history = Array.isArray(d.history) ? d.history : [];
    state.settings = Object.assign(freshSettings(), (d.settings && typeof d.settings === "object") ? d.settings : {});
    tidyReceiving();
    normalizeMerge({ silent: true });
    tidyCustomers();
    tidyPickBatches();
    // Whatever was just adopted (a load, a merged save, undo/redo, a
    // replace-import) is the new "before" for restock detection. None of
    // those is this browser receiving stock, so none may create a "came in"
    // match. See checkRestocks().
    resetRestockBaseline();
  }

  function stateObject() {
    pickLists(); // make sure the old-shape migration has run before this document round-trips
    return {
      app: APP_NAME, version: SAVE_VERSION, savedAt: new Date().toISOString(),
      locations: state.locations, cards: state.cards, receipts: state.receipts, returns: state.returns,
      pickLists: state.pickLists, deckList: state.deckList, decks: state.decks, trades: state.trades, listingRules: state.listingRules,
      listingKeepExceptions: state.listingKeepExceptions,
      priceRules: state.priceRules,
      watchList: state.watchList,
      sealed: state.sealed,
      sealedPriceRules: state.sealedPriceRules,
      // Customers carry personal data (a name, an optional email). They
      // live here because they are the seller's own per-account/per-Store
      // data like everything else, but nothing that leaves the account
      // reads these fields: friend shares (/api/share, /api/friends/* in
      // server/index.js) whitelist card fields, and the exports below never
      // touch them.
      customers: state.customers, customerWants: state.customerWants,
      restockMatches: state.restockMatches, customerTombstones: state.customerTombstones,
      customerAliases: state.customerAliases,
      receiving: state.receiving, receivingLines: state.receivingLines,
      history: state.history, settings: state.settings
      // audit deliberately excluded - it lives server-side in its own
      // day-sharded store (see logAudit/queryAudit below), not in this
      // document, so it stops riding along in every save/revision/undo
      // snapshot the way the rest of state does.
    };
  }
  const payload = () => JSON.stringify(stateObject());

  async function load() {
    // Before the document, so a save landing in between costs one extra load, never a missed one.
    const stampBefore = await fetchStamp();
    const [meRes, coll] = await Promise.all([
      api("/api/auth/me"),
      api("/api/collection")
    ]);
    me = meRes.user;
    mpBanner = meRes.mpBanner || null;
    if (!me) { location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash); return; }
    seenStamp = stampBefore;
    rev = coll.rev || 0;
    // Which inventory this page now shows (#145); every save echoes it.
    loadedOwner = coll.owner == null ? null : String(coll.owner);
    unackedSaves = [];
    savedAt = coll.savedAt;
    // #181: the document exactly as the server holds it, before
    // adoptState tidies it (a full save is what writes the tidied rows).
    patchesOk = coll.patch === 1;
    known = patchesOk && coll.state ? { rev, fields: docFields(coll.state) } : null;
    adoptState(coll.state || null);
    personal = null;
    if (me.orgId) {
      personal = Object.assign({}, meRes.personalPrefs || {});
      // The first load after #159: whatever the Store's document says now
      // becomes this person's own value, so nobody's Simple mode or chime
      // flips on the upgrade. onlyIfUnset keeps a value already chosen.
      const seed = {};
      for (const k of PERSONAL_KEYS) {
        if (personal[k] === undefined && state.settings[k] !== undefined) seed[k] = personal[k] = state.settings[k];
      }
      if (Object.keys(seed).length) {
        api("/api/prefs/personal", { method: "POST", body: Object.assign({ onlyIfUnset: true }, seed) }).catch(() => {});
      }
    }
    // One-time migration: a pre-existing account may still have its audit
    // history embedded in the document from before it moved server-side.
    // Ship it to the new store once; the field simply stops being written
    // (stateObject() above no longer includes it) from the next save on.
    if (coll.state && Array.isArray(coll.state.audit) && coll.state.audit.length) {
      importAuditBulk(coll.state.audit);
    }
    loaded = true;
    lastSnap = undoSnap();
    lastAuditId = recentAudit[0] ? recentAudit[0].id : null;
    dirty = false;
    emit("loaded", { me, rev });
    emit("change", { reason: "loaded" });
    emit("savestate", saveState());
    return me;
  }

  /* ============================== Catching up with the server ==============================
     A page only hears of another device's saves when it loads or saves. Right
     before anything that depends on what's on the floor (a count, a chase, a
     Complete), and on the RF's lists: save what's unsaved, ask whether anything
     changed (cheap, no document read), and load only if it did. { ok, loaded }:
     ok false means the page may be out of date (no answer, or a save that didn't
     go), so the caller says so instead of acting. The load fires "change", and
     it replaces the state's objects: re-read anything held from before. */
  let seenStamp = null, catchingUp = null;
  async function fetchStamp() {
    try { return (await api("/api/collection/stamp")).stamp || null; } catch (e) { return null; }
  }
  async function catchUpNow() {
    try {
      if (!loaded) return { ok: true, loaded: false };   // nothing here to be out of date
      if (hasUnsaved() && !await saveAll(8000)) return { ok: false, loaded: false };
      const s = await fetchStamp();
      if (!s) return { ok: false, loaded: false };
      if (s === seenStamp) return { ok: true, loaded: false };
      return await load() ? { ok: true, loaded: true } : { ok: false, loaded: false };
    } catch (e) {
      return { ok: false, loaded: false };
    }
  }
  /* Two buttons asking at once share one answer. `btn` (optional) says "Checking…"
     until it comes: nothing else on screen moves during a load. A press while it
     already says so leaves the first one's words to put back. */
  function catchUp(btn) {
    if (btn && btn.dataset.checking == null) {
      btn.dataset.checking = btn.innerHTML;
      btn.innerHTML = "Checking…";
    }
    if (!catchingUp) {
      catchingUp = catchUpNow().then(r => { catchingUp = null; return r; });
    }
    if (!btn) return catchingUp;
    return catchingUp.then(r => {
      if (btn.dataset.checking != null) {
        btn.innerHTML = btn.dataset.checking;
        delete btn.dataset.checking;
      }
      return r;
    });
  }
  /* A page that stays open all shift (the RF): this page's own save moved the
     stamp, and that isn't news. The desk doesn't use it: right before acting it
     would rather load once too often than miss a save that landed just after. */
  async function stampOwnSave() {
    const s = await fetchStamp();
    if (s) seenStamp = s;
  }

  /* ============================== Autosave ============================== */
  /* One debounce, one in-flight PUT, and a re-run if anything changed while that
     PUT was in the air. Leaving the page (#174, docs/flows/save-before-leave.dot):
     in-app links and page switches wait for saveAll() first (ui.js); hiding
     or leaving the page saves at once instead of waiting out the debounce
     (saveOnLeave, under "Boot"); closing, reloading or Back with anything
     unsaved still gets the browser's own "Leave site?" prompt. A tab closed
     within the debounce can still lose that last edit, but never silently. */
  const SAVE_DEBOUNCE = 1500;
  let savePending = false;
  let saveTimer = null;
  // The HTTP status of the save that failed (409 is a conflict; 0 when the
  // network failed), so a page can tell a conflict from a dropped connection.
  let saveErrorStatus = 0;
  // The last conflict the page was told about, so a held explicit save can
  // show its toast again (#190).
  let lastConflict = null;
  // True only while saveOnLeave() starts its requests: they ask for keepalive.
  let leaveFlush = false;

  /* A save (or audit flush) that failed for a reason that may pass (no
     answer, a 5xx) is tried again after SAVE_RETRY_MS. There is at most one
     such timer for each (#183): every save actually sent cancels the one
     waiting, and every failure replaces it rather than adding another. Each
     failed link click, Ctrl+S or Save button used to start a loop of its
     own, so four clicks meant four full documents every 8 s. */
  const SAVE_RETRY_MS = 8000;
  let saveRetryTimer = null, auditRetryTimer = null;
  function cancelSaveRetry() { clearTimeout(saveRetryTimer); saveRetryTimer = null; }
  function cancelAuditRetry() { clearTimeout(auditRetryTimer); auditRetryTimer = null; }
  function retrySaveLater() {
    cancelSaveRetry();
    saveRetryTimer = setTimeout(() => { saveRetryTimer = null; if (savePending) flushSave(); }, SAVE_RETRY_MS);
  }
  function retryAuditLater() {
    cancelAuditRetry();
    auditRetryTimer = setTimeout(() => { auditRetryTimer = null; flushAudit(); }, SAVE_RETRY_MS);
  }
  /* The last save was refused in a way sending it again can't change: a
     conflict (409, waiting for "Keep mine" or a reload) or a refusal (403,
     #159). saveAll() doesn't resend it (#183). A failure that may pass (no
     answer, a 5xx) is resent: someone leaving the page wants it saved now. */
  function saveRefused() {
    return !!saveError && (saveErrorStatus === 409 || saveErrorStatus === 403);
  }

  /* A save that may have landed although this page never heard back (#175,
     docs/flows/collection-save.dot): the reply was lost, a server error
     came after the write, or the page was hidden mid-save and the browser
     reported a failure for a request that still went through. Its retry is
     a new PUT carrying the same document plus anything changed since; with
     the old rev, the server would merge it against itself and count every
     quantity change twice. So every PUT gets a fresh saveId, and the next
     PUT lists the ones whose fate is unknown as afterSaveIds: the server
     answers a copy of a save it already has with that save's result, and
     diffs a later save against its own earlier one. A refusal (a 4xx) never
     wrote anything, so it isn't listed. Cleared once a save is answered. */
  let unackedSaves = [];
  const UNACKED_MAX = 20;
  function saveBody(base) {
    const body = Object.assign(base, { saveId: uid() });
    if (unackedSaves.length) body.afterSaveIds = unackedSaves.slice();
    if (loadedOwner != null) body.owner = loadedOwner;
    return body;
  }
  /* Patch saves (#181, server/lib/patch.js, docs/flows/collection-save.dot).
     Rather than the whole document (megabytes) on every autosave, a save
     sends only what changed since `rev`: rows added, edited or deleted in
     the id-keyed lists, by key, and any other field that changed, whole.
     The server rebuilds the full document from the one it holds at that
     rev, then saves it exactly as before (merge, saveIds, locks and all).
     `known` is that document as this page last sent or received it: each
     field's JSON, row by row for the keyed lists. A full save is sent
     instead when `known` isn't for the current rev, the server didn't say
     it takes patches, the patch would be most of the document anyway, or
     the server refuses it (422 patchRefused, or 400 from a server before
     this), and that full save is what `known` is rebuilt from. Keys must
     match merge.js MERGE_ARRAYS; a list keyed differently there is refused
     and so sent whole. */
  const PATCH_KEYS = {
    cards: "id", locations: "id", receipts: "id", returns: "id", pickLists: "id", listingRules: "id",
    listingKeepExceptions: "id", priceRules: "id", watchList: "id", sealed: "id", sealedPriceRules: "id",
    customers: "id", customerWants: "id", restockMatches: "id", customerTombstones: "id",
    customerAliases: "id", deckList: "name", decks: "id", trades: "id", receiving: "id", receivingLines: "id"
  };
  let patchesOk = false; // GET /api/collection said `patch: 1`
  let known = null;      // { rev, fields: Map(field -> { json } | { order: [key], rows: Map(key -> json), bytes }) }
  // A keyed list row by row, or null when a row has no string key or
  // shares one (such a list is sent whole).
  function rowsOf(arr, key) {
    const rows = new Map(), order = [];
    let bytes = 2;
    for (const r of arr) {
      const k = r && typeof r === "object" ? r[key] : undefined;
      if (typeof k !== "string" || rows.has(k)) return null;
      const j = JSON.stringify(r);
      rows.set(k, j); order.push(k);
      bytes += j.length + 1;
    }
    return { order, rows, bytes };
  }
  function docFields(st) {
    const fields = new Map();
    for (const k of Object.keys(st || {})) {
      const v = st[k];
      if (v === undefined || typeof v === "function") continue;
      const rows = PATCH_KEYS[k] && Array.isArray(v) ? rowsOf(v, PATCH_KEYS[k]) : null;
      fields.set(k, rows || { json: JSON.stringify(v) });
    }
    return fields;
  }
  function rowChanges(was, now, arr, key) {
    const edit = [], add = [];
    for (const r of arr) {
      const old = was.rows.get(r[key]);
      if (old === undefined) add.push(r);
      else if (old !== now.rows.get(r[key])) edit.push(r);
    }
    const del = [], kept = [];
    for (const k of was.order) (now.rows.has(k) ? kept : del).push(k);
    // The server's order without `order`: kept rows, then the added ones.
    let same = now.order.length === kept.length + add.length;
    for (let i = 0; same && i < kept.length; i++) same = now.order[i] === kept[i];
    for (let i = 0; same && i < add.length; i++) same = now.order[kept.length + i] === add[i][key];
    if (same && !edit.length && !add.length && !del.length) return null;
    const op = { n: arr.length };
    if (edit.length) op.edit = edit;
    if (add.length) op.add = add;
    if (del.length) op.del = del;
    if (!same) {
      const at = new Map(kept.map((k, i) => [k, i]));
      const order = [];
      for (const k of now.order) {
        const i = at.get(k), last = order[order.length - 1];
        if (i === undefined) order.push(k);
        else if (Array.isArray(last) && last[0] + last[1] === i) last[1]++;
        else order.push([i, 1]);
      }
      op.order = order;
    }
    return op;
  }
  // -> { patch (or null: send the whole document), fields: what `known` becomes once it lands }
  // fields is null when the server takes no patches (nothing to remember).
  function savePlan(st, whole) {
    if (!patchesOk) return { patch: null, fields: null };
    const fields = docFields(st);
    if (whole || !known || known.rev !== rev) return { patch: null, fields };
    const keys = Array.from(fields.keys()), set = {}, rows = {};
    let full = 0, size = 0;
    for (const k of keys) {
      const now = fields.get(k), was = known.fields.get(k);
      const n = now.rows ? now.bytes : now.json.length;
      full += n;
      if (now.rows && was && was.rows) {
        const op = rowChanges(was, now, st[k], PATCH_KEYS[k]);
        if (!op) continue;
        rows[k] = op;
        for (const r of (op.edit || []).concat(op.add || [])) size += now.rows.get(r[PATCH_KEYS[k]]).length + 1;
        size += (op.del ? op.del.length * 16 : 0) + (op.order ? op.order.length * 12 : 0);
      } else if (!was || was.json === undefined || was.json !== now.json) {
        set[k] = st[k];
        size += n;
      }
    }
    if (size > full / 2) return { patch: null, fields };
    return { patch: { v: 1, keys, set, rows }, fields };
  }
  const patchRefused = e => !!e && (e.status === 400 || (e.status === 422 && !!(e.data && e.data.patchRefused)));

  /* #214: the completion marks (completePickList) a save carries. Once
     that save is answered the server has used them, and they stop riding
     along. Kept while its fate is unknown, so the retry carries them too.
     Only the mark that went out is cleared, by identity. */
  function completionMarks(st) {
    const out = [];
    for (const p of (st && Array.isArray(st.pickLists)) ? st.pickLists : []) {
      if (p && p.completion) out.push([p, p.completion]);
    }
    return out;
  }
  function clearCompletionMarks(marks) {
    for (const [p, c] of marks) if (p.completion === c) delete p.completion;
  }
  function saveUnanswered(body, e) {
    const s = (e && e.status) || 0;
    if (s >= 400 && s < 500) return;
    unackedSaves.push(body.saveId);
    if (unackedSaves.length > UNACKED_MAX) unackedSaves.shift();
  }

  /* #145: the inventory GET /api/collection said this page shows. The
     server refuses a save or audit flush naming another one (the session
     switched stores in another tab): nothing more is sent from this page,
     and it says to reload, instead of the conflict prompt's overwrite.
     Settings' Restore and revision list send it too (#185) and hand their
     refusal to refusedForOwner(), so the page says the same thing; a
     button press passes { again: true } to say it again if it already
     did. */
  let loadedOwner = null;
  let wrongOwner = null;
  function refusedForOwner(e, opts) {
    if (!(e && e.status === 409 && e.data && e.data.wrongOwner)) return false;
    held = true;
    if (!wrongOwner || (opts && opts.again)) {
      wrongOwner = e.message || "This tab was showing a different store. Reload to continue.";
      emit("wrongowner", { message: wrongOwner });
    }
    return true;
  }

  /* saveNow({ archive: true }) marks the next save as an Erase or Replace
     import (#157): the server then always keeps the version it replaces as
     a revision. A sequence, not a boolean, so a flag set while another save
     is in the air rides on the next PUT rather than being lost, and is only
     cleared once a PUT carrying it has succeeded. */
  let archiveWanted = 0, archiveSent = 0;

  function saveState() {
    return {
      dirty, saving, rev, savedAt, error: saveError,
      conflict: !!saveError && saveErrorStatus === 409 && !wrongOwner,
      wrongOwner: !!wrongOwner,
      label: saveError ? "save failed" : saving ? "saving…" : dirty ? "unsaved" : "saved"
    };
  }

  function scheduleSave() {
    savePending = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flushSave(); }, SAVE_DEBOUNCE);
  }

  /* Audit entries are flushed on the same debounce as the collection save
     (piggybacking flushSave's timer rather than running a second one), but
     are otherwise independent: a collection-save conflict/retry has nothing
     to do with whether pending audit entries made it to the server. */
  let auditFlushInFlight = false;
  let auditFlushRun = null;
  function flushAudit() {
    if (auditFlushInFlight) return auditFlushRun;
    if (held || !pendingAudit.length) return Promise.resolve();
    auditFlushInFlight = true;
    cancelAuditRetry();
    const batch = pendingAudit.slice();
    const ids = new Set(batch.map(e => e.id));
    const body = { entries: batch };
    if (loadedOwner != null) body.owner = loadedOwner;
    return auditFlushRun = api("/api/audit", { method: "POST", body, keepalive: leaveFlush })
      .then(() => { pendingAudit = pendingAudit.filter(e => !ids.has(e.id)); })
      .catch(e => { if (!refusedForOwner(e)) retryAuditLater(); })
      .then(() => {
        auditFlushInFlight = false;
        // Lets a page waiting on this flush (the restart banner, #190) see
        // that nothing is left unsaved.
        if (!pendingAudit.length) emit("savestate", saveState());
      }, () => { auditFlushInFlight = false; });
  }

  async function flushSave() {
    clearTimeout(saveTimer);
    if (held) return;
    if (pendingAudit.length) flushAudit();
    // A conflict (or refusal) is waiting for the person (#190): a new edit
    // after the debounce, Ctrl+S and the Save buttons would only get the
    // same answer and raise a second conflict toast. The edit stays pending;
    // Keep mine (overwriteServer) sends the latest state.
    if (saveRefused()) return;
    if (!loaded || saving || !savePending) return;
    savePending = false;
    // This save is the retry: one waiting from an earlier failure would
    // only send the same thing again.
    cancelSaveRetry();
    saving = true; saveError = null; saveErrorStatus = 0;
    emit("savestate", saveState());
    const archiveSeq = archiveWanted;
    const st = stateObject();
    // An Erase or Replace (archive) always goes whole (#181).
    const plan = savePlan(st, archiveSeq > archiveSent);
    const body = saveBody(plan.patch ? { rev, patch: plan.patch } : { rev, state: st });
    const marks = completionMarks(st);
    try {
      if (archiveSeq > archiveSent) body.archive = true;
      const out = await api("/api/collection", { method: "PUT", body, gzip: true, keepalive: leaveFlush });
      if (body.archive) archiveSent = Math.max(archiveSent, archiveSeq);
      unackedSaves = [];
      clearCompletionMarks(marks);
      rev = out.rev; savedAt = out.savedAt;
      // What the server now holds at this rev: what this save sent, or
      // the merged document it answered with (read before adoptState,
      // which keeps some of its lists and goes on to change them).
      known = !patchesOk ? null : { rev, fields: out.merged ? docFields(out.state) : plan.fields };
      // The server resolved a concurrent write via a three-way merge
      // (server/lib/merge.js) instead of rejecting - out.state is the
      // authoritative merged document, which may include a coworker's
      // concurrent edits this browser never saw. Adopt it the same way
      // undo/redo already replace `state` wholesale (adoptState is a
      // proven, already-relied-on operation, not new machinery), then
      // reset the undo baseline to this merged result - it isn't this
      // browser's own edit, so it doesn't get an undo-stack entry of its
      // own, but the NEXT local edit needs to diff against the merged
      // state, not the stale pre-merge one. The existing undo stack is
      // left alone: undoing far enough back can still discard a
      // meanwhile-merged coworker edit, but that's the same
      // whole-snapshot-replace characteristic undo has always had
      // (undoing 3 steps already discards your own steps 1-2), not a new
      // failure mode this introduces.
      if (out.merged) {
        adoptState(out.state);
        lastSnap = undoSnap();
        lastAuditId = recentAudit[0] ? recentAudit[0].id : null;
        emit("change", { reason: "merged" });
        emit("merged", { conflicts: out.conflicts || [] });
      }
      dirty = savePending;
      saving = false;
      emit("savestate", saveState());
      if (savePending) scheduleSave();
    } catch (e) {
      saving = false;
      savePending = true;
      if (body.patch && patchRefused(e)) {
        // Nothing was written (#181): send the whole document now. A 400
        // is a server from before patches: stop trying them on this page.
        known = null;
        if (e.status === 400) patchesOk = false;
        return flushSave();
      }
      saveError = e.message || "save failed";
      saveErrorStatus = e.status || 0;
      saveUnanswered(body, e);
      const refused = refusedForOwner(e);
      emit("savestate", saveState());
      if (refused) {
        // Another inventory now (#145): not a conflict to overwrite, and
        // retrying can't help. refusedForOwner() told the page.
      } else if (e.status === 409) {
        // alreadyCompleted (#214): pick lists another device completed
        // first, refused rather than taking their cards off twice.
        lastConflict = { message: e.message, serverRev: e.data && e.data.serverRev,
          alreadyCompleted: e.data && Array.isArray(e.data.alreadyCompleted) ? e.data.alreadyCompleted : null };
        emit("conflict", lastConflict);
      } else if (e.status === 403) {
        // Refused, not failed (#159: Staff sending a store Erase/Replace).
        // Retrying can't change the answer; the error stays on the save
        // indicator until the page is reloaded.
      } else {
        // Transient failures retry on a back-off rather than silently
        // dropping work: one timer, however many saves failed (#183).
        retrySaveLater();
      }
    }
  }

  /* Saves now, skipping the debounce. It never rejects and doesn't say
     whether the save landed: a failure is caught in flushSave (shown on the
     save indicator, retried), and it returns at once if a save is already
     in the air. A caller that needs to know, because it is about to leave
     the page or switch stores, uses saveAll() instead (#176). */
  function saveNow(opts) {
    if (opts && opts.archive) archiveWanted++;
    savePending = true;
    // Held by a waiting conflict (#190): send nothing, but show its toast
    // (with Keep mine) again in case it was replaced or dismissed. The
    // debounced autosave stays quiet; it doesn't come through here.
    if (saveRefused() && saveErrorStatus === 409 && !wrongOwner && lastConflict) emit("conflict", lastConflict);
    return flushSave();
  }

  /* Before something moves this session to ANOTHER inventory (opening a
     notification about a different store, #139). A PUT names no owner: the
     server saves it into the session's active store, so any later save
     from this page would land in the new one. saveAll() waits out a save
     in flight, saves what's left (the document and audit entries) and
     resolves true only once nothing is unsaved; a conflict or a refusal
     isn't sent again (#183), it resolves false. A save that failed for a
     reason that may pass is sent again now, in place of its waiting retry.
     holdSaves(true) then stops
     this page saving at all, the save on hiding or leaving the page
     included, until holdSaves(false). hasUnsaved() says whether anything changed
     while held. */
  let held = false;
  function hasUnsaved() {
    return !!(savePending || dirty || saving || saveError || pendingAudit.length || auditFlushInFlight);
  }
  async function saveAll(timeoutMs) {
    const until = Date.now() + (timeoutMs || 15000);
    while (Date.now() < until) {
      if (held) return !hasUnsaved();
      if (saving || auditFlushInFlight) { await sleep(100); continue; }
      // A conflict waits for its "Keep mine" prompt; a refusal stands.
      // Sending the same save again only gets the same answer (#183).
      if (saveRefused()) return false;
      if (savePending || dirty) {
        if (!loaded) return false;
        await saveNow();
        if (saveError) return false;
        continue;
      }
      if (pendingAudit.length) {
        await flushAudit();
        if (pendingAudit.length) return false;
        continue;
      }
      return !saveError;
    }
    return false;
  }
  function holdSaves(on) {
    held = !!on;
    if (!held && savePending) scheduleSave();
  }
  /* The person chose to leave with work unsaved ("Sign out anyway"): stop
     saving (the session is going away) and don't ask again with the
     browser's "Leave site?" prompt. */
  let leaveConfirmed = false;
  function leaveWithoutSaving() {
    leaveConfirmed = true;
    holdSaves(true);
  }

  /* Force this browser's version onto the server, discarding whatever the other
     tab or device wrote. Only reachable from the conflict prompt. */
  async function overwriteServer() {
    const archiveSeq = archiveWanted;
    const body = saveBody({ rev: -1, state: stateObject() });
    const marks = completionMarks(body.state);
    if (archiveSeq > archiveSent) body.archive = true;
    let out;
    try { out = await api("/api/collection", { method: "PUT", body, gzip: true }); }
    catch (e) {
      saveUnanswered(body, e);
      if (refusedForOwner(e)) emit("savestate", saveState());
      throw e;
    }
    if (body.archive) archiveSent = Math.max(archiveSent, archiveSeq);
    unackedSaves = [];
    clearCompletionMarks(marks);
    rev = out.rev; savedAt = out.savedAt; dirty = false; savePending = false; saveError = null; saveErrorStatus = 0;
    emit("savestate", saveState());
    return out;
  }

  /* ============================== Undo / redo ============================== */
  const UNDO_MAX = 25;
  let undoStack = [];
  let redoStack = [];
  let lastSnap = null;
  let lastAuditId = null;
  /* A page with no Undo button can turn the snapshots off before load() (#386,
     Warehouse Mode). Each one is a copy of the whole document, 25 are kept, and
     one is built per edit: fine on a desk, a crash waiting to happen on a phone
     tapping through a pick at 70k stacks. */
  let undoOff = false;
  function setUndoOff(on) { undoOff = !!on; if (undoOff) { lastSnap = null; undoStack = []; redoStack = []; } }
  const undoSnap = () => (undoOff ? null : payload());

  const UNDO_VERBS = {
    add: "Add", remove: "Remove", edit: "Edit", move: "Move", delete: "Delete", list: "Listing",
    import: "Import", ship: "Ship", build: "Build deck", location: "Location", price: "Price refresh",
    receipt: "Receipt", cost: "Cost basis", putaway: "Putaway", transfer: "Transfer", lend: "Lend"
  };
  function auditLabel(e) {
    const verb = UNDO_VERBS[e.action] || String(e.action || "change");
    const who = e.name || (e.set ? String(e.set).toUpperCase() + " #" + e.collector : "");
    const n = e.qty ? Math.abs(e.qty) + "× " : "";
    return who ? verb + " " + n + who : verb;
  }
  function undoLabel(explicit) {
    if (explicit) return explicit;
    const e = recentAudit[0];
    return (e && e.id !== lastAuditId) ? auditLabel(e) : "last change";
  }
  function pushUndo(text, label) {
    undoStack.push({ text, label });
    while (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  function undoInfo() {
    return {
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : "",
      redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : ""
    };
  }
  function applySnapshot(text) {
    adoptState(JSON.parse(text));
    lastSnap = payload();
    lastAuditId = recentAudit[0] ? recentAudit[0].id : null;
    dirty = true;
    scheduleSave();
    emit("change", { reason: "snapshot" });
    emit("savestate", saveState());
    emit("undo", undoInfo());
  }
  function undo() {
    const step = undoStack.pop();
    if (!step) return null;
    redoStack.push({ text: lastSnap == null ? payload() : lastSnap, label: step.label });
    applySnapshot(step.text);
    return step.label;
  }
  function redo() {
    const step = redoStack.pop();
    if (!step) return null;
    pushUndo(lastSnap == null ? payload() : lastSnap, step.label);
    applySnapshot(step.text);
    return step.label;
  }

  /* Every mutation ends here: snapshot for undo, mark dirty, schedule the save,
     tell the page to re-render. */
  // opts.restock === false: this edit adds copies that are not stock for
  // sale (a return written off as damaged), so it must not count as a
  // wanted card coming in. The baseline still moves on.
  // opts.undo === false: this edit joins the step before it (#432: Manapool's
  // answer for an order just entered), so Undo still reverses that whole step.
  function persist(label, opts) {
    // Every stock-changing path (Receive, lot receive, a return put back,
    // CSV/transfer imports, quantity edits, cycle counts, freeing a pick
    // reservation...) ends in persist(), so this one call is where "a
    // wanted card just came in" is detected. See checkRestocks().
    checkRestocks({ match: !(opts && opts.restock === false) });
    const text = undoSnap();
    if (lastSnap !== null && lastSnap !== text && !(opts && opts.undo === false)) {
      pushUndo(lastSnap, undoLabel(label));
      redoStack = [];
    }
    lastSnap = text;
    lastAuditId = recentAudit[0] ? recentAudit[0].id : null;
    dirty = true;
    scheduleSave();
    emit("change", { reason: label || "change" });
    emit("savestate", saveState());
    emit("undo", undoInfo());
  }
  /* Simple mode / chime / chime threshold (#159): read through pref(), set
     through setPersonalPrefs(). A personal account: its own document, as
     always. An org member: their own account on the server, never the
     Store's document. Resolves once saved. */
  function pref(key) {
    if (personal && PERSONAL_KEYS.includes(key) && personal[key] !== undefined) return personal[key];
    return state.settings[key];
  }
  function setPersonalPrefs(values) {
    const v = {};
    for (const k of PERSONAL_KEYS) if (values && values[k] !== undefined) v[k] = values[k];
    if (!personal) {
      Object.assign(state.settings, v);
      persistSettings();
      return Promise.resolve();
    }
    Object.assign(personal, v);
    return api("/api/prefs/personal", { method: "POST", body: v }).then(() => {});
  }

  // Preference-only changes do not deserve an undo slot.
  function persistSettings() {
    lastSnap = undoSnap();
    dirty = true;
    scheduleSave();
    emit("savestate", saveState());
  }

  /* ============================== Audit ==============================
     Entries live server-side in their own day-sharded store (server/lib/
     audit.js), not in this document - see stateObject()'s comment. Two
     small local arrays stand in for the old state.audit:
       pendingAudit - logged but not yet flushed to the server (flushAudit,
                      piggybacked on the normal save debounce)
       recentAudit  - a ring buffer of the last RECENT_AUDIT_MAX entries
                      logged this session, kept even after a flush, purely
                      for instant local reads (undo-button labels) that
                      can't wait on a network round trip.
     Anything that needs the full history (the Activity Log tab, the
     Receive ledger, the Dashboard tile) goes through queryAudit(), which
     also merges in whatever's still sitting in pendingAudit so a just-
     logged entry shows up immediately even before its flush lands. */
  const RECENT_AUDIT_MAX = 50;
  let pendingAudit = [];
  let recentAudit = [];
  function logAudit(e) {
    const entry = {
      id: uid(), ts: new Date().toISOString(),
      action: e.action || "edit", name: e.name || "", set: e.set || "", collector: e.collector || "",
      // A pre-finish entry (server-side history predating this) only has
      // `foil`; readers should use finishOf(entry) below rather than this
      // field directly, so old and new rows display the same way.
      lang: e.lang || "", finish: normalizeFinish(e.finish) || (e.foil ? "foil" : "nonfoil"), condition: e.condition || "",
      qty: e.qty == null ? 0 : e.qty,
      oldQty: e.oldQty == null ? null : e.oldQty,
      newQty: e.newQty == null ? null : e.newQty,
      from: e.from || "", to: e.to || "", note: e.note || "",
      cost: e.cost == null ? null : round2(e.cost),
      receiptId: e.receiptId || "",
      // Best-effort, for immediate display before this entry is flushed -
      // the server stamps (and trusts only) its own value from the
      // authenticated session at flush time (POST /api/audit), since a
      // client-supplied name can't be trusted for an accountability record.
      // Matters once an Organization/Store has more than one person editing
      // the same collection (BACKLOG.md #9).
      by: me ? (me.displayName || me.username || "") : ""
    };
    pendingAudit.push(entry);
    recentAudit.unshift(entry);
    if (recentAudit.length > RECENT_AUDIT_MAX) recentAudit.length = RECENT_AUDIT_MAX;
  }
  const auditCard = r => ({ name: r.name, set: r.set, collector: r.collector, lang: r.lang, finish: r.finish, condition: r.condition || "NM" });
  // Reads either shape - a pre-finish audit entry from server-side history
  // only ever had `foil`.
  const finishOf = e => normalizeFinish(e.finish) || (e.foil ? "foil" : "nonfoil");

  // Fire-and-forget bulk import, used for the one-time legacy migration
  // (load()) and for a v0.07 "replace" import that carries its own audit
  // history (importLegacy()).
  function importAuditBulk(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const body = { entries };
    if (loadedOwner != null) body.owner = loadedOwner;
    return api("/api/audit", { method: "POST", body }).catch(e => { refusedForOwner(e); });
  }

  // The one shared read path every consumer (Dashboard tile, Activity Log
  // tab, Receive ledger, CSV export) uses instead of filtering state.audit
  // in memory. Merges in not-yet-flushed pendingAudit entries so a change
  // made moments ago (within the save debounce) is never briefly invisible.
  async function queryAudit(params) {
    const p = params || {};
    const qs = new URLSearchParams();
    if (p.action) qs.set("action", p.action);
    if (p.q) qs.set("q", p.q);
    if (p.set && p.collector) { qs.set("set", p.set); qs.set("collector", p.collector); }
    if (p.from) qs.set("from", p.from);
    if (p.to) qs.set("to", p.to);
    const limit = p.limit == null ? 400 : Number(p.limit);
    const offset = Number(p.offset || 0);
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));
    // total: false (#178): the caller doesn't show a count, so the server
    // stops reading once the page is full, and total comes back null.
    if (p.total === false) qs.set("total", "0");
    const res = await api("/api/audit?" + qs.toString());
    const action = p.action || "";
    const q = String(p.q || "").trim().toLowerCase();
    // A completion's lines wait on its pick list until the save (#216).
    const marked = (Array.isArray(state.pickLists) ? state.pickLists : []).flatMap(l => (l && l.completion && l.completion.audit) || []);
    const pending = pendingAudit.concat(marked).filter(e => {
      if (action && e.action !== action) return false;
      if (p.set && p.collector && (String(e.set || "").toLowerCase() !== String(p.set).toLowerCase() ||
        String(e.collector == null ? "" : e.collector).toLowerCase() !== String(p.collector).toLowerCase())) return false;
      if (q) {
        const hay = [e.name, e.set, e.collector, e.from, e.to, e.note, e.action, e.receiptId]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const known = new Set(res.entries.map(e => e.id));
    const newPending = pending.filter(e => !known.has(e.id));
    // Unflushed session-local entries are always the newest, so once sorted
    // they only ever belong on the first page - splicing them into a later
    // offset page would both duplicate rows across pages and break the
    // server's own offset math. They still count toward `total` on every
    // page (below) so the page count stays stable as you page through, just
    // not injected into the row list itself past page one.
    const entries = offset === 0
      ? newPending.concat(res.entries).sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, limit)
      : res.entries;
    return { entries, total: res.total == null ? null : res.total + newPending.length };
  }

  // Unsent entries are dropped only once the server clear succeeds: on a
  // failure or a 403 they stay queued and flush as usual (#76).
  function clearAuditLog() {
    const ids = new Set(pendingAudit.map(e => e.id));
    return api("/api/audit", { method: "DELETE" }).then(r => {
      pendingAudit = pendingAudit.filter(e => !ids.has(e.id));
      return r;
    });
  }

  // A Store's activity log is shared, so only its managers and owners may
  // clear it (the server refuses anyone else, #76). Personal accounts have
  // no orgId and always clear their own.
  function canClearAuditLog() {
    return !(me && me.orgId && me.orgRole !== "owner" && me.orgRole !== "manager");
  }
  // The same rank for the rest of what acts on a whole Store (#159): Erase,
  // Replace import, Restore, and changing the Store defaults in Settings.
  const canManageStore = canClearAuditLog;

  /* ---------- Undoing a specific historical audit row ----------
     Deliberately narrow: an audit entry only records display names (not a
     stable card/location id) and a qty delta, so "undo this row" means
     re-finding a live stack by (set, collector, lang, foil, condition) at a
     named location and replaying the delta backwards - there is nothing
     here to reuse from the whole-document undo() stack above, which only
     ever rewinds the single most recent change.

     Scoped to the four action types where that replay is unambiguous and
     safe: add/remove (one stack, one location, a qty delta) and
     move/putaway (a qty moved between two named locations). Left out on
     purpose: "edit" logs several unrelated kinds of change under one label
     (quantity, location, and condition edits can all land in the same
     entry - too polymorphic to reverse generically); "list"/"cost" don't
     actually track `quantity` in their qty/oldQty/newQty fields despite the
     shared schema; "delete" would need to fabricate a card's full metadata
     (price, rarity, image...) from just its name; "transfer" crosses
     accounts via an exported file, which this app has no way to unwind on
     the other end; "receipt"/"import"/"ship"/"build"/"location"/"price" are
     either multi-row or don't describe a single stack's state at all.

     Every branch refuses (rather than guesses) when the exact stack a row
     described no longer exists in the shape needed to reverse it - a
     partial sale, a since-deleted location, or someone having moved it
     again in the meantime all fall out here as a clear "can't undo" message
     instead of a wrong or fabricated result. */
  const UNDOABLE_AUDIT_ACTIONS = ["add", "remove", "move", "putaway"];
  const canUndoAudit = entry => UNDOABLE_AUDIT_ACTIONS.includes(entry && entry.action);

  function findStackAt(entry, locationId) {
    return state.cards.find(r => r.locationId === locationId && r.set === entry.set &&
      normNum(r.collector) === normNum(entry.collector) && r.lang === entry.lang &&
      r.finish === finishOf(entry) && (r.condition || "NM") === (entry.condition || "NM"));
  }
  const locByName = name => state.locations.find(l => l.name === name);
  const copyWord = n => n === 1 ? "copy" : "copies";

  function undoAuditEntry(entry) {
    if (!canUndoAudit(entry)) return { ok: false, message: "This kind of entry can't be undone automatically." };
    const n = Math.abs(Number(entry.qty) || 0);
    if (!n) return { ok: false, message: "Nothing to undo - this entry has no quantity attached." };

    if (entry.action === "add") {
      const loc = locByName(entry.to);
      if (!loc) return { ok: false, message: '"' + entry.to + '" no longer exists.' };
      const rec = findStackAt(entry, loc.id);
      if (!rec || availableQty(rec) < n) {
        return { ok: false, message: "Can't undo - " + loc.name + " no longer has " + n + " " + copyWord(n) +
          " of " + entry.name + " (some may have since moved, been listed, or sold)." };
      }
      rec.quantity -= n;
      if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
      normalizeMerge({ silent: true });
      return { ok: true, qty: n, from: loc.name,
        summary: "Removed " + n + " × " + entry.name + " from " + loc.name + " (undoing an add)" };
    }

    if (entry.action === "remove") {
      const loc = locByName(entry.from);
      if (!loc) return { ok: false, message: '"' + entry.from + '" no longer exists.' };
      const rec = findStackAt(entry, loc.id);
      if (!rec) {
        return { ok: false, message: "That stack was fully removed and no longer exists in " + loc.name +
          " - receive it again instead of undoing." };
      }
      rec.quantity += n;
      normalizeMerge({ silent: true });
      return { ok: true, qty: n, to: loc.name,
        summary: "Added " + n + " × " + entry.name + " back to " + loc.name + " (undoing a remove)" };
    }

    // move / putaway: both log "n copies moved from A to B" the same way.
    const fromLoc = locByName(entry.from), toLoc = locByName(entry.to);
    if (!fromLoc || !toLoc) return { ok: false, message: "One of the locations involved no longer exists." };
    const destRec = findStackAt(entry, toLoc.id);
    if (!destRec || availableQty(destRec) < n) {
      return { ok: false, message: "Can't undo - " + toLoc.name + " no longer has " + n + " " + copyWord(n) +
        " of " + entry.name + "." };
    }
    const srcRec = findStackAt(entry, fromLoc.id);
    if (!srcRec) {
      return { ok: false, message: "The original stack in " + fromLoc.name + " no longer exists, so this can't " +
        "be safely recreated - move it back manually instead." };
    }
    destRec.quantity -= n;
    srcRec.quantity += n;
    normalizeMerge({ silent: true });
    return { ok: true, qty: n, from: toLoc.name, to: fromLoc.name,
      summary: "Moved " + n + " × " + entry.name + " from " + toLoc.name + " back to " + fromLoc.name };
  }

  function addHistory(entry) {
    state.history.unshift(entry);
    if (state.history.length > 2000) state.history.length = 2000;
  }

  /* ============================== Cost basis ============================== */
  /* Moving average, kept honest about coverage.

     A stack carries costQty (copies with a known cost) and costTotal (what those
     copies cost). avgCost is costTotal / costQty. When you already owned ten
     copies and then buy four in a lot, costQty is 4 and avgCost describes those
     four - the app says "avg $2.10 across 4 of 14 copies" rather than inventing
     a basis for the ten it knows nothing about. Backfill the older copies from
     Manage -> Set cost basis when you do know what they cost. */
  function applyCost(rec, qty, unitCost) {
    if (unitCost == null || !(qty > 0)) return;
    rec.costQty = (Number(rec.costQty) || 0) + qty;
    rec.costTotal = round2((Number(rec.costTotal) || 0) + qty * unitCost);
    rec.avgCost = rec.costQty > 0 ? round2(rec.costTotal / rec.costQty) : null;
  }
  function removeCost(rec, qty) {
    const cq = Number(rec.costQty) || 0;
    if (cq <= 0 || !(qty > 0)) return;
    const avg = (Number(rec.costTotal) || 0) / cq;
    const take = Math.min(qty, cq);
    rec.costQty = cq - take;
    rec.costTotal = Math.max(0, round2((Number(rec.costTotal) || 0) - take * avg));
    rec.avgCost = rec.costQty > 0 ? round2(rec.costTotal / rec.costQty) : null;
  }
  function setCostBasis(rec, unitCost, copies) {
    const n = Math.min(Math.max(1, parseInt(copies, 10) || 1), rec.quantity);
    rec.costQty = n;
    rec.costTotal = round2(n * Number(unitCost || 0));
    rec.avgCost = n > 0 ? round2(rec.costTotal / n) : null;
  }

  /* Spread a lot's purchase price across its lines.
     "market" weights by each line's market value, because a $40 rare and a
     bulk common in the same box did not cost the same share of the money. Lines
     with no known price are weighted at the average of the known ones so they
     absorb something rather than nothing. "even" splits per card. Cents are
     reconciled onto the largest line so the allocation sums to the money spent. */
  // The lot's total spend. A typed total above $0 is the owner's own number;
  // while it is empty or $0, typed per-card costs stand in for it (auto = true).
  function lotSpend(typed, manualTotal) {
    const t = parseFloat(typed);
    const m = round2(manualTotal || 0);
    if (!(t > 0) && m > 0) return { spend: m, auto: true };
    return { spend: isNaN(t) ? 0 : t, auto: false };
  }

  function allocateLotCost(lines, spend, mode) {
    const totalCards = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const total = Number(spend) || 0;
    if (!totalCards || total <= 0) return lines.map(() => 0);

    let weights;
    if (mode === "even") {
      weights = lines.map(l => Number(l.qty) || 0);
    } else {
      const known = lines.filter(l => l.market != null && Number(l.market) > 0);
      const avgKnown = known.length ? known.reduce((s, l) => s + Number(l.market), 0) / known.length : 0;
      weights = lines.map(l => {
        const m = (l.market != null && Number(l.market) > 0) ? Number(l.market) : avgKnown;
        return m * (Number(l.qty) || 0);
      });
    }
    let sum = weights.reduce((s, w) => s + w, 0);
    if (!(sum > 0)) { weights = lines.map(l => Number(l.qty) || 0); sum = totalCards; }

    const cents = lines.map((l, i) => Math.round(total * 100 * (weights[i] / sum)));
    const drift = Math.round(total * 100) - cents.reduce((s, c) => s + c, 0);
    if (drift !== 0) {
      let big = 0;
      for (let i = 1; i < cents.length; i++) if (cents[i] > cents[big]) big = i;
      cents[big] += drift;
    }
    return lines.map((l, i) => {
      const q = Number(l.qty) || 1;
      return (cents[i] / 100) / q;
    });
  }

  function costSummary(rows) {
    const list = rows || state.cards;
    let cards = 0, costCards = 0, cost = 0, value = 0, valueOfCosted = 0;
    for (const r of list) {
      cards += r.quantity;
      costCards += Number(r.costQty) || 0;
      cost += Number(r.costTotal) || 0;
      value += rowTotal(r);
      if (r.price != null) valueOfCosted += r.price * Math.min(r.quantity, Number(r.costQty) || 0);
    }
    return {
      cards, costCards, cost: round2(cost), value: round2(value),
      coverage: cards ? costCards / cards : 0,
      // Gains are only meaningful over the copies with a cost, so that is what
      // gets compared - not the whole collection against a partial spend.
      valueOfCosted: round2(valueOfCosted),
      gain: round2(valueOfCosted - cost),
      gainPct: cost > 0 ? ((valueOfCosted - cost) / cost) * 100 : null
    };
  }

  /* ============================== Merge / CRUD ============================== */
  const metaScore = r => (r.typeLine ? 4 : 0) + (r.imageUrl ? 2 : 0) + (r.scryfallId ? 1 : 0);
  function betterRecord(a, b) {
    const sa = metaScore(a), sb = metaScore(b);
    if (sa !== sb) return sa > sb ? a : b;
    const ta = Date.parse(a.priceUpdated || "") || 0, tb = Date.parse(b.priceUpdated || "") || 0;
    return tb > ta ? b : a;
  }

  function normalizeMerge(opts) {
    const silent = !!(opts && opts.silent);
    const map = new Map();
    const out = [];
    let merged = 0, dropped = 0;
    for (const r of state.cards) {
      r.quantity = Number(r.quantity) || 0;
      r.listedQty = Number(r.listedQty) || 0;
      if (r.quantity <= 0) { dropped++; continue; }
      const k = idKey(r);
      const m = map.get(k);
      if (m) {
        const qty = m.quantity + r.quantity;
        const listed = m.listedQty + r.listedQty;
        // Cost basis is additive across merged stacks - that is exactly what
        // makes the moving average come out right.
        const costQty = (Number(m.costQty) || 0) + (Number(r.costQty) || 0);
        const costTotal = round2((Number(m.costTotal) || 0) + (Number(r.costTotal) || 0));
        // When copies were last added, so the Mana Pool import (#353) can
        // tell cards that came in after an order from older ones.
        // The receipt they came on travels with that date.
        const newer = String(r.acquiredAt || "") > String(m.acquiredAt || "") ? r : m;
        const acquiredAt = newer.acquiredAt, lastReceiptId = newer.lastReceiptId || "";
        // Both stacks' loans carry over, whichever one's card data wins below.
        const loans = (m.loans || []).concat(r.loans || []);
        if (betterRecord(m, r) !== m) Object.assign(m, r, { id: m.id, locationId: m.locationId });
        if (acquiredAt) { m.acquiredAt = acquiredAt; m.lastReceiptId = lastReceiptId; }
        m.quantity = qty; m.listedQty = listed;
        setLoans(m, loans);
        m.costQty = Math.min(costQty, qty);
        m.costTotal = costTotal;
        m.avgCost = m.costQty > 0 ? round2(m.costTotal / m.costQty) : null;
        merged++;
        if (!silent) {
          logAudit({
            action: "edit", ...auditCard(m), qty: r.quantity,
            oldQty: qty - r.quantity, newQty: qty, from: locName(m.locationId),
            note: "Duplicate stack merged into this one"
          });
        }
      } else { map.set(k, r); out.push(r); }
    }
    for (const r of out) {
      r.listedQty = Math.min(r.listedQty, r.quantity);
      r.costQty = Math.min(Number(r.costQty) || 0, r.quantity);
      r.avgCost = r.costQty > 0 ? round2((Number(r.costTotal) || 0) / r.costQty) : null;
      if (r.loans) setLoans(r, r.loans);
    }
    state.cards = out;
    return { merged, dropped };
  }

  /* Add copies of a looked-up printing, optionally with a unit cost.
     Returns the surviving stack. */
  function addCopies(opts) {
    const info = opts.info;
    const rec = normalizeCard({
      set: opts.set, collector: info.collector || opts.num, lang: opts.lang, finish: opts.finish,
      condition: opts.condition,
      name: info.name, setName: info.setName, rarity: info.rarity, tcgplayerId: info.tcgplayerId,
      scryfallId: info.scryfallId, price: info.price, priceNote: info.priceNote,
      locationId: opts.locationId, quantity: opts.qty, listedQty: 0,
      priceUpdated: new Date().toISOString(),
      acquiredAt: opts.acquiredAt || new Date().toISOString(),
      lastReceiptId: opts.receiptId || "",
      ...info.meta,
      held: opts.held || ""
    });
    if (opts.unitCost != null) applyCost(rec, opts.qty, opts.unitCost);
    state.cards.push(rec);
    normalizeMerge({ silent: true });
    const survivor = state.cards.find(r => idKey(r) === idKey(rec)) || rec;
    logAudit({
      action: opts.action || "add", ...auditCard(survivor), qty: opts.qty,
      oldQty: survivor.quantity - opts.qty, newQty: survivor.quantity,
      to: locName(opts.locationId),
      cost: opts.unitCost == null ? null : opts.unitCost * opts.qty,
      receiptId: opts.receiptId || "",
      note: (opts.note || info.note || "").trim()
    });
    return survivor;
  }

  function deleteRecord(id) {
    const rec = state.cards.find(x => x.id === id);
    if (rec) {
      logAudit({
        action: "delete", ...auditCard(rec), qty: -rec.quantity, oldQty: rec.quantity, newQty: 0,
        from: locName(rec.locationId), note: "Stack deleted"
      });
    }
    state.cards = state.cards.filter(x => x.id !== id);
    persist();
  }

  /* ============================== Sealed product ==============================
     Parallel, much simpler inventory type - see normalizeSealedItem above for
     why (no oracle id, no condition/finish/language tiers, fungible quantity
     per SKU). Dedupe key mirrors idKey's own inclusion of locationId above -
     the same SKU sitting in two different locations is two rows, not one. */
  const sealedKey = r => [r.tcgplayerProductId, r.locationId].join("|") + (r.held ? "|held:" + r.held : "");

  /* Add sealed stock, optionally with a unit cost - same shape as addCopies()
     above. Folds into an existing row at the same location/SKU rather than
     always creating a new one, since sealed has no per-stack tiering to keep
     rows apart the way condition/finish does for cards. */
  function addSealedCopies(opts) {
    const key = sealedKey({ tcgplayerProductId: opts.tcgplayerProductId, locationId: opts.locationId, held: opts.held });
    const existing = state.sealed.find(r => sealedKey(r) === key);
    let rec;
    if (existing) {
      existing.quantity += opts.qty;
      if (opts.unitCost != null) applyCost(existing, opts.qty, opts.unitCost);
      rec = existing;
    } else {
      rec = normalizeSealedItem({
        tcgplayerProductId: opts.tcgplayerProductId, manapoolProductId: opts.manapoolProductId,
        name: opts.name, setCode: opts.setCode, locationId: opts.locationId, quantity: opts.qty,
        price: opts.price, priceUpdated: new Date().toISOString(), held: opts.held || ""
      });
      if (opts.unitCost != null) applyCost(rec, opts.qty, opts.unitCost);
      state.sealed.push(rec);
    }
    logAudit({
      action: "sealed-add", name: rec.name, qty: opts.qty,
      oldQty: rec.quantity - opts.qty, newQty: rec.quantity, to: locName(rec.locationId),
      cost: opts.unitCost == null ? null : round2(opts.unitCost * opts.qty),
      receiptId: opts.receiptId || "",
      note: (opts.note || "").trim()
    });
    return rec;
  }

  function moveSealedLocation(id, destLocationId) {
    const rec = state.sealed.find(x => x.id === id);
    if (!rec || rec.locationId === destLocationId) return;
    const from = locName(rec.locationId);
    // Merge into whatever's already at the destination for this SKU, same
    // "one row per SKU per location" rule addSealedCopies enforces on add.
    const destKey = sealedKey({ tcgplayerProductId: rec.tcgplayerProductId, locationId: destLocationId, held: rec.held });
    const dest = state.sealed.find(x => x.id !== id && sealedKey(x) === destKey);
    if (dest) {
      dest.quantity += rec.quantity;
      dest.costQty += rec.costQty;
      dest.costTotal = round2(dest.costTotal + rec.costTotal);
      dest.avgCost = dest.costQty > 0 ? round2(dest.costTotal / dest.costQty) : null;
      // The moved row's listed-for-sale count travels with it.
      dest.listedQty = Math.min(dest.quantity, (Number(dest.listedQty) || 0) + (Number(rec.listedQty) || 0));
      state.sealed = state.sealed.filter(x => x.id !== id);
    } else {
      rec.locationId = destLocationId;
    }
    logAudit({ action: "sealed-move", name: rec.name, qty: rec.quantity, from, to: locName(destLocationId), note: "Sealed product moved" });
  }

  /* Bulk version - every sealed row at one location moves to another in
     one action, same "location emptied into X" concept as
     locations.page.js's moveAll() for cards. Reuses moveSealedLocation per
     row so the merge-into-an-existing-destination-SKU behavior stays in
     one place rather than being duplicated here. */
  function moveAllSealedFromLocation(fromId, toId) {
    const moving = state.sealed.filter(r => r.locationId === fromId);
    const quantity = moving.reduce((s, r) => s + r.quantity, 0);
    for (const r of moving) moveSealedLocation(r.id, toId);
    return { moved: moving.length, quantity };
  }

  function setSealedQuantity(id, qty) {
    const rec = state.sealed.find(x => x.id === id);
    if (!rec) return;
    const oldQty = rec.quantity;
    const newQty = Math.max(0, Number(qty) || 0);
    if (newQty === oldQty) return;
    if (newQty < oldQty) removeCost(rec, oldQty - newQty);
    rec.quantity = newQty;
    if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
    logAudit({ action: "sealed-edit", name: rec.name, qty: newQty - oldQty, oldQty, newQty, note: "Quantity adjusted" });
  }

  function setSealedListedQty(id, qty) {
    const rec = state.sealed.find(x => x.id === id);
    if (!rec) return;
    const newQty = Math.max(0, Math.min(rec.quantity, Number(qty) || 0));
    if (newQty === rec.listedQty) return;
    const old = rec.listedQty;
    rec.listedQty = newQty;
    logAudit({ action: "sealed-edit", name: rec.name, qty: 0, note: "Listed quantity " + old + " → " + newQty });
  }

  function deleteSealedRow(id) {
    const rec = state.sealed.find(x => x.id === id);
    if (rec) {
      logAudit({
        action: "sealed-delete", name: rec.name, qty: -rec.quantity, oldQty: rec.quantity, newQty: 0,
        from: locName(rec.locationId), note: "Sealed row deleted"
      });
    }
    state.sealed = state.sealed.filter(x => x.id !== id);
  }

  /* Bulk version, one audit entry per row - used when a location itself is
     deleted (locations.page.js's deleteLocation()), which previously only
     deleted the cards there and silently left any sealed rows pointing at
     a now-nonexistent locationId. */
  function deleteSealedRowsAtLocation(locationId, locName2) {
    const rows = state.sealed.filter(r => r.locationId === locationId);
    for (const r of rows) {
      logAudit({
        action: "sealed-delete", name: r.name, qty: -r.quantity, oldQty: r.quantity, newQty: 0,
        from: locName2, note: 'Location "' + locName2 + '" deleted'
      });
    }
    state.sealed = state.sealed.filter(r => r.locationId !== locationId);
    return { deleted: rows.length, quantity: rows.reduce((s, r) => s + r.quantity, 0) };
  }

  /* Would moving these stacks into destId take it past its card ceiling?
     Stacks already in destId don't count as moving. Shared by Locations'
     "Move all" and Inventory's bulk Move (#69), which both warn with the
     numbers and let the person go ahead rather than refusing. */
  function moveOverCapacity(destId, rows) {
    const moving = (rows || []).reduce((s, r) =>
      s + (r.locationId === destId ? 0 : Math.max(0, Number(r.quantity) || 0)), 0);
    const st = locStats(destId);
    return { moving, cap: st.cap, free: st.free, over: moving > 0 && st.cap != null && st.free < moving };
  }

  function locStats(id) {
    let rows = 0, cards = 0, value = 0, cost = 0, listed = 0;
    for (const r of state.cards) {
      if (r.locationId !== id) continue;
      rows++; cards += r.quantity; value += rowTotal(r);
      cost += Number(r.costTotal) || 0; listed += r.listedQty || 0;
    }
    const loc = locById(id) || {};
    const cap = loc.maxCards == null ? null : Number(loc.maxCards);
    return {
      rows, cards, value: round2(value), cost: round2(cost), listed,
      cap, free: cap == null ? null : Math.max(0, cap - cards),
      fillPct: cap ? Math.min(999, (cards / cap) * 100) : null,
      over: cap != null && cards > cap
    };
  }

  /* ============================== Type line parsing ============================== */
  /* "Legendary Artifact Creature - Human Wizard" splits into
     supertypes [legendary], types [artifact, creature], subtypes [human, wizard].
     The putaway rules for SUPERTYPE / TYPE / SUBTYPE all read this.
     From window.RuleEngine (public/js/priceRuleEngine.js, loaded before this
     file) - the same matching engine server/lib/priceRules.js requires
     directly, so the browser's rule preview and the unattended nightly
     schedule can never quietly drift apart the way two hand-kept-in-sync
     copies eventually do. */
  const { SUPERTYPES, typeParts } = window.RuleEngine;

  /* ============================== Putaway rule engine ============================== */
  const PUTAWAY_FIELDS = [
    { key: "colorIdentity", label: "Color identity", kind: "colors" },
    { key: "colors", label: "Card colors", kind: "colors" },
    { key: "rarity", label: "Rarity", kind: "enum", options: ["common", "uncommon", "rare", "mythic", "special", "bonus"] },
    { key: "supertype", label: "Supertype", kind: "enum", options: SUPERTYPES },
    { key: "type", label: "Card type", kind: "enum", options: ["artifact", "battle", "creature", "enchantment", "instant", "land", "planeswalker", "sorcery", "kindred", "tribal", "dungeon", "plane", "scheme", "vanguard", "conspiracy", "phenomenon", "emblem"] },
    { key: "subtype", label: "Subtype", kind: "text", placeholder: "e.g. goblin, equipment" },
    { key: "set", label: "Set code", kind: "text", placeholder: "e.g. neo, mh3" },
    { key: "setName", label: "Set name", kind: "text", placeholder: "e.g. Modern Horizons" },
    { key: "setType", label: "Set type", kind: "text", placeholder: "e.g. expansion, masters, commander" },
    { key: "oracleTag", label: "Oracle text / keyword", kind: "text", placeholder: "e.g. flying, draw a card" },
    { key: "name", label: "Card name", kind: "text" },
    { key: "artist", label: "Artist", kind: "text" },
    { key: "price", label: "Price (USD)", kind: "number" },
    // #375: Bulk Price and Listings only (`pricing: true`); the Putaway
    // builder leaves it out of its field list. See RuleEngine.profitInfo.
    { key: "profit", label: "Profit vs cost", kind: "profit", pricing: true },
    { key: "edhrecRank", label: "EDHRec rank (lower = more popular)", kind: "number" },
    { key: "cmc", label: "Mana value", kind: "number" },
    { key: "finish", label: "Finish", kind: "enum", options: FINISHES },
    { key: "language", label: "Language", kind: "enum", options: Object.keys(LANG_NAMES) },
    { key: "location", label: "Storage location", kind: "text", placeholder: "e.g. Binder 1" },
    { key: "borderColor", label: "Border", kind: "enum", options: ["black", "white", "borderless", "silver", "gold"] },
    { key: "promo", label: "Promo", kind: "bool" },
    { key: "fullArt", label: "Full art", kind: "bool" },
    { key: "reserved", label: "Reserved list", kind: "bool" }
  ];
  const fieldDef = key => PUTAWAY_FIELDS.find(f => f.key === key) || PUTAWAY_FIELDS[0];

  const OPS_BY_KIND = {
    colors: [
      { op: "exactly", label: "is exactly" },
      { op: "anyOf", label: "includes any of" },
      { op: "allOf", label: "includes all of" },
      { op: "noneOf", label: "includes none of" }
    ],
    enum: [
      { op: "is", label: "is" },
      { op: "isNot", label: "is not" },
      { op: "anyOf", label: "is any of" },
      { op: "noneOf", label: "is none of" }
    ],
    text: [
      { op: "is", label: "is" },
      { op: "isNot", label: "is not" },
      { op: "anyOf", label: "is any of" },
      { op: "noneOf", label: "is none of" },
      { op: "contains", label: "contains" },
      { op: "notContains", label: "does not contain" }
    ],
    number: [
      { op: "gte", label: "is at least" },
      { op: "lte", label: "is at most" },
      { op: "eq", label: "equals" },
      { op: "between", label: "is between" }
    ],
    bool: [
      { op: "isTrue", label: "is true" },
      { op: "isFalse", label: "is false" }
    ],
    profit: [
      { op: "profitable", label: "is profitable" },
      { op: "unprofitable", label: "is unprofitable" }
    ]
  };
  const PROFIT_UNITS = [{ key: "usd", label: "$ per copy" }, { key: "pct", label: "% of cost" }];
  const opsFor = key => OPS_BY_KIND[fieldDef(key).kind] || OPS_BY_KIND.text;

  function normalizeRule(r) {
    const src = r || {};
    const key = fieldDef(src.field).key;
    const kind = fieldDef(key).kind;
    const ops = opsFor(key).map(o => o.op);
    const out = {
      id: src.id || uid(),
      on: src.on !== false,
      field: key,
      op: ops.includes(src.op) ? src.op : ops[0],
      value: Array.isArray(src.value) ? src.value.slice()
        : (src.value == null ? (kind === "colors" ? [] : "") : src.value)
    };
    // Profit vs cost's margin unit; no other field carries one.
    if (kind === "profit") out.unit = src.unit === "pct" ? "pct" : "usd";
    return out;
  }
  const newRule = () => normalizeRule({ field: "colorIdentity", op: "exactly", value: [] });

  const COLOR_LETTERS = ["W", "U", "B", "R", "G", "C"];
  function normColors(list) {
    const a = (Array.isArray(list) ? list : []).map(c => String(c).toUpperCase()).filter(c => COLOR_LETTERS.includes(c));
    return a.length ? [...new Set(a)] : ["C"];      // no colours at all means colourless
  }

  /* ruleFieldValue, ruleValueList and the criteria-matching logic itself all
     come from window.RuleEngine too (see the note by SUPERTYPES/typeParts
     above) - matchRule here just supplies this page's own locName so the
     shared engine's "location" field lookup has somewhere to resolve a
     location id against, the one piece that legitimately differs between
     the browser and the server. */
  const { ruleFieldValue: engineRuleFieldValue, ruleValueList } = window.RuleEngine;
  const ruleFieldValue = (card, key) => engineRuleFieldValue(card, key, locName);
  const matchRule = (card, rule) => window.RuleEngine.matchRule(card, rule, locName);
  const matchesCriteria = (card, criteria, opts) => window.RuleEngine.matchesCriteria(card, criteria, locName, opts);

  function ruleText(rule) {
    const def = fieldDef(rule.field);
    const ops = opsFor(rule.field);
    const opLabel = (ops.find(o => o.op === rule.op) || ops[0]).label;
    const vals = ruleValueList(rule);
    const shown = def.kind === "colors" ? vals.map(v => v.toUpperCase()).join("") : vals.join(", ");
    if (def.kind === "bool") return def.label + " " + opLabel;
    if (def.kind === "profit") {
      const m = window.RuleEngine.profitMargin(rule);
      if (!(m > 0)) return def.label + " " + opLabel;
      return def.label + " " + opLabel + " by at least " + (rule.unit === "pct" ? m + "%" : "$" + m.toFixed(2));
    }
    return def.label + " " + opLabel + " " + (shown || "—");
  }

  /* A criteria "box" is { combinator: "ALL"|"ANY", not, conditions, groups }
     - see window.RuleEngine's matchesCriteria for the matching semantics.
     `groups` is normally one level deep (a group has conditions but no
     sub-groups of its own) - that is a UI/normalization choice, not
     something the engine itself enforces. normalizeCriteriaBox turns legacy
     data (a bare array of conditions, from before grouping existed) or a
     partial/missing box into the canonical shape with real ids. */
  function normalizeCriteriaBox(box) {
    const shaped = window.RuleEngine.normalizeCriteriaShape(box);
    return {
      combinator: shaped.combinator,
      not: shaped.not,
      conditions: shaped.conditions.map(normalizeRule),
      groups: shaped.groups.map(g => {
        const gs = window.RuleEngine.normalizeCriteriaShape(g);
        return { combinator: gs.combinator, not: gs.not, conditions: gs.conditions.map(normalizeRule) };
      })
    };
  }
  const newCriteriaBox = () => normalizeCriteriaBox(null);

  /* Every leaf condition row in a box, top-level plus one level of groups -
     for counting ("N of M active"), scoring (putaway tie-breaks on how many
     conditions matched), and the "why did this match" reason lists. Does
     NOT reflect AND/OR/NOT/group structure - just every row that exists. */
  function criteriaConditions(box) {
    const b = box || {};
    return [].concat(b.conditions || [], ...(b.groups || []).map(g => g.conditions || []));
  }

  /* Plain-text rendering of a criteria box's ALL/ANY + NOT + grouping, e.g.
     "(Set is neo OR Set is mh3) AND Rarity is common" - lets every rule
     builder show a live "Evaluates as: …" preview above its condition list. */
  /* Nested-group text, recursive to whatever depth the boxes actually go -
     a sub-group's own sub-groups get the same treatment, not just its plain
     conditions. Returns null (not the "matches every stack" placeholder,
     which only makes sense for the outermost box) when a group has nothing
     active, so an empty group quietly drops out of its parent's join
     instead of printing an empty "()" pair. */
  function groupExpressionText(g) {
    const condTexts = (g.conditions || []).filter(c => c.on).map(ruleText);
    const groupTexts = (g.groups || []).map(groupExpressionText).filter(Boolean);
    const all = condTexts.concat(groupTexts);
    if (!all.length) return null;
    const inner = "(" + all.join(g.combinator === "ANY" ? " OR " : " AND ") + ")";
    return g.not ? "NOT " + inner : inner;
  }
  function criteriaExpressionText(box) {
    const b = box || {};
    const condTexts = (b.conditions || []).filter(c => c.on).map(ruleText);
    const groupTexts = (b.groups || []).map(groupExpressionText).filter(Boolean);
    const all = condTexts.concat(groupTexts);
    if (!all.length) return "matches every stack (no active conditions)";
    const text = all.join(b.combinator === "ANY" ? " OR " : " AND ");
    return b.not ? "NOT (" + text + ")" : text;
  }

  /* ---------- Condition-group rule builder (shared UI) ----------
     One condition row's field/op/value editor, and the recursive box
     renderer built on top of it - used as-is by every rule-builder page
     (Putaway locations, Listings, Bulk price) instead of each page keeping
     its own near-identical copy. `onDelete` removes this row from whatever
     list holds it; `onStructural` fires for changes that can alter the
     row's own shape (field/op/on) and expects the caller to rebuild;
     `onLight` fires for a value/color edit that only needs the live
     "Evaluates as:" preview refreshed, not a full rebuild (rebuilding on
     every keystroke would steal focus from the input mid-type).
     `opts.pricing` (Bulk Price, Listings) offers the pricing-only fields
     such as Profit vs cost; Putaway leaves it off. A row already using one
     keeps it in its list either way. */
  function conditionRowEl(rule, onDelete, onStructural, onLight, opts) {
    const def = fieldDef(rule.field);
    const ops = opsFor(rule.field);
    const div = document.createElement("div");
    div.className = "rule" + (rule.on ? "" : " off");
    const pricing = !!(opts && opts.pricing);
    const fields = PUTAWAY_FIELDS.filter(f => !f.pricing || pricing || f.key === rule.field);

    const fieldSel = '<select data-r="field">' + fields.map(f =>
      '<option value="' + f.key + '"' + (f.key === rule.field ? " selected" : "") + ">" + esc(f.label) + "</option>").join("") + "</select>";
    const opSel = '<select data-r="op">' + ops.map(o =>
      '<option value="' + o.op + '"' + (o.op === rule.op ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") + "</select>";

    let valHtml;
    const vals = Array.isArray(rule.value) ? rule.value.map(v => String(v).toUpperCase())
      : String(rule.value == null ? "" : rule.value).split(",").map(v => v.trim()).filter(Boolean);
    if (def.kind === "colors") {
      valHtml = '<div class="colorset">' + COLOR_LETTERS.map(c =>
        '<label><input type="checkbox" data-color="' + c + '"' +
        (vals.map(v => v.toUpperCase()).includes(c) ? " checked" : "") + "> " +
        (c === "C" ? "Colorless" : c) + "</label>").join("") + "</div>";
    } else if (def.kind === "bool") {
      valHtml = '<span class="muted">no value needed</span>';
    } else if (def.kind === "profit") {
      // Optional margin: empty means plain profitable / unprofitable.
      valHtml = '<div class="rule-margin"><span class="muted">by at least</span>' +
        '<input data-r="value" type="text" inputmode="decimal" placeholder="optional, e.g. 2" value="' +
        esc(String(rule.value == null ? "" : rule.value)) + '" aria-label="Minimum margin (optional)">' +
        '<select data-r="unit" aria-label="Margin unit">' + PROFIT_UNITS.map(u =>
          '<option value="' + u.key + '"' + (u.key === (rule.unit === "pct" ? "pct" : "usd") ? " selected" : "") + ">" +
          esc(u.label) + "</option>").join("") + "</select></div>";
    } else if (def.kind === "number") {
      const two = rule.op === "between";
      valHtml = '<input data-r="value" type="text" inputmode="decimal" placeholder="' +
        (two ? "e.g. 1, 5" : "e.g. 10") + '" value="' + esc(vals.join(", ")) + '">';
    } else {
      // Location has no static option list (locations are per-collection, created
      // at runtime) - build one live from the current locations instead of baking
      // it into PUTAWAY_FIELDS. Still a text field underneath, so "contains" still
      // works as a LIKE-style partial match; this only adds pick-from-a-list.
      const options = rule.field === "location" ? sortedLocations().map(l => l.name) : def.options;
      const listId = "opts_" + rule.id;
      const dl = options
        ? '<datalist id="' + listId + '">' + options.map(o => '<option value="' + esc(o) + '">').join("") + "</datalist>"
        : "";
      const many = rule.op === "anyOf" || rule.op === "noneOf";
      valHtml = '<input data-r="value" ' + (options ? 'list="' + listId + '" ' : "") +
        'placeholder="' + esc(many ? "comma-separated, e.g. " + ((options || ["a", "b"]).slice(0, 2).join(", "))
          : (def.placeholder || (options ? options[0] : "value"))) + '" value="' +
        esc(vals.join(", ")) + '">' + dl;
    }

    div.innerHTML =
      '<div class="toggle"><input type="checkbox" data-r="on"' + (rule.on ? " checked" : "") +
        ' title="Switch this condition off without deleting it"></div>' +
      fieldSel + opSel + valHtml +
      '<div class="toggle"><button class="small" data-r="del" title="Delete this condition" aria-label="Delete this condition">✕</button></div>';

    div.querySelector('[data-r="on"]').onchange = e => { rule.on = e.target.checked; onStructural(); };
    div.querySelector('[data-r="field"]').onchange = e => {
      rule.field = e.target.value;
      const newOps = opsFor(rule.field).map(o => o.op);
      if (!newOps.includes(rule.op)) rule.op = newOps[0];
      rule.value = fieldDef(rule.field).kind === "colors" ? [] : "";
      if (fieldDef(rule.field).kind === "profit") rule.unit = "usd"; else delete rule.unit;
      onStructural();
    };
    div.querySelector('[data-r="op"]').onchange = e => { rule.op = e.target.value; onStructural(); };
    div.querySelector('[data-r="del"]').onclick = () => onDelete();
    const valInput = div.querySelector('[data-r="value"]');
    if (valInput) valInput.oninput = () => { rule.value = valInput.value; onLight(); };
    const unitSel = div.querySelector('[data-r="unit"]');
    if (unitSel) unitSel.onchange = () => { rule.unit = unitSel.value; onLight(); };
    div.querySelectorAll("[data-color]").forEach(cb => {
      cb.onchange = () => {
        rule.value = [...div.querySelectorAll("[data-color]")].filter(x => x.checked).map(x => x.dataset.color);
        onLight();
      };
    });
    return div;
  }

  /* BACKLOG.md #39: a deeply-nested rule tree (group inside group inside
     group) gets visually overwhelming - this is purely a "fold this subtree
     away for now" UI convenience, not a data-model field, so it lives in a
     WeakMap keyed by the box object itself rather than on the box (which
     gets saved to the server as part of the rule) - collapsing a group must
     never write anything into the saved criteria. State is keyed by object
     identity, which `renderBoxEl` preserves across rerenders (the same box
     objects are mutated in place, never recreated), so a fold survives
     adding/removing a sibling condition but resets on a fresh page load -
     same as any other collapsed-accordion convention in the app. */
  const groupCollapsed = new WeakMap();
  function collapsedSummary(box) {
    const nCond = (box.conditions || []).length;
    const nGroup = (box.groups || []).length;
    const parts = [];
    if (nCond) parts.push(nCond + " condition" + (nCond === 1 ? "" : "s"));
    if (nGroup) parts.push(nGroup + " group" + (nGroup === 1 ? "" : "s"));
    return parts.join(", ");
  }

  function combinatorBarHtml(box, label) {
    return '<div class="crit-bar">' +
      '<label><input type="checkbox" data-cb="not"' + (box.not ? " checked" : "") + '> NOT</label>' +
      "<span>" + label + "</span>" +
      '<select data-cb="combinator">' +
        '<option value="ALL"' + (box.combinator !== "ANY" ? " selected" : "") + ">ALL</option>" +
        '<option value="ANY"' + (box.combinator === "ANY" ? " selected" : "") + ">ANY</option>" +
      "</select>" +
      "<span>of the following:</span>" +
      "</div>";
  }

  /* Renders a criteria box into `host`: a live "Evaluates as:" preview, then
     the recursive box element below (see renderBoxEl) - a group can itself
     contain groups, to whatever depth the user builds, since the underlying
     evaluator (priceRuleEngine.js's matchesCriteria) already recurses on
     `box.groups` with no depth limit; the UI used to stop at one level for
     no reason tied to the data model. `box` is mutated in place. `onChange`
     (optional) fires after any edit, for a caller that wants to react beyond
     the rebuild this function already does for itself (e.g. the Putaway
     page's live rule-test preview). `opts` (optional) goes to every
     condition row: `{ pricing: true }` on Bulk Price and Listings. */
  function renderCriteriaBuilder(host, box, onChange, opts) {
    const rerender = () => renderCriteriaBuilder(host, box, onChange, opts);
    const notify = () => { if (onChange) onChange(); };
    const structural = () => { rerender(); notify(); };

    host.innerHTML = "";

    const preview = document.createElement("div");
    preview.className = "rule-help";
    const updatePreview = () => { preview.textContent = "Evaluates as: " + criteriaExpressionText(box); };
    updatePreview();
    host.appendChild(preview);
    const light = () => { updatePreview(); notify(); };

    host.appendChild(renderBoxEl(box, "Match", structural, light, null, rerender, opts));
  }

  /* One box's worth of UI - its ALL/ANY + NOT bar, its own condition rows,
     its own nested group boxes (rendered by calling this same function
     again, one level deeper), and its own "+ Add condition" / "+ Add group"
     controls. Used both for the top-level box and for every group inside it,
     so nesting depth is just recursion depth, not a separately-coded case.
     `onDeleteThisGroup` is null for the top-level box (nothing deletes the
     box itself) and a callback for a nested group (splices it out of its
     parent's `groups` array) - its presence is also what decides whether
     this level gets the bordered .crit-group look and a "✕ group" button.
     `redraw` rebuilds the DOM without calling the caller's onChange (unlike
     `structural`) - collapsing/expanding a group is a display-only toggle,
     not an edit, and firing onChange for it would make callers that use it
     to re-run a live test (Putaway's rule preview) do pointless work. */
  function renderBoxEl(box, label, structural, light, onDeleteThisGroup, redraw, opts) {
    if (!box.groups) box.groups = [];
    const wrap = document.createElement("div");
    if (onDeleteThisGroup) wrap.className = "crit-group";

    const hasChildren = box.conditions.length > 0 || box.groups.length > 0;
    const collapsed = hasChildren && !!groupCollapsed.get(box);

    const bar = document.createElement("div");
    bar.innerHTML = combinatorBarHtml(box, label);
    const barEl = bar.firstElementChild;
    barEl.querySelector('[data-cb="not"]').onchange = e => { box.not = e.target.checked; light(); };
    barEl.querySelector('[data-cb="combinator"]').onchange = e => { box.combinator = e.target.value; light(); };
    if (hasChildren) {
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "small ghost crit-collapse";
      toggleBtn.textContent = collapsed ? "▸" : "▾";
      toggleBtn.title = collapsed ? "Expand this group" : "Collapse this group";
      toggleBtn.setAttribute("aria-label", collapsed ? "Expand this group" : "Collapse this group");
      toggleBtn.onclick = () => { groupCollapsed.set(box, !collapsed); redraw(); };
      barEl.insertBefore(toggleBtn, barEl.firstChild);
      if (collapsed) {
        const summary = document.createElement("span");
        summary.className = "muted";
        summary.textContent = collapsedSummary(box);
        barEl.appendChild(summary);
      }
    }
    if (onDeleteThisGroup) {
      const delBtn = document.createElement("button");
      delBtn.className = "small ghost";
      delBtn.textContent = "✕ group";
      delBtn.title = "Delete this group";
      delBtn.onclick = onDeleteThisGroup;
      barEl.appendChild(delBtn);
    }
    wrap.appendChild(barEl);

    if (!collapsed) {
      box.conditions.forEach((r, i) => {
        wrap.appendChild(conditionRowEl(r,
          () => { box.conditions.splice(i, 1); structural(); },
          structural, light, opts));
      });

      box.groups.forEach((g, gi) => {
        wrap.appendChild(renderBoxEl(g, "Group — match", structural, light,
          () => { box.groups.splice(gi, 1); structural(); }, redraw, opts));
      });

      const controls = document.createElement("div");
      controls.style.marginTop = "8px";
      const addCond = document.createElement("button");
      addCond.className = "small";
      addCond.textContent = "+ Add condition";
      addCond.onclick = () => { box.conditions.push(newRule()); structural(); };
      const addGroup = document.createElement("button");
      addGroup.className = "small ghost";
      addGroup.style.marginLeft = "8px";
      addGroup.textContent = "+ Add group";
      addGroup.onclick = () => { box.groups.push({ combinator: "ANY", not: false, conditions: [newRule()], groups: [] }); structural(); };
      controls.appendChild(addCond);
      controls.appendChild(addGroup);
      wrap.appendChild(controls);
    }
    return wrap;
  }

  /* ---------- "the same card" ----------
     Oracle identity, so every printing and language of Lightning Bolt counts as
     one card for a per-name cap. Rows written before oracle ids were captured
     fall back to the name, and a match on EITHER key counts - otherwise a
     refreshed row and a stale one would be treated as two different cards. */
  const oracleKey = c => String((c && c.oracleId) || "").trim();
  const nameKey = c => String((c && c.name) || "").trim().toLowerCase();
  function sameCardName(a, b) {
    const oa = oracleKey(a), ob = oracleKey(b);
    if (oa && ob) return oa === ob;
    const na = nameKey(a), nb = nameKey(b);
    return !!na && na === nb;
  }
  /* How many copies of this card a location already holds. One full scan -
     fine for a single question, but anything asking per card x location
     builds a putawayIndex() instead. */
  function nameCountAt(locationId, card) {
    let n = 0;
    for (const r of state.cards) {
      if (r.locationId !== locationId) continue;
      if (sameCardName(r, card)) n += r.quantity;
    }
    return n;
  }

  /* ---------- Per-plan location index (#67) ----------
     One pass over state.cards giving each location's card total and its
     per-card counts, so a plan asks "how full is X / how many of this card
     does X hold" with a Map lookup instead of a full collection scan per
     card x location (that was stacks x locations x stacks, which never
     finished at the ~70k-stack account size). Build one per plan run; it is
     a snapshot, so rebuild after anything moves.

     nameCountAt() must come out identical to sameCardName()'s rule: a card
     with an oracle id matches rows with the same oracle id plus rows that
     have NO oracle id but the same name; a card without one matches every
     row with its name. Hence three tallies, kept in a cardTally(). */
  const IDX_SEP = "\u0001";
  /* Per-location "copies of this card" counter using sameCardName()'s rule.
     The index uses one for what is already filed; planners use another for
     what they have promised so far (binPlan's reservedName,
     fitPutawayMoves), so a reservation is counted exactly the way stock is -
     an oracle-id stack and an older same-name stack without one are the
     same card for a per-card limit either way. */
  function cardTally() {
    const byOracle = new Map(), byBareName = new Map(), byName = new Map();
    const bump = (m, k, q) => m.set(k, (m.get(k) || 0) + q);
    return {
      add(id, card, q) {
        const ok = oracleKey(card), nk = nameKey(card);
        if (ok) bump(byOracle, id + IDX_SEP + ok, q);
        else if (nk) bump(byBareName, id + IDX_SEP + nk, q);
        if (nk) bump(byName, id + IDX_SEP + nk, q);
      },
      count(id, card) {
        const ok = oracleKey(card), nk = nameKey(card);
        if (ok) return (byOracle.get(id + IDX_SEP + ok) || 0) + (nk ? byBareName.get(id + IDX_SEP + nk) || 0 : 0);
        return nk ? byName.get(id + IDX_SEP + nk) || 0 : 0;
      }
    };
  }
  function putawayIndex() {
    const totals = new Map(), names = cardTally();
    for (const r of state.cards) {
      const id = r.locationId;
      if (!id) continue;
      totals.set(id, (totals.get(id) || 0) + r.quantity);
      names.add(id, r, r.quantity);
    }
    const rules = new Map();
    return {
      cardsAt: id => totals.get(id) || 0,
      nameCountAt: (id, card) => names.count(id, card),
      // A location's enabled putaway rules, parsed once per plan rather than
      // once per card x location.
      rulesOf(loc) {
        let r = rules.get(loc.id);
        if (!r) { r = criteriaConditions((loc.putaway || {}).rules).filter(c => c.on); rules.set(loc.id, r); }
        return r;
      }
    };
  }

  /* ---------- Candidate locations ----------
     A location is a candidate when putaway is switched on, it is not a sorting
     tray, and EVERY enabled rule matches. A location with putaway on and no
     rules matches everything - that is the overflow box, and it scores 0 so any
     specific match beats it. Ties break on priority, then free space, then name.

     Two separate ceilings decide how much a candidate can take:
       maxCards    - total cards in the place
       maxPerName  - copies of THIS card in the place
     `reserved` lets a caller simulate a run of putaways (a whole bin) so the
     second card of a pair does not get told the same last slot is still free.
     `index` is a putawayIndex() shared across a whole plan; without one, a
     single call builds its own (one scan, not one per location). */
  function candidates(card, opts) {
    const o = opts || {};
    const reserved = o.reserved || null;      // Map "locId" -> total cards already promised
    const reservedName = o.reservedName || null;  // cardTally() of copies promised per location
    const idx = o.index || putawayIndex();
    const out = [];
    for (const loc of state.locations) {
      if (o.excludeLocationId && loc.id === o.excludeLocationId) continue;
      if (loc.staging) continue;             // never file INTO a sorting tray
      const pa = loc.putaway || {};
      if (!pa.enabled) continue;
      const rules = idx.rulesOf(loc);
      if (!matchesCriteria(card, pa.rules)) continue;

      const held = idx.cardsAt(loc.id);
      const cap = loc.maxCards == null ? null : Number(loc.maxCards);
      const st = { cards: held, cap, free: cap == null ? null : Math.max(0, cap - held) };
      const promised = reserved ? (reserved.get(loc.id) || 0) : 0;
      const capFree = st.cap == null ? Infinity : Math.max(0, st.free - promised);

      const perName = loc.maxPerName == null ? null : Number(loc.maxPerName);
      const namePromised = reservedName ? reservedName.count(loc.id, card) : 0;
      const nameHeld = perName == null ? 0 : idx.nameCountAt(loc.id, card) + namePromised;
      const nameFree = perName == null ? Infinity : Math.max(0, perName - nameHeld);

      const free = Math.min(capFree, nameFree);
      out.push({
        location: loc, locationId: loc.id, name: loc.name, type: loc.type,
        rules: rules.slice(), matched: rules.length,
        score: rules.length, priority: Number(loc.priority) || 0,
        cards: st.cards + promised, cap: st.cap, capFree,
        perName, nameHeld, nameFree,
        free,
        // Why it cannot take any more, for the UI to explain rather than just refuse.
        blockedBy: free > 0 ? "" : (nameFree <= 0 ? "per-name" : "capacity")
      });
    }
    out.sort((a, b) => b.score - a.score || b.priority - a.priority ||
      (b.free === Infinity ? 1e9 : b.free) - (a.free === Infinity ? 1e9 : a.free) ||
      LOC_NAME_COLLATOR.compare(a.name, b.name));
    return out;
  }
  // Same order as localeCompare(b, undefined, {sensitivity:"base"}), but one
  // collator instead of building a fresh one on every comparison - this sort
  // runs once per stack in a plan, so that cost dominated at scale.
  const LOC_NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

  const putawayLocationCount = () =>
    state.locations.filter(l => l.putaway && l.putaway.enabled && !l.staging).length;

  /* Single best destination for a whole quantity. */
  function suggestLocation(card, opts) {
    const o = opts || {};
    const qty = Math.max(1, Number(o.qty) || 1);
    const all = candidates(card, o);
    const eligible = all.filter(c => c.free >= qty);
    const blocked = all.filter(c => c.free < qty);
    return {
      best: eligible[0] || null,
      eligible, blocked, all,
      considered: putawayLocationCount(),
      qty
    };
  }

  /* Split a quantity across destinations in rank order.
     This is what makes an overflow bin work: a binder that takes one of each
     accepts the first copy, and the other three fall through to whatever comes
     next - usually a sell-overflow box with putaway on and no rules. */
  function allocatePutaway(card, qty, opts) {
    const o = opts || {};
    let need = Math.max(0, Number(qty) || 0);
    const picks = [];
    const all = candidates(card, o);
    for (const c of all) {
      if (need <= 0) break;
      if (!(c.free > 0)) continue;
      const take = Math.min(need, c.free === Infinity ? need : c.free);
      if (take <= 0) continue;
      picks.push({
        locationId: c.locationId, name: c.name, type: c.type, take,
        rules: c.rules, reason: c.rules.map(ruleText),
        cap: c.cap, perName: c.perName, nameHeld: c.nameHeld,
        overflow: picks.length > 0
      });
      need -= take;
    }
    return {
      picks, shortfall: need,
      candidates: all,
      considered: putawayLocationCount(),
      split: picks.length > 1
    };
  }

  /* ---------- Bin plan ----------
     "I counted a tray of cards in; where does it all go?" Every stack in one
     location, allocated in order, with capacity and per-name ceilings consumed
     as the plan is built - so the plan you are shown is a plan that will
     actually fit when you press the button.

     Stacks are planned most-constrained first (highest priced, then largest),
     so the valuable singles claim the good binder slots before the bulk does.

     A pick into a location with a sorting method also carries spot: where
     inside it those copies go (locationLayouts().place, #293), counting the
     copies earlier lines of this plan send there. Each destination is
     sorted once per plan. */
  function binPlan(locationId, opts) {
    const o = opts || {};
    const rows = state.cards
      .filter(r => r.locationId === locationId)
      .slice()
      .sort((a, b) => (b.price || 0) - (a.price || 0) || b.quantity - a.quantity ||
        String(a.name).localeCompare(String(b.name)));
    const reserved = new Map();
    const reservedName = cardTally();
    const index = putawayIndex();
    const layouts = locationLayouts();
    const lines = [];
    for (const r of rows) {
      const alloc = allocatePutaway(r, r.quantity, {
        excludeLocationId: o.allowSame ? null : locationId,
        reserved, reservedName, index
      });
      for (const p of alloc.picks) {
        reserved.set(p.locationId, (reserved.get(p.locationId) || 0) + p.take);
        reservedName.add(p.locationId, r, p.take);
        const lay = p.locationId !== r.locationId ? layouts.get(p.locationId) : null;
        if (lay) p.spot = lay.place(r, p.take);
      }
      lines.push({
        record: r, picks: alloc.picks, shortfall: alloc.shortfall,
        split: alloc.split, candidates: alloc.candidates
      });
    }
    const moves = lines.reduce((s, l) => s + l.picks.reduce((t, p) => t + p.take, 0), 0);
    return {
      locationId,
      lines,
      stacks: lines.length,
      cards: rows.reduce((s, r) => s + r.quantity, 0),
      moves,
      stranded: lines.reduce((s, l) => s + l.shortfall, 0),
      considered: putawayLocationCount()
    };
  }

  /* Move n copies of one stack to another bin: the desk's Manage "Move" and
     Warehouse Mode's find-and-move (#387) both come here, so the two can't
     disagree. The clone carries a proportional slice of the cost basis (a move
     never invents or destroys cost) and the loans only of copies the stack no
     longer has room for (splitLoans). The caller has checked the copies are
     free to move. Returns normalizeMerge's { merged }: 1 when the moved copies
     joined a matching stack already in the bin. */
  function moveCopies(rec, destId, n, why) {
    const oldQty = rec.quantity;
    const costEach = Number(rec.costQty) > 0 ? rec.avgCost : null;
    const costCopies = Math.min(n, Number(rec.costQty) || 0);
    logAudit({
      action: "move", ...auditCard(rec), qty: n, oldQty, newQty: oldQty - n,
      from: locName(rec.locationId), to: locName(destId),
      note: (why ? why + " — " : "") + "Moved " + n + " of " + oldQty
    });
    const clone = Object.assign({}, rec, {
      id: uid(), locationId: destId, quantity: n, listedQty: 0,
      costQty: 0, costTotal: 0, avgCost: null
    });
    if (costEach != null && costCopies > 0) applyCost(clone, costCopies, costEach);
    removeCost(rec, costCopies);
    state.cards.push(clone);
    rec.quantity -= n;
    splitLoans(rec, clone);
    if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
    return normalizeMerge({ silent: true });
  }

  /* Commit a bin plan (or a filtered subset of its lines). Splitting a stack
     clones it and carries a proportional slice of the cost basis with the
     clone, so moving cards never invents or destroys cost. */
  function applyPutawayLines(lines, note) {
    let moved = 0, split = 0;
    for (const line of lines) {
      const rec = state.cards.find(x => x.id === line.record.id);
      if (!rec) continue;
      for (const p of line.picks) {
        if (p.locationId === rec.locationId) continue;
        const take = Math.min(p.take, rec.quantity);
        if (take <= 0) continue;
        const why = (note ? note + ": " : "") + (p.reason.join("; ") || "catch-all") +
          (p.perName != null ? " (per-name cap " + p.perName + ")" : "");
        logAudit({
          action: "putaway", ...auditCard(rec), qty: take,
          oldQty: rec.quantity, newQty: rec.quantity - (take === rec.quantity ? 0 : take),
          from: locName(rec.locationId), to: p.name, note: why
        });
        if (take >= rec.quantity) {
          rec.locationId = p.locationId;
        } else {
          const costEach = Number(rec.costQty) > 0 ? rec.avgCost : null;
          const costCopies = Math.min(take, Number(rec.costQty) || 0);
          const clone = Object.assign({}, rec, {
            id: uid(), locationId: p.locationId, quantity: take, listedQty: 0,
            costQty: 0, costTotal: 0, avgCost: null
          });
          if (costEach != null && costCopies > 0) applyCost(clone, costCopies, costEach);
          removeCost(rec, costCopies);
          rec.quantity -= take;
          splitLoans(rec, clone);
          if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
          state.cards.push(clone);
          split++;
        }
        moved += take;
      }
    }
    normalizeMerge({ silent: true });
    return { moved, split };
  }

  /* Same question for the whole collection - "is everything filed correctly?" */
  function putawayPlan(opts) {
    const o = opts || {};
    const rows = o.rows || state.cards;
    const index = putawayIndex();
    const out = [];
    for (const r of rows) {
      const s = suggestLocation(r, { qty: r.quantity, excludeLocationId: null, index });
      const bestId = s.best ? s.best.locationId : null;
      out.push({
        record: r,
        current: r.locationId,
        suggestion: s.best,
        blocked: s.blocked,
        move: !!bestId && bestId !== r.locationId,
        reason: s.best ? s.best.rules.map(ruleText) : []
      });
    }
    return out;
  }

  /* ---------- Reserving fit check (#65) ----------
     putawayPlan() and ruleBreakers() pick each stack's destination against
     today's free space on its own, so three 4-card stacks can all be told
     the same 5 free slots. This walks a list of moves in order and reserves
     capacity as it goes - the card ceiling (maxCards) and the per-card limit
     (maxPerName) both - the same way binPlan() and "To a bin" do, so only as
     many fit as the place can actually take.
     moves: [{ record, locationId, qty? }] (qty defaults to the stack's size).
     Returns one { fits, capFree, nameFree, blockedBy } per move. */
  function fitPutawayMoves(moves, opts) {
    const idx = (opts && opts.index) || putawayIndex();
    const usedTotal = new Map(), usedName = cardTally();
    return moves.map(m => {
      const loc = locById(m.locationId);
      if (!loc) return { fits: false, capFree: 0, nameFree: 0, blockedBy: "missing" };
      const id = loc.id, r = m.record;
      const qty = m.qty == null ? r.quantity : m.qty;
      const cap = loc.maxCards == null ? null : Number(loc.maxCards);
      const capFree = cap == null ? Infinity : Math.max(0, cap - idx.cardsAt(id) - (usedTotal.get(id) || 0));
      const perName = loc.maxPerName == null ? null : Number(loc.maxPerName);
      const nameFree = perName == null ? Infinity
        : Math.max(0, perName - idx.nameCountAt(id, r) - usedName.count(id, r));
      const fits = capFree >= qty && nameFree >= qty;
      if (fits) {
        usedTotal.set(id, (usedTotal.get(id) || 0) + qty);
        usedName.add(id, r, qty);
      }
      return { fits, capFree, nameFree, blockedBy: fits ? "" : nameFree < qty ? "per-name" : "capacity" };
    });
  }

  /* Apply the ticked rows of a putawayPlan() / ruleBreakers() list: each
     stack goes whole to its suggestion, in order, and a row that would push
     its destination over the ceiling or the per-card limit (counting what
     earlier rows already took) is skipped rather than moved. */
  function applySuggestedMoves(rows, note) {
    const withDest = rows.filter(p => p.suggestion);
    const fit = fitPutawayMoves(withDest.map(p => ({ record: p.record, locationId: p.suggestion.locationId })));
    const lines = [];
    withDest.forEach((p, i) => {
      if (!fit[i].fits) return;
      lines.push({
        record: p.record,
        picks: [{ locationId: p.suggestion.locationId, name: p.suggestion.name, take: p.record.quantity,
          reason: p.reason || [], cap: p.suggestion.cap, perName: p.suggestion.perName,
          nameHeld: p.suggestion.nameHeld, rules: p.suggestion.rules, overflow: false }],
        shortfall: 0
      });
    });
    const out = applyPutawayLines(lines, note);
    return { moved: out.moved, split: out.split, applied: lines.length, skipped: rows.length - lines.length };
  }

  /* Cards that break the rules of the location they are CURRENTLY sitting in -
     a strict compliance check, distinct from putawayPlan()'s "is there a
     globally better location" question. A stack can fail here with nowhere
     else to go either (no location's rules claim it) or pass here while
     putawayPlan() still suggests moving it somewhere the rules like more -
     those are two different questions and deliberately not conflated. */
  function ruleBreakers(opts) {
    const o = opts || {};
    const rows = o.rows || state.cards;
    const index = putawayIndex();
    const out = [];
    for (const r of rows) {
      if (!r.locationId) continue;
      const loc = locById(r.locationId);
      if (!loc || loc.staging) continue;          // a sorting tray has no rules to keep
      const pa = loc.putaway || {};
      if (!pa.enabled) continue;                  // rules not switched on = nothing to enforce
      const conds = criteriaConditions(pa.rules).filter(c => c.on);
      if (!conds.length) continue;                // empty box = catch-all, can't be broken
      if (matchesCriteria(r, pa.rules)) continue;  // satisfies its own location - fine
      const s = suggestLocation(r, { qty: r.quantity, excludeLocationId: loc.id, index });
      out.push({
        record: r,
        location: loc,
        locationId: loc.id,
        expression: criteriaExpressionText(pa.rules),
        failed: conds.filter(c => !matchRule(r, c)).map(ruleText),
        suggestion: s.best,
        reason: s.best ? s.best.rules.map(ruleText) : []
      });
    }
    return out;
  }

  /* The reverse question from ruleBreakers(): not "does this card belong
     where it is," but "what in the rest of the collection belongs HERE" -
     for a location a person is looking at and wondering what to file into
     it. Matches purely on this location's own rules, same as ruleBreakers -
     it does NOT ask whether some other location's rules would claim a stack
     even more specifically, so a card can show up here as eligible even if
     putawayPlan() would send it elsewhere; this is "would this bin take it,"
     not "is this the best bin for it." */
  /* Per-row match info only - NOT a per-row "fits" verdict, deliberately.
     Whether stack #12 in the results still fits depends on how much of the
     ceiling stacks #1-11 already used, so that has to be tallied while
     walking the list in whatever order it's displayed, the same way
     putawayPlan's renderer tallies "used" across rows sharing one
     destination - a static per-row check here would happily mark every
     single one of twenty rows "fits" against the location's current free
     space even though only the first few could actually go in at once. */
  function whatBelongsHere(locationId, opts) {
    const o = opts || {};
    const loc = locById(locationId);
    if (!loc || loc.staging) return { location: loc, rows: [] };
    const pa = loc.putaway || {};
    if (!pa.enabled) return { location: loc, rows: [] };
    const rows = o.rows || state.cards;
    const perName = loc.maxPerName == null ? null : Number(loc.maxPerName);
    const index = perName == null ? null : putawayIndex();
    const out = [];
    for (const r of rows) {
      if (r.locationId === locationId) continue;             // already here
      if (!matchesCriteria(r, pa.rules)) continue;
      const nameHeld = perName == null ? 0 : index.nameCountAt(locationId, r);
      out.push({ record: r, from: r.locationId, nameHeld });
    }
    return { location: loc, rows: out };
  }

  /* Cards fragmented across more than one location - "I have Shock in 9
     different boxes" - grouped by name (not by printing/foil/condition, so a
     card's distinct printings stay distinct rows even after consolidating;
     only their locationId changes). Each group's suggested target is
     wherever the most copies of it ALREADY sit, not wherever the putaway
     rules would send it - the point is gathering an existing mess with the
     least motion, and a card living entirely in catch-all bulk boxes (no
     rule distinguishes between them) would otherwise have no rule-based
     answer at all. The target is just a starting suggestion; the caller can
     override it per group before applying. */
  function consolidatePlan(opts) {
    const o = opts || {};
    const rows = o.rows || state.cards;
    const groups = new Map();
    for (const r of rows) {
      if (!r.locationId) continue;
      const key = oracleKey(r) || nameKey(r);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(r);
    }
    const out = [];
    for (const [key, list] of groups) {
      const byLoc = new Map();
      for (const r of list) byLoc.set(r.locationId, (byLoc.get(r.locationId) || 0) + r.quantity);
      if (byLoc.size < 2) continue;                    // already all in one place
      // Never a sorting tray (nothing is filed INTO one), nor a location
      // that no longer exists. If every copy sits in trays there is no
      // default: the row asks for a target instead (#66).
      let target = null, targetQty = 0;
      for (const [locId, qty] of byLoc) {
        if (!isConsolidateTarget(locId)) continue;
        if (qty > targetQty) { target = locId; targetQty = qty; }
      }
      out.push({
        key, name: list[0].name,
        stacks: list.slice().sort((a, b) => b.quantity - a.quantity),
        locations: byLoc.size,
        totalQty: list.reduce((s, r) => s + r.quantity, 0),
        target, targetQty
      });
    }
    out.sort((a, b) => b.locations - a.locations || b.totalQty - a.totalQty);
    return out;
  }
  function isConsolidateTarget(locId) {
    const l = locById(locId);
    return !!l && !l.staging;
  }
  /* Where Consolidate will actually gather a group: the person's per-row
     override if it still names a real, non-tray location, else the plan's
     default (which may be null - "pick a target"). A deleted override falls
     back here rather than crashing the tab. */
  function consolidateTarget(group, overrideId) {
    if (overrideId && isConsolidateTarget(overrideId)) return overrideId;
    return group.target && isConsolidateTarget(group.target) ? group.target : null;
  }

  /* Locations acting as sorting trays, with what is waiting in them. */
  function stagingBins() {
    return state.locations.filter(l => l.staging).map(l => {
      const st = locStats(l.id);
      return { location: l, id: l.id, name: l.name, type: l.type, cards: st.cards, stacks: st.rows, value: st.value };
    }).sort((a, b) => b.cards - a.cards || a.name.localeCompare(b.name));
  }

  /* Every location holding at least one card, offered as a quick-pick source
     for "From a bin" - a sorting tray is the everyday case (sorted first),
     but nothing stops emptying a full shelf back out and re-filing it, and
     the old tray-only quick-pick list made that look unsupported even though
     the location dropdown next to it always accepted any location. */
  function putawaySources() {
    return state.locations.map(l => {
      const st = locStats(l.id);
      return { location: l, id: l.id, name: l.name, type: l.type, staging: !!l.staging,
        cards: st.cards, stacks: st.rows, value: st.value };
    }).filter(x => x.cards > 0)
      .sort((a, b) => (b.staging ? 1 : 0) - (a.staging ? 1 : 0) || b.cards - a.cards || a.name.localeCompare(b.name));
  }

  /* ============================== Cycle counting ============================== */
  /* Sampling-based inventory-accuracy checks (public/cycle-count.html):
     floor-to-book (a person reports what's physically in a bin, Grimoire
     checks the book) and book-to-floor (Grimoire samples what the book says
     is in a bin, a person confirms it's really there). A high error rate on
     either triggers a full recount of that bin - applyCycleCountAdjustments
     below is what a full recount actually commits.

     Matching deliberately ignores `condition` throughout - this is a
     location-accuracy check ("is this card here"), not a grading audit. */
  function fisherYates(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function stacksInLocation(locationId) {
    return state.cards.filter(r => r.locationId === locationId && r.quantity > 0);
  }

  /* Floor -> Book's "N of M sampled" line. `size` is the page's Sample size
     box (pre-filled from Settings); a blank or invalid box falls back to the
     Settings value, then 10, the same default Book -> Floor uses. */
  function cycleSampleProgress(count, size) {
    const target = Math.max(1, parseInt(size, 10) || parseInt(state.settings && state.settings.cycleCountSampleSize, 10) || 10);
    const n = Math.max(0, Number(count) || 0);
    const left = Math.max(0, target - n);
    return {
      count: n, target, done: left === 0,
      text: n + " of " + target + " sampled" + (left ? " - add " + left + " more for a full sample" : " - ready to check")
    };
  }

  /* Most-overdue bins first (never-counted sorts first of all), a weighted
     random pick among that overdue slice so book-to-floor isn't perfectly
     predictable run to run. */
  function pickCycleCountBin(opts) {
    // A bin on the count list (a short pick said its book is wrong) goes first,
    // emptied or not: it needs a full count to close. A sample can't close it,
    // so sampling (opts.sampling) keeps to the normal rotation.
    if (!(opts && opts.sampling)) {
      const wanted = oldestWanted(COUNT_FLAG.cards);
      if (wanted) return wanted;
    }
    const eligible = state.locations.filter(l => stacksInLocation(l.id).length > 0);
    if (!eligible.length) return null;
    const sorted = eligible.slice().sort((a, b) => {
      const at = a.lastCycleCountAt ? new Date(a.lastCycleCountAt).getTime() : -Infinity;
      const bt = b.lastCycleCountAt ? new Date(b.lastCycleCountAt).getTime() : -Infinity;
      return at - bt;
    });
    const poolSize = Math.max(5, Math.ceil(sorted.length * 0.25));
    const pool = sorted.slice(0, Math.min(poolSize, sorted.length));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function sampleBinStacks(locationId, n) {
    const totes = totesByStack();
    const rows = stacksInLocation(locationId).filter(r => shelfQty(r, totes) > 0);   // all lent out or in a tote: nothing to find
    const want = Math.max(1, parseInt(n, 10) || 1);
    return fisherYates(rows).slice(0, Math.min(want, rows.length));
  }

  /* Does a card matching {set, collector, lang, finish} exist anywhere, and
     if so is it recorded in the bin being checked? */
  function matchStackInBin(locationId, card) {
    const set = String(card.set || "").toLowerCase();
    const collector = String(card.collector || "");
    const lang = card.lang || "en";
    const finish = normalizeFinish(card.finish) || "nonfoil";
    const sameCard = r => String(r.set).toLowerCase() === set && String(r.collector) === collector &&
      (r.lang || "en") === lang && r.finish === finish;
    // Copies in a tote have left the shelf: finding one here isn't one of those.
    const totes = totesByStack();
    const inTote = r => (totes.get(r.id) || { qty: 0 }).qty;
    const here = state.cards.find(r => sameCard(r) && r.locationId === locationId && r.quantity - inTote(r) > 0);
    if (here) return { status: "match", locationId };
    const zeroHere = state.cards.find(r => sameCard(r) && r.locationId === locationId);
    if (zeroHere) return { status: "zero", inTote: inTote(zeroHere) };
    const elsewhere = state.cards.find(r => sameCard(r) && r.quantity > 0);
    if (elsewhere) return { status: "elsewhere", locationId: elsewhere.locationId };
    return { status: "missing" };
  }

  /* Commit a full recount of one bin. `rows` is
     [{recordId|null, set, collector, lang, finish, condition, countedQty}].
     A row with a recordId adjusts that existing stack (same clamp-cost-basis
     shape as the Manage dialog's quantity edit); a row with no recordId is a
     card found on the floor that was never in the book at all - resolved
     through the same lookupCard()+addCopies() pair Receive uses, since
     addCopies needs a live printing lookup (name/rarity/price/etc), not just
     the set+collector the person typed in.
     All-or-nothing: every lookup the count needs runs before any stack is
     touched, so a failed lookup throws (naming the card) with state.cards
     and the audit queue exactly as they were. */
  async function applyCycleCountAdjustments(locationId, rows) {
    const infos = new Map();
    for (const row of rows) {
      if (row.recordId || !(Math.max(0, parseInt(row.countedQty, 10) || 0) > 0)) continue;
      try {
        infos.set(row, await lookupCard(row.set, row.collector, row.lang, row.finish));
      } catch (e) {
        throw new Error("Couldn't look up " + String(row.set || "?").toUpperCase() + " #" + (row.collector || "?") +
          " (" + e.message + "). Nothing was changed.");
      }
    }
    let adjusted = 0, added = 0;
    const totes = totesByStack();
    for (const row of rows) {
      const counted = Math.max(0, parseInt(row.countedQty, 10) || 0);
      if (row.recordId) {
        const rec = state.cards.find(x => x.id === row.recordId);
        if (!rec) continue;
        const oldQty = rec.quantity;
        // The count is what's on the shelf; lent copies (#336) and copies in a tote are owned but not there.
        const newQty = bookFromShelf(rec, counted, totes);
        if (newQty === oldQty) continue;
        if (newQty < oldQty) removeCost(rec, oldQty - newQty);
        rec.quantity = newQty;
        if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
        logAudit({
          action: "edit", ...auditCard(rec), qty: newQty - oldQty, oldQty, newQty,
          note: "Cycle count adjustment"
        });
        adjusted++;
      } else if (counted > 0) {
        const info = infos.get(row);
        addCopies({
          set: row.set, num: row.collector, lang: row.lang, finish: row.finish, condition: row.condition,
          locationId, qty: counted, info,
          action: "add", note: "Found during cycle count, not previously recorded"
        });
        added++;
      }
    }
    state.cards = state.cards.filter(r => r.quantity > 0);
    normalizeMerge({ silent: true });
    const loc = locById(locationId);
    if (loc) { loc.lastCycleCountAt = new Date().toISOString(); loc.countWanted = null; }
    return { adjusted, added };
  }

  /* Sealed cycle counting - same "is this SKU here" concept as the card
     version above, but keyed on tcgplayerProductId instead of set/
     collector/lang/finish (sealed has no such tiers), and only the "full
     count of one bin" mode: sealed's much smaller SKU count per store
     makes sampling-based floor/book checks far less valuable than they are
     for a wall of card bins. Tracks its own lastSealedCycleCountAt on the
     location rather than sharing cards' lastCycleCountAt, so counting one
     kind of stock doesn't make a bin look freshly-checked for the other. */
  function sealedStacksInLocation(locationId) {
    return state.sealed.filter(r => r.locationId === locationId && r.quantity > 0);
  }

  function pickSealedCycleCountBin() {
    const wanted = oldestWanted(COUNT_FLAG.sealed);
    if (wanted) return wanted;
    const eligible = state.locations.filter(l => sealedStacksInLocation(l.id).length > 0);
    if (!eligible.length) return null;
    const sorted = eligible.slice().sort((a, b) => {
      const at = a.lastSealedCycleCountAt ? new Date(a.lastSealedCycleCountAt).getTime() : -Infinity;
      const bt = b.lastSealedCycleCountAt ? new Date(b.lastSealedCycleCountAt).getTime() : -Infinity;
      return at - bt;
    });
    const poolSize = Math.max(3, Math.ceil(sorted.length * 0.25));
    const pool = sorted.slice(0, Math.min(poolSize, sorted.length));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function matchSealedStackInBin(locationId, item) {
    const id = String(item.tcgplayerProductId || "");
    const here = state.sealed.find(r => r.tcgplayerProductId === id && r.locationId === locationId && r.quantity > 0);
    if (here) return { status: "match", locationId };
    const zeroHere = state.sealed.find(r => r.tcgplayerProductId === id && r.locationId === locationId);
    if (zeroHere) return { status: "zero" };
    const elsewhere = state.sealed.find(r => r.tcgplayerProductId === id && r.quantity > 0);
    if (elsewhere) return { status: "elsewhere", locationId: elsewhere.locationId };
    return { status: "missing" };
  }

  /* Commit a full recount of one bin's sealed stock. `rows` is
     [{recordId|null, tcgplayerProductId, manapoolProductId, name, setCode,
     price, countedQty}]. A row with a recordId adjusts that existing row;
     one with none is new-on-the-floor - added straight via
     addSealedCopies, no live lookup step needed the way the card version's
     lookupCard() call is, since the sealed-catalog search picker already
     carries full product info. */
  function applySealedCycleCountAdjustments(locationId, rows) {
    let adjusted = 0, added = 0;
    const totes = totesByStack();
    for (const row of rows) {
      const counted = Math.max(0, parseInt(row.countedQty, 10) || 0);
      if (row.recordId) {
        const rec = state.sealed.find(x => x.id === row.recordId);
        if (!rec) continue;
        const oldQty = rec.quantity;
        const newQty = bookFromShelf(rec, counted, totes);   // the shelf, plus what's in a tote
        if (newQty === oldQty) continue;
        if (newQty < oldQty) removeCost(rec, oldQty - newQty);
        rec.quantity = newQty;
        if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
        logAudit({
          action: "sealed-edit", name: rec.name, qty: newQty - oldQty, oldQty, newQty,
          note: "Cycle count adjustment"
        });
        adjusted++;
      } else if (counted > 0) {
        addSealedCopies({
          tcgplayerProductId: row.tcgplayerProductId, manapoolProductId: row.manapoolProductId,
          name: row.name, setCode: row.setCode, locationId, qty: counted, price: row.price,
          note: "Found during cycle count, not previously recorded"
        });
        added++;
      }
    }
    state.sealed = state.sealed.filter(r => r.quantity > 0);
    const loc = locById(locationId);
    if (loc) { loc.lastSealedCycleCountAt = new Date().toISOString(); loc.countWantedSealed = null; }
    return { adjusted, added };
  }

  /* ============================== Listing engine ============================== */
  /* A listing rule reuses the putaway rule engine's card-matching criteria
     (matchRule et al.) as-is — the only new idea here is the wrapper: a name,
     a priority, and a "keep" quantity, evaluated against inventory rows the
     same way a putaway location's rules are. */
  function normalizeListingRule(r) {
    const src = r || {};
    return {
      id: src.id || uid(),
      on: src.on !== false,
      name: String(src.name || "").trim(),
      priority: Number(src.priority) || 0,
      keep: Math.max(0, Math.floor(Number(src.keep) || 0)),
      criteria: normalizeCriteriaBox(src.criteria)
    };
  }
  const newListingRule = () => normalizeListingRule({});

  function matchesListingRule(record, rule) {
    return matchesCriteria(record, rule.criteria);   // no criteria = catch-all, same as a rules-less putaway location
  }

  /* Enabled listing rules in the order they compete: highest priority first,
     then by name. A plan sorts these once and hands them to ruleForRecord,
     instead of re-filtering and re-sorting the rule list for every stack
     (#99: a 70k-stack Evaluate did 70k sorts). */
  function activeListingRules() {
    return state.listingRules.filter(r => r.on)
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }

  /* Highest-priority enabled rule whose criteria all match; null if none do.
     `active` is an optional activeListingRules() list the caller built once. */
  function ruleForRecord(record, active) {
    return (active || activeListingRules()).find(r => matchesListingRule(record, r)) || null;
  }

  /* ---------- Per-name keep exceptions ----------
     A blunt, deliberately separate override sitting ABOVE the criteria rules
     above: "for this exact card name, always keep N, full stop" - no
     priority number to get shadowed by a catch-all rule (see "Too Many" vs.
     "From Sell Boxes" - a specific rule at a lower priority than a catch-all
     never actually runs), no criteria builder for the common case of "I
     just want to name the card." Matched on the plain card name, case-
     insensitive - not oracleId, since the whole point is typing a name you
     recognize into a box, and a name typo simply won't match anything
     rather than silently matching the wrong card. */
  function normalizeKeepException(r) {
    const src = r || {};
    return {
      id: src.id || uid(),
      name: String(src.name || "").trim(),
      keep: Math.max(0, Math.floor(Number(src.keep) || 0))
    };
  }
  const newKeepException = () => normalizeKeepException({});

  /* A watch-list entry is keyed to one exact printing+finish, same
     granularity as everything else price-related in this app (a foil and
     non-foil of the same card move differently, see movers()). Ownership-
     independent on purpose - watching is about price trend, not inventory. */
  function normalizeWatchItem(w) {
    const src = w || {};
    return {
      id: src.id || uid(),
      set: String(src.set || "").toLowerCase(),
      collector: String(src.collector || ""),
      lang: src.lang || "en",
      finish: normalizeFinish(src.finish) || (src.foil ? "foil" : "nonfoil"),
      name: src.name || "",
      setName: src.setName || "",
      oracleId: src.oracleId || "",
      note: src.note || "",
      addedAt: src.addedAt || new Date().toISOString(),
      // BACKLOG #79: an optional price to be told about - "below" for a buy
      // target, "above" for a sell/"it's finally worth it" watch. null = no
      // target, the watch list's plain pull-only behaviour.
      target: Number(src.target) > 0 ? Math.round(Number(src.target) * 100) / 100 : null,
      targetDir: src.targetDir === "above" ? "above" : "below"
    };
  }
  const watchKey = w => printKey(w.set, w.collector, w.lang) + "|" + (w.finish || "nonfoil");
  // Has this watch item's current price crossed its target? Shared by Buy
  // List's row badge and the Dashboard's "things to do" callout.
  function watchTargetHit(w, now) {
    if (!w || w.target == null || now == null) return false;
    return w.targetDir === "above" ? now >= w.target : now <= w.target;
  }

  /* ============================== Customers & wants (#50) ==============================
     Walk-in customers the seller keeps, each with "wants": a card name (any
     printing) or one exact printing (set / collector # / language / finish,
     the Watch List's identity fields), plus an optional note. When stock of
     a wanted card goes UP, a restock match records who wants it, what came
     in, when, and how many are available. It stays until the seller marks
     it told. The flow is drawn in docs/flows/wantlist-restock.dot.

     Four flat, id-keyed arrays in the collection document, not nested ones,
     so server/lib/merge.js merges concurrent edits per entity (one person
     adding a want while another marks a match told both survive):
       customers          {id, name, email, emailOk, emailOkAt, note, source,
                           buyerId, mpName, orderRefs[{id, by}], createdAt,
                           mergedAt}
       customerWants      {id, customerId, name, oracleId, set, collector,
                           lang, finish, setName, note, addedAt}
       restockMatches     {id, customerId, wantId, name, set, collector, lang,
                           finish, setName, available, added, firstAt, ts, toldAt}
       customerTombstones {id, buyerId, orderIds[], at} - a Manapool customer
                           the seller deleted, so an order sync never
                           recreates them. Holds no name or address.
       customerAliases    {id, keepId, buyerId, mpName, at} - a customer
                           merged into another (#196): id is the merged-away
                           customer's id, keepId the one kept. Its own
                           array, not a field on the kept customer, so two
                           merges into one customer at once both survive
                           server/lib/merge.js, and a tab still running an
                           older core.js can't strip it (store.js
                           carryForward). See "Merging customers" below.

     Personal data: name and email. Never logged to the audit trail, never
     in an export, never in a friend share (see stateObject()). Orders keep
     their shipping address server-side (store.js "Orders (Manapool)"); a
     customer made from orders holds only the buyer id, the recipient name
     and order ids, and the page resolves counts/totals from the orders
     cache at view time. */

  const wantNameKey = name => String(name || "").trim().toLowerCase().split(" // ")[0].trim();
  const wantPrintKey = (set, collector, lang, finish) =>
    [String(set || "").toLowerCase(), normNum(collector), lang || "en", normalizeFinish(finish) || "nonfoil"].join("|");
  const wantIsPrinting = w => !!(w && w.set && w.collector);
  function wantLabel(w) {
    if (!wantIsPrinting(w)) return "any printing";
    return printingLabel(w.set, w.collector, w.setName) +
      (w.lang && w.lang !== "en" ? " · " + (LANG_NAMES[w.lang] || w.lang) : "") +
      (w.finish && w.finish !== "nonfoil" ? " · " + (FINISH_NAMES[w.finish] || w.finish) : "");
  }

  const ORDER_REFS_MAX = 500;
  function normalizeCustomer(c) {
    const src = c || {};
    const email = String(src.email || "").trim().slice(0, 254);
    // Consent only means something attached to an address. Clearing the
    // email clears the tick, so #51's sender can trust emailOk on its own.
    const emailOk = !!(email && src.emailOk);
    const seen = new Set();
    const orderRefs = [];
    for (const r of (Array.isArray(src.orderRefs) ? src.orderRefs : [])) {
      const id = String((r && r.id) || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      orderRefs.push({ id, by: r.by === "name" ? "name" : "buyer" });
    }
    return {
      id: src.id || uid(),
      name: String(src.name || "").trim().slice(0, 200),
      email,
      emailOk,
      emailOkAt: emailOk ? (src.emailOkAt || new Date().toISOString()) : null,
      note: String(src.note || "").slice(0, 1000),
      source: src.source === "manapool" ? "manapool" : "manual",
      // Manapool's buyer_id - the dedupe key for customers made from orders.
      buyerId: String(src.buyerId || ""),
      // The recipient name as Manapool first gave it, kept apart from `name`
      // so the seller can rename the customer and the name fallback (orders
      // with no buyer id) still finds them.
      mpName: String(src.mpName || "").trim().slice(0, 200),
      orderRefs: orderRefs.slice(-ORDER_REFS_MAX),
      createdAt: src.createdAt || new Date().toISOString(),
      // When another customer was last merged into this one (#196). Set on
      // every merge, so the customer kept always counts as edited: without
      // it, merging a customer that brings nothing onto the kept record
      // (no orders, no note) leaves it byte-identical, and a second tab's
      // delete of it (or its opposite merge) would win in server/lib/merge.js.
      mergedAt: src.mergedAt || null
    };
  }
  function normalizeWant(w) {
    const src = w || {};
    const printing = !!(src.set && src.collector);
    return {
      id: src.id || uid(),
      customerId: String(src.customerId || ""),
      name: String(src.name || "").trim(),
      oracleId: src.oracleId || "",
      set: printing ? String(src.set).toLowerCase() : "",
      collector: printing ? String(src.collector) : "",
      lang: printing ? (src.lang || "en") : "",
      finish: printing ? (normalizeFinish(src.finish) || "nonfoil") : "",
      setName: printing ? (src.setName || "") : "",
      note: String(src.note || "").slice(0, 500),
      addedAt: src.addedAt || new Date().toISOString()
    };
  }
  function normalizeRestockMatch(m) {
    const src = m || {};
    const now = new Date().toISOString();
    return {
      id: src.id || uid(),
      customerId: String(src.customerId || ""),
      wantId: String(src.wantId || ""),
      name: src.name || "",
      set: src.set || "", collector: src.collector || "", lang: src.lang || "", finish: src.finish || "",
      setName: src.setName || "",
      // Unreserved copies of the wanted card at the moment it came in.
      available: Math.max(0, Number(src.available) || 0),
      // How many copies arrived across every increase folded into this match.
      added: Math.max(0, Number(src.added) || 0),
      firstAt: src.firstAt || src.ts || now,
      ts: src.ts || now,
      toldAt: src.toldAt || null
    };
  }
  function normalizeTombstone(t) {
    const src = t || {};
    const orderIds = (Array.isArray(src.orderIds) ? src.orderIds : []).map(String).filter(Boolean).slice(-ORDER_REFS_MAX);
    return { id: src.id || uid(), buyerId: String(src.buyerId || ""), orderIds, at: src.at || new Date().toISOString() };
  }
  // No id of its own: it is keyed on the merged-away customer's id, so two
  // tabs merging the same customer write the same entity.
  function normalizeAlias(a) {
    const src = a || {};
    return {
      id: String(src.id || ""),
      keepId: String(src.keepId || ""),
      buyerId: String(src.buyerId || ""),
      mpName: String(src.mpName || "").trim().slice(0, 200),
      at: src.at || new Date().toISOString()
    };
  }

  /* Unreserved copies per want: every stack's quantity minus what open pick
     lists have earmarked from it (pickAllocations - the same "reserved for
     an order" number the Inventory grid shows). A name want counts every
     printing, language, finish and condition of the card; a printing want
     counts that exact printing+finish in any condition. Pure: callers pass
     the cards and reservations. Returns Map wantId -> available. */
  function wantAvailability(wants, cards, reservedById) {
    const names = new Map(), prints = new Map();
    for (const w of wants) {
      if (wantIsPrinting(w)) prints.set(wantPrintKey(w.set, w.collector, w.lang, w.finish), 0);
      else names.set(wantNameKey(w.name), 0);
    }
    for (const r of cards) {
      const q = Math.max(0, availableQty(r) - ((reservedById && reservedById.get(r.id)) || 0));
      if (!q) continue;
      if (names.size) {
        const nk = wantNameKey(r.name);
        if (names.has(nk)) names.set(nk, names.get(nk) + q);
      }
      if (prints.size) {
        const pk = wantPrintKey(r.set, r.collector, r.lang, r.finish);
        if (prints.has(pk)) prints.set(pk, prints.get(pk) + q);
      }
    }
    const out = new Map();
    for (const w of wants) {
      out.set(w.id, wantIsPrinting(w)
        ? prints.get(wantPrintKey(w.set, w.collector, w.lang, w.finish)) || 0
        : names.get(wantNameKey(w.name)) || 0);
    }
    return out;
  }

  /* THE matcher. Every quantity increase is judged here and nowhere else.
     Pure: before/after are Map wantId -> available (wantAvailability()).
       - Only a rise counts (after > before). A drop or no change never does.
       - A want missing from `before` was added after the last check, so it
         has no "before" to rise from: a want added while the card is
         already in stock does NOT create a match. The Customers page shows
         the live "N in stock now" next to every want instead.
       - While the want already has an untold match, a further rise updates
         that match (newest time, available now, copies added) rather than
         stacking a second one, so receiving a playset one scan at a time
         reads as one "came in". Once marked told, the next rise creates a
         fresh match.
     Returns {created: [match], updated: [{id, available, added, ts}]}. */
  function restockMatcher(before, after, wants, matches, now) {
    const created = [], updated = [];
    if (!before) return { created, updated };
    for (const w of wants) {
      if (!before.has(w.id)) continue;
      const b = before.get(w.id) || 0, a = (after && after.get(w.id)) || 0;
      if (a <= b) continue;
      const open = matches.find(m => m.wantId === w.id && !m.toldAt);
      if (open) {
        updated.push({ id: open.id, available: a, added: (Number(open.added) || 0) + (a - b), ts: now });
      } else {
        created.push(normalizeRestockMatch({
          customerId: w.customerId, wantId: w.id, name: w.name,
          set: w.set, collector: w.collector, lang: w.lang, finish: w.finish, setName: w.setName,
          available: a, added: a - b, firstAt: now, ts: now
        }));
      }
    }
    return { created, updated };
  }

  // Reservations, but only for pick-list lines that could touch a wanted
  // card (null when nothing is open - the common case costs nothing).
  function restockReservations(wants) {
    const open = pickLists().some(p => p.status === "open" && p.lines.length);
    if (!open) return null;
    const names = new Set(wants.map(w => wantNameKey(w.name)));
    return pickAllocations(it => it.kind !== "sealed" && names.has(wantNameKey(it.name)));
  }
  function currentWantAvailability(wants) {
    const list = wants || state.customerWants;
    if (!list.length) return new Map();
    return wantAvailability(list, state.cards, restockReservations(list));
  }
  function wantAvailableNow(want) { return currentWantAvailability([want]).get(want.id) || 0; }

  let restockBaseline = null;   // Map wantId -> available at the last check
  function resetRestockBaseline() { restockBaseline = currentWantAvailability(); }
  function checkRestocks(opts) {
    const after = currentWantAvailability();
    const noMatch = opts && opts.match === false;
    const { created, updated } = restockMatcher(noMatch ? null : restockBaseline, after, state.customerWants,
      state.restockMatches, new Date().toISOString());
    for (const u of updated) {
      const m = state.restockMatches.find(x => x.id === u.id);
      if (m) Object.assign(m, u);
    }
    if (created.length) state.restockMatches.unshift(...created);
    restockBaseline = after;
    return { created: created.length, updated: updated.length };
  }

  /* ---------- Edits (the page calls G.persist() after each) ---------- */
  function addCustomer(fields) {
    const c = normalizeCustomer(Object.assign({}, fields, { id: undefined, source: "manual" }));
    state.customers.push(c);
    return c;
  }
  function updateCustomer(id, fields) {
    const c = state.customers.find(x => x.id === id);
    if (!c) return null;
    const f = fields || {};
    const wasOk = c.emailOk;
    const next = normalizeCustomer(Object.assign({}, c, {
      name: f.name != null ? f.name : c.name,
      email: f.email != null ? f.email : c.email,
      emailOk: f.emailOk != null ? !!f.emailOk : c.emailOk,
      note: f.note != null ? f.note : c.note,
      // A fresh tick is a fresh consent, so it gets a fresh timestamp. So
      // does a changed address: the consent recorded was for the old one.
      emailOkAt: wasOk && (f.email == null || String(f.email).trim() === c.email) ? c.emailOkAt : null
    }));
    Object.assign(c, next);
    return c;
  }
  // Removes the customer, their wants and their matches. A customer made
  // from Manapool orders leaves a tombstone (buyer id + order ids, no name)
  // so the next order sync doesn't bring them back. Customers merged into
  // this one (#196) go with it: each of their buyer ids gets a tombstone
  // too, or their next order would bring them back as a new customer.
  function deleteCustomer(id) {
    const c = state.customers.find(x => x.id === id);
    if (!c) return false;
    const { keeperOf } = aliasIndex();
    const merged = state.customerAliases.filter(a => keeperOf(a.id) === c);
    if (c.source === "manapool" || c.buyerId || c.orderRefs.length) {
      state.customerTombstones.push(normalizeTombstone({ buyerId: c.buyerId, orderIds: c.orderRefs.map(r => r.id) }));
    }
    for (const a of merged) {
      if (a.buyerId && a.buyerId !== c.buyerId) state.customerTombstones.push(normalizeTombstone({ buyerId: a.buyerId }));
    }
    if (merged.length) state.customerAliases = state.customerAliases.filter(a => !merged.includes(a));
    state.customers = state.customers.filter(x => x.id !== id);
    state.customerWants = state.customerWants.filter(w => w.customerId !== id);
    state.restockMatches = state.restockMatches.filter(m => m.customerId !== id);
    return true;
  }
  function addWant(customerId, fields) {
    if (!state.customers.some(c => c.id === customerId)) return null;
    const w = normalizeWant(Object.assign({}, fields, { id: undefined, customerId }));
    if (!w.name) return null;
    state.customerWants.push(w);
    return w;
  }
  function deleteWant(id) {
    const before = state.customerWants.length;
    state.customerWants = state.customerWants.filter(w => w.id !== id);
    state.restockMatches = state.restockMatches.filter(m => m.wantId !== id);
    return state.customerWants.length !== before;
  }
  // Told matches are kept as a short "told recently" history, capped so the
  // document can't grow without bound.
  const TOLD_KEEP = 200;
  function markRestockTold(id) {
    const m = state.restockMatches.find(x => x.id === id);
    if (!m || m.toldAt) return false;
    m.toldAt = new Date().toISOString();
    const told = state.restockMatches.filter(x => x.toldAt)
      .sort((a, b) => String(b.toldAt).localeCompare(String(a.toldAt)));
    if (told.length > TOLD_KEEP) {
      const drop = new Set(told.slice(TOLD_KEEP).map(x => x.id));
      state.restockMatches = state.restockMatches.filter(x => !drop.has(x.id));
    }
    return true;
  }
  const untoldRestocks = () => state.restockMatches.filter(m => !m.toldAt);
  const customersWithUntold = () => new Set(untoldRestocks().map(m => m.customerId)).size;

  /* ---------- Customers from Manapool orders ----------
     Every order's buyer becomes a customer, deduped by Manapool's buyer_id.
     An order with a recipient name but no buyer id is matched by that name
     against customers that came from orders. That link is weaker (two
     buyers can share a name), is recorded per order (`by: "name"`) and
     the page says so. An order with neither is a list-endpoint summary
     whose detail was never fetched (about a third of a real cache): it is
     skipped here, and the Customers page offers to fetch those details
     (ordersNeedingDetail()).
     Ids are deterministic - "mp-" + buyer id, or "mpn-" + the name key -
     so two tabs that both create the same buyer produce the same entity
     and server/lib/merge.js folds them into one instead of keeping two.
     Only the buyer id, the recipient name and the order id are copied. The
     shipping address never leaves the orders store.
     Seller edits win: an existing customer's name, email, consent and note
     are never touched here; a sync only creates customers and links new
     order ids. A deleted customer stays deleted (customerTombstones), but
     a tombstone never blocks a buyer who still has a live customer.
     A buyer merged into another customer (#196, customerAliases) is linked
     to the customer kept, never recreated: by buyer id ahead of any
     customer of their own (one that came back in a two-tab race, which
     tidyCustomers folds in anyway), and by their Manapool name after the
     live customers' own names.
     Returns {created, linked}. */
  const mpCustomerId = (bid, name) => bid ? "mp-" + bid : "mpn-" + wantNameKey(name);
  const orderBuyerId = o => String((o && (o.buyerId || (o.raw && (o.raw.buyer_id || o.raw.buyerId)))) || "");
  function syncCustomersFromOrders(orders) {
    let created = 0, linked = 0;
    const list = (Array.isArray(orders) ? orders : []).filter(o => o && o.id)
      .slice().sort((a, b) => String(a.placedAt || "").localeCompare(String(b.placedAt || "")));
    if (!list.length) return { created, linked };
    const byBuyer = new Map(), byName = new Map(), linkedIds = new Set();
    const index = c => {
      if (c.buyerId && !byBuyer.has(c.buyerId)) byBuyer.set(c.buyerId, c);
      const nk = wantNameKey(c.mpName);
      if (c.source === "manapool" && nk && !byName.has(nk)) byName.set(nk, c);
      for (const r of c.orderRefs) linkedIds.add(r.id);
    };
    const { keeperOf } = aliasIndex();
    for (const a of state.customerAliases) {
      const k = a.buyerId && keeperOf(a.id);
      if (k && !byBuyer.has(a.buyerId)) byBuyer.set(a.buyerId, k);
    }
    state.customers.forEach(index);
    for (const a of state.customerAliases) {
      const nk = wantNameKey(a.mpName), k = nk && keeperOf(a.id);
      if (k && !byName.has(nk)) byName.set(nk, k);
    }
    const goneBuyers = new Set(state.customerTombstones.map(t => t.buyerId).filter(Boolean));
    const goneOrders = new Set(state.customerTombstones.flatMap(t => t.orderIds));
    for (const o of list) {
      const oid = String(o.id);
      if (linkedIds.has(oid)) continue;
      const bid = orderBuyerId(o);
      const name = String(o.buyer || (o.ship && o.ship.name) || "").trim();
      let c = bid ? byBuyer.get(bid) : byName.get(wantNameKey(name));
      if (!c) {
        if (!bid && !name) continue;   // a summary-only order: nothing to identify them by
        // Deleted by the seller and not re-added since: stay deleted.
        if (goneOrders.has(oid) || (bid && goneBuyers.has(bid))) continue;
        c = normalizeCustomer({ id: mpCustomerId(bid, name), name: name || "Manapool buyer",
          source: "manapool", buyerId: bid, mpName: name });
        state.customers.push(c);
        index(c);
        created++;
      }
      c.orderRefs.push({ id: oid, by: bid ? "buyer" : "name" });
      if (c.orderRefs.length > ORDER_REFS_MAX) c.orderRefs.splice(0, c.orderRefs.length - ORDER_REFS_MAX);
      linkedIds.add(oid);
      linked++;
    }
    return { created, linked };
  }

  // Cached orders no customer can be made from yet: summary rows with no
  // buyer id and no recipient name. Fetching each one's detail fills both in.
  function ordersNeedingDetail(orders) {
    const linked = new Set(state.customers.flatMap(c => c.orderRefs.map(r => r.id)));
    return (Array.isArray(orders) ? orders : []).filter(o => o && o.id && !linked.has(String(o.id)) &&
      !orderBuyerId(o) && !String(o.buyer || (o.ship && o.ship.name) || "").trim());
  }

  /* Run on every adopt (load, merged save, undo/redo). Three repairs:
     - Manapool customers whose id isn't the deterministic "mp-" + buyer id
       (made before ids were fixed, or duplicated by a two-tab race) are
       folded into one customer per buyer id. The kept one is the existing
       "mp-" one, else the oldest; order refs are unioned; wants and matches
       follow it.
     - A customer merged into another (#196) that came back is folded into
       the customer kept again, and a want or match still naming a merged-
       away customer moves to the one kept (tidyMerged, "Merging customers").
     - Wants whose customer is gone (deleted in one tab while another added
       a want) and matches whose customer or want is gone are dropped, so
       nothing keeps producing "came in" rows for nobody.
     Returns true when anything changed. */
  function tidyCustomers() {
    let changed = false;
    const groups = new Map();
    for (const c of state.customers) {
      if (c.source !== "manapool" || !c.buyerId) continue;
      if (!groups.has(c.buyerId)) groups.set(c.buyerId, []);
      groups.get(c.buyerId).push(c);
    }
    const remap = new Map(), drop = new Set();
    for (const [bid, list] of groups) {
      const want = "mp-" + bid;
      if (list.length === 1 && list[0].id === want) continue;
      const keep = list.find(c => c.id === want) ||
        list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      for (const c of list) {
        if (c === keep) continue;
        for (const r of c.orderRefs) if (!keep.orderRefs.some(x => x.id === r.id)) keep.orderRefs.push(r);
        remap.set(c.id, want);
        drop.add(c);
      }
      if (keep.id !== want) { remap.set(keep.id, want); keep.id = want; }
      if (keep.orderRefs.length > ORDER_REFS_MAX) keep.orderRefs.splice(0, keep.orderRefs.length - ORDER_REFS_MAX);
      changed = true;
    }
    if (drop.size) state.customers = state.customers.filter(c => !drop.has(c));
    if (remap.size) {
      for (const w of state.customerWants) if (remap.has(w.customerId)) w.customerId = remap.get(w.customerId);
      for (const m of state.restockMatches) if (remap.has(m.customerId)) m.customerId = remap.get(m.customerId);
      for (const a of state.customerAliases) if (remap.has(a.keepId)) a.keepId = remap.get(a.keepId);
    }
    if (tidyMerged()) changed = true;
    const ids = new Set(state.customers.map(c => c.id));
    const nW = state.customerWants.length, nM = state.restockMatches.length;
    state.customerWants = state.customerWants.filter(w => ids.has(w.customerId));
    const wantOf = new Map(state.customerWants.map(w => [w.id, w]));
    state.restockMatches = state.restockMatches.filter(m => ids.has(m.customerId) && wantOf.has(m.wantId));
    // A match belongs to its want's customer. Two tabs that moved one want
    // and its match to different customers (#201: one customer merged into
    // two at once) can leave a match naming the other one.
    for (const m of state.restockMatches) {
      const w = wantOf.get(m.wantId);
      if (m.customerId !== w.customerId) { m.customerId = w.customerId; changed = true; }
    }
    return changed || nW !== state.customerWants.length || nM !== state.restockMatches.length;
  }

  /* ---------- Merging customers (#196) ----------
     One person with two customers (two Manapool accounts, or a walk-in
     who also orders online) is combined with "Merge into…". The customer
     kept keeps its own name and email (taking the other's only where its
     own is empty; email consent only comes with the address it was given
     for), gains the other's order links, wants (identical ones folded
     into one) and "came in" matches, and the other's note is appended.
     The other customer is removed, and a customerAliases entry, keyed on
     its id, remembers its buyer id and Manapool name and which customer
     it went into, so:
       - an order sync links that buyer's new orders to the customer kept
         and never recreates them (a tombstone would do the opposite: drop
         those orders);
       - a two-tab race can't undo the merge. Another tab that hadn't seen
         it may link a new order to, edit, or add a want to the merged-
         away customer; server/lib/merge.js keeps an edit over a delete, so
         that customer comes back, and a new want still names it.
         tidyCustomers (every adopt) folds the customer back into the one
         kept and moves the want, instead of keeping two or dropping the
         want as an orphan.
     An alias can name a customer that was itself merged later (A into B,
     then B into C); aliasIndex follows the chain to a live customer.
     Deleting the customer kept deletes the merged ones with it (see
     deleteCustomer). Nothing here is written to the audit log: the page's
     undo label is generic, like every other customer edit. */

  /* keeperOf(id): the live customer a merged-away customer id now lives
     in, or null. Follows a chain of aliases; `dropped` (customers being
     folded away right now) are skipped over; a loop (A into B in one tab,
     B into A in another) resolves to the first live customer reached. */
  function aliasIndex(dropped) {
    const live = new Map(state.customers.map(c => [c.id, c]));
    const byId = new Map(state.customerAliases.map(a => [a.id, a]));
    const keeperOf = id => {
      const seen = new Set([id]);
      let cur = id;
      for (;;) {
        const a = byId.get(cur);
        if (!a) return null;
        cur = a.keepId;
        const c = live.get(cur);
        if (c && !(dropped && dropped.has(c))) return c;
        if (seen.has(cur)) return null;
        seen.add(cur);
      }
    };
    return { live, byId, keeperOf };
  }

  // Two wants are the same want when they'd match the same stock: the
  // card name, and the exact printing+finish for a printing want.
  const wantIdentity = w => wantNameKey(w.name) + "|" +
    (wantIsPrinting(w) ? wantPrintKey(w.set, w.collector, w.lang, w.finish) : "any");

  /* `gone`'s fields into `keep` (not wants, not the alias). Always an
     edit to `keep` (mergedAt, stamped `at` or now), whatever `gone`
     brings. */
  function foldCustomerFields(keep, gone, at) {
    keep.mergedAt = at || new Date().toISOString();
    const seen = new Set(keep.orderRefs.map(r => r.id));
    for (const r of gone.orderRefs) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      keep.orderRefs.push({ id: r.id, by: r.by });
    }
    if (keep.orderRefs.length > ORDER_REFS_MAX) keep.orderRefs.splice(0, keep.orderRefs.length - ORDER_REFS_MAX);
    if (!keep.name && gone.name) keep.name = gone.name;
    if (!keep.email && gone.email) {
      keep.email = gone.email;
      keep.emailOk = !!gone.emailOk;
      keep.emailOkAt = gone.emailOk ? gone.emailOkAt : null;
    }
    const extra = String(gone.note || "").trim();
    if (extra && !keep.note.includes(extra)) {
      keep.note = (keep.note.trim() ? keep.note.trim() + " · " + extra : extra).slice(0, 1000);
    }
  }

  /* Records that `gone` now lives in `keep`. Anything merged into `gone`
     before moves along with it, and `keep`, being live, is no alias. */
  function recordAlias(keep, gone) {
    for (const a of state.customerAliases) if (a.keepId === gone.id) a.keepId = keep.id;
    const was = state.customerAliases.find(a => a.id === gone.id);
    if (!was) {
      state.customerAliases.push(normalizeAlias({ id: gone.id, keepId: keep.id, buyerId: gone.buyerId, mpName: gone.mpName }));
    } else if (was.keepId !== keep.id || (gone.buyerId && was.buyerId !== gone.buyerId) ||
        (gone.mpName && was.mpName !== gone.mpName)) {
      Object.assign(was, { keepId: keep.id, buyerId: gone.buyerId || was.buyerId, mpName: gone.mpName || was.mpName });
    }
    state.customerAliases = state.customerAliases.filter(a => a.id !== keep.id);
  }

  /* Folds a customer's identical wants into one: the customer's own (the
     first not in `moved`, the ids just moved onto it; else the first)
     keeps its place, takes another's note if it has none, and inherits
     their matches. Keeping its own matters in a two-tab race (#201): when
     one customer is merged into two others at once, each tab moves that
     customer's wants differently, and folding the kept customer's own
     want away could lose it in server/lib/merge.js. An untold "came in"
     on a want folded away is dropped when the want kept already has one
     waiting (not two rows for one card). */
  function dedupeWants(customerId, moved) {
    const groups = new Map(), gone = new Map();
    for (const w of state.customerWants) {
      if (w.customerId !== customerId) continue;
      const k = wantIdentity(w);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const s = list.find(w => !(moved && moved.has(w.id))) || list[0];
      for (const w of list) {
        if (w === s) continue;
        if (!s.note && w.note) s.note = w.note;
        gone.set(w.id, s);
      }
    }
    if (!gone.size) return;
    state.customerWants = state.customerWants.filter(w => !gone.has(w.id));
    const open = new Set(state.restockMatches.filter(m => !m.toldAt && !gone.has(m.wantId)).map(m => m.wantId));
    state.restockMatches = state.restockMatches.filter(m => {
      const s = gone.get(m.wantId);
      if (!s) return true;
      if (!m.toldAt && open.has(s.id)) return false;
      m.wantId = s.id;
      if (!m.toldAt) open.add(s.id);
      return true;
    });
  }

  // Moves wants and matches from the customer ids in `to` (Map old id ->
  // new id), then folds duplicates on each customer that gained some.
  function repointWants(to) {
    const touched = new Set(), moved = new Set();
    for (const w of state.customerWants) {
      if (!to.has(w.customerId)) continue;
      w.customerId = to.get(w.customerId);
      touched.add(w.customerId);
      moved.add(w.id);
    }
    for (const m of state.restockMatches) {
      if (!to.has(m.customerId)) continue;
      m.customerId = to.get(m.customerId);
      touched.add(m.customerId);
    }
    for (const id of touched) dedupeWants(id, moved);
    return touched.size > 0;
  }

  /* Merge customer `goneId` into `keepId` (the page calls G.persist()).
     Returns the customer kept, or null when either is missing or they're
     the same customer. */
  function mergeCustomers(goneId, keepId) {
    const gone = state.customers.find(c => c.id === goneId);
    const keep = state.customers.find(c => c.id === keepId);
    if (!gone || !keep || gone === keep) return null;
    foldCustomerFields(keep, gone);
    recordAlias(keep, gone);
    state.customers = state.customers.filter(c => c !== gone);
    repointWants(new Map([[gone.id, keep.id]]));
    return keep;
  }

  /* tidyCustomers' #196 step: merged-away customers that came back are
     folded into the one kept; wants/matches naming a merged-away id move
     to it; an alias naming a live customer (merged both ways in two tabs:
     the first live one reached keeps everything) or leading nowhere (the
     customer kept was deleted) is dropped. Returns true when anything
     changed. */
  function tidyMerged() {
    if (!state.customerAliases.length) return false;
    let changed = false;
    const dropped = new Set();
    const { byId, keeperOf } = aliasIndex(dropped);
    const byBuyer = new Map();
    for (const a of state.customerAliases) if (a.buyerId && !byBuyer.has(a.buyerId)) byBuyer.set(a.buyerId, a);
    for (const c of state.customers) {
      if (dropped.has(c)) continue;
      // By id; or by buyer id, for a Manapool customer that came back
      // under another id than the one merged away.
      let a = byId.get(c.id);
      if (!a && c.source === "manapool" && c.buyerId) a = byBuyer.get(c.buyerId);
      if (!a) continue;
      const k = keeperOf(a.id);
      if (!k || k === c) continue;
      foldCustomerFields(k, c, foldStamp(k, a));
      recordAlias(k, c);
      dropped.add(c);
      changed = true;
    }
    if (dropped.size) state.customers = state.customers.filter(c => !dropped.has(c));
    // Resolved against the customers and aliases as they are now, after
    // every fold: one pass can fold X into Y and then Y into Z, and X's
    // wants must reach Z, not the Y that has just gone.
    const now = aliasIndex();
    const to = new Map();
    for (const x of state.customerWants.concat(state.restockMatches)) {
      if (to.has(x.customerId) || now.live.has(x.customerId)) continue;
      const k = now.keeperOf(x.customerId);
      if (k) to.set(x.customerId, k.id);
    }
    if (to.size && repointWants(to)) changed = true;
    const n = state.customerAliases.length;
    state.customerAliases = state.customerAliases.filter(a => !now.live.has(a.id) && now.keeperOf(a.id));
    if (dedupeOrderRefs(now)) changed = true;
    return changed || n !== state.customerAliases.length;
  }

  /* A tidy fold's mergedAt (#201). Two tabs that adopt the same race
     result both fold the same customer back; stamped with each tab's own
     clock, their next saves disagreed on mergedAt and the second saw a
     conflict warning naming it. This depends only on the document, so
     both tabs stamp the same value: the alias's time, or 1 ms after the
     kept customer's last stamp when that is later, so the fold still
     always edits the customer kept (see normalizeCustomer). */
  function foldStamp(keep, alias) {
    const prev = Date.parse(keep.mergedAt || "") || 0, at = Date.parse(alias.at || "") || 0;
    return new Date(Math.max(at, prev + 1)).toISOString();
  }

  /* One order on two live customers (#201: one customer merged into two
     others in two tabs at once, each kept customer taking its orders)
     counts twice in Lifetime spend. It stays on the customer whose newest
     alias is latest: the race's alias, which server/lib/merge.js settled
     on one of the two, and which routes that buyer's next orders there
     too. Ties go to the lower id, so every tab picks the same customer.
     `idx` is tidyMerged's aliasIndex after its folds. */
  function dedupeOrderRefs(idx) {
    const owner = new Map(), shared = new Map();
    for (const c of state.customers) {
      for (const r of c.orderRefs) {
        const o = owner.get(r.id);
        if (!o) { owner.set(r.id, c); continue; }
        if (o === c) continue;
        const list = shared.get(r.id) || [o];
        if (!list.includes(c)) list.push(c);
        shared.set(r.id, list);
      }
    }
    if (!shared.size) return false;
    const newest = new Map();
    for (const a of state.customerAliases) {
      const k = idx.keeperOf(a.id);
      if (k && String(a.at) > (newest.get(k.id) || "")) newest.set(k.id, String(a.at));
    }
    const rank = c => newest.get(c.id) || "";
    const drop = new Map();
    for (const [id, list] of shared) {
      const win = list.reduce((w, c) => rank(c) > rank(w) || (rank(c) === rank(w) && c.id < w.id) ? c : w);
      for (const c of list) {
        if (c === win) continue;
        if (!drop.has(c)) drop.set(c, new Set());
        drop.get(c).add(id);
      }
    }
    for (const [c, ids] of drop) c.orderRefs = c.orderRefs.filter(r => !ids.has(r.id));
    return true;
  }

  /* Has this order still to go out? (#62) A denylist of finished states
     rather than an allowlist of open ones: Manapool's latest_fulfillment_status
     reads unfulfilled / processing while it's waiting, and the cache defaults
     a missing status to "unfulfilled", so a blank one counts as open too. */
  const ORDER_DONE_STATUSES = new Set(["shipped", "delivered", "replaced", "cancelled", "canceled",
    "refunded", "completed", "complete", "fulfilled", "returned", "closed"]);
  function orderIsOpen(status) {
    const s = String(status == null ? "" : status).trim().toLowerCase().replace(/[\s-]+/g, "_");
    return !ORDER_DONE_STATUSES.has(s);
  }

  /* The orders cache keyed by id, for a caller resolving many customers at
     once (the Customers table) so each one doesn't rebuild it. */
  function ordersById(orders) {
    return new Map((Array.isArray(orders) ? orders : []).filter(o => o && o.id).map(o => [String(o.id), o]));
  }

  /* Refunds recorded on Returns, summed per order id (#195). A return tied
     to a fetched order carries its real orderId; one typed by hand has only
     the free-text orderLabel, which counts when it is exactly a cached
     order's label. A return with no refund amount adds nothing. returns
     defaults to state.returns; orders is the cache array or ordersById()
     of it (only needed for the label match). */
  function refundsByOrder(returns, orders) {
    const byId = orders && !Array.isArray(orders) && typeof orders.get === "function" ? orders : ordersById(orders);
    const byLabel = new Map();
    for (const [id, o] of byId) if (o && o.label) byLabel.set(String(o.label).trim(), id);
    const out = new Map();
    for (const r of Array.isArray(returns) ? returns : state.returns) {
      const amt = r && r.refundTotal != null ? Number(r.refundTotal) : 0;
      if (!(amt > 0)) continue;
      const id = r.orderId ? String(r.orderId) : byLabel.get(String(r.orderLabel || "").trim());
      if (!id) continue;
      out.set(id, round2((out.get(id) || 0) + amt));
    }
    return out;
  }

  /* A customer's order history, resolved against the orders cache at view
     time (the customer only stores order ids). count is every linked order;
     total, refunds, spend, open and list cover the ones still in the cache
     (it keeps the newest 500), newest first. open = cached orders still to
     go out (orderIsOpen). weak = linked by recipient name, not buyer id.
     orders is the cache array, or ordersById() of it.

     Lifetime spend (#195, owner's call): what they paid including shipping
     (the order total), minus refunds on Returns linked to those orders.
     total = paid, refunds = refunded, spend = total - refunds; all three
     only over cached orders, so a refund is never taken off an order whose
     total isn't counted. refunds is optional: a refundsByOrder() Map built
     once by a caller resolving many customers, or a returns array; it
     defaults to state.returns.

     An order Manapool itself marks refunded (orderRefundedOnManapool) counts
     $0 even with no Return logged (owner's call, PR #199 rework): its whole
     total is its refund, and any Return refund on it is not taken off a
     second time. mpRefunded on a list entry marks it; mpRefunded on the
     result counts them.

     Everything here goes through customer.orderRefs, never a buyer id, so a
     customer holding several buyers' orders (#196, merging customers) adds
     up the same way. */
  function customerOrders(customer, orders, refunds) {
    const byId = orders && !Array.isArray(orders) && typeof orders.get === "function" ? orders : ordersById(orders);
    const refundOf = refunds && !Array.isArray(refunds) && typeof refunds.get === "function"
      ? refunds : refundsByOrder(refunds, byId);
    const list = [];
    const seen = new Set();
    for (const r of (customer && customer.orderRefs) || []) {
      const o = byId.get(r.id);
      if (!o || seen.has(r.id)) continue;
      seen.add(r.id);
      const total = o.total == null ? null : Number(o.total) || 0;
      const mpRefunded = orderRefundedOnManapool(o);
      list.push({ id: r.id, label: o.label || "", placedAt: o.placedAt || "", status: o.status || "",
        total, refund: mpRefunded ? (total || 0) : (refundOf.get(r.id) || 0), mpRefunded, weak: r.by === "name" });
    }
    list.sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)));
    const total = round2(list.reduce((t, o) => t + (o.total || 0), 0));
    const refunded = round2(list.reduce((t, o) => t + o.refund, 0));
    return {
      count: ((customer && customer.orderRefs) || []).length,
      total,
      refunds: refunded,
      spend: round2(total - refunded),
      mpRefunded: list.filter(o => o.mpRefunded).length,
      open: list.filter(o => orderIsOpen(o.status)).length,
      list
    };
  }

  /* Has Manapool refunded this order? Its fulfillment status says so
     ("refunded", Manapool's own status, normalised into status by
     integrations.normalizeOrder); the raw payload is checked too in case an
     older cache entry's status predates that. */
  function orderRefundedOnManapool(o) {
    if (!o) return false;
    const norm = s => String(s == null ? "" : s).trim().toLowerCase();
    return norm(o.status) === "refunded" || norm(o.raw && o.raw.latest_fulfillment_status) === "refunded";
  }

  /* `byName` is an optional keepExceptionIndex() built once by a caller that
     looks up many stacks. */
  function keepExceptionFor(record, byName) {
    const key = nameKey(record);
    if (!key) return null;
    if (byName) return byName.get(key) || null;
    return state.listingKeepExceptions.find(x => x.name.trim().toLowerCase() === key) || null;
  }
  // Name -> exception. The first one wins, the same one find() above returns.
  function keepExceptionIndex() {
    const byName = new Map();
    for (const x of state.listingKeepExceptions) {
      const key = x.name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, x);
    }
    return byName;
  }

  /* The account's minimum profit, % of cost (#390): the one number Delist
     unprofitable, the "Never list below my minimum profit" switch and Bulk
     Price's takedowns all use. The rules (a stored value wins, else 0% with
     the switch on, else 25%) live in the shared engine, so the scheduled run
     can't disagree. */
  function minProfitPct() { return window.RuleEngine.minProfitPct(state.settings); }
  // The rule in words, true at any minimum: at 0% it is "at or below cost"
  // (break-even included), not "under 0%".
  function minProfitWords(minPct) {
    const m = minPct == null ? minProfitPct() : minPct;
    return m > 0 ? "under your minimum profit of " + m + "% of cost" : "at or below what you paid";
  }

  /* Unprofitable (#377, #390): the price misses the minimum profit over the
     stack's average cost per copy (`minPct`, default the account's
     minProfitPct()). Reuses the Profit vs cost maths (RuleEngine.profitInfo).
     A stack with no cost entered, or no price, is never unprofitable.
     costQty/costTotal can be passed already summed over several stacks. */
  const BELOW_COST_RULE = { id: "below-cost", name: "Below minimum profit" };
  function belowCost(card, price, minPct) {
    if (!card || !(Number(price) > 0)) return false;
    const info = window.RuleEngine.profitInfo({ costQty: card.costQty, costTotal: card.costTotal,
      avgCost: card.avgCost, price: Number(price) }, { profitPrice: "market" });
    return window.RuleEngine.underMinProfit(info, minPct == null ? minProfitPct() : minPct);
  }

  /* `ctx` is optional: { active: activeListingRules(), exceptions:
     keepExceptionIndex() }, built once per plan so a 70k-stack run doesn't
     redo them for every stack. Without it, both are worked out fresh. */
  function listingTarget(record, ctx) {
    const exception = keepExceptionFor(record, ctx && ctx.exceptions);
    if (exception) return { keep: exception.keep, rule: { id: "exception:" + exception.id, name: 'Name exception "' + exception.name + '"' } };
    const rule = ruleForRecord(record, ctx && ctx.active);
    const keep = rule ? rule.keep : (state.settings.listingDefaultKeep || 0);
    return { keep, rule };
  }

  /* "How many copies of each stack should be listed for sale right now?" -
     same evaluate-a-plan shape as putawayPlan: every row gets a target, and
     the caller decides what to tick and apply.

     "keep" applies once per card NAME across every stack that shares a rule
     (or the default), not once per individual stack in isolation - and it
     keeps the CHEAPEST copies off the market and lists the dearest (owner's
     call, #90). A card split across three $0.10 stacks and one $8 stack,
     with keep=2, keeps two of the $0.10 copies and lists the third $0.10
     copy and the $8 one - the same cheapest-first, running-quantity logic
     as a manual "keep the 2 cheapest copies" SQL query against the
     collection. (Looking at each stack alone used to see "quantity <= keep"
     everywhere and list nothing, however many copies there were in total.)
     Unpriced stacks are kept FIRST, before any priced copy: there's no way
     to tell they're worth selling, and Manapool refuses to create a listing
     with no price anyway. Only copies beyond keep get listed from them.

     Copies reserved for a Manapool order not picked yet (#86, #107: its
     open pick list, or a fetched order with none yet; manapoolReservations)
     are already sold: they're left out of the pool
     entirely, so they neither count toward keep nor get a target.
     `have` is still the whole stack; `available` is what's free to list.

     opts.ruleId scopes the whole run to one specific rule instead of letting
     every enabled rule compete by priority - only stacks that rule's own
     criteria actually match are included (no fallback to the default keep for
     stacks it does not claim), and the rule applies even if its own on/off
     toggle is off, since picking it here is itself the deliberate override.

     Copies in a location with "Sell from this location" off are never listed
     (#194): their target is always 0, so copies listed there now are planned
     down. They still count toward keep, and rank as the kept copies FIRST,
     before any sellable copy (owner's call: keep 1, one copy in a personal
     binder and two in a sell box lists both sell-box copies). The row says
     so with `sellFrom: false`. A forced rule (opts.ruleId) can't list from
     there either. */
  function listingPlan(opts) {
    const o = opts || {};
    const rows = o.rows || state.cards;
    const forcedRule = o.ruleId ? state.listingRules.find(r => r.id === o.ruleId) : null;
    const ctx = forcedRule ? null : { active: activeListingRules(), exceptions: keepExceptionIndex() };
    // One lookup per location, not a state.locations scan per stack (~70k).
    const locs = locationFlags();
    // "Never list below my minimum profit" (#377, #390): the price a push would send, per listing.
    const noLoss = !!state.settings.neverListAtLoss;
    const asks = noLoss ? manapoolListingAsks() : null;
    const minPct = minProfitPct();

    const matched = [];
    for (const r of rows) {
      let keep, rule;
      if (forcedRule) {
        if (!matchesListingRule(r, forcedRule)) continue;
        keep = forcedRule.keep; rule = forcedRule;
      } else {
        ({ keep, rule } = listingTarget(r, ctx));
      }
      // Below the minimum profit: shown as such and listed at 0, but it stays in its
      // rule's keep pool and counts as a kept copy (#194), so a profitable copy isn't
      // pushed out of the listing by it.
      const loss = noLoss && belowCost(r, (asks.get(listingAskKey(r)) || {}).ask, minPct);
      matched.push({ record: r, keep, rule, loss });
    }

    // Pool by (rule, card name): two rules never share a pool even at the same
    // keep number, since each rule is its own claimed population - the same
    // way a SQL WHERE clause scopes what a GROUP BY name even runs over.
    const pools = new Map();
    for (const m of matched) {
      const key = (m.rule ? "r:" + m.rule.id : "d:" + m.keep) + "|" + (oracleKey(m.record) || nameKey(m.record));
      let pool = pools.get(key);
      if (!pool) { pool = []; pools.set(key, pool); }
      pool.push(m);
    }

    const reserved = o.reserved || manapoolReservations();
    // Copies Manapool already took off the listing for sales Grimoire hasn't settled (#487).
    const soldOff = o.soldOff || unsettledManapoolSold();
    const out = [];
    for (const pool of pools.values()) {
      // Ranked in KEEP order: the first copies take the keep units, the rest
      // are listed. Copies in a location not sold from come first (kept -
      // they can never be listed anyway, #194), then unpriced (kept), then
      // cheapest first (kept), so the dearest copies are the ones listed.
      const ranked = pool.slice().sort((a, b) => {
        const sa = locs.sellFrom(a.record.locationId), sb = locs.sellFrom(b.record.locationId);
        if (sa !== sb) return sa ? 1 : -1;                               // not sold from is kept first
        if (!!a.loss !== !!b.loss) return a.loss ? -1 : 1;               // below cost (#377) is kept first: it uses up the keep, never a profitable copy
        const pa = a.record.price, pb = b.record.price;
        if ((pa == null) !== (pb == null)) return pa == null ? -1 : 1;   // no price is kept first
        if (pa !== pb) return (pa || 0) - (pb || 0);
        // On an exact price tie, break by location pick priority instead of the
        // opaque record id - lower priority first (kept), higher priority last
        // (listed), same direction as pick-list fulfillment and the Manapool
        // sync already pulling from high-priority locations first. Without
        // this, two same-priced stacks of different printings could trade
        // places between evaluations for no reason a user could see (id order
        // shifts whenever a stack is re-created, e.g. after a merge/split).
        const prA = locs.pickPriority(a.record.locationId), prB = locs.pickPriority(b.record.locationId);
        if (prA !== prB) return prA - prB;
        return a.record.id.localeCompare(b.record.id);                   // stable tie-break
      });
      const keep = ranked[0].keep;
      let running = 0;
      const lines = [];
      for (const m of ranked) {
        const r = m.record;
        const sellFrom = locs.sellFrom(r.locationId);
        // `available` stays the copies free to count toward keep, sell-from or not.
        const available = listableQty(r, reserved);
        running += available;
        const keepUnits = Math.max(0, Math.min(available, keep - (running - available)));
        const target = sellFrom && !m.loss ? available - keepUnits : 0;
        lines.push({ record: r, have: availableQty(r), reserved: availableQty(r) - available, available, keep,
          listedNow: Math.max(0, (r.listedQty || 0) - (soldOff.get(r.id) || 0)), target, rule: m.loss ? BELOW_COST_RULE : m.rule, sellFrom });
      }
      spreadListingByPickPriority(lines, locs);
      for (const line of lines) {
        line.delta = line.target - line.listedNow;
        if (!o.includeUnchanged && line.delta === 0) continue;
        out.push(line);
      }
    }
    return out;
  }

  /* Within one Manapool listing (manapoolIdentityKey: same printing,
     language, finish, condition), which stack's copies are the listed ones
     is decided by location pick priority, not price (#227, owner
     2026-10-14: "Mana Pool only cares that you are selling N copies of the
     card"). The keep ranking above still decides HOW MANY copies of each
     listing are listed (#90 cheapest kept across different printings, #194
     not-sold-from kept first, #86 reserved never listable); this only moves
     that number onto the listing's "Sell from" stacks in pick order,
     highest priority first, the same order pick lists pull from. One pool
     (rule + card) at a time, so one rule's keep is never filled from
     another rule's stacks. Stacks without a Scryfall id are no Manapool
     listing and are left alone. */
  function spreadListingByPickPriority(lines, locs) {
    const byListing = new Map();
    for (const line of lines) {
      if (!line.sellFrom || !line.record.scryfallId) continue;
      if (line.rule === BELOW_COST_RULE) continue;   // #377: below cost is never listed, so never gets copies moved onto it
      const key = manapoolIdentityKey(line.record);
      let g = byListing.get(key);
      if (!g) { g = []; byListing.set(key, g); }
      g.push(line);
    }
    for (const g of byListing.values()) {
      if (g.length < 2) continue;
      let left = g.reduce((s, l) => s + l.target, 0);
      g.sort((a, b) => (locs.pickPriority(b.record.locationId) - locs.pickPriority(a.record.locationId)) ||
        locs.name(a.record.locationId).localeCompare(locs.name(b.record.locationId)) ||
        a.record.id.localeCompare(b.record.id));
      for (const line of g) {
        line.target = Math.min(line.available, left);
        left -= line.target;
      }
    }
  }

  /* The Evaluate table's rows (#227): one per Manapool listing, never one
     per location. `lines` is a whole listingPlan({ includeUnchanged: true })
     so a listing's totals include its stacks whose own number isn't
     changing. Each row's `lines` are in pick order (highest priority
     first; a "Sell from" stack, then a priced one, ahead of the rest), and `record` is the
     first of them, which is also the stack a push prices the listing from
     (manapoolPushGroups' sample). Have /
     reserved / listed now / target / delta are totals; `changed` says
     whether any stack in it moves; `offQty` counts copies in locations
     with "Sell from" off. A stack with no Scryfall id is a row of its own.
     opts.includeUnchanged keeps rows where nothing moves. */
  function listingPlanRows(lines, opts) {
    const o = opts || {};
    const locs = locationFlags();
    const rows = new Map();
    for (const line of lines) {
      const r = line.record;
      const key = r.scryfallId ? manapoolIdentityKey(r) : "stack:" + r.id;
      let row = rows.get(key);
      if (!row) {
        row = { key, record: r, lines: [], have: 0, reserved: 0, listedNow: 0, target: 0, delta: 0,
          keeps: [], rules: [], offQty: 0, offLocations: [], changed: false };
        rows.set(key, row);
      }
      row.lines.push(line);
      row.have += Number(line.have) || 0;
      row.reserved += Number(line.reserved) || 0;
      row.listedNow += line.listedNow;
      row.target += line.target;
      if (line.target !== line.listedNow) row.changed = true;
      if (!row.keeps.includes(line.keep)) row.keeps.push(line.keep);
      const rule = line.rule || null;
      if (!row.rules.includes(rule)) row.rules.push(rule);
      if (line.sellFrom === false) {
        row.offQty += Number(line.have) || 0;
        const name = locs.name(r.locationId);
        if (!row.offLocations.includes(name)) row.offLocations.push(name);
      }
    }
    const out = [];
    for (const row of rows.values()) {
      if (!o.includeUnchanged && !row.changed) continue;
      row.delta = row.target - row.listedNow;
      if (row.lines.length > 1) {
        // The first line is the push's sample (the stack whose details go
        // out). Its price no longer matters for what is sent: the ask is the
        // listing's, from manapoolListingAsks (#228). A "Sell from" stack
        // first (a not-sold-from stack's copies are never listed), then one
        // with a market price of its own.
        const off = l => l.sellFrom === false ? 1 : 0;
        const unpriced = l => l.record.price == null ? 1 : 0;
        row.lines.sort((a, b) => (off(a) - off(b)) || (unpriced(a) - unpriced(b)) ||
          (locs.pickPriority(b.record.locationId) - locs.pickPriority(a.record.locationId)) ||
          locs.name(a.record.locationId).localeCompare(locs.name(b.record.locationId)) ||
          a.record.id.localeCompare(b.record.id));
        row.record = row.lines[0].record;
      }
      out.push(row);
    }
    return out;
  }

  /* Commit a listing plan (or a filtered subset of its lines) - writes listedQty
     directly, clamped to the stack's current quantity in case it changed since
     the plan was built. Caller persists, same convention as applyPutawayLines. */
  function applyListingPlan(lines, note) {
    let changed = 0;
    const reserved = manapoolReservations();
    // One id index for the whole call, not a state.cards scan per line: an
    // Apply of a big plan is tens of thousands of lines (#99).
    const byId = lines.length > 1 ? new Map(state.cards.map(x => [x.id, x])) : null;
    const locs = locationFlags();
    for (const line of lines) {
      const rec = byId ? byId.get(line.record.id) : state.cards.find(x => x.id === line.record.id);
      if (!rec) continue;
      // A location switched off "Sell from" since the plan was built lists nothing (#194).
      const target = locs.sellFrom(rec.locationId) ? Math.max(0, Math.min(listableQty(rec, reserved), line.target)) : 0;
      if (target === (rec.listedQty || 0)) continue;
      logAudit({
        action: "list", ...auditCard(rec), qty: target - (rec.listedQty || 0),
        oldQty: rec.listedQty || 0, newQty: target,
        note: (note ? note + ": " : "") + (line.rule ? 'rule "' + line.rule.name + '"' : "default keep " + line.keep)
      });
      rec.listedQty = target;
      changed++;
    }
    return { changed };
  }

  /* ============================== Manapool sync ==============================
     listedQty is Manapool-sourced for any stack Manapool has a listing for -
     not a locally-guessed number. Manapool identifies a listing by
     (scryfall_id, language, finish, condition), with no concept of storage
     location, so one Manapool listing can correspond to several local stacks
     split across locations - these two functions distribute a Manapool-
     confirmed quantity across every matching local row instead of writing to
     just one. */
  const { manapoolIdentityKey } = window.RuleEngine;

  const sortManapoolGroup = group => group.slice().sort((a, b) => (pickPriorityOf(b.locationId) - pickPriorityOf(a.locationId))
    || locName(a.locationId).localeCompare(locName(b.locationId)) || a.id.localeCompare(b.id));

  function manapoolGroup(identityKey) {
    return sortManapoolGroup(state.cards.filter(r => r.scryfallId && manapoolIdentityKey(r) === identityKey));
  }

  /* Fill each row in order until the confirmed total is used up - same
     greedy-fill idiom allocatePutaway/allocatePick already use for "spread a
     quantity across candidates." Can't know which physical copies Manapool
     actually has listed when they're split across locations. Takes an
     already-grouped-and-sorted array rather than re-deriving it via
     manapoolGroup(identityKey) - syncManapoolListings() below is the one
     caller that needs this per identity across the *whole* collection, and
     re-filtering state.cards from scratch for every identity there was a
     real O(identities × stacks) hot spot (measured ~24M array-filter
     visits, several seconds of unresponsive UI, against a ~5300-stack
     collection) - it builds one grouped index up front instead and passes
     each group straight in. applyManapoolQuantity below still does its own
     manapoolGroup(identityKey) lookup for every other, one-off caller
     (push/delist a picked batch, etc.), where that's not a hot loop. */
  //
  // Copies reserved for an open Manapool order (#86) are filled LAST: Manapool
  // already took those off its listing, so its confirmed number belongs on the
  // copies still free to sell. A first pass fills each row up to its
  // listable (unreserved) copies; only if Manapool confirms more than that
  // does a second pass spill onto reserved copies, so the local total still
  // matches Manapool and Evaluate shows the excess as something to lower.
  // `reserved` is optional (computed when omitted) so the hot sync loop can
  // pass one map for the whole collection.
  //
  // Copies in a location with "Sell from" off are filled only after every
  // sell-from stack's free copies (#194): those are never listed, so
  // Manapool's number belongs on the sellable copies. Only a number bigger
  // than all of those lands on a not-sold-from stack, where Evaluate then
  // offers to take it down. The order is: free sell-from copies, free
  // not-sold-from copies, then the reserved (already sold) copies last, as
  // before. `locs` (locationFlags()) is optional, for the same reason as
  // `reserved`.
  function applyManapoolQuantityToGroup(group, confirmedQty, note, reserved, locs) {
    let remaining = Math.max(0, Number(confirmedQty) || 0);
    // Nothing to place (a delist) needs no reservations at all.
    const res = remaining > 0 ? (reserved || manapoolReservations()) : null;
    const takes = new Map(group.map(r => [r.id, 0]));
    const fill = (rows, cap) => {
      for (const r of rows) {
        if (remaining <= 0) return;
        const extra = Math.max(0, Math.min(remaining, cap(r) - takes.get(r.id)));
        takes.set(r.id, takes.get(r.id) + extra);
        remaining -= extra;
      }
    };
    if (remaining > 0) {
      const lf = locs || locationFlags();
      const sell = [], noSell = [];
      for (const r of group) (lf.sellFrom(r.locationId) ? sell : noSell).push(r);
      fill(sell, r => listableQty(r, res));
      fill(noSell, r => listableQty(r, res));
      fill(group, r => r.quantity);
    }
    let changed = 0;
    for (const r of group) {
      if (setListedFromManapool(r, takes.get(r.id), note)) changed++;
    }
    return { changed };
  }
  function setListedFromManapool(r, take, note) {
    if (take === (r.listedQty || 0)) return false;
    logAudit({
      action: "list", ...auditCard(r), qty: 0, oldQty: r.quantity, newQty: r.quantity,
      note: (note ? note + ": " : "") + "Manapool shows " + take + " listed"
    });
    r.listedQty = take;
    return true;
  }
  function applyManapoolQuantity(identityKey, confirmedQty, note, reserved) {
    const group = manapoolGroup(identityKey);
    settleOpenManapoolLists(group[0], false);
    return applyManapoolQuantityToGroup(group, confirmedQty, note, reserved);
  }

  /* Live Manapool card listings ([normalizeListing rows]) -> Map of
     manapoolIdentityKey -> total quantity listed. */
  function manapoolListingTotals(listings) {
    const totals = new Map();
    for (const l of listings || []) {
      if (l.kind === "sealed" || !l.scryfallId) continue;
      const key = [l.scryfallId, String(l.lang || "en").toLowerCase(), l.finish || "nonfoil", l.condition || "NM"].join("|");
      totals.set(key, (totals.get(key) || 0) + (Number(l.quantity) || 0));
    }
    return totals;
  }

  /* The quantity a PRICE push sends for one listing (#86). Manapool's write
     endpoint always sets a quantity alongside the price, so a price change
     has to send one: never more than Manapool lists right now (`liveQty`,
     read just before the push - a sale lowers it there before Grimoire
     hears of it), and never more than the copies on hand that aren't
     already sold to an open Manapool order. A price push can therefore
     never raise the quantity; it only lowers it if fewer copies are really
     free to sell than Manapool thinks. */
  function pricePushQuantity(identityKey, liveQty, reserved) {
    const res = reserved || manapoolReservations();
    const free = manapoolGroup(identityKey).reduce((s, r) => s + listableQty(r, res), 0);
    return Math.max(0, Math.min(Number(liveQty) || 0, free));
  }
  // Sealed counterparts: keyed by tcgplayerProductId (sealedIdentityKey).
  function manapoolSealedListingTotals(listings) {
    const totals = new Map();
    for (const l of listings || []) {
      if (l.kind !== "sealed" || !l.tcgplayerProductId) continue;
      totals.set(l.tcgplayerProductId, (totals.get(l.tcgplayerProductId) || 0) + (Number(l.quantity) || 0));
    }
    return totals;
  }
  function sealedPricePushQuantity(identityKey, liveQty, reserved) {
    const res = reserved || manapoolReservations();
    const free = sealedManapoolGroup(identityKey).reduce((s, r) => s + listableQty(r, res), 0);
    return Math.max(0, Math.min(Number(liveQty) || 0, free));
  }

  /* Send only what changes (#482). A push re-sent every ticked listing,
     even ones Manapool already showed at exactly that quantity and price.
     Pushes now read the live listings first and leave those out.
     manapoolLiveListings: live listings by identity -> { quantity, price }
     (cards by manapoolIdentityKey, sealed by tcgplayerProductId, the same
     keys and quantity sums as manapoolListingTotals / the sealed one).
     Rows of one identity that disagree on price get price null, so they
     are sent rather than counted as already right. */
  const priceCents = p => (p == null || !(Number(p) > 0) ? null : Math.round(Number(p) * 100));
  function manapoolLiveListings(listings, sealed) {
    const out = new Map();
    for (const l of listings || []) {
      if (!l) continue;
      if (sealed ? (l.kind !== "sealed" || !l.tcgplayerProductId) : (l.kind === "sealed" || !l.scryfallId)) continue;
      const key = sealed ? l.tcgplayerProductId : manapoolIdentityKey(l);
      const qty = Number(l.quantity) || 0, price = priceCents(l.price);
      const cur = out.get(key);
      if (!cur) { out.set(key, { quantity: qty, price }); continue; }
      cur.quantity += qty;
      if (cur.price !== price) cur.price = null;
    }
    return out;
  }
  /* The skip decision: is this push entry already what Manapool shows?
     Quantity 0 with nothing live is already right (nothing to take down).
     Otherwise the live quantity and price (in cents) must both match. */
  function manapoolPushAlreadyLive(live, quantity, price) {
    const want = Math.max(0, Number(quantity) || 0);
    if (!live || !(live.quantity > 0)) return want === 0;
    if (live.quantity !== want) return false;
    const cents = priceCents(price);
    return cents != null && cents === live.price;
  }
  /* Splits a push's parallel keys/entries ({quantity, price, ...}) into what
     still has to be sent and what is already up to date. The caller records
     each upToDate one exactly as a confirmed send of `quantity` at `price`. */
  function splitManapoolPush(keys, entries, live) {
    const send = { keys: [], entries: [] }, upToDate = [];
    keys.forEach((key, i) => {
      const e = entries[i];
      if (manapoolPushAlreadyLive(live.get(key), e.quantity, e.price)) upToDate.push({ key, quantity: Math.max(0, Number(e.quantity) || 0), price: e.price });
      else { send.keys.push(key); send.entries.push(e); }
    });
    return { keys: send.keys, entries: send.entries, upToDate };
  }

  /* After a Listings push Manapool confirmed (#89): put each stack's listed
     quantity exactly where the push meant it to go, rather than re-spreading
     the total greedily by pick priority (which ignores the plan's price
     ranking and any location-scoped rule, so the plan never settled).
     `perStack` is a Map of record id -> the quantity that stack contributed
     to `sentQty`. If Manapool confirms a different total than was sent,
     nobody knows which copies it meant, so fall back to the greedy fill. */
  function applyManapoolPushToStacks(identityKey, perStack, sentQty, confirmedQty, note) {
    const group = manapoolGroup(identityKey);
    settleOpenManapoolLists(group[0], false);
    if (Number(confirmedQty) !== Number(sentQty)) return applyManapoolQuantityToGroup(group, confirmedQty, note);
    let changed = 0;
    for (const r of group) {
      if (!perStack.has(r.id)) continue;
      const want = Math.max(0, Math.min(r.quantity, Number(perStack.get(r.id)) || 0));
      if (setListedFromManapool(r, want, note)) changed++;
    }
    return { changed };
  }

  /* What a Listings push sends, per Manapool listing (#89, #194). Manapool
     identifies a listing by (scryfall_id, language, finish, condition) - no
     location - and its endpoint SETS a quantity rather than adding to it.
     Two local rows sharing an identity (same card split across locations)
     pushed separately would silently clobber each other's contribution, so
     ticked plan lines are grouped by identity and pushed once per group,
     with any untouched sibling row's current (already Manapool-true)
     listedQty folded into the total instead of dropped.

     perStack records what each local stack contributes to the total, so a
     confirmed push lands on exactly those stacks (applyManapoolPushToStacks)
     instead of being re-spread by pick priority.

     A sibling's already-listed quantity only counts toward the combined push
     if it would ALSO match one of the rule(s) that ticked this group -
     otherwise a rule scoped by location (e.g. "location is not SELL BOX 1")
     would have that box's stock silently folded back in here, defeating the
     whole point of the location filter. Lines with no rule (the default
     keep, unscoped) fold every sibling in, since nothing claims to exclude
     anything in that case.

     A folded-in sibling counts only its listable copies: anything reserved
     for an open Manapool order is already sold (#86), so it is never sent
     back up. A sibling in a location with "Sell from" off is never listed
     (#194), and neither is a ticked line there (the plan already gives it
     0; this holds even for a stale line). An excluded stack contributes 0 -
     its copies come off Manapool with this push - and is recorded as 0 so
     local matches. Returns Map identity key -> { sample, perStack,
     targetSum, rules }. */
  function manapoolPushGroups(lines, reserved) {
    const res = reserved || manapoolReservations();
    const locs = locationFlags();
    const groups = new Map();
    for (const line of lines) {
      const key = manapoolIdentityKey(line.record);
      if (!groups.has(key)) groups.set(key, { sample: line.record, perStack: new Map(), targetSum: 0, rules: new Set() });
      const g = groups.get(key);
      const qty = locs.sellFrom(line.record.locationId) ? Math.max(0, Number(line.target) || 0) : 0;
      g.perStack.set(line.record.id, qty);
      g.targetSum += qty;
      if (line.rule) g.rules.add(line.rule);
    }
    // Siblings in one pass over the stacks, not a state.cards scan per group.
    for (const r of state.cards) {
      if (!r.scryfallId) continue;
      const g = groups.get(manapoolIdentityKey(r));
      if (!g || g.perStack.has(r.id)) continue;
      const eligible = locs.sellFrom(r.locationId) &&
        (g.rules.size === 0 || [...g.rules].some(rule => matchesListingRule(r, rule)));
      const keepListed = eligible ? Math.min(r.listedQty || 0, listableQty(r, res)) : 0;
      g.perStack.set(r.id, keepListed);
      g.targetSum += keepListed;
    }
    return groups;
  }

  /* Inventory -> Storefront's + / - "list one / unlist one" for one Manapool
     listing (#194 review). Same rules as a Listings push, through the same
     manapoolPushGroups: copies are only ever listed from a location with
     "Sell from" on, and any copies listed from elsewhere come off with the
     push.
     + lists one more copy on the first sell-from stack (pick priority
       order) with a free copy not yet listed. With no sell-from stack at
       all it is refused: { refused: "noSellFrom", name, offTakenDown } (the
       copies still listed from off locations, for the toast to point at -).
     - takes down the copies listed from not-sold-from stacks if there are
       any (that is all it does then), otherwise one copy from the last
       sell-from stack that has one listed.
     Returns { sample, perStack, quantity, offTakenDown } for the push and
     applyManapoolPushToStacks, or { refused, name, offTakenDown } (offTakenDown
     only on noSellFrom). */
  function storefrontListedPush(identityKey, delta, reserved) {
    const res = reserved || manapoolReservations();
    const locs = locationFlags();
    const group = manapoolGroup(identityKey);
    if (!group.length) return { refused: "noStacks", name: "" };
    const name = group[0].name;
    const sell = group.filter(r => locs.sellFrom(r.locationId));
    const offTakenDown = group.filter(r => !locs.sellFrom(r.locationId)).reduce((s, r) => s + (Number(r.listedQty) || 0), 0);
    const listedOf = r => Math.min(Number(r.listedQty) || 0, listableQty(r, res));
    let rep, want;
    if (delta > 0) {
      if (!sell.length) return { refused: "noSellFrom", name, offTakenDown };
      rep = sell.find(r => listedOf(r) < listableQty(r, res)) || sell[0];
      want = Math.min(listableQty(rep, res), listedOf(rep) + 1);
    } else if (offTakenDown > 0 || !sell.length) {
      rep = sell[0] || group[0];
      want = sell.length ? listedOf(rep) : 0;
    } else {
      rep = sell.slice().reverse().find(r => listedOf(r) > 0) || sell[0];
      want = Math.max(0, listedOf(rep) - 1);
    }
    const g = manapoolPushGroups([{ record: rep, target: want, rule: null }], res).get(identityKey);
    return { sample: rep, perStack: g.perStack, quantity: g.targetSum, offTakenDown };
  }

  /* Same distribute-across-matching-rows idiom as applyManapoolQuantity
     above, for sealed - sealedIdentityKey is just tcgplayerProductId (no
     lang/finish/condition tiers to fold in), but a Manapool sealed listing
     can still correspond to more than one local state.sealed row split
     across locations, same reason cards can. */
  function applySealedManapoolQuantityToGroup(group, confirmedQty, note) {
    let remaining = Math.max(0, Number(confirmedQty) || 0);
    let changed = 0;
    for (const r of group) {
      const take = Math.min(remaining, r.quantity);
      if (take !== (r.listedQty || 0)) {
        logAudit({ action: "sealed-edit", name: r.name, qty: 0, note: (note ? note + ": " : "") + "Manapool shows " + take + " listed" });
        r.listedQty = take;
        changed++;
      }
      remaining -= take;
    }
    return { changed };
  }
  /* ---------- Delist all (#96) ----------
     Built from a fresh read of the LIVE Manapool listings, not from local
     listedQty: a listing made on Manapool directly, one whose local count is
     stale at 0, one with no local stack at all, and sealed listings all have
     to come down too. Returns the write entries for /api/manapool/list-bulk
     (cards) and /list-bulk-sealed (sealed), one per live listing identity,
     plus `cantDelist`: live listings Grimoire has no way to address (no
     Scryfall id / Manapool product id), so the caller can say so. */
  function delistAllPlan(listings) {
    const cards = [], sealed = [], cantDelist = [];
    const seenCards = new Set(), seenSealed = new Set();
    for (const l of listings || []) {
      if (!l || !(Number(l.quantity) > 0)) continue;
      if (l.kind === "sealed") {
        if (!l.manapoolProductId) { cantDelist.push(l.name || "a sealed listing"); continue; }
        if (seenSealed.has(l.manapoolProductId)) continue;
        seenSealed.add(l.manapoolProductId);
        sealed.push({ key: l.manapoolProductId, tcgplayerProductId: l.tcgplayerProductId || "",
          entry: { item: { manapoolProductId: l.manapoolProductId, tcgplayerProductId: l.tcgplayerProductId || "",
            name: l.name || "", setCode: l.setCode || "" }, quantity: 0, price: null } });
        continue;
      }
      if (!l.scryfallId) { cantDelist.push(l.name || "a card listing"); continue; }
      const key = manapoolIdentityKey(l);
      if (seenCards.has(key)) continue;
      seenCards.add(key);
      const card = { scryfallId: l.scryfallId, lang: l.lang || "en", finish: l.finish || "nonfoil",
        condition: l.condition || "NM", name: l.name || "", set: l.set || "", collector: l.collector || "" };
      cards.push({ key, entry: { card, quantity: 0, price: null, condition: card.condition } });
    }
    return { cards, sealed, cantDelist };
  }

  /* "Delist unprofitable" (#377, #390): the live card listings whose price
     misses the account's minimum profit (minProfitPct()) over the average cost
     per copy of the stacks behind them. `listings` is
     the live Manapool read; without it the listings are worked out from local
     stacks (listedQty > 0, priced at askPrice), used for the button's count.
     A listing is left alone if it has no price, if any of its stacks has no
     cost entered, or if it has no local stack. Returns { cards, items }:
     `cards` are the delistAllPlan write entries, `items` the display info. */
  function delistUnprofitablePlan(listings) {
    const stacksByKey = new Map();
    for (const r of state.cards) {
      if (!r.scryfallId) continue;
      const k = manapoolIdentityKey(r);
      const g = stacksByKey.get(k);
      if (g) g.push(r); else stacksByKey.set(k, [r]);
    }
    let live = listings;
    if (!live) {
      live = [];
      for (const stacks of stacksByKey.values()) {
        const up = stacks.filter(r => Number(r.listedQty) > 0);
        if (!up.length) continue;
        const r = up[0];
        live.push({ kind: "card", scryfallId: r.scryfallId, lang: r.lang, finish: r.finish, condition: r.condition,
          quantity: up.reduce((n, x) => n + Number(x.listedQty), 0), price: r.askPrice, name: r.name, set: r.set, collector: r.collector });
      }
    }
    const keep = [], items = [];
    const seen = new Set();
    const minPct = minProfitPct();
    for (const l of live) {
      if (!l || l.kind === "sealed" || !(Number(l.quantity) > 0) || !l.scryfallId) continue;
      const key = manapoolIdentityKey(l);
      if (seen.has(key)) continue;
      // Judge the stacks that are listed (what the price covers); all of them if none are.
      const all = stacksByKey.get(key) || [];
      const up = all.filter(r => Number(r.listedQty) > 0);
      const stacks = up.length ? up : all;
      if (!stacks.length) continue;
      let price = Number(l.price);
      if (!(price > 0)) price = Number(stacks.map(r => r.askPrice).find(a => Number(a) > 0));
      const below = window.RuleEngine.listingBelowCost(stacks, price, minPct);
      if (!below) continue;
      seen.add(key);
      keep.push(l);
      // profit / pct: what selling at `price` makes over cost, so a card that is
      // profitable but under the minimum reads right (#390).
      items.push({ key, name: l.name || stacks[0].name, price, cost: below.cost, profit: below.profit, pct: below.pct });
    }
    return { cards: delistAllPlan(keep).cards, items, minPct };
  }

  /* After a Delist unprofitable push: locally listed stacks of the listings
     in `downKeys` go to 0. Nothing else is touched. */
  function applyDelistUnprofitable(downKeys, note) {
    let changed = 0;
    for (const r of state.cards) {
      if (!(Number(r.listedQty) > 0) || !r.scryfallId || !downKeys.has(manapoolIdentityKey(r))) continue;
      if (setListedFromManapool(r, 0, note)) changed++;
    }
    return { changed };
  }

  /* After Delist all: Manapool now lists nothing, except the listings that
     failed or were never sent (`keep`: {cards: Set of identity keys,
     sealed: Set of tcgplayer/Manapool product ids}). Every other locally
     listed stack goes to 0, including ones whose local count was stale.
     One pass over state.cards and state.sealed - no per-listing scan. */
  function applyDelistAll(keep, note) {
    const keepCards = (keep && keep.cards) || new Set(), keepSealed = (keep && keep.sealed) || new Set();
    let changed = 0;
    for (const r of state.cards) {
      if (!(Number(r.listedQty) > 0)) continue;
      if (r.scryfallId && keepCards.has(manapoolIdentityKey(r))) continue;
      if (setListedFromManapool(r, 0, note)) changed++;
    }
    for (const r of state.sealed) {
      if (!(Number(r.listedQty) > 0)) continue;
      if ((r.tcgplayerProductId && keepSealed.has(String(r.tcgplayerProductId))) ||
          (r.manapoolProductId && keepSealed.has(String(r.manapoolProductId)))) continue;
      logAudit({ action: "sealed-edit", name: r.name, qty: 0, note: (note ? note + ": " : "") + "Manapool shows 0 listed" });
      r.listedQty = 0;
      changed++;
    }
    return { changed };
  }

  function applySealedManapoolQuantity(identityKey, confirmedQty, note) {
    const group = sealedManapoolGroup(identityKey);
    settleOpenManapoolLists(group[0], true);
    return applySealedManapoolQuantityToGroup(group, confirmedQty, note);
  }

  /* Local listed for this listing was just set from a number Manapool
     confirmed (a push or a price push). Every open Manapool-order pick list
     belongs to an order placed before now, so that number already excludes
     what those orders sold: completing one of them must not lower this
     listing's listed count again (#86). Recorded per listing, only on the
     lists whose own lines can draw from it, so it stays bounded by those
     lines. A full Fetch listings settles whole lists instead (listedSettled). */
  function settledListingKey(r, isSealed) {
    return isSealed ? "sealed|" + sealedIdentityKey(r) : manapoolIdentityKey(r);
  }
  /* When each listing last got Manapool's confirmed number (key -> ISO time,
     #487): an order placed before it is already in that number, even with no
     pick list yet. Cleared by a full Fetch listings; older entries pruned. */
  function noteListingSettled(key) {
    const now = Date.now(), at = state.settings.manapoolListingSettledAt || {};
    for (const k of Object.keys(at)) if (now - Date.parse(at[k]) > 45 * 864e5) delete at[k];
    at[key] = new Date(now).toISOString();
    state.settings.manapoolListingSettledAt = at;
  }
  function settleOpenManapoolLists(sample, isSealed) {
    if (!sample) return;
    const key = settledListingKey(sample, isSealed);
    noteListingSettled(key);
    for (const p of pickLists()) {
      if (p.status !== "open" || p.source !== "manapool" || p.listedSettled) continue;
      const touches = (p.lines || []).some(it => isSealed
        ? it.kind === "sealed" && it.tcgplayerProductId === sample.tcgplayerProductId
        : it.kind !== "sealed" && cardLineMatches(it, sample));
      if (!touches) continue;
      if (!Array.isArray(p.listedSettledKeys)) p.listedSettledKeys = [];
      if (!p.listedSettledKeys.includes(key)) p.listedSettledKeys.push(key);
    }
  }

  /* Full reconciliation from a live fetch - every local stack's listedQty
     comes entirely from this snapshot; an identity absent from `listings`
     goes to 0. Only ever called from an explicit user action (Fetch
     listings), never silently, since it overwrites wholesale rather than
     merging. Reconciles state.sealed the same way as state.cards - a
     Manapool listing row is told apart by `kind` (see integrations.js's
     normalizeListing), not by trying to guess from field shape. */
  function syncManapoolListings(listings) {
    const totals = new Map(), sealedTotals = new Map();
    for (const l of listings) {
      if (l.kind === "sealed") {
        if (!l.tcgplayerProductId) continue;
        sealedTotals.set(l.tcgplayerProductId, (sealedTotals.get(l.tcgplayerProductId) || 0) + (Number(l.quantity) || 0));
        continue;
      }
      if (!l.scryfallId) continue;
      const key = [l.scryfallId, String(l.lang || "en").toLowerCase(), l.finish || "nonfoil", l.condition || "NM"].join("|");
      totals.set(key, (totals.get(key) || 0) + (Number(l.quantity) || 0));
    }
    // Group every stack by identity ONCE up front rather than calling
    // manapoolGroup(key) (a fresh state.cards.filter()) for each of
    // potentially thousands of distinct identities - that was a real
    // O(identities × stacks) hot spot (measured ~24M array-filter visits,
    // several seconds of unresponsive UI, against a ~5300-stack
    // collection) and is exactly why this looked like it "didn't load" on
    // a large enough account. Same for sealed below.
    const groups = new Map();
    for (const r of state.cards) {
      if (!r.scryfallId) continue;
      const key = manapoolIdentityKey(r);
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(r);
    }
    let changed = 0;
    const reserved = manapoolReservations();
    const locs = locationFlags();
    for (const [key, group] of groups) {
      changed += applyManapoolQuantityToGroup(sortManapoolGroup(group), totals.get(key) || 0, "Manapool sync", reserved, locs).changed;
    }
    // Every order with an open pick list right now was placed before this
    // fetch, so Manapool's numbers above already exclude what it sold:
    // completing that list must not lower listed a second time (#86, see
    // completePickList). Stamped so a list generated later for an order
    // placed before this fetch knows the same (ensureOrderPickList).
    state.settings.manapoolSyncedAt = new Date().toISOString();
    state.settings.manapoolListingSettledAt = {};
    for (const p of pickLists()) {
      if (p.status === "open" && p.source === "manapool") p.listedSettled = true;
    }
    const sealedGroups = new Map();
    for (const r of state.sealed) {
      const key = sealedIdentityKey(r);
      if (!key) continue;
      let g = sealedGroups.get(key);
      if (!g) { g = []; sealedGroups.set(key, g); }
      g.push(r);
    }
    for (const [key, group] of sealedGroups) {
      changed += applySealedManapoolQuantityToGroup(group, sealedTotals.get(key) || 0, "Manapool sync").changed;
    }
    return { changed, identities: groups.size + sealedGroups.size };
  }

  /* One-time catch-up for stock whose Manapool price Grimoire never sent -
     listed on Manapool directly, or before pushes recorded what they sent.
     `askPrice` is only "the price last sent to Manapool" (#228): display for
     Bulk Price's "On Manapool" column, never a price anything pushes. So
     those stacks would otherwise show a blank there forever. Only fills
     rows with no askPrice yet - after that, pushes keep it current
     (recordManapoolAsks). */
  /* Ids of listed stacks that still have no ask price and could be filled
     from Manapool, minus `skip` (a Set of ids an earlier fetch already
     couldn't fill, #98) - so the Bulk Price page fetches every Manapool
     listing page only when there is something new to look up. */
  function askPriceBackfillPending(skip) {
    const out = [];
    for (const r of state.cards) {
      if (r.askPrice != null || !r.scryfallId || !(Number(r.listedQty) > 0)) continue;
      if (skip && skip.has(r.id)) continue;
      out.push(r.id);
    }
    return out;
  }
  // Returns {filled, missed}: missed = ids of rows it looked for but found
  // no live listing price for.
  function backfillAskPricesFromManapool(listings) {
    const priceByKey = new Map();
    for (const l of listings) {
      if (!l.scryfallId || l.price == null) continue;
      const key = [l.scryfallId, String(l.lang || "en").toLowerCase(), l.finish || "nonfoil", l.condition || "NM"].join("|");
      if (!priceByKey.has(key)) priceByKey.set(key, Number(l.price));
    }
    let filled = 0;
    const missed = [];
    for (const r of state.cards) {
      if (r.askPrice != null || !r.scryfallId || !(Number(r.listedQty) > 0)) continue;
      const price = priceByKey.get(manapoolIdentityKey(r));
      if (price == null || !(price > 0)) { missed.push(r.id); continue; }
      logAudit({
        action: "price", ...auditCard(r), qty: 0,
        note: "Backfilled from live Manapool listing price (never priced via Grimoire before) — set to " + money(round2(price))
      });
      r.askPrice = round2(price);
      filled++;
    }
    return { filled, missed };
  }

  /* ============================== Bulk price engine ==============================
     Same rule shape as the listing engine just above - criteria + priority,
     highest-priority enabled match wins - but the payload each rule carries is
     a pricing action instead of a keep quantity. "exclude" has no numeric
     payload at all: it is how a higher-priority rule opts specific stacks out
     of a sweep a lower-priority rule would otherwise apply to them (a Reserved
     List binder that should never be auto-priced, say), matching the
     "include or disinclude" idea directly. */
  const PRICE_RULE_MODES = [
    { key: "percent", label: "% of the base price" },
    { key: "delta", label: "Base price, plus/minus $" },
    { key: "fixed", label: "Fixed price" },
    // #228 (owner): an excluded listing goes out at market x condition %.
    { key: "exclude", label: "Exclude — market price × condition %" }
  ];

  /* What "the base price" means for a percent/delta rule - Scryfall's own
     market price (the historical default, r.price), or one of Manapool's
     numbers: their algorithmic market estimate, or the lowest price actually
     being asked for that printing/condition on Manapool right now. Ignored
     by "fixed" (there is no base to apply to) and "exclude" (nothing is
     priced at all). Refreshed alongside `price` - see refreshPrices() and
     the Manapool lookup joined into POST /api/cards/collection server-side
     (server/index.js, server/lib/integrations.js's manapoolPrices). Looked
     up live for just the printings that need it, not any kind of local copy
     of Manapool's whole catalog - and only for accounts with Manapool
     connected, so it degrades to "no data" everywhere else. */
  const { PRICE_BASES, basisValue } = window.RuleEngine;

  function normalizePriceRule(r) {
    const src = r || {};
    const mode = PRICE_RULE_MODES.some(m => m.key === src.mode) ? src.mode : "percent";
    return {
      id: src.id || uid(),
      on: src.on !== false,
      name: String(src.name || "").trim(),
      priority: Number(src.priority) || 0,
      mode,
      basis: PRICE_BASES.some(b => b.key === src.basis) ? src.basis : "market",
      percent: Math.max(0, Number(src.percent == null ? 1 : src.percent) || 0),
      delta: Number(src.delta) || 0,
      fixed: src.fixed == null || src.fixed === "" ? null : Math.max(0, Number(src.fixed) || 0),
      criteria: normalizeCriteriaBox(src.criteria)
    };
  }
  const newPriceRule = () => normalizePriceRule({ mode: "percent", basis: "market", percent: 1 });

  function matchesPriceRule(record, rule) {
    // no criteria = catch-all, same as a listing rule. Profit vs cost is judged
    // against market price here, not the ask this rule sets (#375).
    return matchesCriteria(record, rule.criteria, window.RuleEngine.PRICE_RULE_MATCH);
  }

  /* Enabled price rules in competing order, sorted once per plan (#99), the
     same way activeListingRules() is for Listings. */
  function activePriceRules() {
    return state.priceRules.filter(r => r.on)
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }

  /* Highest-priority enabled rule whose criteria all match; null if none do.
     `active` is an optional activePriceRules() list the caller built once. */
  function ruleForPriceRecord(record, active) {
    return (active || activePriceRules()).find(r => matchesPriceRule(record, r)) || null;
  }

  /* null means "do not touch this stack's price" - no rule claims it, an
     exclude rule claims it, or a percent/delta rule has no market price to
     work from. Deliberately no fallback to a collection-wide default the way
     listingDefaultKeep gives the listing engine one: a rule INCLUDES specific
     stacks into the sweep, and a stack nothing names is simply left alone,
     not silently repriced off some catch-all. That is what makes it safe for
     the schedule to run unattended - an empty or narrow rule set touches
     nothing, never "the whole collection at whatever the default happens to
     be." (#228: a Listings push still needs a price for an unclaimed
     listing - market x condition %, see manapoolListPrice.) */
  const { priceRuleTarget, zeroTarget } = window.RuleEngine;

  /* Bulk pricing only makes sense for stock actually for sale - repricing a
     stack with nothing listed has no effect anywhere and just clutters the
     plan with rows there is nothing to do about. */
  const isListed = record => Number(record.listedQty) > 0;

  /* ---------- One live ask per Manapool listing (#228) ----------
     A listing's ask is worked out every time something needs it - the
     Listings table, Bulk Price's plan, every push - from the Bulk Price
     rules and the latest prices on the stacks (RuleEngine.listingAsk has
     the rules for which stack and which rule speak for a listing). Nothing
     stores it, so it follows the nightly market refresh by itself and the
     stacks of one listing can never disagree. A stored askPrice is only the
     price last sent to Manapool, for display.

     Stacks with no Scryfall id can't be on Manapool, so each is its own
     "listing" here. */
  const listingAskKey = r => r.scryfallId ? manapoolIdentityKey(r) : "stack:" + r.id;
  function listingAskOpts() {
    const locs = locationFlags();
    return { locName, sellFrom: locs.sellFrom, conditionPricing: state.settings.conditionPricing };
  }

  /* Map listing key -> RuleEngine.listingAsk info ({ask, fallback, target,
     rule, market, basisVal, excluded, zero, noBasis, record}) in one pass over the
     stacks, with the rules sorted once: build it once per render or push,
     never per row. `keys` (optional Set) limits it to those listings. */
  function manapoolListingAsks(keys) {
    const groups = new Map();
    for (const r of state.cards) {
      const key = listingAskKey(r);
      if (keys && !keys.has(key)) continue;
      const g = groups.get(key);
      if (g) g.push(r); else groups.set(key, [r]);
    }
    const rules = activePriceRules(), opts = listingAskOpts();
    const out = new Map();
    for (const [key, stacks] of groups) out.set(key, window.RuleEngine.listingAsk(stacks, rules, opts));
    return out;
  }

  /* The price a push sends Manapool for this stack's listing (#88, #228):
     the listing's live ask - its Bulk Price rule's price, else (no rule,
     an exclude, a $0.00 rule or one with no base price) the market price
     times the condition % from Listings' Rules tab. null = no market price
     either, so nothing to send. `asks` is an
     optional prebuilt manapoolListingAsks() map for a caller pricing many
     rows; without it only this listing's stacks are looked at. */
  function manapoolListPrice(record, asks) {
    if (!record) return null;
    const key = listingAskKey(record);
    const info = (asks && asks.get(key)) || manapoolListingAsks(new Set([key])).get(key);
    return info ? info.ask : null;
  }

  /* "Which listed stacks would a push reprice, and to what?" - same
     evaluate-a-plan shape as listingPlan/putawayPlan, one line per listed
     stack. Every stack of one listing carries that listing's one live
     ask (target) and the rule that claims it. `current` is the price last
     sent to Manapool (askPrice), so a line is a change when Manapool would
     get a different price. opts.ruleId narrows the plan to the listings that
     rule prices; it no longer overrides the others (a switched-off rule
     prices nothing). Only listings some rule claims are in it - an exclude
     included. A listing whose rule gives no price (exclude, $0.00, no base
     price) carries the market x condition % ask like any other listing
     (owner, #228), flagged so the page can say why; with no market price
     either its target is null and Push skips it.
     With "Never list below my minimum profit" on (#378, #390), a listing whose
     ask misses the minimum profit over its cost is flagged delist, with its
     cost, profit % and no delta: target
     stays the price that would have been sent, and Push takes it down
     instead. It shows even if the ask hasn't changed. */
  function bulkPricePlan(opts) {
    const o = opts || {};
    const listedKeys = new Set();
    for (const r of state.cards) if (isListed(r)) listedKeys.add(listingAskKey(r));
    const asks = manapoolListingAsks(listedKeys);
    let stacksByKey = null;
    const minPct = minProfitPct();
    if (state.settings.neverListAtLoss) {
      stacksByKey = new Map();
      for (const r of state.cards) {
        if (!r.scryfallId) continue;   // can't be on Manapool, so nothing to take down
        const k = manapoolIdentityKey(r);
        if (!listedKeys.has(k)) continue;
        const g = stacksByKey.get(k);
        if (g) g.push(r); else stacksByKey.set(k, [r]);
      }
    }
    const out = [];
    for (const r of state.cards) {
      if (!isListed(r)) continue;   // nothing listed - nothing to reprice, not part of the sweep at all
      const a = asks.get(listingAskKey(r));
      if (!a || !(a.rule || a.excluded)) continue;   // nothing claims this listing
      if (o.ruleId && !(a.rule && a.rule.id === o.ruleId)) continue;
      const current = r.askPrice == null ? null : Number(r.askPrice);
      const line = { record: r, key: listingAskKey(r), market: a.market, basisVal: a.basisVal, current, rule: a.rule,
        target: a.ask, fallback: a.fallback, excluded: a.excluded, noBasis: a.noBasis, zero: a.zero,
        delta: a.ask == null || current == null ? null : round2(a.ask - current) };
      const below = stacksByKey && r.scryfallId ? window.RuleEngine.listingBelowCost(stacksByKey.get(line.key), a.ask, minPct) : null;
      if (below) { line.delist = true; line.cost = below.cost; line.pct = below.pct; line.delta = null; }
      // No price at all (no market price either) is always surfaced, never
      // silently dropped; an unchanged one only on request.
      if (!below && a.ask != null && !o.includeUnchanged && current != null && Math.abs(current - a.ask) < 0.005) continue;
      out.push(line);
    }
    return out;
  }

  /* Record what a confirmed push sent: `sent` is [{key, price}] per
     Manapool listing. Every stack of the listing gets it as askPrice ("last
     sent to Manapool"), so they all show the same number and Bulk Price
     stops offering the same change. One audit line per listing whose
     number moved. One pass over the stacks however many listings were
     pushed. Caller persists. */
  function recordManapoolAsks(sent, note) {
    const byKey = new Map();
    for (const s of sent) {
      const price = Number(s.price);
      if (s.price != null && price > 0) byKey.set(s.key, { price: round2(price), note: s.note || note || "Manapool push" });
    }
    let changed = 0;
    const logged = new Set();
    if (!byKey.size) return { changed };
    for (const rec of state.cards) {
      if (!rec.scryfallId) continue;
      const key = manapoolIdentityKey(rec);
      const hit = byKey.get(key);
      if (!hit) continue;
      const price = hit.price;
      if (rec.askPrice != null && Math.abs(rec.askPrice - price) < 0.005) continue;
      if (!logged.has(key)) {
        logged.add(key);
        logAudit({ action: "price", ...auditCard(rec), qty: 0,
          note: hit.note + " — " + money(rec.askPrice) + " → " + money(price) });
      }
      rec.askPrice = price;
      changed++;
    }
    return { changed };
  }

  /* ============================== Sealed pricing engine ==============================
     Deliberately NOT a reuse of the card criteria engine above - a sealed
     record run through matchesCriteria/ruleFieldValue can silently WRONGLY
     match (an absent field reads as "no opinion" for most rule kinds, and
     `finish` specifically defaults to "nonfoil" for any record missing it -
     see priceRuleEngine.js), so e.g. a "finish is nonfoil" card rule would
     quietly reprice every booster box if sealed rows were ever run through
     it. Sealed gets its own tiny, structurally separate matcher instead:
     an optional exact set-code match and an optional name-contains match -
     sealed has no attributes rich enough to need the nested AND/OR/NOT
     criteria builder anyway. The actual math (priceRuleTarget/basisValue)
     is reused unchanged - confirmed generic over a bare numeric basis - but
     basis is always the sealed record's own `price` (its only number;
     there is no Manapool-low/Manapool-market alternative the way singles
     have). */
  const SEALED_PRICE_RULE_MODES = PRICE_RULE_MODES; // same four modes, same meanings

  function normalizeSealedPriceRule(r) {
    const src = r || {};
    const mode = SEALED_PRICE_RULE_MODES.some(m => m.key === src.mode) ? src.mode : "percent";
    return {
      id: src.id || uid(),
      on: src.on !== false,
      name: String(src.name || "").trim(),
      priority: Number(src.priority) || 0,
      mode,
      setCode: String(src.setCode || "").trim().toLowerCase(),
      nameContains: String(src.nameContains || "").trim().toLowerCase(),
      percent: Math.max(0, Number(src.percent == null ? 1 : src.percent) || 0),
      delta: Number(src.delta) || 0,
      fixed: src.fixed == null || src.fixed === "" ? null : Math.max(0, Number(src.fixed) || 0)
    };
  }
  const newSealedPriceRule = () => normalizeSealedPriceRule({ mode: "percent", percent: 1 });

  function matchesSealedPriceRule(record, rule) {
    if (rule.setCode && String(record.setCode || "").toLowerCase() !== rule.setCode) return false;
    if (rule.nameContains && !String(record.name || "").toLowerCase().includes(rule.nameContains)) return false;
    return true; // no filters set at all = catch-all, same "unfilled = matches everything" convention as card rules
  }

  function ruleForSealedPriceRecord(record) {
    const active = state.sealedPriceRules.filter(r => r.on)
      .slice().sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    return active.find(r => matchesSealedPriceRule(record, r)) || null;
  }

  const isSealedListed = record => Number(record.listedQty) > 0;

  function sealedBulkPriceTarget(record) {
    if (!isSealedListed(record)) return { target: null, rule: null, excluded: false, market: null };
    const rule = ruleForSealedPriceRecord(record);
    const market = record.price == null ? null : Number(record.price);
    const excluded = !!(rule && rule.mode === "exclude");
    return { target: priceRuleTarget(rule, market), rule, excluded, market };
  }

  function sealedBulkPricePlan(opts) {
    const o = opts || {};
    const rows = o.rows || state.sealed;
    const forcedRule = o.ruleId ? state.sealedPriceRules.find(r => r.id === o.ruleId) : null;
    const out = [];
    for (const r of rows) {
      if (!isSealedListed(r)) continue;
      let rule, target, excluded;
      const market = r.price == null ? null : Number(r.price);
      if (forcedRule) {
        if (!matchesSealedPriceRule(r, forcedRule)) continue;
        rule = forcedRule;
        excluded = forcedRule.mode === "exclude";
        target = priceRuleTarget(forcedRule, market);
      } else {
        ({ target, rule, excluded } = sealedBulkPriceTarget(r));
        if (!rule) continue;
      }
      const current = r.askPrice == null ? null : Number(r.askPrice);
      if (excluded) {
        if (!o.includeUnchanged) continue;
        out.push({ record: r, market, current, target: null, delta: null, rule, excluded });
        continue;
      }
      if (target == null) {
        const zero = zeroTarget(rule, market);   // a $0.00 price is left alone, like the card plan (#98)
        out.push({ record: r, market, current, target: null, delta: null, rule, excluded: false, noBasis: !zero, zero });
        continue;
      }
      if (!o.includeUnchanged && current != null && Math.abs(current - target) < 0.005) continue;
      out.push({ record: r, market, current, target, delta: current == null ? null : round2(target - current), rule, excluded: false });
    }
    return out;
  }

  function applySealedBulkPricePlan(lines, note) {
    let changed = 0;
    const byId = lines.length > 1 ? new Map(state.sealed.map(x => [x.id, x])) : null;
    for (const line of lines) {
      if (line.excluded || line.target == null) continue;
      const rec = byId ? byId.get(line.record.id) : state.sealed.find(x => x.id === line.record.id);
      if (!rec) continue;
      const target = round2(line.target);
      if (rec.askPrice != null && Math.abs(rec.askPrice - target) < 0.005) continue;
      logAudit({
        action: "sealed-edit", name: rec.name, qty: 0,
        note: (note ? note + ": " : "") + 'rule "' + (line.rule ? line.rule.name : "?") + '"' +
          " — " + money(rec.askPrice) + " → " + money(target)
      });
      rec.askPrice = target;
      changed++;
    }
    return { changed };
  }

  /* Manapool identity for a sealed row - just the vendor-neutral
     tcgplayerProductId, unlike manapoolIdentityKey's four-field key for
     cards, since sealed has no lang/finish/condition tiers to fold in. */
  const sealedIdentityKey = r => String(r.tcgplayerProductId || "");
  function sealedManapoolGroup(identityKey) {
    return state.sealed.filter(r => sealedIdentityKey(r) === identityKey);
  }

  /* ============================== Query engine ============================== */
  function emptyQuery() {
    return {
      name: "", set: "", num: "", type: "", oracle: "", artist: "", keyword: "", mana: "", setType: "",
      lang: "", finish: "", condition: "", loc: "", rarities: [], colorField: "colors", colors: [], colorMode: "any",
      cmcMin: null, cmcMax: null, priceMin: null, priceMax: null, qtyMin: null, qtyMax: null,
      relFrom: "", relTo: "",
      listed: false, sellingFast: false, promo: false, fullArt: false, reserved: false, noPrice: false,
      needsMeta: false, failed: false, hasCost: false, noCost: false,
      // otag/art are the raw text typed into the query builder; otagIds/artIds
      // are the resolved Scryfall oracle-id / scryfall-id Sets it looks up
      // live (see cardsApi.tagSearch) - null while unresolved, a Set (however
      // small, even empty) once a lookup has actually completed. matchesQuery
      // only filters on the resolved Set, never the raw text.
      otag: "", otagIds: null, art: "", artIds: null
    };
  }
  const numOrNull = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const hasText = (hay, needle) => String(hay == null ? "" : hay).toLowerCase().includes(needle);

  function queryFieldCount(q) {
    if (!q) return 0;
    let n = 0;
    ["name", "set", "num", "type", "oracle", "artist", "keyword", "mana", "setType", "lang", "finish", "condition", "loc", "relFrom", "relTo", "otag", "art"]
      .forEach(k => { if (q[k]) n++; });
    ["cmcMin", "cmcMax", "priceMin", "priceMax", "qtyMin", "qtyMax"].forEach(k => { if (q[k] != null) n++; });
    ["listed", "sellingFast", "promo", "fullArt", "reserved", "noPrice", "needsMeta", "failed", "hasCost", "noCost"]
      .forEach(k => { if (q[k]) n++; });
    if (q.rarities && q.rarities.length) n++;
    if (q.colors && q.colors.length) n++;
    return n;
  }

  function matchesQuery(r, q) {
    if (!q) return true;
    if (q.name && !hasText(r.name, q.name)) return false;
    if (q.set && !hasText(r.set, q.set)) return false;
    if (q.num && !hasText(r.collector, q.num)) return false;
    if (q.type && !hasText(r.typeLine, q.type)) return false;
    if (q.oracle && !hasText(r.oracle, q.oracle)) return false;
    if (q.artist && !hasText(r.artist, q.artist)) return false;
    if (q.mana && !hasText(r.manaCost, q.mana)) return false;
    if (q.setType && !hasText(r.setType, q.setType)) return false;
    if (q.keyword && !(r.keywords || []).some(k => hasText(k, q.keyword))) return false;
    if (q.lang && r.lang !== q.lang) return false;
    if (q.finish && r.finish !== q.finish) return false;
    if (q.condition && (r.condition || "NM") !== q.condition) return false;
    if (q.loc && r.locationId !== q.loc) return false;
    if (q.rarities && q.rarities.length && !q.rarities.includes(String(r.rarity || "").toLowerCase())) return false;
    // Oracle tags apply to the rules card (shared by every printing), so
    // match on oracleId; art tags are specific to one printing's artwork, so
    // match on the exact scryfallId. A field with typed text but no resolved
    // Set yet (still looking up, or the lookup failed) is treated as not
    // filtering anything, same as if it were empty - see emptyQuery().
    if (q.otagIds && !(r.oracleId && q.otagIds.has(r.oracleId))) return false;
    if (q.artIds && !(r.scryfallId && q.artIds.has(r.scryfallId))) return false;

    const cmc = r.cmc == null ? null : Number(r.cmc);
    if (q.cmcMin != null && (cmc == null || cmc < q.cmcMin)) return false;
    if (q.cmcMax != null && (cmc == null || cmc > q.cmcMax)) return false;
    if (q.priceMin != null && (r.price == null || r.price < q.priceMin)) return false;
    if (q.priceMax != null && (r.price == null || r.price > q.priceMax)) return false;
    if (q.qtyMin != null && r.quantity < q.qtyMin) return false;
    if (q.qtyMax != null && r.quantity > q.qtyMax) return false;
    if (q.relFrom && !(r.releasedAt && r.releasedAt >= q.relFrom)) return false;
    if (q.relTo && !(r.releasedAt && r.releasedAt <= q.relTo)) return false;

    if (q.colors && q.colors.length) {
      let cs = (q.colorField === "identity" ? r.colorIdentity : r.colors) || [];
      cs = cs.slice();
      if (!cs.length) cs = ["C"];
      const want = q.colors;
      if (q.colorMode === "any" && !want.some(c => cs.includes(c))) return false;
      if (q.colorMode === "all" && !want.every(c => cs.includes(c))) return false;
      if (q.colorMode === "exact" && (want.length !== cs.length || !want.every(c => cs.includes(c)))) return false;
    }

    if (q.listed && !(r.listedQty > 0)) return false;
    // #366: the printing is SELLING FAST on Manapool (loadSoldMine); nothing
    // matches until that has loaded, or while it is too early to compare.
    if (q.sellingFast) { const x = soldOf(r); if (!(x && x.hot)) return false; }
    if (q.promo && !r.promo) return false;
    if (q.fullArt && !r.fullArt) return false;
    if (q.reserved && !r.reserved) return false;
    if (q.noPrice && r.price != null) return false;
    if (q.needsMeta && r.typeLine) return false;
    if (q.failed && !r.lookupFail) return false;
    if (q.hasCost && !(Number(r.costQty) > 0)) return false;
    if (q.noCost && Number(r.costQty) > 0) return false;
    return true;
  }

  /* ============================== Price refresh ============================== */
  /* The server answers from the bulk file it already holds, so the 75-identifier
     ceiling, the padded-collector-number probing and the "look the stragglers
     up one at a time?" prompt from v0.07 are all gone. POST /api/cards/collection
     does keep only the first COLLECTION_BATCH identifiers of a request, though,
     so identifiers go up in batches of at most that many (deduped first: stacks
     of one printing in several finishes/conditions share one identifier) and
     the answers are merged before any row is touched.
     A batch that throws is retried once. If it fails again, its stacks are
     left exactly as they were (old price, NOT flagged "lookup failed") and
     counted in `skipped`; the other batches still apply. If every batch
     fails the refresh throws with nothing changed.
     The answers are applied to state.cards as it is AFTER the last batch,
     not the array captured at the start: a merged save, undo/redo or import
     can replace state.cards while the batches are in flight (adoptState),
     and writing to the old array would silently lose every price. A stack
     whose identifier wasn't asked about (added mid-refresh) is skipped too. */
  const COLLECTION_BATCH = 20000; // keep in step with server/index.js POST /api/cards/collection
  async function refreshPrices(onProgress, opts) {
    if (!state.cards.length) return { updated: 0, missing: 0, rows: 0, skipped: 0 };
    const report = onProgress || function () {};
    const batchSize = Math.max(1, Math.min(COLLECTION_BATCH, (opts && opts.batchSize) || COLLECTION_BATCH));
    const askKey = r => r.scryfallId ? "id:" + r.scryfallId : printKey(r.set, r.collector, r.lang);

    const identifiers = [];
    const keys = [];
    const seen = new Set();
    for (const r of state.cards) {
      const key = askKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      identifiers.push({ set: r.set, collector: r.collector, lang: r.lang, id: r.scryfallId || undefined });
    }
    const batches = Math.ceil(identifiers.length / batchSize);
    const found = new Map();
    const answered = new Set(); // identifier keys whose batch came back
    let liveTried = 0, lastError = null;
    for (let b = 0; b < batches; b++) {
      const chunk = identifiers.slice(b * batchSize, (b + 1) * batchSize);
      report("Asking the server for " + identifiers.length + " printing" + (identifiers.length === 1 ? "" : "s") +
        (batches > 1 ? " (batch " + (b + 1) + " of " + batches + ")" : "") + "…");
      let out = null;
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        try { out = await cardsApi.collection(chunk); }
        catch (e) { lastError = e; }
      }
      if (!out) continue;
      liveTried += out.liveTried || 0;
      for (const k of keys.slice(b * batchSize, (b + 1) * batchSize)) answered.add(k);
      for (const c of out.found || []) {
        found.set(printKey(c.set, c.collector, c.lang), c);
        if (c.id) found.set("id:" + c.id, c);
      }
    }
    if (!answered.size) throw lastError || new Error("The card database didn't answer.");

    const rows = state.cards;
    let updated = 0, priceChanged = 0, missing = 0, metaFilled = 0, skipped = 0;
    const now = new Date().toISOString();
    for (const r of rows) {
      if (!answered.has(askKey(r))) { skipped++; continue; }
      const card =(r.scryfallId && found.get("id:" + r.scryfallId)) ||
        found.get(printKey(r.set, r.collector, r.lang)) ||
        found.get(printKey(r.set, r.collector, "en"));
      if (!card) {
        missing++;
        r.lookupFail = { at: now, why: "not in the card database" };
        continue;
      }
      r.lookupFail = null;
      const before = r.price;
      const wasBare = !r.typeLine;
      const price = priceOf(card, r.finish);
      r.price = price;
      r.priceNote = price == null ? "no-" + r.finish + "-price" : "";
      r.priceUpdated = now;
      // Manapool's public price catalog, joined server-side by scryfall id -
      // both foil variants and both condition tiers travel together (see
      // POST /api/cards/collection), so pick this row's own combination.
      // Manapool has no separate etched price tier at all - the foil one is
      // the closest real comp, same reasoning as the bulk-price rule engine
      // (server/lib/priceRules.js) uses for the same gap.
      const isNm = (r.condition || "NM") === "NM";
      const useFoilBasis = r.finish === "foil" || r.finish === "etched";
      const mpLow = useFoilBasis ? (isNm ? card.mpLowNmFoil : card.mpLowOtherFoil) : (isNm ? card.mpLowNm : card.mpLowOther);
      const mpMarket = useFoilBasis ? card.mpMarketFoil : card.mpMarket;
      r.mpLow = mpLow == null ? null : Number(mpLow);
      r.mpMarket = mpMarket == null ? null : Number(mpMarket);
      // TCGplayer/Card Kingdom/Manapool for this row's finish (price-rule
      // vendor bases, priceRuleEngine.js) - absent when the archive has none.
      r.vp = (card.vendor && card.vendor[r.finish || "nonfoil"]) || null;
      r.name = cardName(card) || r.name;
      r.collector = String(card.collector || r.collector);
      r.setName = card.setName || r.setName;
      r.rarity = card.rarity || r.rarity;
      r.tcgplayerId = card.tcgplayerId || r.tcgplayerId;
      r.scryfallId = card.id || r.scryfallId;
      Object.assign(r, pickMeta(card));
      updated++;
      if (before !== r.price) priceChanged++;
      if (wasBare && r.typeLine) metaFilled++;
    }
    normalizeMerge({ silent: true });
    logAudit({
      action: "price", qty: 0,
      note: "Price & data refresh: " + updated + " updated, " + priceChanged + " price changes" +
        (metaFilled ? ", " + metaFilled + " backfilled with card data" : "") +
        (missing ? ", " + missing + " not found" : "") +
        (skipped ? ", " + skipped + " not refreshed (the server didn't answer)" : "")
    });
    persist("Price refresh");
    return { rows: rows.length, updated, priceChanged, missing, metaFilled, liveTried, skipped };
  }

  /* Sealed's equivalent of refreshPrices() above, much simpler - no
     metadata to reconcile, just re-reading the current market price from
     the server's already daily-refreshed sealed catalog (server/lib/
     sealed.js) via GET /api/sealed/lookup. A row whose id the catalog no
     longer recognizes (delisted product) is left untouched, not zeroed -
     the same "never silently erase a price nobody asked to change" stance
     refreshPrices takes for a missing card. */
  async function refreshSealedPrices() {
    const rows = state.sealed;
    if (!rows.length) return { rows: 0, updated: 0, missing: 0 };
    const ids = [...new Set(rows.map(r => r.tcgplayerProductId).filter(Boolean))];
    const out = await api("/api/sealed/lookup?ids=" + ids.map(encodeURIComponent).join(","));
    const byId = new Map((out.data || []).map(p => [p.tcgplayerProductId, p]));
    const now = new Date().toISOString();
    let updated = 0, missing = 0;
    for (const r of rows) {
      const p = byId.get(r.tcgplayerProductId);
      if (!p) { missing++; continue; }
      const before = r.price;
      r.price = p.marketPrice == null ? null : Number(p.marketPrice);
      r.priceUpdated = now;
      if (before !== r.price) updated++;
    }
    logAudit({ action: "price", qty: 0,
      note: "Sealed price refresh: " + updated + " updated" + (missing ? ", " + missing + " not found in the catalog" : "") });
    persist("Sealed price refresh");
    return { rows: rows.length, updated, missing };
  }

  /* ============================== Receipts ============================== */
  function nextReceiptId(kind) {
    const prefix = kind === "lot" ? "LOT" : kind === "transfer" ? "XFR" : "COL";
    const year = new Date().getFullYear();
    const used = state.receipts.filter(r => String(r.receiptId || "").startsWith(prefix + "-" + year)).length;
    // A receipt open on the floor (#388) already has its number: skip past it.
    const taken = new Set(state.receipts.map(r => r.receiptId).concat((state.receiving || []).map(r => r.receiptId)));
    let n = used + 1, id;
    do { id = prefix + "-" + year + "-" + String(n++).padStart(4, "0"); } while (taken.has(id));
    return id;
  }

  function recordReceipt(receipt) {
    const doc = Object.assign({
      id: uid(), ts: new Date().toISOString(), kind: "collection",
      receiptId: "", source: "", note: "", spend: null, allocation: "market",
      lines: [], totalCards: 0, totalCost: 0, fromUser: ""
    }, receipt);
    doc.totalCards = doc.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    doc.totalCost = round2(doc.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0));
    state.receipts.unshift(doc);
    if (state.receipts.length > 2000) state.receipts.length = 2000;
    return doc;
  }

  const receiptById = id => state.receipts.find(r => r.id === id || r.receiptId === id);

  /* ============================== Mana Pool purchases (#353) ==============================
     Receive's "Mana Pool order" source turns an order the user bought on
     Mana Pool (the server's normalized buyer order) into a lot receipt. */

  // Seller packages already on a posted receipt: package id -> receipt number.
  function mpReceivedPackages() {
    const out = new Map();
    for (const r of state.receipts) {
      const ids = r && r.manapool && Array.isArray(r.manapool.packageIds) ? r.manapool.packageIds : [];
      for (const id of ids) if (!out.has(id)) out.set(id, r.receiptId || r.id);
    }
    return out;
  }

  /* The chosen packages (all when none named) -> lot lines and what was paid
     for them. Each line keeps `paid`, its price each. The spend is the goods
     that arrive (refunded copies are already off the quantity) + each
     package's shipping + the order's tax pro rata to those goods. Spread by
     price paid (allocateLotCost weighting by `paid`), every line gets its
     price plus a share of shipping and tax, and the lines add up to the spend. */
  function mpPurchaseLot(order, packageIds) {
    const want = packageIds && packageIds.length ? new Set(packageIds) : null;
    const pkgs = ((order && order.packages) || []).filter(p => !want || want.has(p.id));
    const lines = [];
    let goods = 0, shipping = 0;
    for (const p of pkgs) {
      shipping += Number(p.shipping) || 0;
      for (const it of p.items || []) {
        const qty = Math.max(0, Math.round(Number(it.qty) || 0));
        if (!qty) continue;
        const paid = round2(Number(it.unitPrice) || 0);
        goods += paid * qty;
        lines.push(Object.assign({}, it, { packageId: p.id, seller: p.seller || "", qty, paid }));
      }
    }
    const sub = Number(order && order.subtotal) || 0;
    const tax = sub > 0 ? (Number(order.tax) || 0) * Math.min(1, goods / sub) : 0;
    return {
      lines,
      packages: pkgs.map(p => ({ id: p.id, seller: p.seller || "", receivedAt: p.receivedAt || null })),
      goods: round2(goods), shipping: round2(shipping), tax: round2(tax),
      spend: round2(round2(goods) + round2(shipping) + round2(tax))
    };
  }

  /* Copies already in inventory with this exact printing, finish, condition
     and language, in any location. */
  function ownedCopies(l) {
    const lang = l.lang || "en", finish = l.finish || "nonfoil", cond = l.condition || "NM";
    const stacks = state.cards.filter(r => r.set === l.set && normNum(r.collector) === normNum(l.collector) &&
      (r.lang || "en") === lang && (r.finish || "nonfoil") === finish && (r.condition || "NM") === cond);
    let qty = 0, newest = "";
    for (const r of stacks) {
      qty += Number(r.quantity) || 0;
      if (String(r.acquiredAt || "") > newest) newest = String(r.acquiredAt || "");
    }
    return { qty, stacks, newestAcquiredAt: newest || null };
  }

  /* A purchased line that is already in inventory: "cost" (already have it,
     just set the cost) only when some matching copies have NO cost and were
     added on or after the order date, so they are most likely these very
     cards entered by hand; else "new". Copies that already carry a cost (a
     costed receipt, a pull sheet) or came in on a receipt for this same
     Mana Pool order (the other seller's package of the same card) never
     count. null when nothing matches. */
  function mpDupeDefault(l, orderDate, orderId) {
    const o = ownedCopies(l);
    if (!o.qty) return null;
    const placed = Date.parse(orderDate || "");
    if (isNaN(placed)) return "new";
    const sameOrder = new Set(orderId ? state.receipts
      .filter(r => r && r.manapool && r.manapool.orderId === orderId).map(r => r.receiptId) : []);
    const fresh = o.stacks.some(r => {
      const added = Date.parse(r.acquiredAt || "");
      return !isNaN(added) && added >= placed &&
        (Number(r.quantity) || 0) > (Number(r.costQty) || 0) &&
        !(r.lastReceiptId && sameOrder.has(r.lastReceiptId));
    });
    return fresh ? "cost" : "new";
  }

  /* "Already have it, just set the cost": give up to qty owned copies this
     cost, newest stacks first, adding nothing. Copies with no cost yet take it
     first; past those, the stack's existing basis gives way for the rest.
     Returns how many copies got the cost (fewer than qty if fewer are owned). */
  function costOwnedCopies(o) {
    const stacks = ownedCopies(o).stacks.slice()
      .sort((a, b) => String(b.acquiredAt || "").localeCompare(String(a.acquiredAt || "")));
    let left = Math.max(0, Math.round(Number(o.qty) || 0)), done = 0;
    for (const rec of stacks) {
      if (left <= 0) break;
      const n = Math.min(left, Number(rec.quantity) || 0);
      if (n <= 0) continue;
      const uncosted = Math.max(0, rec.quantity - (Number(rec.costQty) || 0));
      if (o.unitCost != null) {
        if (n > uncosted) removeCost(rec, n - uncosted);
        applyCost(rec, n, o.unitCost);
      }
      logAudit({
        action: "cost", ...auditCard(rec), qty: 0, oldQty: rec.quantity, newQty: rec.quantity,
        from: locName(rec.locationId), cost: o.unitCost == null ? null : round2(o.unitCost * n),
        receiptId: o.receiptId || "", note: (o.note || "").trim()
      });
      left -= n; done += n;
    }
    return done;
  }

  /* ============================== Trades made in person (#335) ==============================
     "Record a trade": cards that went out and cards that came in, in one
     step, with a history (state.trades, keyed by id in merge.js). Values are
     each card's Near Mint market price; a card with no price isn't counted
     and the record says how many weren't (#326). The cards received carry
     the market value of the cards given as their cost basis, split by market
     value like a lot (allocateLotCost), so profit stays honest (owner,
     2026-10-28). Nothing given with a price means no cost is known: the
     received cards get none, rather than a made-up $0.
     Record: { id, ts, date "YYYY-MM-DD", who, note, gave: [line], got: [line],
     gaveValue, gotValue, gaveUnpriced, gotUnpriced, costTotal }. The array
     isn't kept in order (a save merged with another device's puts the new
     record after the older ones), so tradesNewestFirst orders it, by trade
     date then ts, wherever order matters: drawing it, and the TRADES_MAX
     cap, which keeps the newest. A line is { name, set, collector, lang,
     finish, condition, qty, price (each, or null), imageUrl } and, on the
     got side, unitCost (each, or null). Deleting a record never moves cards. */
  const TRADES_MAX = 1000;
  // A sorted copy, newest trade date first, then latest recorded (ts).
  function tradesNewestFirst(list) {
    const k = t => String((t && t.date) || "") + " " + String((t && t.ts) || "");
    return (list || []).slice().sort((a, b) => { const x = k(a), y = k(b); return x < y ? 1 : x > y ? -1 : 0; });
  }
  function tradeLine(l) {
    const s = l || {};
    const price = s.price == null || s.price === "" || !isFinite(Number(s.price)) ? null : round2(Number(s.price));
    const out = {
      name: String(s.name || "").slice(0, 200), set: String(s.set || "").toLowerCase(), collector: String(s.collector || ""),
      lang: s.lang || "en", finish: normalizeFinish(s.finish) || "nonfoil", condition: s.condition || "NM",
      qty: Math.max(1, parseInt(s.qty, 10) || 1), price, imageUrl: s.imageUrl || ""
    };
    if (s.unitCost !== undefined) out.unitCost = s.unitCost == null ? null : round2(Number(s.unitCost) || 0);
    return out;
  }
  // { value: priced cards' total, unpriced: how many cards have no price }
  function tradeValue(lines) {
    let value = 0, unpriced = 0;
    for (const l of lines || []) {
      const q = Number(l.qty) || 0;
      if (l.price == null) unpriced += q; else value += Number(l.price) * q;
    }
    return { value: round2(value), unpriced };
  }
  function normalizeTrade(src) {
    const s = src || {};
    const gave = (Array.isArray(s.gave) ? s.gave : []).map(tradeLine);
    const got = (Array.isArray(s.got) ? s.got : []).map(tradeLine);
    const gv = tradeValue(gave), tv = tradeValue(got);
    const ts = s.ts || new Date().toISOString();
    return {
      id: s.id || uid(), ts,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : localDay(Date.parse(ts) || Date.now()),
      who: String(s.who || "").trim().slice(0, 80), note: String(s.note || "").trim().slice(0, 500),
      gave, got,
      gaveValue: gv.value, gotValue: tv.value, gaveUnpriced: gv.unpriced, gotUnpriced: tv.unpriced,
      costTotal: s.costTotal == null ? null : round2(Number(s.costTotal) || 0)
    };
  }

  /* Applies a trade to inventory and saves its record. The caller persists.
     o: { date, who, note, locationId (where the cards received go),
          gave: [{ id: stack id, qty }],
          got: [{ set, num, lang, finish, condition, qty, info (lookupCard) }] }
     Throws, changing nothing, when a line can't be done. -> the record. */
  function recordTrade(o) {
    o = o || {};
    const gaveIn = (o.gave || []).filter(g => (parseInt(g.qty, 10) || 0) > 0);
    const gotIn = (o.got || []).filter(g => (parseInt(g.qty, 10) || 0) > 0);
    if (!gaveIn.length && !gotIn.length) throw new Error("Add the cards you gave and the cards you got first.");
    const want = new Map();
    for (const g of gaveIn) want.set(g.id, (want.get(g.id) || 0) + (parseInt(g.qty, 10) || 0));
    for (const [id, n] of want) {
      const r = state.cards.find(x => x.id === id);
      if (!r) throw new Error("One of the cards you gave isn't in your inventory any more.");
      if (n > availableQty(r)) {
        throw new Error("You only have " + availableQty(r) + " of " + r.name + (lentQty(r) ? " that aren't lent out." : "."));
      }
    }
    if (gotIn.length && !locById(o.locationId)) throw new Error("Choose where the cards you got go.");
    for (const g of gotIn) if (!g.info || !g.set || !g.num) throw new Error("A card you got hasn't been looked up yet.");

    const who = String(o.who || "").trim().slice(0, 80);
    const gave = [...want].map(([id, qty]) => {
      const r = state.cards.find(x => x.id === id);
      return tradeLine(Object.assign({}, r, { qty, price: r.price }));
    });
    const gaveValue = tradeValue(gave).value;
    const got = gotIn.map(g => tradeLine({
      name: g.info.name, set: g.set, collector: g.info.collector || g.num, lang: g.lang, finish: g.finish,
      condition: g.condition, qty: g.qty, price: g.info.price,
      imageUrl: (g.info.meta && g.info.meta.imageUrl) || ""
    }));
    const costs = gaveValue > 0 && got.length ? allocateLotCost(got.map(l => ({ qty: l.qty, market: l.price })), gaveValue, "market") : null;
    got.forEach((l, i) => { l.unitCost = costs ? round2(costs[i]) : null; });

    // Out first, then in, so a card given and got back (another printing
    // merging into the same stack) counts right.
    for (const [id, qty] of want) {
      const r = state.cards.find(x => x.id === id);
      const old = r.quantity;
      removeCost(r, qty);
      r.quantity -= qty;
      if (r.listedQty > r.quantity) r.listedQty = r.quantity;
      logAudit({ action: r.quantity > 0 ? "remove" : "delete", ...auditCard(r), qty: -qty, oldQty: old, newQty: r.quantity,
        from: locName(r.locationId), note: "Traded away" + (who ? " to " + who : "") });
      if (r.quantity <= 0) state.cards = state.cards.filter(x => x !== r);
    }
    const today = localDay(Date.now());
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || "")) ? o.date : today;
    const acquiredAt = date === today ? new Date().toISOString() : new Date(date + "T12:00:00").toISOString();
    gotIn.forEach((g, i) => {
      addCopies({
        set: g.set, num: g.num, lang: g.lang, finish: g.finish, condition: g.condition,
        locationId: o.locationId, qty: got[i].qty, info: g.info, acquiredAt,
        unitCost: got[i].unitCost, action: "add", note: "Got in a trade" + (who ? " with " + who : "")
      });
    });

    const rec = normalizeTrade({ date, who, note: o.note, gave, got, costTotal: costs ? gaveValue : null });
    state.trades = tradesNewestFirst([rec].concat(Array.isArray(state.trades) ? state.trades : [])).slice(0, TRADES_MAX);
    return rec;
  }
  // Takes a record out of the history; the cards stay as they are.
  function deleteTrade(id) {
    state.trades = state.trades.filter(t => t.id !== id);
  }

  /* ============================== Returns / RMA ==============================
     A record that a customer sent something back - see BACKLOG.md #18. Card
     lines are put back into inventory the same way a lot receipt's lines are
     (G.addCopies per line, called by returns.page.js before this runs - this
     function only records the doc, mirroring recordReceipt's own split
     between "do the inventory writes" and "log what happened"). orderId/
     orderLabel/buyer stay free text by default (an order that predates
     Manapool integration, or was never fetched) but returns.page.js can also
     tie a return to a real, already-fetched order (searched from the
     account's server-side order cache) - when it does, `orderId` is the
     order's real id and `orderSnapshot` freezes that order's placedAt/
     status/ship-to/lines at return time, since the order cache itself isn't
     part of this synced document and could evict or change later. */
  function nextReturnId() {
    const year = new Date().getFullYear();
    const used = state.returns.filter(r => String(r.returnId || "").startsWith("RMA-" + year)).length +
      (state.receiving || []).filter(r => r.kind === "return" && String(r.receiptId || "").startsWith("RMA-" + year)).length;
    let n = used + 1, id;
    do { id = "RMA-" + year + "-" + String(n++).padStart(4, "0"); }
    while (state.returns.some(r => r.returnId === id) || (state.receiving || []).some(r => r.receiptId === id));
    return id;
  }
  function recordReturn(ret) {
    const doc = Object.assign({
      id: uid(), ts: new Date().toISOString(), returnId: "",
      orderId: "", orderLabel: "", buyer: "", disposition: "restock", locationId: "",
      reason: "", note: "", refundTotal: null, lines: [], totalQty: 0, orderSnapshot: null
    }, ret);
    if (!doc.returnId) doc.returnId = nextReturnId();
    doc.totalQty = doc.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    state.returns.unshift(doc);
    if (state.returns.length > 2000) state.returns.length = 2000;
    return doc;
  }
  const returnById = id => state.returns.find(r => r.id === id || r.returnId === id);

  /* ============================== Monthly P&L (issue #48) ==============================
     Rolls the Accounting page's own rows (accountingRows() in
     accounting.page.js: {date, type: "Sale"|"Receipt"|"Return", revenue,
     cogs, fees, spend, refund, costBack}) up into one row per calendar month, so the
     P&L can never disagree with the tiles/CSV built from the same rows.

     Month boundaries are LOCAL time, not UTC, on purpose: the page's From/To
     range is local midnight to 23:59:59, the transactions table prints local
     dates, and the daily chart buckets by local day. A UTC month would put a
     US seller's 8pm Oct 31 sale into November while every other view on the
     same page says Oct 31.

     Line definitions (each total equals the matching tile for the range):
     - revenue  = sale revenue (item prices + buyer-paid shipping)
     - cogs     = sale cost basis
     - gross    = revenue - cogs (the "Gross profit" tile)
     - fees     = Manapool's seller fee; a sale whose fee was never fetched
                  counts $0 and is counted in salesMissingFees instead
     - refunds  = refunds recorded on returns (the "Refunds" tile)
     - costBack = returned stock's cost going back into inventory (see
                  returnCostBack() below); not a tile, but a column in the
                  transactions CSV
     - net      = gross - fees - refunds + costBack
     Refunds and costBack sit below gross profit (gross stays equal to its
     tile), so a month with returns has a gross profit that ignores them.
     Receipt spend is deliberately left out: buying stock isn't an expense
     until it sells, and it reaches the P&L then, as COGS. Counting both
     would charge the same cards twice.

     fromMs/toMs bound the months listed (so a quiet month in the range still
     gets a $0 row); either may be null, in which case the rows' own first/
     last dates stand in. Each month's start/end is clipped to the range so a
     partial first or last month says so. */
  /* Whether a return with this disposition puts its cost basis back into
     the stack. Only a restock does (a missing disposition predates the
     field and was a restock). A "damaged" or "other" return is a write-off:
     its copies still go into the chosen bin, but with no cost basis, or a
     later sale of that stack would charge the same cost to COGS twice.
     returns.page.js (what it passes to addCopies) and returnCostBack()
     below both use this, so the two always agree. */
  function returnRestoresCost(disposition) {
    return (disposition || "restock") === "restock";
  }

  /* The cost a return puts back into inventory, which the P&L adds back.
     returns.page.js posts each return line with G.addCopies({ unitCost }),
     so that cost re-enters the stack's basis and is charged to COGS again
     when the card resells. The original sale's COGS is never reversed, so
     without this the same card's cost would be counted twice (sell $4 card
     for $10, refund it, resell for $10: $2 net instead of $6).
     Restocked returns only (a return with no disposition predates the field
     and was a restock): a "damaged" or "other" return is a write-off, so its
     original COGS rightly stays charged. Lines with no unitCost went back
     with no basis, so nothing is charged twice and nothing is added back. */
  function returnCostBack(ret) {
    if (!ret || !returnRestoresCost(ret.disposition)) return 0;
    let total = 0;
    for (const l of ret.lines || []) {
      if (!returnRestoresCost(l.disposition)) continue;   // a floor return can mix restock and damaged lines (#411)
      if (l.unitCost == null || l.unitCost === "") continue;
      const cost = Number(l.unitCost), qty = Number(l.qty);
      if (cost > 0 && qty > 0) total += cost * qty;
    }
    return round2(total);
  }

  /* "YYYY-MM-DD" of a timestamp in LOCAL time. toISOString() gives the UTC
     date, a day off east of UTC (or west of it in the evening). */
  function localDay(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  /* The Accounting page's date presets as {from, to} "YYYY-MM-DD" strings,
     for "now". Day counts step by calendar day (setDate), not by
     N * 86400000 ms, which lands a day early across a DST change. null for
     an unknown key. */
  function accountingPresetRange(key, now) {
    const today = new Date(now == null ? Date.now() : now);
    const y = today.getFullYear(), m = today.getMonth();
    let from, to = new Date(y, m, today.getDate());
    if (key === "7" || key === "30") {
      from = new Date(y, m, today.getDate() - Number(key));
    } else if (key === "month") {
      from = new Date(y, m, 1);
    } else if (key === "lastMonth") {
      from = new Date(y, m - 1, 1);
      to = new Date(y, m, 0);
    } else if (key === "quarter") {
      from = new Date(y, Math.floor(m / 3) * 3, 1);
    } else if (key === "ytd") {
      from = new Date(y, 0, 1);
    } else {
      return null;
    }
    return { from: localDay(from.getTime()), to: localDay(to.getTime()) };
  }

  function monthKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function pnlByMonth(rows, fromMs, toMs) {
    rows = rows || [];
    const blank = () => ({ sales: 0, salesMissingFees: 0, returns: 0,
      revenue: 0, cogs: 0, fees: 0, shipping: 0, refunds: 0, costBack: 0 });
    const add = (b, r) => {
      if (r.type === "Sale") {
        b.sales++;
        b.revenue += Number(r.revenue) || 0;
        b.cogs += Number(r.cogs) || 0;
        if (r.fees == null) b.salesMissingFees++;
        else b.fees += Number(r.fees) || 0;
        b.shipping += Number(r.shipping) || 0;   // packing + postage (#457)
      } else if (r.type === "Return") {
        b.returns++;
        b.refunds += Number(r.refund) || 0;
        b.costBack += Number(r.costBack) || 0;
      }
    };
    const finish = b => {
      const out = Object.assign({}, b);
      out.revenue = round2(b.revenue); out.cogs = round2(b.cogs);
      out.fees = round2(b.fees); out.shipping = round2(b.shipping); out.refunds = round2(b.refunds); out.costBack = round2(b.costBack);
      out.gross = round2(b.revenue - b.cogs);
      out.net = round2(b.revenue - b.cogs - b.fees - b.shipping - b.refunds + b.costBack);
      return out;
    };
    const dated = [];
    for (const r of rows) {
      const t = Date.parse(r && r.date);
      if (!isNaN(t)) dated.push({ t, r });
    }
    let startMs = fromMs, endMs = toMs;
    if (startMs == null || endMs == null) {
      if (!dated.length) {
        if (startMs == null && endMs == null) return { months: [], totals: finish(blank()) };
      } else {
        const ts = dated.map(x => x.t);
        if (startMs == null) startMs = Math.min.apply(null, ts);
        if (endMs == null) endMs = Math.max.apply(null, ts);
      }
      if (startMs == null) startMs = endMs;
      if (endMs == null) endMs = startMs;
    }
    if (endMs < startMs) return { months: [], totals: finish(blank()) };
    const byMonth = new Map();
    const totals = blank();
    for (const { t, r } of dated) {
      if (t < startMs || t > endMs) continue; // outside the range: neither a month row nor the totals
      const key = monthKey(new Date(t));
      let b = byMonth.get(key);
      if (!b) { b = blank(); byMonth.set(key, b); }
      add(b, r);
      add(totals, r);
    }
    const months = [];
    const first = new Date(startMs), last = new Date(endMs);
    // Step by calendar month in local time (setMonth on the 1st), never by a
    // fixed number of ms - months differ in length and DST shifts an hour.
    for (const d = new Date(first.getFullYear(), first.getMonth(), 1);
      d.getFullYear() < last.getFullYear() ||
      (d.getFullYear() === last.getFullYear() && d.getMonth() <= last.getMonth());
      d.setMonth(d.getMonth() + 1)) {
      const key = monthKey(d);
      const monthStart = d.getTime();
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
      const row = finish(byMonth.get(key) || blank());
      row.key = key;
      row.year = d.getFullYear();
      row.month = d.getMonth() + 1;
      row.start = Math.max(monthStart, startMs);
      row.end = Math.min(monthEnd, endMs);
      // Partial by whole days: the page's range ends at 23:59:59, not .999,
      // and a range with no From starts at the first row's own timestamp,
      // so a millisecond comparison would call a fully covered month partial.
      row.partial = row.start >= new Date(d.getFullYear(), d.getMonth(), 2).getTime() ||
        row.end < new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
      months.push(row);
    }
    return { months, totals: finish(totals) };
  }

  /* ============================== Dashboard tiles (#298) ==============================
     Each person picks, orders and sizes their Dashboard tiles. The layout is
     a personal pref (PERSONAL_KEYS "dashTiles"): the tiles shown, in order,
     as [{ id, wide? }]; a tile not in the list is hidden. null (or never
     set) is the default layout. The server keeps the same shape
     (orgs.personalPrefsFrom), well inside /api/prefs/personal's 4 KB body.

     dashLayout(saved, allowed, defaults): the tiles to draw. allowed is the
     ids this person may see right now (mode, role). An id that's gone or
     not allowed is skipped quietly, so a layout saved in full mode still
     works in Simple mode and comes back whole on switching back. */
  const DASH_TILE_ID = /^[a-z][a-zA-Z0-9-]{0,31}$/;
  const DASH_TILES_MAX = 60;
  function dashLayoutClean(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set(), out = [];
    for (const t of list) {
      const id = t && typeof t === "object" ? t.id : null;
      if (typeof id !== "string" || !DASH_TILE_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(t.wide === true ? { id, wide: true } : { id });
      if (out.length >= DASH_TILES_MAX) break;
    }
    return out;
  }
  function dashLayout(saved, allowed, defaults) {
    const ok = new Set(allowed);
    const list = dashLayoutClean(saved) || (defaults || []).map(id => ({ id }));
    return list.filter(t => ok.has(t.id));
  }

  /* The counts behind the tiles, from data already in the document. */
  const dayStartMs = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const monthStartMs = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  const tsIn = (iso, fromMs, toMs) => { const t = Date.parse(iso || ""); return !isNaN(t) && t >= fromMs && t <= toMs; };
  // Order sales (Manapool and counter, #431) in the range, by saleDate: orders, copies and revenue.
  function salesBetween(fromMs, toMs) {
    let orders = 0, copies = 0, revenue = 0;
    for (const p of pickLists()) {
      if (!isOrderSale(p) || !tsIn(saleDate(p), fromMs, toMs)) continue;
      orders++;
      copies += (p.lines || []).reduce((s, l) => s + (Number(l.qty) || 0), 0);
      revenue += Number(p.revenue) || 0;
    }
    return { orders, copies, revenue: round2(revenue) };
  }
  // Net profit over the range: the same rows and sums as Accounting's P&L.
  function profitBetween(fromMs, toMs) {
    const rows = [];
    for (const p of pickLists()) {
      const date = saleDate(p), counter = isCounterSale(p);
      if (!date || (!counter && !p.revenue && !p.cogs)) continue;
      rows.push({ date, type: "Sale", revenue: Number(p.revenue) || 0, cogs: Number(p.cogs) || 0,
        fees: counter ? 0 : p.fees == null ? null : Number(p.fees), shipping: saleShipCost(p) });
    }
    for (const r of state.returns) {
      rows.push({ date: r.ts, type: "Return", refund: r.refundTotal == null ? null : Number(r.refundTotal), costBack: returnCostBack(r) });
    }
    return pnlByMonth(rows, fromMs, toMs).totals;
  }
  function receiptsSince(fromMs) {
    const list = state.receipts.filter(r => tsIn(r.ts, fromMs, Infinity));
    return { receipts: list, cards: list.reduce((s, r) => s + (Number(r.totalCards) || 0), 0) };
  }
  function returnsSince(fromMs) {
    const list = state.returns.filter(r => tsIn(r.ts, fromMs, Infinity));
    return { returns: list.length, copies: list.reduce((s, r) => s + (Number(r.totalQty) || 0), 0) };
  }
  // Locations with a ceiling that are at least `pct` percent full, over included.
  function nearlyFullLocations(pct) {
    const at = pct == null ? 90 : pct;
    const out = [];
    for (const l of state.locations) {
      const st = locStats(l.id);
      if (st.cap > 0 && st.fillPct >= at) out.push({ location: l, cards: st.cards, cap: st.cap, fillPct: st.fillPct });
    }
    return out.sort((a, b) => b.fillPct - a.fillPct);
  }
  // Copies with no cost basis: each stack's quantity beyond its costed copies.
  function copiesWithoutCost() {
    let n = 0;
    for (const r of state.cards) n += Math.max(0, (Number(r.quantity) || 0) - (Number(r.costQty) || 0));
    return n;
  }
  // The n priciest stacks by price per copy: one pass, no sort of every stack.
  function topCardsByPrice(n) {
    const top = [];
    for (const r of state.cards) {
      if (r.price == null || !(r.quantity > 0)) continue;
      if (top.length >= n && r.price <= top[top.length - 1].price) continue;
      let i = top.length;
      while (i > 0 && top[i - 1].price < r.price) i--;
      top.splice(i, 0, r);
      if (top.length > n) top.pop();
    }
    return top;
  }
  // Customer wants that stock could fill right now, and how many customers.
  function wantsInStock() {
    const avail = currentWantAvailability();
    const hit = state.customerWants.filter(w => (avail.get(w.id) || 0) > 0);
    return { wants: hit.length, customers: new Set(hit.map(w => w.customerId)).size };
  }
  /* #299: listings (one per Manapool card, or per stack with no Scryfall id)
     that have no price to send: no rule gives one and there's no market
     price either, so a push would skip them. One pass over the listed stacks. */
  function listedWithoutAsk() {
    const keys = new Set();
    for (const r of state.cards) if (isListed(r)) keys.add(listingAskKey(r));
    if (!keys.size) return 0;
    let n = 0;
    for (const info of manapoolListingAsks(keys).values()) if (info.ask == null) n++;
    return n;
  }
  /* The collection's value change from /api/prices/movers' `held` summary:
     only cards priced at both ends of the window count, so a card that got
     its first price mid-week (a new set) doesn't blank the figure. null when
     no snapshot from the window's start exists or nothing could be compared.
     thenValue (the same cards' start value) gives the percentage; a server
     from before it existed sends none, and then there's no percentage. */
  function heldChange(d) {
    const h = d && d.held;
    if (!h || !d.fromDate || typeof h.netValue !== "number") return null;
    if (!(h.thenValue > 0) && !h.up && !h.down) return null;
    const delta = round2(h.netValue);
    return { delta, pct: h.thenValue > 0 ? (100 * h.netValue) / h.thenValue : null, from: d.fromDate, to: d.toDate };
  }

  /* Sold 7d on your own stock (#366): copies sold on Manapool in the last 7
     days, and the SELLING FAST flag, for every printing the account holds.
     /api/prices/sold-mine answers per set + collector number (Manapool
     counts per printing, so every finish, condition, language and location
     of one shares the number). loadSoldMine() fetches it once per page
     (force: again) and emits "sold" when it lands, so a table drawn before
     then can redraw. soldOf(r): null while not loaded, with no history yet
     or no printing matched; else { n, atLeast, hot }, where atLeast means
     the count is a minimum and hot is null while it's too early to compare. */
  let soldMine = null, soldMineLoad = null;
  const soldKey = r => r.set + "|" + r.collector;
  function loadSoldMine(force) {
    if (soldMineLoad && !force) return soldMineLoad;
    const take = d => {
      soldMine = {
        sales: (d && d.sales) || {},
        by: new Map(Object.entries((d && d.sold) || {})),
        unmatched: new Set((d && d.unmatched) || [])
      };
      emit("sold", soldMine);
      return soldMine;
    };
    soldMineLoad = api("/api/prices/sold-mine").then(take, () => take({ sales: { error: "Manapool sales couldn't be loaded just now." } }));
    return soldMineLoad;
  }
  // The coverage notes (history start, the SELLING FAST rule), or null.
  const soldSales = () => (soldMine ? soldMine.sales : null);
  function soldOf(r) {
    if (!soldMine || !r || !r.set || !r.collector) return null;
    const s = soldMine.sales;
    if (s.error || !s.historySince) return null;
    const k = soldKey(r);
    const e = soldMine.by.get(k);
    // #368: daysLeft / available (days of listings left, copies listed now)
    // come only when the server could estimate them; null otherwise.
    if (e) return { n: e[0], atLeast: !!e[1], hot: e[2], daysLeft: e[3] == null ? null : e[3], available: e[4] == null ? null : e[4] };
    if (soldMine.unmatched.has(k)) return null;
    return { n: 0, atLeast: !s.window7Complete, hot: s.comparable ? false : null, daysLeft: null, available: null };
  }

  /* Restock hints (#370), for the Buy List: what the account sold before or
     has customers wanting, and has none of now.
       - Sold before: its Manapool orders once picked (a ticket with an order
         that's past "open", the same sales the Dashboard counts), copies per
         printing.
       - Wanted: customer wants; a printing want is that printing, an
         any-printing want is the card name.
       - None of: availableQty less what open tickets have earmarked, summed
         over every stack of the printing (any condition, finish, language)
         or, for a name, every printing. That's the "free to sell" number the
         wantlist's "in stock" uses, so copies lent out, on an open receipt or
         set aside for an order don't count as stock to sell.
     Pure: callers pass the stacks, tickets, wants and reservations (stack id
     -> copies earmarked, or null). Returns
       prints: [{ key: "set|collector", q: what the server is asked for, set,
         collector, lang, finish, name, setName, oracleId, sold, wanted }]
       names:  [{ key: the name, name, oracleId, sold, wanted }]
     most sold first, then most wanted. wanted counts customers. */
  function restockCandidates(cards, lists, wants, reservedById) {
    const pk = (set, collector) => String(set || "").toLowerCase() + "|" + String(collector || "");
    const prints = new Map(), names = new Map(), soldByName = new Map();
    const entry = x => {
      const k = pk(x.set, x.collector);
      let e = prints.get(k);
      if (!e) prints.set(k, e = { key: k, set: String(x.set).toLowerCase(), collector: String(x.collector), lang: x.lang || "en",
        name: x.name || "", setName: x.setName || "", oracleId: x.oracleId || "", sold: 0, by: new Set(), fin: {} });
      if (!e.setName && x.setName) e.setName = x.setName;
      if (!e.oracleId && x.oracleId) e.oracleId = x.oracleId;
      return e;
    };
    for (const p of lists || []) {
      if (!p || !p.orderId || p.status === "open") continue;
      for (const l of p.lines || []) {
        const n = Number(l.qty) || 0;
        if (l.kind === "sealed" || !l.set || !l.collector || n <= 0) continue;
        const e = entry(l), f = normalizeFinish(l.finish) || "nonfoil";
        e.sold += n;
        e.fin[f] = (e.fin[f] || 0) + n;
        const nk = wantNameKey(l.name);
        if (nk) soldByName.set(nk, (soldByName.get(nk) || 0) + n);
      }
    }
    for (const w of wants || []) {
      if (wantIsPrinting(w)) {
        const e = entry(w), f = normalizeFinish(w.finish) || "nonfoil";
        e.by.add(w.customerId || w.id);
        if (!e.sold) e.fin[f] = (e.fin[f] || 0) + 1;
      } else {
        const nk = wantNameKey(w.name);
        if (!nk) continue;
        let e = names.get(nk);
        if (!e) names.set(nk, e = { key: w.name.trim(), name: w.name.trim(), oracleId: w.oracleId || "", by: new Set() });
        e.by.add(w.customerId || w.id);
      }
    }
    if (!prints.size && !names.size) return { prints: [], names: [] };
    const freePrint = new Map(), freeName = new Map();
    for (const r of cards || []) {
      const q = Math.max(0, availableQty(r) - ((reservedById && reservedById.get(r.id)) || 0));
      if (!q) continue;
      const k = pk(r.set, r.collector);
      if (prints.has(k)) freePrint.set(k, (freePrint.get(k) || 0) + q);
      if (names.size) { const nk = wantNameKey(r.name); if (names.has(nk)) freeName.set(nk, (freeName.get(nk) || 0) + q); }
    }
    const order = (a, b) => b.sold - a.sold || b.wanted - a.wanted || SORT_COLLATOR.compare(a.name, b.name);
    const outPrints = [...prints.values()].filter(e => !freePrint.get(e.key)).map(e => {
      const finish = Object.keys(e.fin).sort((a, b) => e.fin[b] - e.fin[a])[0] || "nonfoil";
      return { key: e.key, q: e.key + (e.lang !== "en" ? "|" + e.lang : ""), set: e.set, collector: e.collector, lang: e.lang, finish,
        name: e.name, setName: e.setName, oracleId: e.oracleId, sold: e.sold, wanted: e.by.size };
    }).sort(order);
    const outNames = [...names.entries()].filter(([nk]) => !freeName.get(nk))
      .map(([nk, e]) => ({ key: e.key, name: e.name, oracleId: e.oracleId, sold: soldByName.get(nk) || 0, wanted: e.by.size })).sort(order);
    return { prints: outPrints, names: outNames };
  }
  // The account's own candidates: its stock, tickets and customer wants, with
  // open tickets' earmarks taken off (none open, the usual case, costs nothing).
  function restockHints() {
    const open = pickLists().some(p => p.status === "open" && p.lines.length);
    return restockCandidates(state.cards, pickLists(), state.customerWants,
      open ? pickAllocations(it => it.kind !== "sealed") : null);
  }
  /* The candidates joined to POST /api/prices/restock's answer: only the ones
     the server says are selling well come back, as rows for the Buy List's
     Restock table. A name row carries the card's best-selling printing (so it
     can be watched) and printing: false. SELLING FAST first, then the most
     sold on Manapool this week, then the most you've sold. */
  const RESTOCK_PRINTS_MAX = 20000, RESTOCK_NAMES_MAX = 2000;
  function restockRequest(c) {
    return { prints: c.prints.slice(0, RESTOCK_PRINTS_MAX).map(e => e.q), names: c.names.slice(0, RESTOCK_NAMES_MAX).map(e => e.key) };
  }
  function restockRows(c, d) {
    const rows = [];
    const ans = (d && d.prints) || {}, nameAns = (d && d.names) || {};
    for (const e of c.prints) {
      const a = ans[e.q];
      if (!a) continue;
      rows.push({ printing: true, key: e.key, name: e.name, set: e.set, collector: e.collector, lang: e.lang, finish: e.finish,
        setName: e.setName, oracleId: e.oracleId, sold7: a[0], atLeast: !!a[1], hot: a[2], rank: a[3] == null ? null : a[3],
        ownSold: e.sold, wanted: e.wanted });
    }
    for (const e of c.names) {
      const a = nameAns[e.key];
      if (!a) continue;
      const p = a[4] || null;
      rows.push({ printing: false, key: "name:" + e.key, name: e.name, set: p ? p.set : "", collector: p ? p.collector : "",
        lang: p ? p.lang : "en", finish: "nonfoil", setName: p ? p.setName : "", oracleId: e.oracleId || (p ? p.oracleId : ""),
        sold7: a[0], atLeast: !!a[1], hot: a[2], rank: a[3], ownSold: e.sold, wanted: e.wanted });
    }
    return rows.sort((a, b) => (b.hot === true) - (a.hot === true) || b.sold7 - a.sold7 || b.ownSold - a.ownSold ||
      SORT_COLLATOR.compare(a.name, b.name));
  }

  /* Days of listings left (#368), for Movers > Selling fast and Listings:
     what a cell shows and its tooltip, from the server's estimate (copies
     listed on Manapool now ÷ copies sold a day over the last 7 days).
     `daysLeft` null: { text: "—", title: whyNot }. `atLeast`: the 7-day
     count is a minimum, so the days are a maximum. */
  function daysLeftView(daysLeft, available, copies7, atLeast, whyNot) {
    if (daysLeft == null) return { text: "—", title: whyNot || "Not enough recent sales, or the listed supply isn't known, to estimate this." };
    const d = Number(daysLeft);
    const text = d === 0 ? "0d" : d < 1 ? "<1d" : d > 365 ? ">1y" : "~" + Math.round(d) + "d";
    const words = d === 0 ? "None left: no copies are listed on Manapool right now"
      : d < 1 ? "Less than a day of listings left" : d > 365 ? "More than a year of listings left"
      : "About " + Math.round(d) + " day" + (Math.round(d) === 1 ? "" : "s") + " of listings left";
    const pace = Math.round(copies7 / 7 * 10) / 10;
    const how = d === 0 ? "" : ": " + available + " cop" + (available === 1 ? "y" : "ies") + " listed on Manapool now (every seller together) ÷ about " +
      pace + " sold a day over the last 7 days";
    return { text, title: words + how + ". A market-wide estimate from listed supply and the recent sales pace, not a forecast for your own price." +
      (atLeast ? " Some sales may be missing from the 7-day count, so it could run out sooner." : "") };
  }
  /* The Dashboard's line: listed stacks (listedQty > 0) whose printing is
     SELLING FAST, each printing counted once. null when there's nothing to
     say (not loaded, no history, or too early to compare). */
  function listedSellingFast() {
    const s = soldSales();
    if (!s || s.error || !s.historySince || !s.comparable) return null;
    const keys = new Set();
    for (const r of state.cards) {
      if (!(r.listedQty > 0)) continue;
      const x = soldOf(r);
      if (x && x.hot) keys.add(soldKey(r));
    }
    return keys.size;
  }

  /* ============================== Allocation (pick / deck) ============================== */
  function allocateFrom(stacks, need, sortBy) {
    stacks = stacks.slice().sort(sortBy || ((a, b) => b.quantity - a.quantity));
    const pulls = [];
    for (const s of stacks) {
      if (need <= 0) break;
      const take = Math.min(need, availableQty(s));
      if (take > 0) { pulls.push({ recordId: s.id, locationId: s.locationId, take }); need -= take; }
    }
    return { pulls, shortfall: need };
  }
  // No condition on the request means "any grade will do" - it does not mean
  // NM specifically, so an unset item.condition matches every stack rather
  // than only NM ones. See pickKey below for the same distinction.
  function stacksMatching(item) {
    // A sealed order line/pick-list line (item.kind === "sealed", see
    // integrations.js's normalizeOrderLine) has no set/collector/finish at
    // all - identity is just tcgplayerProductId, matched against
    // state.sealed instead of state.cards.
    if (item.kind === "sealed") {
      return state.sealed.filter(r => r.tcgplayerProductId === item.tcgplayerProductId);
    }
    return state.cards.filter(r => cardLineMatches(item, r));
  }
  // One card stack against one card pick-list line - the predicate above, on
  // its own so a single record can be checked without scanning state.cards.
  function cardLineMatches(item, r) {
    if (item.collector) {
      return r.set === item.set &&
        normNum(r.collector) === normNum(item.collector) && r.lang === item.lang && r.finish === item.finish &&
        (!item.condition || r.condition === item.condition);
    }
    return r.name.toLowerCase() === String(item.name).toLowerCase() &&
      (!item.set || r.set === item.set) && r.finish === item.finish &&
      (!item.condition || r.condition === item.condition);
  }
  // Manapool-order fulfillment scopes the pick to locations actually
  // offered for sale - a deck-list pull or a manual pick has no such
  // restriction, so this only applies when the caller asks for it.
  function pickableStacks(item, opts, lookup) {
    const stacks = lookup ? lookup(item) : stacksMatching(item);
    if (!(opts && opts.sellFromOnly)) return stacks;
    return stacks.filter(r => { const l = locById(r.locationId); return !!(l && l.sellFrom); });
  }
  /* Copies in a tote have left the shelf, so they aren't there for anyone else
     to pick (#395). `holders` are the lists whose own tote this allocation is
     for, left in: a ticket's own pulls still come from its own line. At equal
     priority the order stays by the book (`book`), so a tote landing on a bin
     doesn't send a ticket already working there to another bin while the shelf
     still has enough. */
  function allocatePick(item, opts, holders) {
    const totes = totesByStack(holders);
    const stacks = pickableStacks(item, opts).map(r => (totes.has(r.id)
      ? { id: r.id, locationId: r.locationId, quantity: shelfQty(r, totes), book: r.quantity } : r));
    return allocateFrom(stacks, item.qty, (a, b) =>
      (pickPriorityOf(b.locationId) - pickPriorityOf(a.locationId)) || (bookOrder(b) - bookOrder(a)));
  }
  const bookOrder = s => (s.book != null ? s.book : s.quantity);
  // The lists whose own tote a ticket's allocation leaves in: it, or its whole batch.
  function pickHolders(p) {
    return p ? (p.batchId ? pickBatchLists(p.batchId) : [p]) : [];
  }
  /* A short line whose copies are in another ticket's tote says so (owner,
     2026-11-01), so nobody chases or recounts a bin for nothing: "2 in a tote,
     pulled by sam", or "" when no tote holds any. Copies booked today on a
     receipt still open on the floor (#388) say so too (owner, 2026-11-02):
     "3 held on LOT-2026-0007 until the desk closes it". */
  function pickShortTote(p, item, opts) {
    const totes = totesByStack(pickHolders(p));
    const found = { qty: 0, by: [] }, held = new Map();
    for (const r of pickableStacks(item, opts === undefined ? pickListAllocOpts(p) : opts)) {
      if (r.held) { const no = heldOn(r); held.set(no, (held.get(no) || 0) + r.quantity); }
      const t = totes.get(r.id);
      if (!t) continue;
      found.qty += t.qty;
      for (const n of t.by) if (!found.by.includes(n)) found.by.push(n);
    }
    const words = found.qty ? [toteHeld(found)] : [];
    for (const [no, n] of held) words.push(n + " held on " + no + " until the desk closes it");
    return words.join("; ");
  }
  /* The allocation options for one pick list's lines (#91). A Manapool
     order's list pulls only from sell-from locations, the same rule the
     Orders tab's preview uses, so completing it can never take a copy from
     a personal binder the preview left out. Manual, deck and TCGplayer
     lists are unrestricted. Everything that allocates a pick list's line
     (complete, the Pick tab, print, reservations, Warehouse Mode's walk)
     goes through this. A counter sale (#431) follows the Manapool rule
     (owner, 2026-11-07): it sells from sell-from locations only, so it can't
     take a sell-from copy an online order needs while one sits in a binder. */
  function pickListAllocOpts(p) {
    return p && (p.source === "manapool" || isCounterSale(p)) ? { sellFromOnly: true } : undefined;
  }
  function allocatePickLine(p, item) {
    return allocatePick(item, pickListAllocOpts(p), pickHolders(p));
  }

  /* How many of EACH stack are earmarked to fulfill the current pick list,
     if it were shipped right now - the per-stack number the WMS grid and the
     Manage dialog show instead of a listed-for-sale quantity (that lives on
     the Storefront grain now; a location has no idea what Manapool has
     listed, but it very much cares what it's already on the hook to ship).
     Mirrors shipPick()'s own greedy, pick-priority-ordered allocation, but
     non-destructively: a local "remaining" snapshot stands in for real
     quantities so one pick-list line's claim on a stack is honored by the
     next line's allocation, same as real shipping would, without touching
     state.cards. Returns a Map of record id -> allocated qty. */
  // lineFilter (optional) limits which open pick-list lines are allocated.
  // Restock detection only cares about lines for wanted cards, and skipping
  // the rest keeps it cheap on a big collection. Lines for one card name
  // only ever compete for that name's stacks, so filtering by name leaves
  // the allocation of the lines that are kept unchanged.
  // listFilter (optional) limits which open pick LISTS take part, e.g. only
  // Manapool orders' lists (manapoolReservations below).
  // extraLists (optional) are pick-list-shaped { source, lines } that are
  // not saved pick lists, allocated after the real ones: the Manapool orders
  // that have no pick list yet (#107), in the order their lists would be
  // made, so the copies they claim are the ones their lists will pull.
  function pickAllocations(lineFilter, listFilter, extraLists) {
    const remaining = new Map([...state.cards, ...state.sealed].map(r => [r.id, availableQty(r)]));
    const byId = new Map();
    const openLines = pickLists().filter(p => p.status === "open" && (!listFilter || listFilter(p)))
      .concat(extraLists || [])
      .flatMap(p => p.lines.map(item => ({ item, opts: pickListAllocOpts(p) })))
      .filter(x => !lineFilter || lineFilter(x.item));
    if (!openLines.length) return byId;
    const lookup = stackLookup(openLines.map(x => x.item));
    for (const { item, opts } of openLines) {
      for (const p of allocateRemaining(item, opts, remaining, lookup).pulls) {
        byId.set(p.recordId, (byId.get(p.recordId) || 0) + p.take);
      }
    }
    return byId;
  }
  /* stacksMatching() for many lines at once (#107): one pass over the
     collection indexing only the printings, names and sealed products the
     lines ask for, instead of a full scan per line (~70k stacks, a busy
     day's orders). Returns item -> its matching stacks, in collection order,
     exactly what stacksMatching(item) would return. */
  function stackLookup(items) {
    const printKey = (set, num, lang, finish) => set + "|" + normNum(num) + "|" + lang + "|" + finish;
    const wantPrint = new Set(), wantSet = new Set(), wantName = new Set(), wantSealed = new Set();
    for (const it of items) {
      if (it.kind === "sealed") wantSealed.add(it.tcgplayerProductId);
      else if (it.collector) { wantPrint.add(printKey(it.set, it.collector, it.lang, it.finish)); wantSet.add(it.set); }
      else wantName.add(String(it.name).toLowerCase());
    }
    const byPrint = new Map(), byName = new Map(), bySealed = new Map();
    const push = (m, k, r) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(r); };
    for (const r of state.cards) {
      if (wantSet.has(r.set)) {
        const k = printKey(r.set, r.collector, r.lang, r.finish);
        if (wantPrint.has(k)) push(byPrint, k, r);
      }
      if (wantName.size) {
        const k = String(r.name).toLowerCase();
        if (wantName.has(k)) push(byName, k, r);
      }
    }
    if (wantSealed.size) for (const r of state.sealed) if (wantSealed.has(r.tcgplayerProductId)) push(bySealed, r.tcgplayerProductId, r);
    return item => {
      if (item.kind === "sealed") return bySealed.get(item.tcgplayerProductId) || [];
      const pool = item.collector ? byPrint.get(printKey(item.set, item.collector, item.lang, item.finish))
        : byName.get(String(item.name).toLowerCase());
      return (pool || []).filter(r => cardLineMatches(item, r));
    };
  }
  /* One line's allocation against a running "remaining" snapshot (record id
     -> qty still unclaimed), taking what it pulls off the snapshot so the
     next line sees only what's left. Same pick-priority order as
     allocatePick, so a run of lines allocated this way matches what
     completing them one after another really pulls. Shared by
     pickAllocations and the batch pull sheet (pickBatchSheet, #212).
     lookup (optional): a stackLookup() for the whole run. totes (optional): what
     was already taken off `remaining` for totes, so the order at equal priority
     matches allocatePick's. */
  function allocateRemaining(item, opts, remaining, lookup, totes) {
    const snap = pickableStacks(item, opts, lookup)
      .map(r => {
        const quantity = remaining.get(r.id) || 0;
        const t = totes && totes.get(r.id);
        return t ? { id: r.id, locationId: r.locationId, quantity, book: quantity + t.qty } : { id: r.id, locationId: r.locationId, quantity };
      })
      .filter(s => s.quantity > 0);
    const out = allocateFrom(snap, item.qty, (a, b) =>
      (pickPriorityOf(b.locationId) - pickPriorityOf(a.locationId)) || (bookOrder(b) - bookOrder(a)));
    for (const p of out.pulls) remaining.set(p.recordId, (remaining.get(p.recordId) || 0) - p.take);
    return out;
  }
  /* Copies sold on Manapool but not yet picked (#86). Manapool takes a sold
     copy off its listing the moment the order is placed, so until the
     order's pick list is completed those copies are still on the shelf here
     but must not be listed (or pushed) again, or the same copy can sell
     twice. Reserved per stack with the same allocation completing the list
     uses (pickAllocations: sell-from only, pick-priority order, exactly as
     allocatePickLine), so Listings and picking agree on which stacks the
     reserved copies come from. Only open lists made from a Manapool order
     count, and an open counter ticket (#432: entering it lowered its
     listings, and its copies are set aside for the counter): a manual, deck
     or TCGplayer list never lowered anything on Manapool. Returns a Map of
     record id -> reserved qty.

     A fetched order that has no pick list yet counts too (#107): its copies
     are just as sold, and pick lists are only made when someone opens the
     order on Lists. Those orders come from setManapoolOrders() (the orders
     this page has loaded; none loaded = pick lists only, as before) and are
     allocated after the open lists, exactly as their pick lists would be.
     Never counted twice: an order with any pick list is skipped, whether
     that list is open (already counted above) or completed (its copies have
     left the shelf). A finished order (shipped, cancelled, refunded...,
     orderIsOpen) holds nothing. */
  function manapoolReservations() {
    const unpicked = unpickedManapoolOrders();
    // No open Manapool-order list or unpicked order (the usual case) costs nothing.
    const held = p => p.source === "manapool" || isCounterSale(p);
    if (!unpicked.length && !pickLists().some(p => p.status === "open" && held(p))) return new Map();
    return pickAllocations(null, held,
      unpicked.map(o => ({ source: "manapool", lines: orderPickItems(o, true) })));
  }

  /* The Manapool orders this page knows about (#107), for
     manapoolReservations. null until a page loads them. */
  let knownManapoolOrders = null;
  function setManapoolOrders(orders) {
    knownManapoolOrders = Array.isArray(orders) ? orders : null;
    noteOrderStatuses(knownManapoolOrders);
  }
  /* Load the orders: the server's cache (cheap, no Manapool call) by
     default, or opts.fresh = Fetch orders (new and still-open orders from
     Manapool, with their lines). Throws when the request fails, leaving
     what was loaded before in place. */
  async function loadManapoolOrders(opts) {
    const d = await api(opts && opts.fresh ? "/api/manapool/orders" : "/api/manapool/orders/cached");
    setManapoolOrders((d && d.orders) || []);
    return knownManapoolOrders;
  }
  /* The Manapool orders already fetched for this inventory, whoever fetched
     them (#433): a Staff login has no orders cache of its own, but the
     counter must still hold a copy sold online from the moment its order is
     fetched (owner, 2026-11-08). Card lines and status only, for counterFree;
     the Walk-in page uses this, the kiosk does the same on the server. */
  async function loadFetchedOrders() {
    const d = await api("/api/order-entry/fetched-orders");
    setManapoolOrders((d && d.orders) || []);
    return knownManapoolOrders;
  }
  // Known orders still to go out that have lines on file and no pick list,
  // oldest first (the order their lists are likely to be made in).
  function unpickedManapoolOrders() {
    if (!knownManapoolOrders || !knownManapoolOrders.length) return [];
    const listed = new Set(pickLists().map(p => p.orderId).filter(Boolean).map(String));
    const seen = new Set();
    return knownManapoolOrders.filter(o => {
      if (!o || !o.id || !Array.isArray(o.lines) || !o.lines.length) return false;
      const id = String(o.id);
      if (seen.has(id) || listed.has(id) || !orderIsOpen(o.status)) return false;
      seen.add(id);
      return true;
    }).sort((a, b) => String(a.placedAt || "").localeCompare(String(b.placedAt || "")));
  }
  /* An order's lines as pick-list lines - what ensureOrderPickList puts on
     the order's list. merged: same-card lines folded into one, as
     addToPickList does, for a caller that never makes a real list. */
  function orderPickItems(order, merged) {
    const items = (order.lines || []).map(l => l.kind === "sealed"
      ? { kind: "sealed", tcgplayerProductId: l.tcgplayerProductId, manapoolProductId: l.manapoolProductId,
          name: l.name, setCode: l.setCode, qty: l.qty, unitPrice: l.unitPrice != null ? l.unitPrice : null }
      : { kind: "card", set: l.set, collector: l.collector, lang: l.lang || "en", finish: l.finish,
          condition: conditionCode(l.condition), name: l.name, qty: l.qty,
          unitPrice: l.unitPrice != null ? l.unitPrice : null });
    if (!merged) return items;
    const byKey = new Map();
    for (const it of items) {
      const k = pickKey(it), ex = byKey.get(k);
      if (ex) ex.qty += it.qty; else byKey.set(k, it);
    }
    return [...byKey.values()];
  }
  /* Per stack, the copies reserved for Manapool sales whose copy Manapool
     has already taken off the listing but whose listed count Grimoire still
     includes (#487): an unpicked order placed after the last Fetch listings,
     and an open Manapool-order list not listedSettled, less the listings it
     settled by key (see completePickList, which lowers listed by the same
     rule). Evaluate subtracts this from listedQty, so those rows aren't
     offered as "lower". A settled listing is Manapool's own number and
     keeps its real overlisting. Counter sales already lowered on entry. */
  function unsettledManapoolSold() {
    const synced = Date.parse(state.settings.manapoolSyncedAt || "");
    const at = state.settings.manapoolListingSettledAt || {}, anyAt = Object.keys(at).length > 0;
    const cands = []; // { lines, keys: settled by key, placed: order time or 0 }
    for (const o of unpickedManapoolOrders()) {
      const placed = Date.parse(o.placedAt || "");
      if (synced && placed && synced > placed) continue;
      cands.push({ lines: orderPickItems(o, true), keys: null, placed: placed || 0 });
    }
    for (const p of pickLists()) {
      if (p.status !== "open" || p.source !== "manapool" || isCounterSale(p) || p.listedSettled) continue;
      cands.push({ lines: p.lines, keys: new Set(p.listedSettledKeys || []), placed: 0 });
    }
    if (!cands.length) return new Map();
    // One pass over the stacks for every line that could be settled by key or push time.
    const check = cands.filter(c => (c.keys && c.keys.size) || (anyAt && c.placed));
    const find = check.length ? stackLookup(check.flatMap(c => c.lines)) : null;
    const lists = [];
    for (const c of cands) {
      let lines = c.lines;
      if (check.includes(c)) {
        lines = lines.filter(it => !find(it).some(r => {
          const k = settledListingKey(r, it.kind === "sealed");
          return (c.keys && c.keys.has(k)) || (c.placed && at[k] && Date.parse(at[k]) > c.placed);
        }));
      }
      if (lines.length) lists.push({ source: "manapool", lines });
    }
    if (!lists.length) return new Map();
    return pickAllocations(null, () => false, lists);
  }
  // A stack's copies that are free to list: on hand, less any lent out, minus reserved.
  function listableQty(r, reserved) {
    return Math.max(0, availableQty(r) - ((reserved && reserved.get(r.id)) || 0));
  }

  /* Which copies Deck List's Build takes, for every line at once (#117,
     #118). The table preview, the printout and Build all use this, for the
     chosen destination, so what the preview says is what Build does. The
     owner's rules (2026-10-09):
     A. Copies already in the destination count toward the line; only the
        rest move. They show as `here`, not as pulls.
     B. Copies reserved for an open Manapool order (sold, not yet picked,
        manapoolReservations) are never moved, nor counted as already in the
        destination: that order's pick list takes them out again. A line
        nothing else covers is short.
     C. Order: unlisted copies in locations not marked Sell from, then
        unlisted sell-from copies, then listed copies (non-sell-from first),
        biggest stack first within each. A stack's listed copies are the
        last to go: of its free copies, min(listedQty, free) count as
        listed. `listedTake` says how many listed copies a pull moves.
     D. No destination ceiling check.
     One name index, one reservation map and one location lookup per call,
     not a collection scan per line: ~70k stacks and a 100-line list. Two
     lines of the same name share the stock (an earlier line's claim counts).
     destId null (no destination yet, or a new one) = every stack is a source. */
  function deckPlan(list, destId, skipLocs) {   // skipLocs: a Set of location ids never pulled from (#334)
    const byName = new Map();
    for (const r of state.cards) {
      const k = String(r.name || "").toLowerCase();
      let a = byName.get(k);
      if (!a) byName.set(k, a = []);
      a.push(r);
    }
    const reserved = manapoolReservations();
    const sellFrom = new Map();
    const isSellFrom = id => {
      if (!sellFrom.has(id)) { const l = locById(id); sellFrom.set(id, !!(l && l.sellFrom)); }
      return sellFrom.get(id);
    };
    const used = new Map();   // record id -> copies an earlier line already claimed
    const free = r => Math.max(0, listableQty(r, reserved) - (used.get(r.id) || 0));
    const claim = (r, n) => used.set(r.id, (used.get(r.id) || 0) + n);
    let inDest = 0, listedMoving = 0, moving = 0;
    const lines = (list || []).map(item => {
      const stacks = byName.get(String(item.name || "").toLowerCase()) || [];
      let need = Math.max(0, Number(item.qty) || 0);
      const here = [], pulls = [];
      let lineHere = 0, lineReserved = 0;
      for (const r of stacks) lineReserved += reserved.get(r.id) || 0;
      if (destId) {
        for (const r of stacks) {
          if (r.locationId !== destId || need <= 0) continue;
          const take = Math.min(need, free(r));
          if (take <= 0) continue;
          here.push({ record: r, recordId: r.id, locationId: r.locationId, take });
          claim(r, take);
          need -= take;
          lineHere += take;
        }
      }
      const parts = [];
      for (const r of stacks) {
        if (destId && r.locationId === destId) continue;
        if (skipLocs && skipLocs.has(r.locationId)) continue;
        const f = free(r);
        if (f <= 0) continue;
        const listed = Math.min(Math.max(0, Number(r.listedQty) || 0), f);
        // Copies sitting in another deck come last: loose stock goes first (#334).
        const sf = (isSellFrom(r.locationId) ? 1 : 0) + (deckByLocation(r.locationId) || isDeckBox(locById(r.locationId)) ? 4 : 0);
        if (f - listed > 0) parts.push({ r, n: f - listed, tier: sf, listed: false });
        if (listed > 0) parts.push({ r, n: listed, tier: 2 + sf, listed: true });
      }
      parts.sort((a, b) => (a.tier - b.tier) || (b.r.quantity - a.r.quantity));
      const byRec = new Map();
      for (const p of parts) {
        if (need <= 0) break;
        const take = Math.min(need, p.n);
        let pull = byRec.get(p.r.id);
        if (!pull) {
          pull = { record: p.r, recordId: p.r.id, locationId: p.r.locationId, take: 0, listedTake: 0 };
          byRec.set(p.r.id, pull);
          pulls.push(pull);
        }
        pull.take += take;
        if (p.listed) pull.listedTake += take;
        need -= take;
      }
      let lineListed = 0;
      for (const p of pulls) { claim(p.record, p.take); lineListed += p.listedTake; moving += p.take; }
      inDest += lineHere;
      listedMoving += lineListed;
      return { item, here, pulls, inDest: lineHere, listedTake: lineListed, reserved: lineReserved, shortfall: need };
    });
    // Everything the confirm dialog states: which copies stay, which move
    // and from where, how many of them are listed, and what's short. "Already
    // there" and "will move" are kept apart so a stack moved into the
    // destination while the dialog was open still counts as a change.
    const fingerprint = lines.map(l => l.here.map(p => "h" + p.recordId + ":" + p.take).join(",") + ">" +
      l.pulls.map(p => p.recordId + "@" + p.locationId + ":" + p.take + "~" + p.listedTake).join(",") +
      "/" + l.shortfall).join("|");
    return { lines, inDest, listedMoving, moving, fingerprint };
  }
  // "" (not "NM") for an unset condition, so "any grade" pick-list lines stay
  // their own bucket instead of silently narrowing to NM-only on merge.
  // Sealed lines get their own branch entirely - they have none of set/
  // collector/lang/finish/condition, so without this every sealed line
  // would hash to the same key and silently merge into one on add,
  // regardless of which product it actually was.
  const pickKey = i => i.kind === "sealed"
    ? "sealed|" + String(i.tcgplayerProductId || "")
    : [i.set, normNum(i.collector), i.lang, i.finish || "nonfoil", i.condition || ""].join("|");

  /* ============================== Pick lists ==============================
     Numbered and independently shippable - one per Manapool order (generated
     on demand, never automatically), one per TCGplayer import, or one
     ongoing "manual" list that Manage -> Add to pick list accumulates into
     until it ships. Never one shared bucket: shipping one must never touch
     what's queued for another order. */
  function nextPickListId() {
    const year = new Date().getFullYear();
    const prefix = "PICK-" + year + "-";
    // Highest number ever issued this year, not how many lists currently
    // exist - a discarded list (pickClear in lists.page.js actually removes
    // it from the array, unlike a shipped one) must not free up its number
    // for reuse, or two different lists could end up sharing an id.
    let max = 0;
    for (const p of pickLists()) {
      if (!String(p.id || "").startsWith(prefix)) continue;
      const n = parseInt(String(p.id).slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return prefix + String(max + 1).padStart(4, "0");
  }
  function newPickList(opts) {
    const o = opts || {};
    return {
      id: nextPickListId(), source: o.source || "manual", orderId: o.orderId || null,
      // The order's own human-readable label (e.g. a Manapool order number),
      // NOT its internal id/UUID - captured at creation time so printing
      // later never depends on the Orders tab's in-memory `orders` list
      // still being loaded (a reload, or printing in a later session,
      // wouldn't have it). Falls back to the id only if the caller truly
      // has no label to give.
      orderLabel: o.orderLabel || null,
      // The order's own payment breakdown (subtotal/shipping/total/fee/net
      // in dollars, from Manapool's single-order-detail endpoint - see
      // integrations.js's normalizeOrder) - captured once at generation
      // time, same reasoning as orderLabel above: the order cache it came
      // from isn't part of this synced document, so nothing later can rely
      // on looking it up live. null for a manual/deck pick, or an order
      // whose full detail was never fetched (the list endpoint alone never
      // carries this). See BACKLOG.md #19 - completePickList() below reads
      // it to recognise shipping revenue and Manapool's own net "Earnings"
      // figure alongside the existing per-line item revenue/COGS.
      orderPayment: o.orderPayment || null,
      // Manapool's required shipping method (#454): whether marking it
      // shipped there needs a tracking number, when the order isn't loaded.
      shippingMethod: o.shippingMethod || null,
      // Three stages, not two: "open" (still needs picking), "picked"
      // (inventory already decremented via completePickList, awaiting
      // weigh/ship), "shipped" (done in Grimoire). pickAllocations() below
      // relies on "open" meaning "not yet pulled" - once picked, those cards
      // are already gone from state.cards, not just reserved.
      status: "open", createdAt: new Date().toISOString(), pickedAt: null, shippedAt: null, lines: []
    };
  }
  function pickLists() {
    if (!Array.isArray(state.pickLists)) {
      state.pickLists = [];
      // Migrate the old flat array - including anything already queued by
      // the earlier auto-dispatch feature - into one manual list rather than
      // losing it.
      const old = Array.isArray(state.pickList) ? state.pickList : [];
      if (old.length) {
        const p = newPickList({ source: "manual" });
        p.lines = old.map(i => Object.assign({}, i));
        state.pickLists.push(p);
      }
      delete state.pickList;
    }
    return state.pickLists;
  }
  function currentManualPickList() {
    const list = pickLists();
    let p = list.find(x => x.status === "open" && x.source === "manual" && !x.orderId);
    if (!p) { p = newPickList({ source: "manual" }); list.push(p); }
    return p;
  }
  function addToPickList(pickListId, item) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!p) return;
    const k = pickKey(item);
    const ex = p.lines.find(x => pickKey(x) === k);
    // A changed quantity is a different amount to pick: its ticks start over (#217).
    if (ex) { ex.qty += item.qty; clearPickLineTicks(p, k); } else p.lines.push(Object.assign({}, item));
  }
  function pickListForOrder(orderId) {
    return pickLists().find(p => p.orderId === orderId) || null;
  }

  /* The readable order number of a pick list's order (#197), never
     Manapool's internal UUID: the saved orderLabel, else the label of that
     order in the orders cache (array or ordersById() Map), else the UUID
     shortened to its first 8 characters. Pick lists made before orderLabel
     was saved have none, and some saved the UUID itself as the label; the
     server's one-time backfill (server/lib/orderLabels.js) fixed those that
     existed, and this covers anything it couldn't. fullId: fall back to
     the whole UUID instead (the Accounting CSV, where a spreadsheet can
     still look it up). "" for a pick list with no order. */
  function shortOrderId(id) {
    const s = String(id == null ? "" : id);
    return s.length > 12 ? s.slice(0, 8) + "…" : s;
  }
  function pickListOrderLabel(p, orders, fullId) {
    if (!p || !p.orderId) return "";
    const id = String(p.orderId);
    const own = p.orderLabel ? String(p.orderLabel).trim() : "";
    if (own && own !== id) return own;
    let o = null;
    if (orders && typeof orders.get === "function") o = orders.get(id);
    else if (Array.isArray(orders)) o = orders.find(x => x && String(x.id) === id);
    if (o && o.label && String(o.label) !== id) return String(o.label);
    return fullId ? id : shortOrderId(id);
  }

  /* ---------- Order Fulfillment search (#198) ----------
     Case-insensitive, partial, every word must match somewhere in the row
     (not necessarily the same field). searchTerms splits the box; a row's
     text is its searchable fields joined with newlines, so one word can't
     straddle two fields. */
  function searchTerms(q) {
    return String(q == null ? "" : q).toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matchesTerms(text, terms) {
    if (!terms || !terms.length) return true;
    const t = String(text || "").toLowerCase();
    return terms.every(w => t.includes(w));
  }
  // Order id -> the customer's name in Customers, for a search by the
  // name the seller filed them under (which they may have edited).
  function customerNameByOrder() {
    const m = new Map();
    for (const c of state.customers) for (const r of c.orderRefs || []) if (!m.has(r.id)) m.set(r.id, c.name || "");
    return m;
  }
  const lineNames = lines => (Array.isArray(lines) ? lines : []).map(l => l && l.name).filter(Boolean);
  // Orders tab: readable number and id, buyer / ship-to name, the customer,
  // card names on its lines, and its pick ticket's number.
  function orderSearchText(o, pickList, customerName) {
    if (!o) return "";
    return [o.label, o.id, o.buyer, o.ship && o.ship.name, o.ship && o.ship.company, customerName,
      pickList && pickList.id].concat(lineNames(o.lines)).filter(Boolean).join("\n").toLowerCase();
  }
  // Pick list tab: ticket number, order number (saved or from the cache),
  // customer / ship-to name, and card names on its lines.
  function pickListSearchText(p, order, customerName) {
    if (!p) return "";
    return [p.id, p.orderLabel, p.orderId, order && order.label, order && order.buyer,
      order && order.ship && order.ship.name, customerName,
      // A counter sale (#431): its customer, and "walk-in" itself.
      isCounterSale(p) ? counterSaleName(p) : "", isCounterSale(p) ? ORDER_SOURCE_NAMES[p.source] : ""].concat(lineNames(p.lines))
      .filter(Boolean).join("\n").toLowerCase();
  }

  /* One pick list per Manapool order, however many times it's asked for
     (#92). The Orders tab has three ways to generate one (the row button,
     the drill-down button, bulk generate), and loading an order's lines can
     mean an await on the network, so two clicks used to both pass the
     "already has one?" check before either had created it. Now overlapping
     calls for the same order share one in-flight creation, and the check is
     repeated after the await. loadDetail(order) is the caller's fetch of the
     order's lines (it fills order.lines); it may throw, and the error reaches
     every waiting caller. Returns { pickList, created }: pickList is null
     when the order has no lines; created is true only for the one call that
     actually made the list. */
  const orderPickInFlight = new Map(); // order id -> Promise<pick list | null>
  async function ensureOrderPickList(order, loadDetail) {
    const existing = pickListForOrder(order.id);
    if (existing) return { pickList: existing, created: false };
    const pending = orderPickInFlight.get(order.id);
    if (pending) return { pickList: await pending, created: false };
    const run = (async () => {
      if (!(order.lines || []).length && loadDetail) await loadDetail(order);
      // Re-checked after the await: something else may have made it meanwhile.
      const again = pickListForOrder(order.id);
      if (again) return { pickList: again, created: false };
      const lines = order.lines || [];
      if (!lines.length) return { pickList: null, created: false };
      // No label: leave it blank rather than saving the UUID as one (#197),
      // so pickListOrderLabel() can still find it in the cache later.
      const pl = newPickList({ source: "manapool", orderId: order.id, orderLabel: order.label || "",
        orderPayment: order.payment || null,
        shippingMethod: order.shippingMethod || (order.raw && order.raw.shipping_method) || null });
      // Fetched listings since this order was placed already exclude what it
      // sold, so completing the list mustn't lower listed again (#86).
      const synced = Date.parse(state.settings.manapoolSyncedAt || ""), placed = Date.parse(order.placedAt || "");
      if (synced && placed && synced > placed) pl.listedSettled = true;
      // A push that confirmed a listing's number after this order was placed already
      // excludes it: completing must not lower that listing again (#86, #487).
      const at = state.settings.manapoolListingSettledAt || {};
      if (!pl.listedSettled && placed && Object.keys(at).length) {
        const items = orderPickItems(order), find = stackLookup(items);
        const keys = new Set();
        for (const it of items) for (const r of find(it)) {
          const k = settledListingKey(r, it.kind === "sealed");
          if (at[k] && Date.parse(at[k]) > placed) keys.add(k);
        }
        if (keys.size) pl.listedSettledKeys = [...keys];
      }
      pickLists().push(pl);
      // unitPrice carries the order line's real sale price through to the
      // pick list, so completePickList() can recognise real revenue when it
      // ships - see BACKLOG.md #19. A manual pick or deck pull never sets this.
      // orderPickItems is shared with manapoolReservations (#107), so an
      // order reserves the same lines before and after its list exists.
      for (const item of orderPickItems(order)) addToPickList(pl.id, item);
      return { pickList: pl, created: true };
    })();
    const shared = run.then(r => r.pickList);
    shared.catch(() => {}); // a waiter may never come; the first caller sees the error via `run`
    orderPickInFlight.set(order.id, shared);
    try { return await run; } finally { orderPickInFlight.delete(order.id); }
  }

  // opts.commander marks the line as (one of) the deck's commander(s) - only
  // Deck List's format check reads it (#81); allocation ignores it.
  // opts.set + opts.collector (+ opts.finish) say which printing a pasted
  // line named; the line keeps them in `prints` for "Add a deck I got"
  // (#310), which adds exactly those printings. Build ignores them.
  function addToDeckList(name, qty, opts) {
    name = String(name || "").trim();
    if (!name) return;
    const ex = state.deckList.find(x => x.name.toLowerCase() === name.toLowerCase());
    const it = ex || { name, qty: 0 };
    if (!ex) state.deckList.push(it);
    it.qty += qty;
    if (opts && opts.commander) it.commander = true;
    // A foil/etched marker on a line with no printing yet: the finish to use once one is picked.
    if (opts && opts.finish && !(opts.set && opts.collector) && normalizeFinish(opts.finish)) it.finish = normalizeFinish(opts.finish);
    if (opts && opts.set && opts.collector) {
      const set = String(opts.set).toLowerCase(), collector = String(opts.collector);
      const finish = normalizeFinish(opts.finish) || "nonfoil";
      if (!it.prints) it.prints = [];
      const pr = it.prints.find(x => x.set === set && x.collector === collector && x.finish === finish);
      if (pr) pr.qty += qty; else it.prints.push({ set, collector, finish, qty });
    }
  }

  /* ============================== Manapool links (#310) ==============================
     Shared by Buy List (a printing's page) and Deck List (missing cards). */
  // Strip combining diacritical marks (code points 0x0300-0x036F) left behind
  // by NFKD normalization, by code point rather than a literal-character
  // regex range, so this file's source stays plain ASCII.
  function stripDiacritics(s) {
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code < 0x0300 || code > 0x036f) out += ch;
    }
    return out;
  }
  function slugify(name) {
    return stripDiacritics(String(name || "").toLowerCase().normalize("NFKD"))
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function manapoolUrl(set, collector, name) {
    return "https://manapool.com/card/" + encodeURIComponent(set) + "/" +
      encodeURIComponent(collector) + "/" + slugify(name);
  }
  /* A card known only by name: Manapool's own search page (its site sends
     name searches to /cards?q=), so no printing has to be guessed. */
  const manapoolSearchUrl = name => "https://manapool.com/cards?q=" + encodeURIComponent(String(name || "").trim());
  const MANAPOOL_ADD_DECK = "https://manapool.com/add-deck";
  /* The text Manapool's Mass Entry box takes: "qty name" per line. */
  const manapoolPasteText = lines => lines.map(l => l.qty + " " + l.name).join("\n");

  /* ============================== Saved decks (#309) ==============================
     A deck is either a saved deck (state.decks) or a location of type
     "Deck Box" that no saved deck lives in. A saved deck keeps its full
     list, so cards it lists that aren't in its location show as missing.
     Record: { id, name, locationId, format, source, lines: [{ name, qty,
     commander }], createdAt, updatedAt }. `source` says how it was made:
     "build" (Deck List's Build, moved from stock). Part 2 (#310) adds decks
     brought in as new stock and buying the missing cards. Deleting a record
     never moves or deletes cards. Keyed by id in merge.js. */
  function normalizeDeck(src) {
    const s = src || {};
    const lines = (Array.isArray(s.lines) ? s.lines : [])
      .map(l => ({ name: String((l && l.name) || "").trim(), qty: Math.max(0, parseInt(l && l.qty, 10) || 0), commander: !!(l && l.commander) }))
      .filter(l => l.name && l.qty > 0);
    return {
      id: s.id || uid(),
      name: String(s.name || "").trim() || "Unnamed deck",
      locationId: s.locationId || null,
      format: typeof s.format === "string" ? s.format : "",
      source: s.source || "build",
      lines,
      createdAt: s.createdAt || new Date().toISOString(),
      updatedAt: s.updatedAt || s.createdAt || new Date().toISOString()
    };
  }
  const deckByLocation = locationId => state.decks.find(d => d.locationId === locationId) || null;
  const isDeckBox = l => !!l && String(l.type || "").toLowerCase() === "deck box";

  /* Build saves the list (#309): a new deck record, or, when a saved deck
     already lives in that location, that deck's list changed the way the
     person picked in Build's confirm (owner, 2026-10-18: ask each time):
     o.mode "add" (the default) adds these lines to its list - the same card
     name sums its qty, and a line is the commander if either side says so;
     "replace" swaps its list for this one. Returns the record. */
  function mergeDeckLines(a, b) {
    const out = [], at = new Map();
    for (const l of a.concat(b)) {
      const k = l.name.toLowerCase();
      const e = at.get(k);
      if (e) { e.qty += l.qty; e.commander = e.commander || l.commander; } else { const n = Object.assign({}, l); at.set(k, n); out.push(n); }
    }
    return out;
  }
  function saveBuiltDeck(o) {
    const lines = (o.lines || []).map(it => ({ name: it.name, qty: it.qty, commander: !!it.commander }));
    const now = new Date().toISOString();
    const ex = deckByLocation(o.locationId);
    if (ex) {
      const next = o.mode === "replace" ? lines : mergeDeckLines(ex.lines, lines);
      Object.assign(ex, normalizeDeck(Object.assign({}, ex, { format: o.format || ex.format, lines: next, updatedAt: now })));
      return ex;
    }
    const d = normalizeDeck({ name: o.name, locationId: o.locationId, format: o.format || "", source: o.source || "build",
      lines, createdAt: now, updatedAt: now });
    state.decks.push(d);
    return d;
  }
  /* "Add a deck I got" (#310): what a pasted list can add as new stock.
     A line adds only the copies its printing(s) cover (item.prints, from
     addToDeckList); the rest of the line has no set + number, and no printing
     is ever guessed (as in Receive's pasted-list import), so it comes back in
     `loose`. The Deck List page makes the owner pick a printing for those
     lines first (Add stays off until none are left), so `loose` is normally
     empty by the time Add runs. -> { printed: [{ name, set, collector,
     finish, qty, commander }], loose: [{ name, qty }] }. */
  function gotDeckPlan(list) {
    const printed = [], loose = [];
    for (const it of list || []) {
      let left = Math.max(0, Number(it.qty) || 0);
      for (const pr of it.prints || []) {
        const q = Math.min(left, Math.max(0, Number(pr.qty) || 0));
        if (q <= 0) continue;
        printed.push({ name: it.name, set: pr.set, collector: pr.collector, finish: pr.finish || "nonfoil", qty: q, commander: !!it.commander });
        left -= q;
      }
      if (left > 0) loose.push({ name: it.name, qty: left });
    }
    return { printed, loose };
  }
  /* Add the looked-up cards as new stock in the deck's location (the same
     addCopies path Receive uses, so every stack gets its audit entry), then
     save the deck with the lines that were added. o.entries: [{ name, set,
     collector, lang, finish, condition, qty, commander, info }] (info from
     lookupCard). o.mode "add"|"replace" as saveBuiltDeck. Caller persists. */
  function addGotDeck(o) {
    let added = 0;
    const lines = [], at = new Map();
    for (const e of o.entries || []) {
      addCopies({ set: e.set, num: e.collector, lang: e.lang || "en", finish: e.finish || "nonfoil",
        condition: e.condition || defaultCondition(), locationId: o.locationId, qty: e.qty, info: e.info,
        action: "add", note: 'Added with the deck "' + o.name + '" (no cost basis)' });
      added += e.qty;
      const name = (e.info && e.info.name) || e.name, k = name.toLowerCase();
      const ln = at.get(k);
      if (ln) { ln.qty += e.qty; ln.commander = ln.commander || !!e.commander; }
      else { const n = { name, qty: e.qty, commander: !!e.commander }; at.set(k, n); lines.push(n); }
    }
    const deck = saveBuiltDeck({ name: o.name, locationId: o.locationId, lines, format: o.format, source: "got", mode: o.mode });
    return { added, deck };
  }
  function deleteDeck(id) {
    const n = state.decks.length;
    state.decks = state.decks.filter(d => d.id !== id);
    return state.decks.length < n;
  }

  /* Every deck for the Deck List page, with one pass over the collection:
     [{ key, deck (the saved record, or null for a plain Deck Box), name,
     locationId, location (its current name, null when it's gone), stacks
     (records in it), have (cards in it), listed (cards in its list, null
     for a plain Deck Box), value, missing: [{ name, qty, have, short }],
     short (cards missing) }]. `key` is the deck's id, or "loc:<location id>". */
  function deckEntries() {
    const seeds = state.decks.map(d => ({ key: d.id, deck: d, name: d.name, locationId: d.locationId }));
    const taken = new Set(state.decks.map(d => d.locationId));
    for (const l of state.locations) {
      if (isDeckBox(l) && !taken.has(l.id)) seeds.push({ key: "loc:" + l.id, deck: null, name: l.name, locationId: l.id });
    }
    const want = new Set(seeds.map(x => x.locationId).filter(Boolean));
    const byLoc = new Map();
    for (const r of state.cards) {
      if (!want.has(r.locationId) || !(r.quantity > 0)) continue;
      let a = byLoc.get(r.locationId);
      if (!a) byLoc.set(r.locationId, a = []);
      a.push(r);
    }
    return seeds.map(x => {
      const loc = x.locationId ? locById(x.locationId) : null;
      const stacks = loc ? (byLoc.get(x.locationId) || []) : [];
      const missing = x.deck ? deckMissing(x.deck.lines, stacks) : [];
      return Object.assign(x, {
        location: loc ? loc.name : null,
        stacks,
        have: stacks.reduce((n, r) => n + availableQty(r), 0),
        listed: x.deck ? x.deck.lines.reduce((n, l) => n + l.qty, 0) : null,
        value: round2(stacks.reduce((n, r) => n + rowTotal(r), 0)),
        missing,
        short: missing.reduce((n, m) => n + m.short, 0)
      });
    });
  }
  /* A list's lines that the deck's location doesn't hold enough of,
     matched by name across every printing (as Build matches). */
  function deckMissing(lines, stacks) {
    const have = new Map();
    for (const r of stacks) {
      const k = String(r.name || "").toLowerCase();
      have.set(k, (have.get(k) || 0) + availableQty(r));   // a copy lent out isn't in the deck (#336)
    }
    const need = new Map();
    for (const l of lines || []) {
      const k = String(l.name || "").toLowerCase();
      const e = need.get(k);
      if (e) e.qty += l.qty; else need.set(k, { name: l.name, qty: l.qty });
    }
    const out = [];
    for (const [k, e] of need) {
      const h = have.get(k) || 0;
      if (h < e.qty) out.push({ name: e.name, qty: e.qty, have: h, short: e.qty - h });
    }
    return out;
  }

  /* Commit a pick list's allocation - decrements the actual stacks it pulled
     from, same as the old shipPick() did in one step, but stops short of
     marking it "shipped": that's a separate, later action (markPickListShipped
     below) once weigh/manifest has happened. Split into its own core.js
     function so lists.page.js stays a thin UI wrapper, same convention as
     applyListingPlan/applyManapoolQuantity. */
  /* Take `n` sold copies off the local listed count for this listing (#86):
     from the stack the copies were pulled from first, then from other stacks
     sharing its Manapool listing, since Manapool lowered the listing as a
     whole and has no idea which shelf a copy sat on. */
  function lowerListedForSale(r, n, pickListId, isSealed, touch) {
    let left = n;
    const siblings = isSealed
      ? (sealedIdentityKey(r) ? sealedManapoolGroup(sealedIdentityKey(r)) : [])
      : (r.scryfallId ? manapoolGroup(manapoolIdentityKey(r)) : []);
    for (const x of [r, ...siblings.filter(s => s !== r)]) {
      if (left <= 0) break;
      const cut = Math.min(left, x.listedQty || 0);
      if (!cut) continue;
      if (touch) touch(x, isSealed);
      const msg = "Sold on Manapool, picked for " + pickListId + ": listed " + x.listedQty + " -> " + (x.listedQty - cut);
      logAudit(isSealed ? { action: "sealed-edit", name: x.name, qty: 0, note: msg }
        : { action: "list", ...auditCard(x), qty: 0, oldQty: x.quantity, newQty: x.quantity, note: msg });
      x.listedQty -= cut;
      left -= cut;
    }
  }

  /* What completing a pick list changed on each inventory row (#214), so
     the server can undo exactly that if another device completed the same
     list first (server/lib/merge.js "Repeat completions"). touch(row)
     before each change, takes() after them all. A row the completion
     emptied also carries its whole earlier self (gone), as it is deleted. */
  const TAKE_FIELDS = ["quantity", "listedQty", "costQty", "costTotal", "avgCost"];
  function completionTakes() {
    const seen = new Map();
    const touch = (r, isSealed) => {
      if (seen.has(r)) return;
      const before = {};
      for (const f of TAKE_FIELDS) before[f] = r[f];
      seen.set(r, { kind: isSealed ? "sealed" : "cards", before });
    };
    const takes = () => {
      const out = [];
      for (const [r, t] of seen) {
        const before = {}, after = {};
        for (const f of TAKE_FIELDS) {
          if (t.before[f] === r[f]) continue;
          before[f] = t.before[f]; after[f] = r[f];
        }
        if (!Object.keys(after).length) continue;
        const take = { kind: t.kind, id: r.id, before, after };
        if (!(r.quantity > 0)) take.gone = Object.assign({}, r, t.before);
        out.push(take);
      }
      return out;
    };
    return { touch, takes };
  }

  /* takesFor(line) (optional, Warehouse Mode): { pulls, shortfall } saying what
     this line really pulled, instead of allocating it here. */
  function completePickList(pickListId, takesFor) {
    const p = pickLists().find(x => x.id === pickListId);
    // Only an open list: a second press, or a stale view of one already
    // completed here, must not take its cards off again (#214).
    if (!p || p.status !== "open" || !p.lines.length) return { shipped: 0, shortLines: 0 };
    // An order Manapool replaced or cancelled isn't picked at the desk (#489): the ticket is
    // discarded instead. Warehouse Mode's Finish (takesFor) completes one with copies already
    // in hand, so they come off as picked and Cancel and put back sends them to a sorting tray.
    if (!takesFor && pickOrderCancelled(p)) return { shipped: 0, shortLines: 0, cancelled: pickOrderCancelled(p) };
    let shipped = 0, shortLines = 0, revenue = 0, cogs = 0;
    const took = completionTakes();
    const auditFrom = pendingAudit.length; // the lines logged below go with the mark (#216)
    // A Manapool order's copies came off Manapool's listing when it sold, so
    // the local listed count drops by what this pick pulled (#86), not merely
    // to the new quantity - selling 1 of 4 with 2 listed leaves 1 listed, as
    // on Manapool. Skipped when Fetch listings already brought listed in line
    // after the order was placed (listedSettled), or it would drop twice.
    // The same holds for one listing whose listed count was set from a
    // Manapool confirmation (a push or price push) while this list was open
    // (listedSettledKeys, see settleOpenManapoolLists).
    const lowerListed = p.source === "manapool" && !p.listedSettled;
    const settledKeys = new Set(p.listedSettledKeys || []);
    // A Manapool order can be replaced after it's picked (#489): same record.
    const keepPutBack = isCounterSale(p) || isManapoolOrderTicket(p);
    const lines = [];
    for (const it of p.lines) {
      const a = (takesFor && takesFor(it)) || allocatePickLine(p, it);
      if (a.shortfall > 0) shortLines++;
      const isSealed = it.kind === "sealed";
      // Freeze what actually happened onto the line itself - a picked/shipped
      // list's own display (renderPick, lists.page.js) reads this instead of
      // re-running allocatePick() live, which used to show a stale/misleading
      // "short 1 - none in inventory" on an already-completed order once
      // inventory had moved on since the real pick. Lives on the line, not
      // just the state.history ship event below, so it survives the user
      // clearing the ship/build event log and travels with the pick list.
      it.pickedResult = { pulls: a.pulls.map(pu => ({ locationId: pu.locationId, qty: pu.take })),
        shortfall: a.shortfall, value: 0, cogs: 0 };
      for (const pull of a.pulls) {
        const r = (isSealed ? state.sealed : state.cards).find(x => x.id === pull.recordId);
        if (!r) continue;
        it.pickedResult.value = round2(it.pickedResult.value + pull.take * (r.price == null ? 0 : r.price));
        // it.unitPrice only exists on a line generated from a real order (see
        // lists.page.js's generatePickList - it copies the order line's own
        // price across) - a manual pick or a deck pull has none, and stays
        // out of revenue entirely rather than guessing at what it sold for.
        const lineRevenue = it.unitPrice != null ? round2(it.unitPrice * pull.take) : null;
        const lineCogs = Number(r.costQty) > 0 ? round2(r.avgCost * Math.min(pull.take, r.costQty)) : null;
        if (lineRevenue != null) revenue = round2(revenue + lineRevenue);
        if (lineCogs != null) cogs = round2(cogs + lineCogs);
        // This line's own cost, so one card's sales can be split out later (#410).
        if (lineCogs != null) it.pickedResult.cogs = round2(it.pickedResult.cogs + lineCogs);
        // A counter sale can still be cancelled after its cards came off the
        // shelf (#431), and a Manapool order replaced (#489): keep what puts
        // each pull back, with its cost, even once the stack itself is gone.
        if (keepPutBack && !isSealed) it.pickedResult.pulls[a.pulls.indexOf(pull)].back = putBackSnapshot(r, pull.take);
        lines.push({ name: it.name, set: it.set, collector: it.collector, finish: it.finish,
          qty: pull.take, from: locName(pull.locationId), unitPrice: it.unitPrice != null ? it.unitPrice : null });
        if (isSealed) {
          logAudit({
            action: "sealed-edit", name: r.name, qty: -pull.take, oldQty: r.quantity,
            newQty: r.quantity - pull.take, from: locName(pull.locationId),
            cost: lineCogs == null ? null : -lineCogs, note: "Picked for " + p.id
          });
        } else {
          logAudit({
            action: "pick", ...auditCard(r), qty: -pull.take, oldQty: r.quantity,
            newQty: r.quantity - pull.take, from: locName(pull.locationId),
            cost: lineCogs == null ? null : -lineCogs,
            note: "Picked for " + p.id
          });
        }
        took.touch(r, isSealed);
        if (lowerListed && !settledKeys.has(settledListingKey(r, isSealed))) lowerListedForSale(r, pull.take, p.id, isSealed, took.touch);
        removeCost(r, pull.take);
        r.quantity -= pull.take;
        shipped += pull.take;
        if (r.listedQty > r.quantity) r.listedQty = Math.max(0, r.quantity);
      }
    }
    const takes = took.takes(); // before the emptied rows go
    state.cards = state.cards.filter(r => r.quantity > 0);
    state.sealed = state.sealed.filter(r => r.quantity > 0);
    normalizeMerge({ silent: true });
    // Shipping charged to the buyer is real revenue too, same as each
    // line's own sale price - just order-level instead of per-line, so it
    // only ever adds in once here rather than needing to be split across
    // lines. fees/earnings are order-level only (Manapool doesn't itemize
    // its cut per line) - "Earnings" is Manapool's own net_cents, not
    // derived from revenue-cogs-fees here, since that would need every
    // line's unitPrice to reconcile exactly with their subtotal to be
    // trustworthy. p.orderPayment is null for a manual/deck pick or an
    // order whose full detail was never fetched - see newPickList().
    const shippingRevenue = p.orderPayment ? p.orderPayment.shipping : null;
    if (shippingRevenue != null) revenue = round2(revenue + shippingRevenue);
    const historyId = uid();
    addHistory({ id: historyId, ts: new Date().toISOString(), type: "pick", title: "Completed " + p.id,
      lines, totalCards: shipped, short: shortLines, revenue, cogs });
    p.status = "picked";
    // Rides on the next save only: the server never stores it, and this
    // page drops it once a save carrying it is answered (#214). Its
    // activity log lines ride on it instead of posting on their own, so
    // the server logs them only if this completion stands (#216, merge.js
    // completionAudit); queryAudit still shows them meanwhile.
    p.completion = { historyId, takes, audit: pendingAudit.splice(auditFrom) };
    p.pickedAt = new Date().toISOString();
    // Kept on the pick list itself, not just the history entry - the
    // accounting export (BACKLOG.md #19) reads state.pickLists directly, and
    // a pick list is the natural join to its order (p.orderId/p.source),
    // which a history entry doesn't carry.
    p.revenue = revenue; p.cogs = cogs;
    p.shippingRevenue = shippingRevenue;
    p.fees = p.orderPayment ? p.orderPayment.fee : null;
    p.earnings = p.orderPayment ? p.orderPayment.net : null;
    // What packing and posting it cost, frozen on the sale (#457): today's
    // Settings → Shipping, never re-worked when those change later.
    if (isManapoolOrderTicket(p)) p.shipCost = shipCostOfSale(p);
    return { shipped, shortLines, revenue, cogs, fees: p.fees, earnings: p.earnings };
  }

  /* The final step - no inventory effect, just records that this pick list
     is done on Grimoire's side. A Manapool order's ticket then tells
     Manapool too (pushShippedToManapool below, #454). */
  function markPickListShipped(pickListId) {
    const p = pickLists().find(x => x.id === pickListId);
    // An order Manapool replaced or cancelled never ships (#489).
    if (!p || pickOrderCancelled(p)) return null;
    p.status = "shipped";
    p.shippedAt = new Date().toISOString();
    logAudit({ action: "ship", note: "Marked " + p.id + " shipped in Grimoire" });
    return p;
  }

  /* ---- Marking the Manapool order shipped too (#454) ----
     A ticket made from a Manapool order (never a counter sale) tells Manapool
     it shipped, through POST /api/manapool/order/:id/fulfillment (the server
     holds the token). What was sent and how it went is kept on the ticket as
     p.manapoolShip = { ok, at, status, tracking: {company, number, url} | null,
     alreadyDone?, needsTracking?, error? }, so the ticket can show it and a
     failed one can be retried. */
  const isManapoolOrderTicket = p => !!p && p.source === "manapool" && !!p.orderId && !isCounterSale(p);

  /* ---- An order Manapool replaced, cancelled or refunded after its ticket was made (#489) ----
     Nothing re-reads an order once its ticket exists, so pick, pack and ship
     would carry on. The server answers which orders are gone, from the orders
     caches of everyone working this inventory (GET /api/manapool/cancelled-orders,
     server/lib/orderShip.js, which also refuses to mark one shipped). Any orders
     a page loads itself add to it. Such a ticket is flagged everywhere, can't be
     marked shipped or packed, and is cancelled with cancelPickedOrder below. */
  const ORDER_CANCELLED_STATUSES = new Set(["replaced", "cancelled", "canceled", "refunded"]);
  const orderStatusKey = s => String(s == null ? "" : s).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const orderWasCancelled = s => ORDER_CANCELLED_STATUSES.has(orderStatusKey(s));
  let cancelledOrders = new Map();   // order id -> status
  function noteOrderStatuses(orders) {
    for (const o of Array.isArray(orders) ? orders : []) {
      if (o && o.id != null && orderWasCancelled(o.status)) cancelledOrders.set(String(o.id), orderStatusKey(o.status));
    }
  }
  /* Asks the server. Resolves true when the set of flagged orders changed (redraw),
     false when it didn't; throws when the request fails, keeping what was known. */
  async function loadCancelledOrders() {
    const d = await api("/api/manapool/cancelled-orders");
    const before = [...cancelledOrders].map(e => e.join("=")).sort().join(",");
    const next = new Map();
    for (const o of (d && d.orders) || []) if (o && o.id != null && orderWasCancelled(o.status)) next.set(String(o.id), orderStatusKey(o.status));
    // Never drops one: an order Manapool replaced or refunded doesn't come back.
    for (const [id, s] of cancelledOrders) if (!next.has(id)) next.set(id, s);
    cancelledOrders = next;
    return [...cancelledOrders].map(e => e.join("=")).sort().join(",") !== before;
  }
  /* "replaced", "cancelled" or "refunded" for an unshipped Manapool ticket whose
     order Manapool says is gone; "" for anything else. */
  function pickOrderCancelled(p) {
    if (!isManapoolOrderTicket(p) || p.status === "shipped") return "";
    const s = cancelledOrders.get(String(p.orderId));
    return !s ? "" : s === "canceled" ? "cancelled" : s;
  }
  /* A Manapool order's packing + postage (#457), from this account's
     Settings → Shipping (public/js/shipCost.js, the same math the server's
     one-time backfill uses: server/lib/shipCostBackfill.js). null when it
     shipped no copies, or no packing rule can carry it. */
  function shipCostOfSale(p) {
    const SC = typeof window !== "undefined" ? window.ShipCost : null;
    if (!SC) return null;
    return SC.costSale(p, orderNeedsTracking(p), state.settings && state.settings.shipping);
  }
  // A sale's frozen shipping cost in dollars, 0 when it has none.
  const saleShipCost = p => (p && p.shipCost && Number(p.shipCost.total)) || 0;
  /* Manapool's "Minimum Required Shipping Method": ground_advantage is USPS's
     tracked package service, so it needs a tracking number; first_class (a
     letter) doesn't. Same rule as the server's integrations.orderNeedsTracking.
     Takes an order (shippingMethod, or raw.shipping_method in an older cache)
     or a ticket (shippingMethod saved when it was made). */
  const TRACKED_SHIPPING = ["ground_advantage"];
  function orderNeedsTracking(o) {
    const m = o && (o.shippingMethod || (o.raw && o.raw.shipping_method));
    return TRACKED_SHIPPING.includes(String(m || "").trim().toLowerCase());
  }
  // The order in hand wins (it's fresher); a ticket whose order isn't loaded uses what it saved.
  function pickNeedsTracking(p, orders) {
    if (!isManapoolOrderTicket(p)) return false;
    const order = (orders || []).find(o => o && String(o.id) === String(p.orderId));
    return orderNeedsTracking(order && (order.shippingMethod || order.raw) ? order : p);
  }
  // Shipped in Grimoire, but Manapool wasn't told: shown with the reason and Retry.
  const manapoolShipFailed = p => !!p && p.status === "shipped" && !!p.manapoolShip && p.manapoolShip.ok === false;

  /* Sends one shipped ticket's order to Manapool and records the answer on
     the ticket. Never throws: a dropped connection is recorded like any
     other failure. The caller persists. Re-reads the ticket by id after the
     wait, since a load may have replaced it meanwhile. */
  async function pushShippedToManapool(pickListId, tracking) {
    const first = pickLists().find(x => x.id === pickListId);
    if (!isManapoolOrderTicket(first)) return null;
    let rec;
    try {
      rec = await api("/api/manapool/order/" + encodeURIComponent(first.orderId) + "/fulfillment",
        { method: "POST", body: { tracking: tracking && tracking.number ? tracking : null } });
    } catch (e) {
      rec = { ok: false, at: new Date().toISOString(), status: "shipped",
        tracking: tracking && tracking.number ? tracking : null,
        error: "Couldn't reach Grimoire's server" + (e && e.message ? " (" + e.message + ")" : "") + "." };
    }
    const p = pickLists().find(x => x.id === pickListId);
    if (!p) return rec;
    p.manapoolShip = rec;
    logAudit({ action: "ship", note: rec.ok
      ? (rec.alreadyDone ? "Manapool already had " + p.id + "'s order as shipped" : "Marked " + p.id + "'s order shipped on Manapool")
      : "Couldn't mark " + p.id + "'s order shipped on Manapool: " + rec.error });
    return rec;
  }

  /* Packed and ready to ship (#386): the last thing Warehouse Mode does to a
     ticket. Still status "picked" (no stock effect); the desk shows it on the
     queue, then weighs, labels and marks it shipped as before. */
  function markPickListPacked(pickListId) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!p || p.status !== "picked" || p.packedAt || pickOrderCancelled(p)) return null;
    p.packedAt = new Date().toISOString();
    p.packedBy = me ? (me.displayName || me.username || "") : "";
    logAudit({ action: "pack", note: "Packed " + p.id + ", ready to ship" });
    return p;
  }

  /* ============================== Order Entry (#402) ==============================
     Orders from outside Manapool, starting with a walk-in at the counter (#431).
     A walk-in order is an ordinary pick ticket (source "walkin"): every line
     carries its sale price (unitPrice), so completePickList books revenue and
     cost exactly as for a Manapool sale, and it allocates, reserves and picks
     like any ticket, desk or Warehouse Mode. What differs: an optional customer,
     no label, weigh or ship step, and the payment taken when it's handed over.
     "shipped" on a counter sale means handed over and paid. A kiosk order
     (#433) is the second source: the customer sends it from the store's
     kiosk, the server writes it as an open ticket (server/lib/kiosk.js, which
     mirrors counterFree), and from then on staff pick, hand over and cancel
     it exactly like a walk-in sent to be picked. */
  const COUNTER_SOURCES = ["walkin", "kiosk"];
  const isCounterSale = p => !!p && COUNTER_SOURCES.includes(p.source);
  const PAY_METHODS = ["cash", "card", "other"];
  const PAY_METHOD_NAMES = { cash: "Cash", card: "Card", other: "Other" };
  const ORDER_SOURCE_NAMES = { walkin: "Walk-in", kiosk: "Kiosk" };
  // "walk-in order", "kiosk order": how the activity log and the desk name one.
  const counterOrderWord = p => (ORDER_SOURCE_NAMES[p && p.source] || "Walk-in").toLowerCase() + " order";
  // How to reach a kiosk customer (#433: an email or a phone, required there), or "".
  const counterContact = p => (p && p.customer && (p.customer.email || p.customer.phone)) || "";
  // Who a counter sale went to: its customer, else the anonymous "Walk-in".
  const counterSaleName = p => (p && p.customer && p.customer.name) || ORDER_SOURCE_NAMES[p && p.source] || "Walk-in";

  /* What puts one pull back (#431): the stack as it was, without its counts,
     and the cost of the copies taken, as completePickList reckons it. */
  const PUT_BACK_DROP = new Set(["id", "quantity", "listedQty", "loans", "costQty", "costTotal", "avgCost", "held"]);
  function putBackSnapshot(r, take) {
    const stack = {};
    for (const k of Object.keys(r)) if (!PUT_BACK_DROP.has(k)) stack[k] = r[k];
    const costQty = Math.min(take, Number(r.costQty) || 0);
    return { stack, costQty, cost: costQty > 0 ? round2(r.avgCost * costQty) : null };
  }

  /* Copies free to sell at the counter, per stack id: what's free
     (availableQty) less what every other open ticket, and every fetched
     Manapool order not yet on a ticket, claims in the allocation completing
     them uses. So the counter can't sell a copy an online order is waiting on.
     exceptId: a ticket left out (the one being finished). Only stacks in a
     sell-from location are on the counter at all (owner, 2026-11-07). */
  const sellsFrom = r => { const l = locById(r.locationId); return !!(l && l.sellFrom); };
  function counterFree(exceptId) {
    const free = new Map(state.cards.filter(sellsFrom).map(r => [r.id, availableQty(r)]));
    const unpicked = unpickedManapoolOrders().map(o => ({ source: "manapool", lines: orderPickItems(o, true) }));
    for (const [id, n] of pickAllocations(null, p => p.id !== exceptId, unpicked)) {
      if (free.has(id)) free.set(id, Math.max(0, free.get(id) - n));
    }
    return free;
  }
  // One sellable unit: a printing in one finish, language and condition.
  const counterKey = l => [String(l.set || "").toLowerCase(), normNum(l.collector), l.lang || "en", l.finish || "nonfoil", l.condition || "NM"].join("|");
  const COUNTER_FIND_MAX = 40;
  /* Cards in stock in sell-from locations matching a search (every word in
     the name, set code or number, as Warehouse Mode's Find), one row per
     sellable unit with its market price, copies on hand there and copies free
     to sell, less what `draft` (the order being built) already takes. */
  function counterFindCards(text, draft) {
    const terms = rfFold(text).split(/\s+/).filter(Boolean);
    const out = { rows: [], more: false };
    if (!terms.length) return out;
    const by = new Map(), folded = new Map();
    for (const r of state.cards) {
      if (!sellsFrom(r) || !terms.every(t => rfHay(r, folded).includes(t))) continue;
      const key = counterKey(r);
      let g = by.get(key);
      if (!g) {
        g = { key, kind: "card", name: r.name, set: r.set, collector: r.collector, lang: r.lang || "en", finish: r.finish || "nonfoil",
          condition: r.condition || "NM", imageUrl: r.imageUrl || "", price: null, onHand: 0, free: 0, ids: [] };
        by.set(key, g);
      }
      g.onHand += Number(r.quantity) || 0;
      g.ids.push(r.id);
      if (g.price == null && r.price != null && isFinite(Number(r.price))) g.price = Number(r.price);
      if (!g.imageUrl && r.imageUrl) g.imageUrl = r.imageUrl;
    }
    const all = [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.set.localeCompare(b.set) ||
      String(a.collector).localeCompare(String(b.collector), undefined, { numeric: true }) ||
      a.finish.localeCompare(b.finish) || CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition));
    out.more = all.length > COUNTER_FIND_MAX;
    out.rows = all.slice(0, COUNTER_FIND_MAX);
    if (!out.rows.length) return out;
    const free = counterFree();
    const taken = new Map();
    for (const l of draft || []) taken.set(counterKey(l), (taken.get(counterKey(l)) || 0) + (Number(l.qty) || 0));
    for (const g of out.rows) {
      g.free = Math.max(0, g.ids.reduce((s, id) => s + (free.get(id) || 0), 0) - (taken.get(g.key) || 0));
      delete g.ids;
    }
    return out;
  }
  // Copies of one order line free to sell right now.
  function counterLineFree(item, free) {
    let n = 0;
    for (const r of state.cards) if (cardLineMatches(item, r)) n += free.get(r.id) || 0;
    return n;
  }
  /* Completing a counter ticket takes its copies around everyone else's
     claims (counterFree), so a sale finished on the spot leaves an online
     order's copies on the shelf. A ticket sent to be picked allocates like a
     Manapool ticket (pickListAllocOpts: sell-from only, desk and floor). */
  function counterTakes(p) {
    const free = counterFree(p.id);
    return it => allocateRemaining(it, pickListAllocOpts(p), free);
  }

  /* Enters a walk-in order (#431).
       lines: [{ set, collector, lang, finish, condition, name, qty, unitPrice, marketPrice }]
       customer: { id, name } or null for an anonymous walk-in
       mode: "pick" sends a ticket to Order Fulfillment; "now" means the cards
         are in hand: stock comes off at once and `payment` (a PAY_METHODS key)
         is recorded.
     Refuses ({ ok: false, error }) an empty order, a line with no price, or a
     line wanting more copies than are free to sell. The caller persists, then
     calls orderEntryListingSync("entered", pickList). */
  function enterWalkInOrder(o) {
    o = o || {};
    const lines = [], byKey = new Map();
    for (const l of o.lines || []) {
      const qty = Number(l.qty);
      const price = l.unitPrice === "" || l.unitPrice == null ? NaN : Number(l.unitPrice);
      if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: "Each line needs a quantity of 1 or more (" + l.name + ")." };
      if (!isFinite(price) || price < 0) return { ok: false, error: l.name + " has no market price. Type the price it sells for." };
      const item = { kind: "card", set: String(l.set || "").toLowerCase(), collector: String(l.collector || ""), lang: l.lang || "en",
        finish: l.finish || "nonfoil", condition: l.condition || "NM", name: l.name || "", qty, unitPrice: round2(price),
        marketPrice: l.marketPrice == null || !isFinite(Number(l.marketPrice)) ? null : Number(l.marketPrice) };
      // One line per sellable unit, as a ticket has (the first price stands).
      const ex = byKey.get(counterKey(item));
      if (ex) { ex.qty += qty; continue; }
      byKey.set(counterKey(item), item);
      lines.push(item);
    }
    if (!lines.length) return { ok: false, error: "Add at least one card to the order." };
    if (o.mode === "now" && !PAY_METHODS.includes(o.payment)) return { ok: false, error: "Choose how they paid." };
    const free = counterFree();
    for (const it of lines) {
      const n = counterLineFree(it, free);
      if (it.qty > n) return { ok: false, error: "Only " + n + " " + copyWord(n) + " of " + it.name + " (" + it.condition + ") " + (n === 1 ? "is" : "are") + " free to sell now." };
    }
    const p = newPickList({ source: "walkin" });
    const c = o.customer && String(o.customer.name || "").trim() ? o.customer : null;
    p.customer = c ? { id: String(c.id || ""), name: String(c.name).trim().slice(0, 200) } : null;
    p.lines = lines;
    pickLists().push(p);
    if (o.mode === "now") {
      completePickList(p.id, counterTakes(p));
      handOverCounterSale(p.id, o.payment);
    }
    return { ok: true, pickList: p };
  }

  /* The counter sale is handed over (#431): records how they paid and the
     total (what was really picked, so a line that went short isn't charged),
     and closes the ticket. Only a picked counter ticket. */
  function handOverCounterSale(pickListId, method) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!isCounterSale(p) || p.status !== "picked" || !PAY_METHODS.includes(method)) return null;
    p.payment = { method, total: round2(Number(p.revenue) || 0) };
    p.status = "shipped";
    p.handedOverAt = p.shippedAt = new Date().toISOString();
    logAudit({ action: "ship", note: "Handed over " + p.id + " to " + counterSaleName(p) + ", paid " + money(p.payment.total) +
      " (" + PAY_METHOD_NAMES[method].toLowerCase() + ")" });
    return p;
  }
  /* When a completed ticket's stock and money count (one rule for Accounting,
     the Dashboard's sales and profit tiles and the card panel): once picked,
     dated pickedAt; a counter sale only once handed over and paid, dated
     handedOverAt, since until then it can be cancelled. null: not yet. */
  function saleDate(p) {
    if (!p || p.status === "open") return null;
    if (isCounterSale(p)) return p.status === "shipped" ? p.handedOverAt || p.pickedAt || null : null;
    return p.pickedAt || null;
  }
  // An order sale (Manapool or counter), not a manual or deck pick.
  const isOrderSale = p => !!p && (!!p.orderId || isCounterSale(p));
  // Picked and waiting to ship: a counter sale is handed over, never shipped.
  const awaitsShip = p => !!p && p.status === "picked" && !isCounterSale(p);
  const isPickEventOf = (h, p) => !!h && h.type === "pick" && h.title === "Completed " + p.id;
  // What a counter ticket would charge now: picked lines as picked, the rest as ordered.
  function counterSaleTotal(p) {
    if (!p) return 0;
    if (p.status !== "open") return round2(Number(p.revenue) || 0);
    return round2((p.lines || []).reduce((s, l) => s + (Number(l.unitPrice) || 0) * (Number(l.qty) || 0), 0));
  }

  /* Cancels a counter order not yet handed over (#431). An open ticket only
     set copies aside, so dropping it frees them. A picked one already took
     them off the shelf: each pull goes back to the bin it came from, with
     its cost, and the sale leaves Statistics. Refused while Warehouse Mode
     has its cards in a tote (reverse them there). The caller confirms first,
     persists, then calls orderEntryListingSync("cancelled", pickList). */
  function cancelCounterSale(pickListId) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!isCounterSale(p) || (p.status !== "open" && p.status !== "picked")) {
      return { ok: false, error: "Only an order that hasn't been handed over can be cancelled." };
    }
    if (pickListInHand(p)) return { ok: false, error: "Its cards are pulled in Warehouse Mode. Reverse them there first." };
    let putBack = 0;
    if (p.status === "picked") {
      for (const it of p.lines) {
        for (const pull of (it.pickedResult && it.pickedResult.pulls) || []) {
          const n = Number(pull.qty) || 0;
          if (n > 0 && pull.back) putBack += putBackPull(pull, n, p);
        }
      }
      normalizeMerge({ silent: true });
      // Its ship event (completePickList's, one per ticket) leaves Statistics with it.
      state.history = state.history.filter(h => !isPickEventOf(h, p));
    }
    const list = pickLists();
    list.splice(list.indexOf(p), 1);
    logAudit({ action: "edit", note: "Cancelled " + counterOrderWord(p) + " " + p.id + (putBack ? ", " + putBack + " " + copyWord(putBack) + " put back" : "") });
    return { ok: true, putBack, pickList: p };
  }
  function putBackPull(pull, n, p) {
    const b = pull.back, s = b.stack;
    let rec = state.cards.find(r => !r.held && r.locationId === pull.locationId && r.set === s.set &&
      normNum(r.collector) === normNum(s.collector) && r.lang === s.lang && r.finish === s.finish &&
      (r.condition || "NM") === (s.condition || "NM"));
    const oldQty = rec ? rec.quantity : 0;
    if (rec) rec.quantity += n;
    else {
      rec = normalizeCard(Object.assign({}, s, { locationId: pull.locationId, quantity: n, listedQty: 0 }));
      state.cards.push(rec);
    }
    if (b.costQty > 0 && b.cost != null) applyCost(rec, Math.min(b.costQty, n), b.cost / b.costQty);
    logAudit({ action: "add", ...auditCard(rec), qty: n, oldQty, newQty: rec.quantity, to: locName(rec.locationId),
      cost: b.cost, note: "Put back: " + counterOrderWord(p) + " " + p.id + " cancelled" });
    return n;
  }

  /* ---- Cancel and put back: a picked Manapool ticket whose order is gone (#489) ----
     Manapool replaced, cancelled or refunded the order after Finish took the
     copies off the shelf. Owner (2026-11-15): they go into a sorting tray with
     their cost, to be shelved with put-away like received stock; the ticket
     goes and its sale leaves Accounting, Statistics and the Dashboard, as
     cancelCounterSale does. Free stock, not held: once put away into a sell-from bin, Listings can list them again. */
  // The sorting trays the copies can go in, by name.
  const sortingTrays = () => state.locations.filter(l => l.staging)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" }));
  // None yet: "Sorting tray", made the first time it's needed (receivingTray's way).
  function newSortingTray() {
    const taken = new Set(state.locations.map(l => String(l.name).toLowerCase()));
    let name = "Sorting tray", n = 2;
    while (taken.has(name.toLowerCase())) name = "Sorting tray " + n++;
    const loc = createLocation({ name, type: "Other", staging: true });
    state.locations.push(loc);
    return loc;
  }
  // What a card stack carries about the printing itself (no counts, place or notes).
  const PRINTING_KEYS = ["name", "setName", "rarity", "tcgplayerId", "scryfallId", "price", "priceNote", "priceUpdated", "englishName"].concat(META_KEYS);
  const SEALED_KEYS = ["tcgplayerProductId", "manapoolProductId", "name", "setCode", "price", "priceUpdated"];
  const pickFields = (r, keys) => { const o = {}; for (const k of keys) if (r && r[k] !== undefined) o[k] = r[k]; return o; };
  /* A line's pulls as stacks to put back: [{ sealed, stack (no counts), n, costQty, cost }].
     A pull made since #489 kept its stack and cost (pull.back). An older Manapool
     pull is only { locationId, qty }: the stack comes from the line, the printing's
     details from any stack of it still here, else from infoFor (lookupCard's answer),
     and the cost from the line's own share of what the sale cost. */
  function putBackPlan(it, infoFor, ticketShare) {
    const res = it.pickedResult;
    const pulls = ((res && res.pulls) || []).filter(x => Number(x.qty) > 0);
    const pulled = pulls.reduce((n, x) => n + Number(x.qty), 0);
    if (!pulled) return [];
    const sealed = it.kind === "sealed";
    // Older lines have no per-line cost (#410): the ticket's, shared by copies.
    const lineCost = res.cogs != null ? Number(res.cogs) || 0 : ticketShare * pulled;
    const each = lineCost > 0 ? lineCost / pulled : 0;
    let template;
    if (sealed) {
      const like = state.sealed.find(r => String(r.tcgplayerProductId) === String(it.tcgplayerProductId));
      template = Object.assign(pickFields(it, SEALED_KEYS), pickFields(like, SEALED_KEYS));
    } else {
      const like = state.cards.find(r => r.set === it.set && normNum(r.collector) === normNum(it.collector) &&
        (r.lang || "en") === (it.lang || "en") && r.finish === (it.finish || "nonfoil"));
      const info = like ? null : infoFor && infoFor(it);
      template = Object.assign({ name: it.name }, like ? pickFields(like, PRINTING_KEYS)
        : info ? Object.assign(pickFields(info, PRINTING_KEYS), info.meta || {}) : {},
        { set: it.set, collector: it.collector, lang: it.lang || "en", finish: it.finish || "nonfoil", condition: it.condition || "NM" });
    }
    return pulls.map(pull => {
      const n = Number(pull.qty), b = pull.back;
      if (b && b.stack) return { sealed, stack: b.stack, n, costQty: Math.min(b.costQty || 0, n), cost: b.cost };
      return { sealed, stack: template, n, costQty: each > 0 ? n : 0, cost: each > 0 ? round2(each * n) : null };
    });
  }
  /* opts: { trayId (a sorting tray; needed when there are several), infoFor(line) ->
     lookupCard's answer or null }. -> { ok, putBack, tray, pickList } or { ok: false,
     error }. The caller confirms first and persists. */
  function cancelPickedOrder(pickListId, opts) {
    const o = opts || {};
    const p = pickLists().find(x => x.id === pickListId);
    if (!isManapoolOrderTicket(p)) return { ok: false, error: "Only a Manapool order's ticket is cancelled this way." };
    if (p.status === "shipped") return { ok: false, error: p.id + " is already shipped, so it can't be cancelled. Book what comes back on Returns." };
    if (p.status !== "picked") return { ok: false, error: p.id + " isn't picked yet: discard the ticket instead, which frees its copies." };
    if (pickListInHand(p)) return { ok: false, error: "Its batch has cards pulled in Warehouse Mode. Finish or reverse them there first." };
    let tray;
    if (o.trayId) {
      tray = locById(o.trayId);
      if (!tray || !tray.staging) return { ok: false, error: "That sorting tray isn't there any more. Choose another." };
    } else {
      const trays = sortingTrays();
      if (trays.length > 1) return { ok: false, error: "Choose which sorting tray the cards go in." };
      tray = trays[0] || newSortingTray();
    }
    const label = pickListTag(p);
    const why = "Put back: order " + label + " (" + p.id + ") cancelled on Manapool";
    const totalPulled = p.lines.reduce((n, it) => n + ((it.pickedResult && it.pickedResult.pulls) || []).reduce((s, x) => s + (Number(x.qty) || 0), 0), 0);
    const ticketShare = totalPulled > 0 && Number(p.cogs) > 0 ? Number(p.cogs) / totalPulled : 0;
    let putBack = 0;
    for (const it of p.lines) {
      for (const put of putBackPlan(it, o.infoFor, ticketShare)) {
        const s = put.stack;
        if (put.sealed) {
          let rec = state.sealed.find(r => !r.held && r.locationId === tray.id && String(r.tcgplayerProductId) === String(s.tcgplayerProductId));
          const oldQty = rec ? rec.quantity : 0;
          if (rec) rec.quantity += put.n;
          else {
            rec = normalizeSealedItem(Object.assign(pickFields(s, SEALED_KEYS), { locationId: tray.id, quantity: put.n, listedQty: 0 }));
            state.sealed.push(rec);
          }
          if (put.costQty > 0 && put.cost != null) applyCost(rec, put.costQty, put.cost / put.costQty);
          logAudit({ action: "sealed-edit", name: rec.name, qty: put.n, oldQty, newQty: rec.quantity, to: locName(tray.id), cost: put.cost, note: why });
        } else {
          const like = { set: s.set, collector: s.collector, lang: s.lang || "en", finish: s.finish || "nonfoil", condition: s.condition || "NM" };
          let rec = state.cards.find(r => !r.held && r.locationId === tray.id && sameCardLine(r, like));
          const oldQty = rec ? rec.quantity : 0;
          if (rec) rec.quantity += put.n;
          else {
            rec = normalizeCard(Object.assign({}, s, like, { locationId: tray.id, quantity: put.n, listedQty: 0 }));
            state.cards.push(rec);
          }
          if (put.costQty > 0 && put.cost != null) applyCost(rec, put.costQty, put.cost / put.costQty);
          logAudit({ action: "add", ...auditCard(rec), qty: put.n, oldQty, newQty: rec.quantity, to: locName(tray.id), cost: put.cost, note: why });
        }
        putBack += put.n;
      }
    }
    normalizeMerge({ silent: true });
    // Its sale (completePickList's ship event, one per ticket) leaves Statistics with it.
    state.history = state.history.filter(h => !isPickEventOf(h, p));
    const list = pickLists();
    list.splice(list.indexOf(p), 1);
    const status = pickOrderCancelled(p);
    logAudit({ action: "edit", note: "Cancelled " + p.id + " (order " + label + (status ? ", " + status + " on Manapool" : "") + ")" +
      (putBack ? ", " + putBack + " " + copyWord(putBack) + " put in " + tray.name : "") });
    return { ok: true, putBack, tray, pickList: p };
  }

  /* Manapool's listed quantity follows an Order Entry order (#432; #402,
     owner's answer 7). Called once the order is entered ("entered": each
     card's listing comes down by its copies, so an online buyer can't take
     the same copy) and once it's cancelled ("cancelled": back up by what came
     down). The server does it all (/api/manapool/order-entry-sync,
     server/lib/orderEntryListing.js): it reads the ticket's cards from the
     saved inventory, uses the inventory owner's Manapool connection (a Staff
     login has none of its own), and records what came down, so a cancel
     raises exactly that. So the change is saved first. Each confirmed
     listing's local listed count is then set from Manapool's own number.
     Resolves { warnings: [plain sentences] } for the page to show: it never
     undoes or blocks the order. A personal account without Manapool, or a
     card that isn't listed there: nothing happens and nothing is said. A
     store whose owner hasn't connected Manapool says so. */
  async function orderEntryListingSync(event, pickList) {
    const out = { warnings: [] };
    if (!pickList || !isCounterSale(pickList)) return out;
    const verb = event === "cancelled" ? "raised again" : "lowered";
    const cards = (pickList.lines || []).filter(it => it.kind !== "sealed");
    if (!cards.length) return out;
    const note = ORDER_SOURCE_NAMES[pickList.source] + " order " + pickList.id + (event === "cancelled" ? " cancelled" : "");
    // rows: [{ card, error }]. Logged per card, and one warning naming them all.
    const fail = rows => {
      for (const { card: c, error } of rows) {
        logAudit({ action: "list", name: c.name, set: c.set, collector: c.collector, lang: c.lang, finish: c.finish, condition: c.condition,
          note: note + ": Manapool listing not " + verb + " (" + String(error || "no reply").slice(0, 200) + ")" });
      }
      out.warnings.push(listingWarning(event, rows.map(r => r.card)));
    };
    let d;
    try {
      // The server reads the ticket as saved: the order (or its cancel) goes first.
      if (!(await saveAll())) throw new Error("the order isn't saved yet");
      d = await api("/api/manapool/order-entry-sync", { method: "POST",
        body: { event, ticketId: pickList.id, createdAt: pickList.createdAt || null, owner: loadedOwner } });
    } catch (e) {
      fail(cards.map(card => ({ card, error: e.message })));
      persist("Manapool listing: " + pickList.id, { undo: false });
      return out;
    }
    if (!d || !d.connected) {
      if (d && d.store && d.reason === "not-connected") {
        out.warnings.push("Manapool wasn't updated: the store isn't connected to Manapool. The store's owner can connect it in " +
          "Settings → Integrations.");
      }
      return out;
    }
    const failed = [];
    let changed = false;
    for (const r of d.results || []) {
      if (!r || !r.card) continue;
      if (!r.ok) { failed.push(r); continue; }
      if (!r.listed || !r.change) continue;
      if (r.quantity != null && r.card.scryfallId) applyManapoolQuantity(manapoolIdentityKey(r.card), r.quantity, note);
      changed = true;
    }
    if (failed.length) { fail(failed); changed = true; }
    // Part of the order's own step: Undo right after a sale still reverses the sale.
    if (changed) persist("Manapool listing: " + pickList.id, { undo: false });
    return out;
  }
  function listingWarning(event, cards) {
    const names = cards.map(c => c.name + (c.set ? " (" + String(c.set).toUpperCase() + (c.collector ? " #" + c.collector : "") + ")" : ""));
    const them = names.length === 1 ? "that listing" : "those listings";
    return event === "cancelled"
      ? "Manapool wasn't raised again for " + names.join(", ") + ". Raise " + them + " on Manapool by hand to put the copies back up for sale."
      : "Manapool wasn't lowered for " + names.join(", ") + ". Lower " + them + " on Manapool by hand so an online buyer can't buy the same copies.";
  }

  /* Is this order short? A completed ticket knows what really happened. An
     open one is short once a floor short pick found no other bin (shortFlag,
     set by rfShortPick, re-checked at each short pick). */
  function pickListIsShort(p) {
    if (!p) return false;
    if (p.status === "open") return !!p.shortFlag;
    return (p.lines || []).some(l => l.pickedResult && l.pickedResult.shortfall > 0);
  }

  /* ---------- Batch picking (#212) ----------
     Several open pick lists pulled together from one combined sheet, then
     sorted back into their orders one order at a time. Each order stays its
     own pick list: the batch is only a tag on each member (p.batchId) plus
     that order's sort progress (p.batchSorted, the pickKeys of its lines
     already bagged). Kept on the pick lists rather than a new top-level
     array so the sync merge (server/lib/merge.js, pickLists keyed by id)
     merges it order by order with no server change. Nothing here touches a
     list's status, lines or inventory: reservations (pickAllocations) and
     completion (completePickList) work exactly as for a list on its own.

     Assigned to one person (owner, 2026-10-13): p.batchAssignee = {id, name}
     on every member, set to whoever pressed Pick together. In a Store only
     the assignee may tick, complete, chase or dissolve; an Owner or Manager
     can reassign. A personal inventory has one person, who may always act.
     The assignee is a field of each member list, so a reassign racing a
     sort tick merges field by field: the tick lands and the new assignee
     stands, and the tab that lost the batch can't act once it adopts that. */
  const BATCH_FIELDS = ["batchId", "batchSorted", "batchAssignee", "batchNamed"];
  function pickBatchLists(batchId) {
    if (!batchId) return [];
    return pickLists().filter(p => p.batchId === batchId);
  }
  const assigneeOf = user => user && user.id
    ? { id: String(user.id), name: String(user.displayName || user.username || user.name || user.id) } : null;
  // Puts the given open, non-empty lists into one new batch (at least two),
  // assigned to `user`. A list already in another batch moves to this one
  // and starts its sort over. Returns the new batch id, or null.
  function createPickBatch(ids, user) {
    const want = new Set(ids || []);
    const personal = !!user && !user.orgId;
    // Not one being picked in Warehouse Mode, or with copies in a tote from it.
    // On a personal account a ticket started there with nothing pulled is just
    // un-started (#448): nobody else is walking to a bin for it.
    const lists = pickLists().filter(p => want.has(p.id) && p.status === "open" && p.lines.length && !rfPullsOf(p).length &&
      (!p.rfPicker || personal));
    if (lists.length < 2) return null;
    const batchId = "batch-" + uid();
    const who = assigneeOf(user);
    for (const p of lists) {
      delete p.rfPicker; delete p.rfReleased;
      p.batchId = batchId; p.batchSorted = [];
      if (who) p.batchAssignee = Object.assign({}, who); else delete p.batchAssignee;
    }
    // A batch this one took every other ticket from is no batch any more.
    tidyPickBatches();
    return batchId;
  }
  // Why these tickets can't be batched, one sentence per blocking ticket (#448):
  // started in Warehouse Mode, or cards already pulled there. A personal account
  // is only blocked by pulled cards (a bare start is cleared on batching).
  function pickBatchBlockers(ids, user) {
    const want = new Set(ids || []);
    const personal = !!user && !user.orgId;
    const out = [];
    for (const p of pickLists()) {
      if (!want.has(p.id) || p.status !== "open" || !p.lines.length) continue;
      const pulled = rfPullsOf(p).reduce((n, h) => n + h.qty, 0);
      if (pulled > 0) out.push(pickListTag(p) + " has " + pulled + " card" + (pulled === 1 ? "" : "s") + " pulled in Warehouse Mode. Finish it there, or reverse them first.");
      else if (p.rfPicker && !personal) out.push(pickListTag(p) + " is being picked by " + p.rfPicker.name + " in Warehouse Mode. Release it first.");
    }
    return out;
  }
  // Takes every list out of the batch, sort progress and all. The lists
  // themselves (lines, status, inventory) are untouched. Returns how many.
  function dissolvePickBatch(batchId) {
    const lists = pickBatchLists(batchId);
    for (const p of lists) for (const f of BATCH_FIELDS) delete p[f];
    return lists.length;
  }
  // The batch's assignee ({id, name}) as its first ticket has it, or null.
  function pickBatchAssignee(batchId) {
    const p = pickBatchLists(batchId)[0];
    return p && p.batchAssignee && p.batchAssignee.id ? p.batchAssignee : null;
  }
  function assignPickBatch(batchId, user) {
    const who = assigneeOf(user);
    if (!who) return 0;
    const lists = pickBatchLists(batchId);
    for (const p of lists) p.batchAssignee = Object.assign({}, who);
    return lists.length;
  }
  /* A manager naming a picker at the desk (owner, 2026-10-31). The assignment
     holds: p.batchNamed takes the batch out of Warehouse Mode's open pool, and
     it shows only for that picker and for those who can take it over. Copies
     already in hand don't move by themselves, so the desk warns first and it's
     logged, with who had it and who has it now. */
  function reassignPickBatch(batchId, to, by) {
    const who = assigneeOf(to);
    if (!who || !canReassignPickBatch(by)) return false;
    const was = rfPickerOf({ kind: "batch", id: batchId });
    assignPickBatch(batchId, to);
    const lists = pickBatchLists(batchId);
    for (const p of lists) {
      if (p.status !== "open") continue;
      p.batchNamed = true;
      delete p.rfReleased;
      if (p.rfPicker) p.rfPicker = Object.assign({}, who);
    }
    logAudit({ action: "pick-assigned", from: was ? was.name : "", to: who.name,
      note: "Assigned " + lists.map(pickListTag).join(", ") + " to " + who.name + (was ? ", from " + was.name : "") });
    return true;
  }
  const pickBatchInHand = batchId => pickBatchLists(batchId).filter(p => p.status === "open").reduce((n, p) => n + rfPullsOf(p).reduce((s, h) => s + h.qty, 0), 0);
  const pickBatchIsOpen = batchId => rfBatchIsOpen(pickBatchLists(batchId));
  const pickBatchIsNamed = batchId => pickBatchLists(batchId).some(p => p.batchNamed);
  // May `user` work this batch (tick, complete, chase, dissolve)? Always on
  // a personal inventory (no orgId); in a Store only if every ticket in the
  // batch names them as assignee - a ticket a racing reassign already moved
  // on locks the whole batch rather than half of it. Once Warehouse Mode has
  // finished picking it, anyone can pack it, same as a single ticket (owner,
  // 2026-10-31).
  function canWorkPickBatch(batchId, user) {
    if (!user) return false;
    if (!user.orgId) return true;
    const lists = pickBatchLists(batchId);
    if (lists.length > 0 && lists.every(rfWasPickedHere)) return true;
    return lists.length > 0 && lists.every(p => p.batchAssignee && String(p.batchAssignee.id) === String(user.id));
  }
  // The same for one ticket: one that isn't in a batch is anyone's, until
  // someone starts it in Warehouse Mode (p.rfPicker, owner 2026-10-31).
  function canWorkPickList(p, user) {
    if (!p) return true;
    if (p.batchId) return canWorkPickBatch(p.batchId, user);
    if (p.status !== "open" || !p.rfPicker || !user || !user.orgId) return true;
    return String(p.rfPicker.id) === String(user.id);
  }
  // Only a Store's Owner or Manager reassigns (personal: nobody else to give
  // it to). Same rank as canManageStore.
  function canReassignPickBatch(user) {
    return !!(user && user.orgId && (user.orgRole === "owner" || user.orgRole === "manager"));
  }
  /* Leftovers two tabs can produce (PR #213 review), cleaned on every
     adopted state and after a new batch: a batch left with one ticket
     (overlapping batches from two tabs - one ticket is no batch), and sort
     ticks or an assignee left on a ticket no longer in any batch (a dissolve
     racing a tick or a reassign). Returns whether anything changed. */
  function tidyPickBatches() {
    if (!Array.isArray(state.pickLists)) return false;
    const count = new Map();
    for (const p of state.pickLists) if (p && p.batchId) count.set(p.batchId, (count.get(p.batchId) || 0) + 1);
    let changed = false;
    for (const p of state.pickLists) {
      if (!p) continue;
      const lone = p.batchId && count.get(p.batchId) < 2;
      for (const f of BATCH_FIELDS) {
        if ((lone || !p.batchId) && f in p) { delete p[f]; changed = true; }
      }
    }
    return changed;
  }
  function setPickBatchSorted(pickListId, key, on) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!p || !p.batchId) return;
    const s = new Set(Array.isArray(p.batchSorted) ? p.batchSorted : []);
    if (on) s.add(key); else s.delete(key);
    p.batchSorted = [...s];
  }
  function pickBatchSortProgress(p) {
    const s = new Set(Array.isArray(p && p.batchSorted) ? p.batchSorted : []);
    const lines = p ? p.lines : [];
    return { done: lines.filter(l => s.has(pickKey(l))).length, total: lines.length };
  }
  /* ---------- Picked ticks (#217) ----------
     A picker ticks each line as it goes into the pile. Stored on the ticket
     as p.pickedKeys. A tick is per PHYSICAL PULL, not per line: one string
     "<pickKey>@<location id>" for each place the line is pulled from (or
     "<pickKey>@short" for the part nobody can pull, "@none" for a completed
     ticket with no history). A line counts as picked only when ALL its
     pulls are ticked, so a card spread over two bins isn't picked until
     both are. Pulls come from the batch's combined sheet for a ticket in a
     batch (so the one-ticket view and the sheet agree) and from the ticket's
     own allocation otherwise. A chase pick that moves a pull to another
     location makes a new, unticked pull; a tick for a pull that no longer
     exists is simply ignored and pruned on the next tick.
     Purely a checklist: it never changes inventory, reservations or the
     ticket's stage - only completePickList does. Known limit, as for
     batchSorted: the sync merge treats pickedKeys as one field, so two
     devices ticking different lines of the same ticket at the same moment
     conflict and one tick can be lost (the merge warns). */
  const pullTickKey = (lineKey, kind, locationId) => lineKey + "@" + (kind === "pull" ? locationId : kind);
  // Map: line pickKey -> its current pull keys (always at least one).
  function pickLineKeys(p) {
    const out = new Map();
    const add = (lineKey, k) => { if (!out.has(lineKey)) out.set(lineKey, new Set()); out.get(lineKey).add(k); };
    if (p && p.batchId && pickBatchLists(p.batchId).some(x => x.id === p.id)) {
      for (const r of pickBatchSheet(p.batchId).rows) {
        if (r.orders.some(o => o.pickListId === p.id)) add(r.key, pullTickKey(r.key, r.kind, r.locationId));
      }
    } else if (p) {
      for (const it of p.lines) {
        const key = pickKey(it);
        if (p.status === "open") {
          const a = allocatePickLine(p, it);
          for (const pu of a.pulls) add(key, pullTickKey(key, "pull", pu.locationId));
          if (a.shortfall > 0) add(key, pullTickKey(key, "short"));
        } else if (it.pickedResult) {
          for (const pu of it.pickedResult.pulls) add(key, pullTickKey(key, "pull", pu.locationId));
          if (it.pickedResult.shortfall > 0) add(key, pullTickKey(key, "short"));
        } else add(key, pullTickKey(key, "none"));
      }
    }
    for (const it of (p ? p.lines : [])) { const key = pickKey(it); if (!out.has(key)) add(key, pullTickKey(key, "none")); }
    return out;
  }
  const tickedSet = p => new Set(Array.isArray(p && p.pickedKeys) ? p.pickedKeys : []);
  function pickLinePicked(p, lineKey, keyMap) {
    const keys = (keyMap || pickLineKeys(p)).get(lineKey);
    const s = tickedSet(p);
    return !!keys && keys.size > 0 && [...keys].every(k => s.has(k));
  }
  // Tick or untick pulls of one line of an open ticket. `only` (optional)
  // is the list of pull keys to change; default every pull of the line.
  // Stale ticks of that line (pulls that moved) are dropped on the way.
  function setPickLinePicked(pickListId, lineKey, on, only) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!p || p.status !== "open" || !p.lines.some(l => pickKey(l) === lineKey)) return false;
    const current = pickLineKeys(p).get(lineKey) || new Set();
    const s = tickedSet(p);
    for (const k of [...s]) if (k.startsWith(lineKey + "@") && !current.has(k)) s.delete(k);
    for (const k of (only || [...current])) {
      if (!current.has(k)) continue;
      if (on) s.add(k); else s.delete(k);
    }
    p.pickedKeys = [...s];
    return true;
  }
  // Tick/untick many lines of one open ticket against ONE pickLineKeys()
  // (the per-line setPickLinePicked rebuilds it every call: quadratic).
  // entries: [{ lineKey, only? }], or omitted for every line. Same result as
  // calling setPickLinePicked per entry. Returns false if nothing applies.
  function setPickLinesPicked(pickListId, on, entries) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!p || p.status !== "open") return false;
    const keyMap = pickLineKeys(p);
    const lineKeys = new Set(p.lines.map(pickKey));
    const list = (entries || [...lineKeys].map(lineKey => ({ lineKey }))).filter(e => lineKeys.has(e.lineKey));
    if (!list.length) return false;
    const s = tickedSet(p);
    for (const { lineKey, only } of list) {
      const current = keyMap.get(lineKey) || new Set();
      for (const k of [...s]) if (k.startsWith(lineKey + "@") && !current.has(k)) s.delete(k);
      for (const k of (only || [...current])) {
        if (!current.has(k)) continue;
        if (on) s.add(k); else s.delete(k);
      }
    }
    p.pickedKeys = [...s];
    return true;
  }
  // Forget every tick of a line (its quantity or identity changed, it was
  // removed, or a chase pick changed where it comes from).
  function clearPickLineTicks(p, lineKey) {
    if (!p || !Array.isArray(p.pickedKeys)) return;
    p.pickedKeys = p.pickedKeys.filter(k => !k.startsWith(lineKey + "@"));
  }
  // Which lines (of this ticket, or of its whole batch) pull from this stack.
  function pickLinesUsingRecord(p, recordId) {
    const out = [];
    if (p && p.batchId) {
      for (const r of pickBatchSheet(p.batchId).rows) {
        if (r.recordId === recordId) for (const o of r.orders) out.push({ pickListId: o.pickListId, key: r.key });
      }
    } else if (p && p.status === "open") {
      for (const it of p.lines) {
        if (allocatePickLine(p, it).pulls.some(pu => pu.recordId === recordId)) out.push({ pickListId: p.id, key: pickKey(it) });
      }
    }
    return out;
  }
  function pickLineProgress(p) {
    const lines = p && Array.isArray(p.lines) ? p.lines : [];
    const m = pickLineKeys(p);
    return { done: lines.filter(l => pickLinePicked(p, pickKey(l), m)).length, total: lines.length };
  }
  // The same added up over several tickets (bulk and batch Complete).
  function pickLinesProgress(lists) {
    return (lists || []).reduce((t, p) => {
      const q = pickLineProgress(p);
      return { done: t.done + q.done, total: t.total + q.total };
    }, { done: 0, total: 0 });
  }
  /* The combined pull sheet: one row per card per stack (so per location),
     each saying how many copies go to which order. Open lists are allocated
     one after another in batch order against one shared snapshot, which is
     exactly what completing them one after another pulls - two orders
     wanting the last copy show one of them short, not both OK. A list
     already completed shows what it really pulled (pickedResult), marked
     done. Rows are sorted by the pick path (walkCompare: the bin's walk
     sequence, else its name in natural order, so bin 2 before bin 10), then
     by that location's sorting method if it has one (#267),
     short and unrecorded lines last. Also returns each list's lines
     with their shortfall, for the sort-into-orders checklist. */
  function pickBatchSheet(batchId) {
    return pickSheetFor(pickBatchLists(batchId));
  }
  // The same sheet for any tickets: a batch, or one ticket walked on its own
  // in Warehouse Mode (#386), so both walk the same rows in the same order.
  // plan (optional, Warehouse Mode): what's already in hand, see rfPlanFor.
  function pickSheetFor(lists, plan) {
    const remaining = new Map([...state.cards, ...state.sealed].map(r => [r.id, availableQty(r)]));
    const totes = plan ? null : totesByStack(lists);
    if (plan) plan.prepare(remaining);
    else for (const [id, t] of totes) if (remaining.has(id)) remaining.set(id, Math.max(0, remaining.get(id) - t.qty));
    const rowsByKey = new Map();
    const lines = new Map();
    const add = (kind, done, it, locationId, recordId, p, qty) => {
      const key = pickKey(it);
      const k = [kind, done ? 1 : 0, key, locationId || "", recordId || ""].join("@");
      let r = rowsByKey.get(k);
      if (!r) {
        r = { kind, done, key, line: it, locationId: locationId || null, recordId: recordId || null, qty: 0, orders: [] };
        rowsByKey.set(k, r);
      }
      r.qty += qty;
      const o = r.orders.find(x => x.pickListId === p.id);
      if (o) o.qty += qty; else r.orders.push({ pickListId: p.id, qty });
    };
    for (const p of lists) {
      const opts = pickListAllocOpts(p);
      const out = [];
      for (const it of p.lines) {
        let shortfall;
        if (p.status === "open") {
          const a = plan ? plan.allocate(p, it, opts, remaining) : allocateRemaining(it, opts, remaining, undefined, totes);
          for (const pu of a.pulls) add("pull", false, it, pu.locationId, pu.recordId, p, pu.take);
          shortfall = a.shortfall;
          if (shortfall > 0) add("short", false, it, null, null, p, shortfall);
        } else if (it.pickedResult) {
          for (const pu of it.pickedResult.pulls) add("pull", true, it, pu.locationId, null, p, pu.qty);
          shortfall = it.pickedResult.shortfall;
          if (shortfall > 0) add("short", true, it, null, null, p, shortfall);
        } else {
          shortfall = null;
          add("unknown", true, it, null, null, p, it.qty);
        }
        out.push({ line: it, key: pickKey(it), shortfall });
      }
      lines.set(p.id, out);
    }
    const rank = r => (r.kind === "pull" ? 0 : r.kind === "short" ? 1 : 2);
    const all = [...rowsByKey.values()];
    // Inside a location with a sorting method (#267) its rows follow that
    // order, so the binder is walked once front to back; elsewhere by name.
    const within = locOrderWithin(all.filter(r => r.kind === "pull"), r => r.locationId,
      (r, recs) => (r.recordId && recs().get(r.recordId)) || r.line);
    const rows = all.sort((a, b) =>
      (rank(a) - rank(b)) ||
      (a.kind === "pull" ? walkCompare(a.locationId, b.locationId) : 0) ||
      (a.kind === "pull" ? within(a, b) : 0) ||
      String(a.line.name || "").localeCompare(String(b.line.name || ""), undefined, { sensitivity: "base" }));
    return { lists, rows, lines };
  }

  /* Stack records by id, built once per call and only when needed (a
     70k-stack collection: one pass, never a find() per row). */
  function lazyRecordMap() {
    let m = null;
    return () => m || (m = new Map([...state.cards, ...state.sealed].map(r => [r.id, r])));
  }

  /* Pick rows in their location's sorting method (#267). For rows whose
     location has one, each row's sort keys are worked out once, from
     recOf(row, recs) (the stack, or the pick line once the stack is gone;
     recs() is a lazy id -> record map). Returns compare(a, b) for two rows
     in the SAME location: 0 when that location has no sorting method. */
  function locOrderWithin(rows, locOf, recOf) {
    const cmps = new Map(), keys = new Map(), recs = lazyRecordMap();
    for (const r of rows) {
      const id = locOf(r);
      if (!cmps.has(id)) { const l = locById(id); cmps.set(id, l && l.sortMethod ? locSortComparator(l.sortMethod) : null); }
      const c = cmps.get(id);
      if (c) keys.set(r, c.keyOf(recOf(r, recs)));
    }
    return (a, b) => { const c = cmps.get(locOf(a)); return c ? c.compareKeys(keys.get(a), keys.get(b)) : 0; };
  }

  /* The order to show one pick list's lines in (#267), as indexes into
     p.lines. A line belongs to the location it pulls from first (its
     highest pick-priority pull). Lines from a location with a sorting
     method are reordered among their own places in the list, so that
     location is walked once, front to back; every other line keeps its
     place, so a list touching no such location is unchanged. pullsOf(i)
     gives line i's pulls ([{ locationId, recordId }], or null); the default
     works them out the way the Pick tab does (live allocation while open,
     what was really pulled after). The printout follows the screen. */
  function pickLineOrder(p, pullsOf) {
    const lines = (p && p.lines) || [];
    const order = lines.map((_, i) => i);
    pullsOf = pullsOf || (i => (p.status === "open" ? allocatePickLine(p, lines[i]).pulls
      : lines[i].pickedResult ? lines[i].pickedResult.pulls : null));
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const first = (pullsOf(i) || [])[0];
      const l = first && locById(first.locationId);
      if (l && l.sortMethod) items.push({ i, locationId: l.id, recordId: first.recordId || null });
    }
    if (items.length < 2) return order;
    const within = locOrderWithin(items, x => x.locationId, (x, recs) => (x.recordId && recs().get(x.recordId)) || lines[x.i]);
    const groups = new Map();
    for (const x of items) { if (!groups.has(x.locationId)) groups.set(x.locationId, []); groups.get(x.locationId).push(x); }
    for (const g of groups.values()) {
      const sorted = g.slice().sort((a, b) => within(a, b) || a.i - b.i);
      g.forEach((x, k) => { order[x.i] = sorted[k].i; });
    }
    return order;
  }

  /* A picker physically didn't find (all of) a card where Grimoire said it
     was - a live, single-stack version of a cycle-count adjustment
     (mirrors applyCycleCountAdjustments' quantity-correction branch), used
     mid-pick so the SAME line's allocation can immediately re-run. No new
     allocation/matching logic needed for the "try a different location"
     part: allocatePick(it) is recomputed fresh on every render, so once
     this stack's quantity is corrected down, the existing pick-priority
     sort in allocateFrom naturally routes the shortfall to the next-best
     location on its own. `foundQty` is what's on the shelf: copies in a tote
     aren't missing, so the book keeps them (bookFromShelf, #395). */
  function chasePickAdjust(recordId, foundQty, note, kind) {
    const rec = (kind === "sealed" ? state.sealed : state.cards).find(x => x.id === recordId);
    if (!rec) return null;
    const oldQty = rec.quantity;
    // What was found is what's on the shelf; lent copies (#336) and copies in a tote are owned but not there.
    const newQty = Math.max(0, Math.min(oldQty, bookFromShelf(rec, Number(foundQty) || 0, totesByStack())));
    if (newQty === oldQty) return rec;
    removeCost(rec, oldQty - newQty);
    rec.quantity = newQty;
    if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
    const defaultNote = note || "Chase pick - not actually there, corrected on the spot";
    logAudit(kind === "sealed"
      ? { action: "sealed-edit", name: rec.name, qty: newQty - oldQty, oldQty, newQty, note: defaultNote }
      : { action: "chase-pick", ...auditCard(rec), qty: newQty - oldQty, oldQty, newQty, from: locName(rec.locationId), note: defaultNote });
    // "Found none" removes a card stack outright rather than saving it at 0,
    // the same as completing a pick list or a cycle count does (#73). A
    // sealed row is left alone: 0 is a state Sealed's own quantity edit
    // keeps on purpose, and it loads back as 0, so it has no such bug.
    if (newQty === 0 && kind !== "sealed") state.cards = state.cards.filter(x => x !== rec);
    return rec;
  }

  /* ============================== Bin labels and the count list (#386) ==============================
     A bin's QR label holds this prefix plus the location's id, not its name:
     renaming a bin doesn't void its printed label, and a word typed into a
     scan field can never pass as a scan (only the keyed path, with a reason,
     accepts a typed bin). */
  const BIN_LABEL_PREFIX = "GRIMBIN:";
  const binLabelText = loc => (loc ? BIN_LABEL_PREFIX + loc.id : "");
  // -> the location a scanned label names, or null. Scanners can change case.
  function binFromLabel(text) {
    const t = String(text == null ? "" : text).trim();
    if (t.slice(0, BIN_LABEL_PREFIX.length).toUpperCase() !== BIN_LABEL_PREFIX) return null;
    const id = t.slice(BIN_LABEL_PREFIX.length).toLowerCase();
    return state.locations.find(l => String(l.id).toLowerCase() === id) || null;
  }
  /* Does this scan prove the picker is at the bin? { ok, scanned, problem }:
     problem is "not-a-label" (not one of our labels), "unknown-bin" (our
     label, a bin this inventory doesn't have) or "wrong-bin". */
  function checkBinScan(expectedLocationId, text) {
    const t = String(text == null ? "" : text).trim();
    if (t.slice(0, BIN_LABEL_PREFIX.length).toUpperCase() !== BIN_LABEL_PREFIX) return { ok: false, scanned: null, problem: "not-a-label" };
    const scanned = binFromLabel(t);
    if (!scanned) return { ok: false, scanned: null, problem: "unknown-bin" };
    if (scanned.id !== expectedLocationId) return { ok: false, scanned, problem: "wrong-bin" };
    return { ok: true, scanned, problem: null };
  }
  const BIN_KEY_REASONS = ["Label missing", "Label damaged", "Label won't scan", "Camera or scanner not working"];
  /* A missing or damaged label: the picker reads the bin's name off the shelf
     and types it, with a reason, instead of scanning. Audit logged. `working`
     says what they were doing, for the log. */
  function keyBin(expectedLocationId, typed, reason, working) {
    const loc = locById(expectedLocationId);
    if (!loc) return { ok: false, problem: "unknown-bin" };
    const why = String(reason || "").trim();
    if (!why) return { ok: false, problem: "no-reason" };
    const norm = s => String(s == null ? "" : s).trim().toLowerCase();
    if (norm(typed) !== norm(loc.name)) return { ok: false, problem: "wrong-bin" };
    logAudit({ action: "bin-keyed", from: loc.name,
      note: "Bin keyed without a scan: " + why + (working ? ". " + working : "") });
    return { ok: true, problem: null };
  }

  /* The owner's rule (2026-10-31, replacing "a scan at every stop"): each account
     chooses. With Require bin scan on, a stop takes a scan or a keyed bin with a
     reason. Off (the default), a tap confirms it, so a shop with no labels can
     use the RF; a scan still works and a wrong bin is still refused. Every stop
     is logged as scanned, keyed (keyBin) or tapped. */
  const binScanRequired = () => !!(state.settings && state.settings.requireBinScan);
  function logBinCheck(locationId, how, working) {
    const loc = locById(locationId);
    if (!loc || (how === "tapped" && binScanRequired())) return false;
    logAudit({ action: how === "tapped" ? "bin-tapped" : "bin-scanned", from: loc.name,
      note: "Bin " + (how === "tapped" ? "confirmed with a tap" : "scanned") + (working ? ". " + working : "") });
    return true;
  }

  /* The count list: bins something on the floor says are wrong. Lives on the
     location, so it syncs field by field with everything else about the bin.
     Cards and sealed are tracked apart (owner, 2026-10-31): a sealed count says
     nothing about a card short. Cycle Count shows them, and each kind's "pick a
     bin" goes there first; a full count of that kind clears it, even when it
     matches the book or finds the bin empty. */
  const COUNT_FLAG = { cards: "countWanted", sealed: "countWantedSealed" };
  function requestBinCount(locationId, reason, kind, src) {
    const loc = locById(locationId);
    if (!loc) return null;
    const field = COUNT_FLAG[kind] || COUNT_FLAG.cards;
    // Already waiting: keep the first date, it's how long the bin has waited.
    if (!loc[field]) {
      loc[field] = { at: new Date().toISOString(), by: me ? (me.displayName || me.username || "") : "", reason: String(reason || ""), src: src === "desk" ? "desk" : "" };
    }
    return loc;
  }
  const wantedAt = (l, field) => (l[field] && l[field].at ? new Date(l[field].at).getTime() : 0);
  function oldestWanted(field) {
    return state.locations.filter(l => l[field]).sort((a, b) => wantedAt(a, field) - wantedAt(b, field))[0] || null;
  }
  // One entry per kind waiting: a bin waiting on both shows twice.
  function binsToCount() {
    const out = [];
    for (const kind of Object.keys(COUNT_FLAG)) {
      const field = COUNT_FLAG[kind];
      for (const l of state.locations) {
        if (l[field]) out.push({ id: l.id, name: l.name, kind, at: l[field].at || "", by: l[field].by || "", reason: l[field].reason || "", time: wantedAt(l, field) });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /* ============================== Warehouse Mode: pick and pack (#386) ==============================
     Everything the RF screens (public/rf/) know about picking comes through
     here, on top of the same allocation, ticks, completion and audit the desk
     uses. These views copy only named fields, on purpose: a pick line carries
     unitPrice, a stack carries price and cost, a ticket carries revenue and
     fees, and none of that may reach an RF screen.
     A target is { kind: "ticket" | "batch", id }. */
  function rfTargetLists(target) {
    if (!target) return [];
    if (target.kind === "batch") return pickBatchLists(target.id);
    const p = pickLists().find(x => x.id === target.id);
    return p ? [p] : [];
  }
  /* The bagging order (#406): Mana Pool order number, highest first, on the
     desk's Sort into orders and the RF Pack walk alike. Tickets with no order
     keep their place after the numbered ones. */
  function sortBagOrders(lists) {
    const num = p => pickListOrderLabel(p).replace(/^#/, "").trim();
    const withOrder = lists.filter(p => p && p.orderId), without = lists.filter(p => !(p && p.orderId));
    const coll = new Intl.Collator("en", { numeric: true });
    withOrder.sort((a, b) => {
      const x = num(a), y = num(b);
      if (/^\d+$/.test(x) && /^\d+$/.test(y) && Number(x) !== Number(y)) return Number(y) - Number(x);
      return coll.compare(y, x);
    });
    return withOrder.concat(without);
  }
  // The order number with its #, else the ticket number (the desk's orderTag).
  function pickListTag(p) {
    const label = pickListOrderLabel(p);
    // A counter sale says so, so the floor knows someone is waiting at the counter (#431).
    // A kiosk order's number already says so (KIOSK-2026-0001, #433).
    if (!label) return isCounterSale(p) && !String(p.id).startsWith("KIOSK-") ? ORDER_SOURCE_NAMES[p.source] + " " + p.id : p.id;
    return label.charAt(0) === "#" ? label : "#" + label;
  }
  const lineCardCount = lists => lists.reduce((n, p) => n + p.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), 0);
  /* The picker's choice of work: every ticket and batch with something still
     to pick or pack. Tickets and batches are made on the desk; this only reads
     them. Nothing here allocates, so it stays cheap however long the list is.
     Pack is for what was picked here (owner, 2026-10-31): a ticket completed
     at the desk finishes at the desk. */
  const rfWasPickedHere = p => p.status === "picked" && !!p.rfPickedAt;
  const rfPackedHere = target => rfTargetLists(target).some(p => !!p.rfPickedAt);
  function rfPickQueue(user) {
    const items = [], batches = new Set();
    for (const p of pickLists()) {
      if (!p.lines || !p.lines.length) continue;
      if (p.batchId) {
        if (batches.has(p.batchId)) continue;
        batches.add(p.batchId);
      }
      const lists = p.batchId ? pickBatchLists(p.batchId) : [p];
      const open = lists.filter(x => x.status === "open");
      const toPack = lists.filter(x => rfWasPickedHere(x) && !x.packedAt);
      if (!open.length && !toPack.length) continue;
      const target = { kind: p.batchId ? "batch" : "ticket", id: p.batchId || p.id };
      const canWork = rfCanWork(target, user);
      const named = open.length > 0 && lists.some(x => x.batchNamed);
      // A batch a manager named shows only for that picker, and whoever can take it over.
      if (named && !canWork && !canReassignPickBatch(user)) continue;
      const who = rfPickerOf(target);
      items.push({
        kind: target.kind, id: target.id,
        title: p.batchId ? "Batch of " + lists.length + " orders" : pickListTag(p),
        orders: lists.map(pickListTag), cards: lineCardCount(lists),
        lines: lists.reduce((n, x) => n + x.lines.length, 0),
        stage: open.length ? "pick" : "pack",
        started: open.some(rfHasProgress),
        // An unstarted batch sits here for whoever claims it first (owner, 2026-10-31).
        unclaimed: !!p.batchId && rfBatchIsOpen(lists),
        named, released: open.some(x => !!x.rfReleased),
        canRelease: rfCanRelease(target, user),
        inHand: open.reduce((n, x) => n + rfPullsOf(x).reduce((s, h) => s + h.qty, 0), 0),
        short: lists.some(pickListIsShort),
        // Manapool replaced or cancelled one of its orders (#489): set it aside.
        cancelled: lists.some(x => !!pickOrderCancelled(x)),
        canWork, assignee: who ? who.name : "", canTakeOver: !canWork && canReassignPickBatch(user),
        createdAt: p.createdAt || ""
      });
    }
    // What this person can work first, then work already started (its cards
    // are in someone's hands), then oldest.
    return items.sort((a, b) => (b.canWork - a.canWork) || (b.started - a.started) || String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  /* Who works what (owner, 2026-10-31). A started ticket locks to its picker
     (canWorkPickList, so the desk honours it too). A batch nobody has started
     is open to any picker unless a manager named one at the desk (batchNamed),
     and is theirs once claimed; after that it's the desk's batch rule, its
     assignee, until picking finishes and anyone can pack it. An Owner or Manager
     can take either over. Released work (rfReleased) is back in the open queue,
     with what's already been pulled still on record. */
  const rfHasProgress = p => !!p.rfPicker || rfPullsOf(p).length > 0 || (Array.isArray(p.pickedKeys) && p.pickedKeys.length > 0);
  const rfBatchIsOpen = lists => lists.length > 0 && lists.every(p => p.status === "open" && !p.rfPicker && !p.batchNamed &&
    (!!p.rfReleased || (!rfHasProgress(p) && !(Array.isArray(p.batchSorted) && p.batchSorted.length))));
  function rfCanWork(target, user) {
    if (!target || !user) return false;
    if (target.kind === "batch") return rfBatchIsOpen(pickBatchLists(target.id)) || canWorkPickBatch(target.id, user);
    return canWorkPickList(pickLists().find(x => x.id === target.id), user);
  }
  function rfPickerOf(target) {
    if (!target) return null;
    if (target.kind === "batch") return rfBatchIsOpen(pickBatchLists(target.id)) ? null : pickBatchAssignee(target.id);
    const p = pickLists().find(x => x.id === target.id);
    return (p && p.status === "open" && p.rfPicker) || null;
  }
  // Has this person still to press Start? Then nothing is theirs yet.
  const rfNeedsStart = target => rfTargetLists(target).some(p => p.status === "open" && !p.rfPicker);
  /* Starting a ticket or claiming a batch. Ticks someone already made at the
     desk carry over as copies in hand, so nobody is sent to pull them again. */
  function rfStartWork(target, user) {
    const who = assigneeOf(user);
    if (!who || !rfCanWork(target, user)) return false;
    const lists = rfTargetLists(target).filter(p => p.status === "open");
    const byId = new Map(lists.map(p => [p.id, p]));
    for (const row of rfPickWalk(target).rows) {
      if (row.held || !row.orders.every(o => tickedSet(byId.get(o.pickListId)).has(row.tick))) continue;
      for (const o of row.orders) rfAddHeld(byId.get(o.pickListId), row, o.need);
    }
    for (const p of lists) { p.rfPicker = Object.assign({}, who); delete p.rfReleased; }
    if (target.kind === "batch") assignPickBatch(target.id, user);
    return true;
  }
  /* Release (owner, 2026-10-31): a picker gives back their own work, a Manager or
     Owner anyone's. It goes back to the open queue, with what's been pulled still
     on record for whoever picks it up. On a personal account the picker is always the owner. */
  function rfCanRelease(target, user) {
    if (!target || !user) return false;
    if (!rfTargetLists(target).some(p => p.status === "open")) return false;
    const who = rfPickerOf(target);
    return !!who && (String(who.id) === String(user.id) || canReassignPickBatch(user));
  }
  function rfRelease(target, user) {
    if (!rfCanRelease(target, user)) return false;
    const was = rfPickerOf(target);
    const lists = rfTargetLists(target).filter(p => p.status === "open");
    const inHand = lists.reduce((n, p) => n + rfPullsOf(p).reduce((s, h) => s + h.qty, 0), 0);
    for (const p of lists) {
      delete p.rfPicker;
      p.rfReleased = { name: was.name, at: new Date().toISOString() };
      if (target.kind === "batch") { delete p.batchAssignee; delete p.batchNamed; }
    }
    const by = assigneeOf(user);
    logAudit({ action: "pick-released", qty: inHand, from: was.name,
      note: by.name + " released " + lists.map(pickListTag).join(", ") + (String(was.id) === String(by.id) ? "" : " from " + was.name) +
        ". " + inHand + " already pulled, still on record" });
    return true;
  }
  function rfTakeOver(target, user) {
    const who = assigneeOf(user);
    if (!who || !canReassignPickBatch(user)) return false;
    const was = rfPickerOf(target);
    for (const p of rfTargetLists(target).filter(x => x.status === "open")) {
      p.rfPicker = Object.assign({}, who);
      delete p.rfReleased;
      delete p.batchNamed;
    }
    if (target.kind === "batch") assignPickBatch(target.id, user);
    logAudit({ action: "pick-takeover", from: was ? was.name : "", to: who.name,
      note: who.name + " took over " + rfTargetLists(target).map(pickListTag).join(", ") + (was ? " from " + was.name : "") });
    return true;
  }
  const rfCardFields = (it, rec) => ({
    name: it.name || (rec && rec.name) || "", sealed: it.kind === "sealed",
    set: String(it.kind === "sealed" ? (it.setCode || "") : (it.set || "")).toUpperCase(),
    collector: it.kind === "sealed" ? "" : String(it.collector || ""),
    finish: it.kind === "sealed" ? "" : (it.finish || "nonfoil"),
    lang: it.kind === "sealed" ? "" : (it.lang || "en"),
    // The stack's own grade once it has one: a line with no condition means
    // "any", and the picker needs to know which copy they're holding.
    condition: it.kind === "sealed" ? "" : String((rec && rec.condition) || it.condition || ""),
    image: (rec && rec.imageUrl) || (it.kind === "sealed" && it.tcgplayerProductId
      ? "https://tcgplayer-cdn.tcgplayer.com/product/" + encodeURIComponent(it.tcgplayerProductId) + "_200w.jpg" : "")
  });
  /* Copies in the picker's hands. p.rfPulls is [{ key, recordId, locationId,
     name, qty }]: per ticket, per stack, how many have been confirmed. Stock
     doesn't move until Finish, so this is the only record of what's physically
     been pulled, and Finish takes exactly this off (rfFinishPicking). One
     field of the ticket for the sync merge, like pickedKeys; a started ticket
     has one picker, so nobody else is writing it. */
  const rfPullsOf = p => (p && Array.isArray(p.rfPulls) ? p.rfPulls : []);
  function rfAddHeld(p, row, qty) {
    if (!p || !(qty > 0)) return;
    const pulls = rfPullsOf(p).slice();
    const by = me ? (me.displayName || me.username || "") : "";
    const at = pulls.findIndex(h => h.key === row.key && h.recordId === row.recordId);
    if (at >= 0) {
      const names = String(pulls[at].by || "").split(", ").filter(Boolean);
      if (by && !names.includes(by)) names.push(by);
      pulls[at] = Object.assign({}, pulls[at], { qty: pulls[at].qty + qty, by: names.join(", ") });
    } else pulls.push({ key: row.key, recordId: row.recordId, locationId: row.locationId, name: row.name, qty, by });
    p.rfPulls = pulls;
  }
  // Who pulled this entry; an older one with no name goes by who has the ticket.
  function rfPullerNames(p, h) {
    const recorded = String(h.by || "").split(", ").filter(Boolean);
    return recorded.length ? recorded : [(p.rfReleased && p.rfReleased.name) || (p.rfPicker && p.rfPicker.name) || ""].filter(Boolean);
  }
  /* In-process stock, per stack (#395): what's in totes on open tickets, off the
     shelf and still on the book until Finish. record id -> { qty, by: [names] }.
     `except` (lists) leaves those tickets' own totes out. One pass over the
     tickets: build it once per screen or count, not per stack. */
  function totesByStack(except) {
    const skip = new Set((except || []).map(p => p.id));
    const out = new Map();
    for (const p of pickLists()) {
      if (p.status !== "open" || skip.has(p.id)) continue;
      for (const h of rfPullsOf(p)) {
        if (!out.has(h.recordId)) out.set(h.recordId, { qty: 0, by: [] });
        const t = out.get(h.recordId);
        t.qty += h.qty;
        for (const n of rfPullerNames(p, h)) if (!t.by.includes(n)) t.by.push(n);
      }
    }
    return out;
  }
  /* What should be on the shelf: what's owned, less what's lent and what's in totes.
     Copies held on an open receipt (#388) are on the shelf, so they're counted
     and they move; they just aren't free to pick or list (availableQty). A
     held stack is never picked, so it never has a tote of its own. */
  function shelfQty(r, totes) {
    return Math.max(0, (Number(r && r.quantity) || 0) - lentQty(r) - ((totes && totes.get(r.id)) || { qty: 0 }).qty);
  }
  /* The rule for anything that counts a stack (owner, 2026-10-31): book = what
     was found on the shelf, plus what's lent, plus what's in totes. So Finish,
     which takes the tote off, leaves the book matching the shelf, and nobody is
     told to put back copies that are legitimately in hand. */
  function bookFromShelf(r, found, totes) {
    return found + lentQty(r) + ((totes && totes.get(r.id)) || { qty: 0 }).qty;
  }
  // The line a screen that asks for a count shows beside a stack with copies in a tote.
  function toteHeld(t) {
    const mine = me ? (me.displayName || me.username || "") : "";
    const who = t.by.map(n => (n === mine ? "you" : n)).join(" and ");
    return t.qty + " in a tote" + (who ? ", pulled by " + who : "");
  }
  function toteWords(t) {
    if (!t || !t.qty) return "";
    return toteHeld(t) + ". Don't count " + (t.qty === 1 ? "it" : "those") + ".";
  }
  /* Copies in a tote, for the desk (owner, 2026-10-31). While a ticket or its
     batch has any, the desk can't complete, discard, chase or edit it: its own
     completion would allocate from scratch and the book would drift. { cards,
     by: [names] } across the whole batch, or null. */
  function pickListInHand(p) {
    if (!p) return null;
    const lists = (p.batchId ? pickBatchLists(p.batchId) : [p]).filter(x => x.status === "open");
    const cards = lists.reduce((n, x) => n + rfPullsOf(x).reduce((s, h) => s + h.qty, 0), 0);
    if (!cards) return null;
    const names = new Set();
    for (const x of lists) {
      for (const h of rfPullsOf(x)) {
        for (const n of rfPullerNames(x, h)) names.add(n);
      }
    }
    return { cards, by: [...names] };
  }
  /* The walk's sheet, the desk's pickSheetFor with one difference: copies in
     hand stay where they are, and only the rest of each line is allocated, from
     what's left on the shelf. So a short never moves what's in the bag, and a
     line that needs more from a bin already passed shows as that row wanting
     the difference. Copies another open ticket's picker is holding aren't on
     the shelf for anyone either. What can't be kept (the desk cut the line, or
     the stack is gone) comes back as `extras`, to put back. */
  function rfPlanFor(openLists) {
    const kept = new Map(), byLine = new Map(), heldAll = new Map(), heldRow = new Map(), heldOrder = new Map(), extras = [];
    const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
    const plan = {
      byLine, heldAll, heldRow, heldOrder, extras,
      prepare(remaining) {
        const take = (id, n) => { if (remaining.has(id)) remaining.set(id, Math.max(0, remaining.get(id) - n)); };
        for (const [id, t] of totesByStack(openLists)) { take(id, t.qty); bump(heldAll, id, t.qty); }
        for (const p of openLists) {
          const room = new Map();
          for (const l of p.lines) bump(room, pickKey(l), Number(l.qty) || 0);
          const lineKept = new Map();
          for (const h of rfPullsOf(p)) {
            const keep = Math.max(0, Math.min(h.qty, room.get(h.key) || 0, remaining.get(h.recordId) || 0));
            if (keep) {
              take(h.recordId, keep);
              bump(room, h.key, -keep);
              bump(heldAll, h.recordId, keep);
              const rowId = h.key + "@" + h.recordId;
              bump(heldRow, rowId, keep);
              bump(heldOrder, p.id + "|" + rowId, keep);
              if (!lineKept.has(h.key)) lineKept.set(h.key, []);
              lineKept.get(h.key).push({ recordId: h.recordId, locationId: h.locationId, take: keep });
            }
            if (h.qty > keep) extras.push({ pickListId: p.id, key: h.key, recordId: h.recordId, locationId: h.locationId, name: h.name, qty: h.qty - keep });
          }
          kept.set(p.id, lineKept);
        }
      },
      allocate(p, it, opts, remaining) {
        const q = (kept.get(p.id) && kept.get(p.id).get(pickKey(it))) || [];
        const pulls = [];
        let left = Number(it.qty) || 0;
        while (left > 0 && q.length) {
          const n = Math.min(left, q[0].take);
          pulls.push({ recordId: q[0].recordId, locationId: q[0].locationId, take: n });
          left -= n;
          q[0].take -= n;
          if (!q[0].take) q.shift();
        }
        // An order Manapool cancelled (#489) wants nothing more: only what's in hand stays on it,
        // so its unpicked lines never hold up the rest of a batch.
        const rest = left > 0 && !pickOrderCancelled(p) ? allocateRemaining(Object.assign({}, it, { qty: left }), opts, remaining) : { pulls: [], shortfall: 0 };
        const out = { pulls: pulls.concat(rest.pulls), shortfall: rest.shortfall };
        byLine.set(it, out);
        return out;
      }
    };
    return plan;
  }
  /* The walk: pulls in pick order (bin by bin, the batch sheet's order), each
     with who it's for. A row's `qty` is all this stack gives, `held` what's
     already in hand and `need` the difference, so a row re-opened by a short
     asks only for what's missing. Recomputed from live stock every time, which
     is what makes a short pick reroute. `skipped` (optional, location ids in
     the order they were skipped) sends those stops to the end of the walk;
     they still have to be picked or shorted before Finish. */
  function rfPickWalk(target, skipped) {
    const lists = rfTargetLists(target);
    const openLists = lists.filter(p => p.status === "open");
    const plan = rfPlanFor(openLists);
    const sheet = pickSheetFor(openLists, plan);
    const tags = new Map(lists.map(p => [p.id, pickListTag(p)]));
    const recs = lazyRecordMap();
    let rows = [];
    for (const r of sheet.rows) {
      if (r.kind !== "pull") continue;
      const id = r.key + "@" + r.recordId;
      const rec = recs().get(r.recordId);
      const held = plan.heldRow.get(id) || 0;
      const need = Math.max(0, r.qty - held);
      rows.push(Object.assign(rfCardFields(r.line, rec), {
        id, key: r.key, recordId: r.recordId, locationId: r.locationId, bin: locName(r.locationId),
        tick: pullTickKey(r.key, "pull", r.locationId),
        qty: r.qty, held, need, picked: need === 0,
        // What should still be in the bin: copies in anyone's hands have left it.
        shelfQty: rec ? Math.max(0, availableQty(rec) - (plan.heldAll.get(r.recordId) || 0)) : 0,
        heldInBin: plan.heldAll.get(r.recordId) || 0,
        orders: r.orders.map(o => {
          const inHand = plan.heldOrder.get(o.pickListId + "|" + id) || 0;
          return { pickListId: o.pickListId, tag: tags.get(o.pickListId), qty: o.qty, need: Math.max(0, o.qty - inHand) };
        })
      }));
    }
    if (skipped && skipped.length) {
      const at = id => skipped.indexOf(id);
      rows = rows.map((r, i) => [r, i]).sort((a, b) => (at(a[0].locationId) - at(b[0].locationId)) || (a[1] - b[1])).map(x => x[0]);
      // Not skipped (-1) stays first, in walk order; skipped follow in skip order.
    }
    const stops = [...new Set(rows.map(r => r.locationId))];
    const next = rows.find(r => r.need > 0) || null;
    const shorts = sheet.rows.filter(r => r.kind === "short").map(r => ({
      key: r.key, name: r.line.name || "", qty: r.qty, orders: r.orders.map(o => tags.get(o.pickListId))
    }));
    const stage = openLists.length ? "pick" : lists.some(p => rfWasPickedHere(p) && !p.packedAt) ? "pack" : "done";
    return {
      stage, rows, next, shorts, tags: lists.map(p => tags.get(p.id)),
      // A desk reassign clears rfReleased, but the pulls still say who has the tote.
      releasedBy: (openLists.find(p => p.rfReleased) || { rfReleased: {} }).rfReleased.name ||
        ((openLists.length && pickListInHand(openLists[0])) || { by: [] }).by.join(" and "),
      // Copies the picker should put back: the row dropped below what's in hand.
      putBack: plan.extras.map(x => ({ id: x.pickListId + "|" + x.key + "@" + x.recordId, pickListId: x.pickListId, key: x.key, recordId: x.recordId,
        locationId: x.locationId, bin: locName(x.locationId), name: x.name || "", qty: x.qty })),
      stopNo: next ? stops.indexOf(next.locationId) + 1 : stops.length, stops: stops.length,
      binsLeft: new Set(rows.filter(r => r.need > 0).map(r => r.locationId)).size,
      binsPulled: new Set(rows.filter(r => r.held > 0).map(r => r.locationId)).size,
      cards: rows.reduce((n, r) => n + r.qty, 0),
      cardsDone: rows.reduce((n, r) => n + r.held, 0),
      cardsShort: shorts.reduce((n, s) => n + s.qty, 0),
      binCards: next ? rows.filter(r => r.need > 0 && r.locationId === next.locationId).reduce((n, r) => n + r.need, 0) : 0
    };
  }
  /* The desk's ticks follow what's in hand: a place is ticked once every stack
     of that line there is fully in hand, and un-ticked when one re-opens. */
  function rfSyncTicks(target, known) {
    const walk = known || rfPickWalk(target);
    const placeDone = new Map();
    for (const r of walk.rows) placeDone.set(r.tick, placeDone.get(r.tick) !== false && r.need === 0);
    for (const p of rfTargetLists(target).filter(x => x.status === "open")) {
      const onThis = walk.rows.filter(r => r.orders.some(o => o.pickListId === p.id)).map(r => r.tick);
      p.pickedKeys = [...new Set(onThis.filter(k => placeDone.get(k)))];
    }
  }
  /* The picker has what this row still needs in hand. */
  function rfConfirmPull(target, rowId, skipped) {
    const walk = rfPickWalk(target, skipped);
    const row = walk.rows.find(r => r.id === rowId);
    if (!row || !row.need) return false;
    const byId = new Map(rfTargetLists(target).map(p => [p.id, p]));
    for (const o of row.orders) rfAddHeld(byId.get(o.pickListId), row, o.need);
    // Nothing else moves on a confirm, so this walk still holds: no need to
    // work it all out again on a phone at 70k stacks.
    row.need = 0;
    rfSyncTicks(target, walk);
    return true;
  }
  /* A mis-tap (owner, 2026-10-31): until Finish the picker can reverse a Picked.
     The row is asked for again. Logged, with whether the copies went back in
     the bin: opts.returned false says nothing physically went back. */
  function rfReversePull(target, rowId, opts) {
    const row = rfPickWalk(target).rows.find(r => r.id === rowId);
    if (!row || !row.held) return null;
    const lists = rfTargetLists(target).filter(p => p.status === "open");
    for (const p of lists) p.rfPulls = rfPullsOf(p).filter(h => !(h.key === row.key && h.recordId === row.recordId));
    rfSyncTicks(target);
    logAudit({ action: "pick-reversed", name: row.name, set: row.set, collector: row.collector, finish: row.finish, qty: row.held, from: row.bin,
      note: "Picked reversed in Warehouse Mode on " + lists.map(p => p.id).join(", ") + ": " +
        (opts && opts.returned === false ? "nothing went back to the bin" : row.held + " back in the bin") });
    return { bin: row.bin, name: row.name, qty: row.held };
  }
  /* A row dropped below what's in hand (the desk cut a line, the stack's book
     fell): the picker has put the extra back. Logged the same way. */
  function rfPutBack(target, putBackId) {
    const x = rfPickWalk(target).putBack.find(b => b.id === putBackId);
    if (!x) return null;
    const p = pickLists().find(l => l.id === x.pickListId);
    p.rfPulls = rfPullsOf(p).map(h => (h.key === x.key && h.recordId === x.recordId ? Object.assign({}, h, { qty: h.qty - x.qty }) : h)).filter(h => h.qty > 0);
    rfSyncTicks(target);
    logAudit({ action: "pick-reversed", name: x.name, qty: x.qty, from: x.bin,
      note: "Extra put back in Warehouse Mode on " + p.id + ": " + x.qty + " back in the bin" });
    return x;
  }
  /* Short pick (owner, 2026-10-31): `found` is how many of this stack are
     really still in the bin. On-hand is corrected on the spot through the same
     chase pick the desk uses, so it's logged the same way, and copies in hand
     still count as owned until Finish. The bin goes on the count list. The walk
     is recomputed from the corrected stock, so the shortfall moves to the next
     bin with free copies by itself, including one the picker already passed,
     where they're sent back for the difference with a new bin check. If none
     has any, the orders it hits are flagged short. */
  function rfShortPick(target, rowId, found, skipped) {
    const before = rfPickWalk(target, skipped);
    const row = before.rows.find(r => r.id === rowId);
    if (!row) return null;
    const qty = Math.max(0, parseInt(found, 10) || 0);
    if (qty >= row.shelfQty) return { changed: false, row };
    const lists = rfTargetLists(target);
    const label = lists.map(p => p.id).join(", ");
    chasePickAdjust(row.recordId, qty, "Short pick in Warehouse Mode on " + label, row.sealed ? "sealed" : undefined);
    requestBinCount(row.locationId, "Short pick on " + label, row.sealed ? "sealed" : "cards");
    rfSyncTicks(target);
    const after = rfPickWalk(target, skipped);
    const needBefore = new Map(before.rows.map(r => [r.id, r.need]));
    const here = r => r.key === row.key && r.locationId === row.locationId;
    const moved = after.rows.filter(r => !here(r) && r.need > (needBefore.get(r.id) || 0))
      .map(r => ({ bin: r.bin, qty: r.need, back: r.held > 0 }));
    const sameBin = after.rows.filter(here).reduce((n, r) => n + r.need, 0);
    const short = after.shorts.filter(s => s.key === row.key).reduce((n, s) => n + s.qty, 0);
    const shortOrders = [...new Set(after.shorts.flatMap(s => s.orders))];
    for (const p of lists) {
      const stillShort = after.shorts.some(s => s.orders.includes(pickListTag(p)));
      if (stillShort && !p.shortFlag) p.shortFlag = { at: new Date().toISOString(), by: me ? (me.displayName || me.username || "") : "" };
      else if (!stillShort) delete p.shortFlag;
    }
    return { changed: true, row, found: qty, onHand: qty + row.heldInBin, sameBin, moved, short, shortOrders,
      putBack: after.putBack.map(x => ({ bin: x.bin, qty: x.qty, name: x.name })) };
  }
  /* Picking's finished: the desk's completion, except it takes exactly what's
     in hand instead of allocating again, so what comes off stock is what was
     physically pulled. Refused while a stop is open or there's extra to put back,
     or when nothing's left but orders Manapool cancelled with nothing in hand (#489). */
  /* The open orders on this ticket or batch that Manapool cancelled (#489): [{ tag, held }],
     held = copies already in hand for it. Those finish as picked, for Cancel and put back;
     one with nothing in hand stays open for the desk to discard. */
  const rfCancelledOrders = target => rfTargetLists(target)
    .filter(x => x.status === "open" && x.lines.length && pickOrderCancelled(x))
    .map(x => ({ tag: pickListTag(x), held: rfPullsOf(x).reduce((n, h) => n + h.qty, 0) }));
  function rfFinishPicking(target) {
    const walk = rfPickWalk(target);
    if (walk.next || walk.putBack.length) return { pulled: 0, short: 0, done: 0, refused: true };
    // An order Manapool cancelled (#489) with nothing in hand isn't finished: it leaves the batch
    // and its picker, so the rest can be packed and the desk can discard it, no lock (setAside: tags).
    const all = rfTargetLists(target);
    const aside = all.filter(x => x.status === "open" && x.lines.length && pickOrderCancelled(x) && !rfPullsOf(x).length);
    for (const p of aside) {
      for (const f of BATCH_FIELDS) delete p[f];
      delete p.rfPicker; delete p.rfReleased; delete p.rfPulls;
    }
    const setAside = aside.map(pickListTag);
    if (aside.length) {
      tidyPickBatches();   // a batch left with one ticket is no batch
      logAudit({ action: "edit", note: "Left " + setAside.join(", ") + " for the desk to discard: cancelled on Manapool, nothing picked" });
    }
    const open = all.filter(x => x.status === "open" && x.lines.length && !aside.includes(x));
    if (!open.length) return { pulled: 0, short: 0, done: 0, refused: true, setAside };
    const plan = rfPlanFor(open);
    pickSheetFor(open, plan);
    const by = me ? (me.displayName || me.username || "") : "";
    let pulled = 0, short = 0, done = 0;
    for (const p of open) {
      const out = completePickList(p.id, it => plan.byLine.get(it));
      if (p.status !== "picked") continue;
      p.rfPickedAt = p.pickedAt;
      p.rfPickedBy = by;
      delete p.rfPulls;
      delete p.rfPicker;
      delete p.rfReleased;
      delete p.batchNamed;
      delete p.shortFlag;   // the frozen result says it from here (pickListIsShort)
      pulled += out.shipped; short += out.shortLines; done++;
    }
    return { pulled, short, done, setAside, rest: open.map(p => p.id) };
  }
  /* What's left to pack, order by order. A line with nothing pulled has
     nothing to bag, so it doesn't wait on a tap. */
  function rfPackView(target) {
    const lists = sortBagOrders(rfTargetLists(target).filter(rfWasPickedHere));
    return lists.map(p => {
      const sorted = new Set(Array.isArray(p.batchSorted) ? p.batchSorted : []);
      const lines = p.lines.map(l => {
        const res = l.pickedResult || { pulls: [], shortfall: 0 };
        const pulled = res.pulls.reduce((n, x) => n + (Number(x.qty) || 0), 0);
        const key = pickKey(l);
        const card = rfCardFields(l, null);
        // The stack may be gone by now; any copy of the printing has the picture.
        if (!card.sealed) {
          const same = state.cards.find(c => c.set === l.set && normNum(c.collector) === normNum(l.collector) && (c.lang || "en") === (l.lang || "en") && c.finish === (l.finish || "nonfoil"));
          if (same) card.image = same.imageUrl || "";
        }
        return Object.assign(card, { key, pulled, short: Number(res.shortfall) || 0, bagged: sorted.has(key) || pulled === 0 });
      });
      return { pickListId: p.id, tag: pickListTag(p), inBatch: !!p.batchId, packed: !!p.packedAt, lines,
        cancelled: pickOrderCancelled(p),
        cards: lines.reduce((n, l) => n + l.pulled, 0), short: lines.reduce((n, l) => n + l.short, 0) };
    });
  }
  // A line with nothing to bag counts as bagged here; the desk's sort progress
  // needs it ticked too, so packing writes it down for the desk.
  function rfPackOrder(pickListId) {
    const p = pickLists().find(x => x.id === pickListId);
    if (!p) return null;
    if (p.batchId) for (const l of p.lines) setPickBatchSorted(p.id, pickKey(l), true);
    return markPickListPacked(p.id);
  }

  /* ============================== Warehouse Mode: find and move (#387) ==============================
     Views copy named fields only (no price, cost or value), like rfPickWalk.
     A stack's book is what's on the shelf + what's lent + what's in a tote, so
     a screen can show the rest of the book beside the bin ("2 in a tote,
     pulled by sam", "1 lent"). Only the shelf copies can move: lent copies are
     out and tote copies are in a picker's hands (owner, 2026-11-01). Copies set
     aside for a ticket but not yet pulled are on the shelf and move freely: the
     walk is worked out fresh from stock, so it sends the picker to the new bin. */
  const rfPrintingKey = r => String(r.set || "").toLowerCase() + "|" + normNum(r.collector);
  function rfStackView(r, totes) {
    const t = totes.get(r.id) || { qty: 0, by: [] };
    return Object.assign(rfCardFields(r, r), {
      id: r.id, locationId: r.locationId, bin: locName(r.locationId), printing: rfPrintingKey(r),
      book: r.quantity, onShelf: shelfQty(r, totes), lent: lentQty(r),
      inTote: t.qty, toteWords: t.qty ? toteHeld(t) : "",
      // On an open receipt (#388): it moves, but nobody can pick it yet.
      receiving: r.held ? ((receivingById(holdId(r.held)) || {}).receiptId || "an open receipt") : ""
    });
  }
  const rfStackOrder = (a, b) => walkCompare(a.locationId, b.locationId) || a.name.localeCompare(b.name) ||
    a.finish.localeCompare(b.finish) || a.lang.localeCompare(b.lang) || a.condition.localeCompare(b.condition);
  const RF_FIND_MAX = 40;
  /* A card by name (every word typed has to be in it) -> the printings that
     match, with how many bins and copies each has. */
  /* A name as a phone types it: lower case, no accents, and no apostrophes or
     hyphens ("urzas" finds Urza's Tower, "lim-dul" finds Lim-Dul's Vault), and "//"
     reads as a space ("fire//ice" finds Fire // Ice). */
  function rfFold(text) {
    return stripDiacritics(String(text == null ? "" : text).toLowerCase().normalize("NFKD")).replace(/\/\//g, " ").replace(/[^a-z0-9 ]+/g, "");
  }
  /* What a search word is matched against: the name, then the set code and collector
     number, so 60 printings of one name can be told apart ("island 1059", "island tst").
     One fold per distinct name, not per stack. */
  function rfHay(r, names) {
    let n = names.get(r.name);
    if (n === undefined) names.set(r.name, n = rfFold(r.name));
    return n + " " + rfFold(r.set) + " " + rfFold(r.collector);
  }
  function rfFindCards(text) {
    const terms = rfFold(text).split(/\s+/).filter(Boolean);
    const out = { printings: [], more: false };
    if (!terms.length) return out;
    const by = new Map(), folded = new Map();
    for (const r of state.cards) {
      const hay = rfHay(r, folded);
      if (!terms.every(t => hay.includes(t))) continue;
      const key = rfPrintingKey(r);
      let g = by.get(key);
      if (!g) by.set(key, g = Object.assign(rfCardFields(r, r), { printing: key, copies: 0, bins: new Set() }));
      g.copies += r.quantity;
      g.bins.add(r.locationId);
    }
    const all = [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.set.localeCompare(b.set) || a.collector.localeCompare(b.collector, undefined, { numeric: true }));
    out.more = all.length > RF_FIND_MAX;
    out.printings = all.slice(0, RF_FIND_MAX).map(g => Object.assign(g, { bins: g.bins.size }));
    return out;
  }
  function rfStack(recordId) {
    const r = state.cards.find(x => x.id === recordId);
    return r ? rfStackView(r, totesByStack()) : null;
  }
  // Where one printing is: a row per stack (bin, condition, finish, language), in walk order.
  function rfCardWhere(printing) {
    const totes = totesByStack();
    const stacks = state.cards.filter(r => rfPrintingKey(r) === printing).map(r => rfStackView(r, totes)).sort(rfStackOrder);
    const first = stacks[0] || null;
    return {
      found: !!first, name: first ? first.name : "", set: first ? first.set : "", collector: first ? first.collector : "",
      image: first ? first.image : "", stacks,
      book: stacks.reduce((n, s) => n + s.book, 0), onShelf: stacks.reduce((n, s) => n + s.onShelf, 0),
      bins: new Set(stacks.map(s => s.locationId)).size
    };
  }
  /* Bins for the picker to choose from, by name (all of them when text is empty),
     in walk order. One pass for the counts, not a scan per bin. */
  function rfBinList(text) {
    const q = String(text || "").trim().toLowerCase();
    const counts = new Map();
    for (const r of state.cards) counts.set(r.locationId, (counts.get(r.locationId) || 0) + r.quantity);
    const locs = state.locations.filter(l => !q || String(l.name).toLowerCase().includes(q));
    locs.sort((a, b) => walkCompare(a.id, b.id));
    const sealed = new Map();
    for (const r of state.sealed) if (r.quantity > 0) sealed.set(r.locationId, (sealed.get(r.locationId) || 0) + r.quantity);
    return locs.map(l => ({ id: l.id, name: l.name, cards: counts.get(l.id) || 0, sealed: sealed.get(l.id) || 0 }));
  }
  const RF_BIN_MAX = 40;
  // What's in one bin, and how much room it has (cap and free are null with no limit).
  /* Only the first RF_BIN_MAX stacks (by name) come back, however big the bin: a
     phone can't draw thousands of rows. 'text' narrows by card name; stackCount
     and matching say how many there really are. Sealed product isn't moved here
     (cards only): 'sealed' is how many are in the bin, so a screen can say so. */
  function rfBinView(locationId, text) {
    const loc = locById(locationId);
    if (!loc) return null;
    const terms = rfFold(text).split(/\s+/).filter(Boolean);
    const here = state.cards.filter(r => r.locationId === locationId);
    const names = new Map();
    const hit = terms.length ? here.filter(r => { const h = rfHay(r, names); return terms.every(t => h.includes(t)); }) : here;
    const key = r => [String(r.name || ""), r.finish || "nonfoil", r.lang || "en", r.condition || ""];
    hit.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 4; i++) { const c = x[i].localeCompare(y[i]); if (c) return c; } return 0; });
    const totes = totesByStack();
    const st = locStats(locationId);
    return { id: loc.id, name: loc.name, cap: st.cap, free: st.free, cards: st.cards,
      stackCount: here.length, matching: hit.length, more: hit.length > RF_BIN_MAX,
      sealed: sealedStacksInLocation(locationId).reduce((n, r) => n + r.quantity, 0),
      stacks: hit.slice(0, RF_BIN_MAX).map(r => rfStackView(r, totes)) };
  }
  /* Can this many copies of the stack go to that bin? Refuses what can never
     move; a bin that's too full is only a warning (owner: the same as the desk,
     the operator can go ahead). { ok, problem, movable, over, free, cap }. */
  function rfMoveCheck(recordId, toId, qty) {
    const rec = state.cards.find(x => x.id === recordId);
    if (!rec) return { ok: false, problem: "gone", movable: 0 };
    const movable = shelfQty(rec, totesByStack());
    const dest = locById(toId);
    if (!dest) return { ok: false, problem: "no-bin", movable };
    if (dest.id === rec.locationId) return { ok: false, problem: "same-bin", movable };
    const n = Math.floor(Number(qty) || 0);
    if (n < 1 || n > movable) return { ok: false, problem: "too-many", movable };
    const room = moveOverCapacity(dest.id, [{ locationId: rec.locationId, quantity: n }]);
    return { ok: true, problem: null, movable, over: room.over, free: room.free, cap: room.cap };
  }
  /* The move itself, right now: nothing sits in transit. Same stock logic and
     audit entry as the desk's Move (moveCopies). */
  function rfMoveCards(recordId, toId, qty, why) {
    const check = rfMoveCheck(recordId, toId, qty);
    if (!check.ok) return check;
    const rec = state.cards.find(x => x.id === recordId);
    const n = Math.floor(Number(qty));
    const from = locName(rec.locationId);
    const out = moveCopies(rec, toId, n, why || "Moved in Warehouse Mode");
    return Object.assign(check, { moved: n, from, to: locName(toId), merged: out.merged > 0 });
  }

  /* ============================== Receiving on the floor (#388) ==============================
     Flow: docs/flows/rf-receive.dot. The desk opens a receipt (where it came
     from, what was spent, how to spread it); Warehouse Mode books cards and
     sealed onto it and never sees money; the desk closes it and the money
     spreads across everything booked (allocateLotCost), as a posted lot does.

     state.receiving: the open receipts, { id, receiptId, source, spend, alloc,
       note, date, openedAt, openedBy }.
     state.receivingLines: what's been booked, one row per booking, so several
       receivers on one receipt never write the same row: { id, receivingId,
       kind "card"|"sealed", the card's or product's identity, name, image, qty,
       locationId (the receiving location it went into), market (the spread's
       weight at close: never on an RF screen), at, byId, by }.

     Booked copies are stock at once, in a stack of their own marked `held`
     (the receiving id). idKey/sealedKey keep it apart from free copies, so two
     phones' saves only ever add to a quantity, and a move's clone carries the
     mark with the copies. Held copies are on the shelf (shelfQty: they're
     counted, and they move and get put away) but none are free (availableQty
     is 0), so pick allocation, listings, trades and lending skip them until
     the desk closes the receipt and the cost lands (owner, 2026-11-02). */
  const receivingById = id => (state.receiving || []).find(r => r.id === id) || null;
  const receivingLinesOf = id => (state.receivingLines || []).filter(l => l.receivingId === id);
  const meId = () => (me ? String(me.id || me.username || "") : "");
  const meName = () => (me ? (me.displayName || me.username || "") : "");
  /* An open return (#411) is a `receiving` doc with kind "return": same hold, same
     lines, same put-away. receiptId is its RMA number. Receipts and returns
     are told apart here, so no receipt list ever shows a return. */
  const isReturnDoc = rc => !!rc && rc.kind === "return";
  const openDocs = () => (state.receiving || []).slice().sort((a, b) => String(a.openedAt || "").localeCompare(String(b.openedAt || "")));
  const openReceivings = () => openDocs().filter(rc => !isReturnDoc(rc));
  const openReturns = () => openDocs().filter(isReturnDoc);
  /* A stack's `held` is the open doc's id, or id + ":damaged" for a return's written-off
     copies (kept apart from the restock ones, as they close with no cost basis). */
  const holdId = h => String(h || "").split(":")[0];
  const holdIsDamaged = h => /:damaged$/.test(String(h || ""));
  // Open one at the desk. Throws a message for the person.
  function openReceiving(o) {
    const src = o || {};
    const spend = src.spend === "" || src.spend == null ? 0 : Number(src.spend);
    if (!(spend >= 0)) throw new Error("The total spent has to be a number, $0 or more.");
    const receiptId = String(src.receiptId || "").trim() || nextReceiptId("lot");
    if (state.receipts.some(r => r.receiptId === receiptId) || (state.receiving || []).some(r => r.receiptId === receiptId)) {
      throw new Error('A receipt numbered "' + receiptId + '" already exists. Give this one a different number.');
    }
    const doc = {
      id: uid(), receiptId, source: String(src.source || "").trim().slice(0, 200),
      spend: round2(spend), alloc: src.alloc === "even" ? "even" : "market",
      note: String(src.note || "").trim().slice(0, 1000),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(src.date || "")) ? src.date : "",
      openedAt: new Date().toISOString(), openedBy: meName()
    };
    if (!Array.isArray(state.receiving)) state.receiving = [];
    state.receiving.push(doc);
    logAudit({ action: "receipt", qty: 0, receiptId, note: "Receipt opened for Warehouse Mode" + (doc.source ? ": " + doc.source : "") });
    return doc;
  }
  /* Where booked copies wait to be put away: the sorting tray the receiver
     chose, or "Receiving", a sorting tray made the first time it's needed. */
  function receivingTray() {
    const named = n => state.locations.find(l => l.staging && String(l.name).toLowerCase() === n.toLowerCase());
    let loc = named("Receiving");
    if (loc) return loc;
    const taken = new Set(state.locations.map(l => String(l.name).toLowerCase()));
    let name = "Receiving", n = 2;
    while (taken.has(name.toLowerCase())) name = "Receiving " + n++;
    loc = createLocation({ name, type: "Other", staging: true });
    state.locations.push(loc);
    return loc;
  }
  const sameCardLine = (r, l) => r.set === l.set && normNum(r.collector) === normNum(l.collector) &&
    (r.lang || "en") === (l.lang || "en") && (r.finish || "nonfoil") === (l.finish || "nonfoil") && (r.condition || "NM") === (l.condition || "NM");
  // Stacks held on one receipt, both kinds.
  function heldStacks(receivingId) {
    return { cards: state.cards.filter(r => r.held && holdId(r.held) === receivingId), sealed: state.sealed.filter(r => r.held && holdId(r.held) === receivingId) };
  }
  function bookingProblem(receivingId, locationId, qty) {
    if (!receivingById(receivingId)) return "closed";
    const loc = locById(locationId);
    if (!loc || !loc.staging) return "no-tray";
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 1 || n > 9999) return "bad-qty";
    return null;
  }
  /* Book copies of a card onto an open receipt, into a receiving location.
     o: { receivingId, locationId, info (lookupCard's answer), set, lang, finish,
     condition, qty }. -> { ok, problem, line, stack }. No cost: that lands at close. */
  function rfBookCard(o) {
    const problem = bookingProblem(o.receivingId, o.locationId, o.qty);
    if (problem) return { ok: false, problem };
    const rc = receivingById(o.receivingId);
    const info = o.info || {};
    const cond = CONDITIONS.includes(o.condition) ? o.condition : "NM";
    const finish = normalizeFinish(o.finish) || "nonfoil";
    const lang = String(o.lang || "en").toLowerCase();
    // A return (#411): the floor says restock or damaged per card; damaged copies are held
    // apart and close with no cost basis.
    const ret = isReturnDoc(rc);
    const damaged = ret && o.disposition === "damaged";
    const stack = addCopies({
      set: String(o.set || "").toLowerCase(), num: info.collector, lang, finish, condition: cond,
      locationId: o.locationId, qty: o.qty, info, held: damaged ? rc.id + ":damaged" : rc.id,
      action: ret ? "return" : "receipt", receiptId: rc.receiptId,
      note: ret ? "Booked in Warehouse Mode on return " + rc.receiptId + (damaged ? " as damaged" : " to restock") + ", held until the desk closes it"
        : "Booked in Warehouse Mode on " + rc.receiptId + ", held until the receipt closes"
    });
    const line = {
      ...(ret ? { disposition: damaged ? "damaged" : "restock", expId: String(o.expId || "") } : null),
      id: uid(), receivingId: rc.id, kind: "card",
      set: stack.set, collector: stack.collector, lang: stack.lang, finish: stack.finish, condition: stack.condition,
      name: stack.name, image: (info.card && info.card.imageUrl) || (info.meta && info.meta.imageUrl) || "",
      qty: o.qty, locationId: o.locationId, market: info.price == null ? null : Number(info.price),
      at: new Date().toISOString(), byId: meId(), by: meName()
    };
    state.receivingLines.push(line);
    return { ok: true, problem: null, line, stack };
  }
  // The same for sealed. product: a /api/sealed/search row.
  function rfBookSealed(o) {
    const problem = bookingProblem(o.receivingId, o.locationId, o.qty);
    if (problem) return { ok: false, problem };
    const p = o.product || {};
    if (!p.tcgplayerProductId) return { ok: false, problem: "no-product" };
    const rc = receivingById(o.receivingId);
    const market = p.marketPrice == null ? null : Number(p.marketPrice);
    const stack = addSealedCopies({
      tcgplayerProductId: String(p.tcgplayerProductId), manapoolProductId: p.manapoolProductId || "",
      name: p.name || "", setCode: p.setCode || "", locationId: o.locationId, qty: o.qty,
      price: market, unitCost: null, held: rc.id, receiptId: rc.receiptId,
      note: "Booked in Warehouse Mode on " + rc.receiptId + ", held until the receipt closes"
    });
    const line = {
      id: uid(), receivingId: rc.id, kind: "sealed", tcgplayerProductId: stack.tcgplayerProductId,
      manapoolProductId: stack.manapoolProductId, setCode: stack.setCode, name: stack.name,
      qty: o.qty, locationId: o.locationId, market, at: new Date().toISOString(), byId: meId(), by: meName()
    };
    state.receivingLines.push(line);
    return { ok: true, problem: null, line, stack };
  }
  // The held stack a booking's copies went into, while they're still in its receiving location.
  function lineStack(line) {
    if (line.kind === "sealed") {
      return state.sealed.find(r => r.held === line.receivingId && r.locationId === line.locationId &&
        r.tcgplayerProductId === line.tcgplayerProductId) || null;
    }
    const held = line.disposition === "damaged" ? line.receivingId + ":damaged" : line.receivingId;
    return state.cards.find(r => r.held === held && r.locationId === line.locationId && sameCardLine(r, line)) || null;
  }
  /* The receiver can take back their own booking until its copies are put
     away or the receipt closes (owner, 2026-11-02). Then it's ordinary stock:
     move or adjust it. -> { ok, problem: "gone" | "closed" | "not-yours" | "put-away" }. */
  function rfLineUndoable(lineId) {
    const line = (state.receivingLines || []).find(l => l.id === lineId);
    if (!line) return { ok: false, problem: "gone" };
    if (!receivingById(line.receivingId)) return { ok: false, problem: "closed" };
    if (!line.byId || line.byId !== meId()) return { ok: false, problem: "not-yours" };
    const rec = lineStack(line);
    if (!rec || shelfQty(rec, line.kind === "sealed" ? null : totesByStack()) < line.qty) return { ok: false, problem: "put-away" };
    return { ok: true, problem: null, line, rec };
  }
  function rfUndoLine(lineId) {
    const can = rfLineUndoable(lineId);
    if (!can.ok) return can;
    const { line, rec } = can;
    const rc = receivingById(line.receivingId);
    const oldQty = rec.quantity;
    rec.quantity -= line.qty;
    if (line.kind === "sealed") {
      logAudit({ action: "receipt", name: rec.name, qty: -line.qty, oldQty, newQty: rec.quantity, from: locName(rec.locationId),
        receiptId: rc.receiptId, note: "Booking undone in Warehouse Mode on " + rc.receiptId });
      if (rec.quantity <= 0) state.sealed = state.sealed.filter(x => x !== rec);
    } else {
      logAudit({ action: isReturnDoc(rc) ? "return" : "receipt", ...auditCard(rec), qty: -line.qty, oldQty, newQty: rec.quantity, from: locName(rec.locationId),
        receiptId: rc.receiptId, note: "Booking undone in Warehouse Mode on " + rc.receiptId });
      if (rec.quantity <= 0) state.cards = state.cards.filter(x => x !== rec);
    }
    state.receivingLines = state.receivingLines.filter(l => l !== line);
    return { ok: true, problem: null, line };
  }
  /* The receipt number a stack is held on, for a desk note ("" when it isn't
     held), so staff can see why an order for a card booked today is short. */
  function heldOn(r) {
    if (!r || !r.held) return "";
    const rc = receivingById(holdId(r.held));
    return rc ? rc.receiptId : "an open receipt";
  }
  // For the desk: how far an open receipt has got.
  function receivingSummary(id) {
    const doc = receivingById(id);
    if (!doc) return null;
    const lines = receivingLinesOf(id);
    const held = heldStacks(id);
    const staging = new Set(state.locations.filter(l => l.staging).map(l => l.id));
    const all = held.cards.concat(held.sealed);
    const inTrays = all.filter(r => staging.has(r.locationId));
    return {
      doc, lines,
      cards: lines.filter(l => l.kind !== "sealed").reduce((n, l) => n + l.qty, 0),
      sealed: lines.filter(l => l.kind === "sealed").reduce((n, l) => n + l.qty, 0),
      receivers: [...new Set(lines.map(l => l.by).filter(Boolean))],
      held: all.reduce((n, r) => n + r.quantity, 0),
      toPutAway: inTrays.reduce((n, r) => n + r.quantity, 0),
      trays: [...new Set(inTrays.map(r => locName(r.locationId)))]
    };
  }
  const lineKey = l => (l.kind === "sealed" ? "sealed|" + l.tcgplayerProductId
    : ["card", l.set, normNum(l.collector), l.lang || "en", l.finish || "nonfoil", l.condition || "NM"].join("|"));
  /* What closing would spread: each booking's cost each (allocateLotCost by
     market value or evenly, as a posted lot), and per card or product the
     average of its bookings, which is what each of its held stacks gets. */
  function receivingCostPlan(id) {
    const doc = receivingById(id);
    const lines = receivingLinesOf(id);
    const spend = doc ? Number(doc.spend) || 0 : 0;
    const unit = allocateLotCost(lines.map(l => ({ qty: l.qty, market: l.market })), spend, doc && doc.alloc === "even" ? "even" : "market");
    const byKey = new Map();
    lines.forEach((l, i) => {
      const k = lineKey(l);
      const g = byKey.get(k) || { qty: 0, cost: 0 };
      g.qty += l.qty; g.cost += unit[i] * l.qty;
      byKey.set(k, g);
    });
    const total = lines.reduce((n, l) => n + l.qty, 0);
    return { spend, lines, unit, total, each: k => { const g = byKey.get(k); return g && g.qty ? g.cost / g.qty : (total ? spend / total : 0); } };
  }
  /* What each held stack gets at close: the spend spread over the stacks
     themselves, so the stock always carries exactly the spend, even when the
     desk regraded or reprinted a booked stack before close (its key no longer
     matches a booking). A stack's weight is its bookings' market value when it
     still matches some, else its own market price. -> Map(stack -> cost each). */
  function heldStackUnits(id, held) {
    const doc = receivingById(id);
    const spend = doc ? Number(doc.spend) || 0 : 0;
    const booked = new Map();   // key -> { qty, value } over bookings with a market value
    for (const l of receivingLinesOf(id)) {
      if (l.market == null || !(Number(l.market) > 0)) continue;
      const g = booked.get(lineKey(l)) || { qty: 0, value: 0 };
      g.qty += l.qty; g.value += l.qty * Number(l.market);
      booked.set(lineKey(l), g);
    }
    const stacks = held.cards.map(r => ({ r, k: lineKey(Object.assign({ kind: "card" }, r)) }))
      .concat(held.sealed.map(r => ({ r, k: lineKey({ kind: "sealed", tcgplayerProductId: r.tcgplayerProductId }) })));
    const marketOf = s => { const g = booked.get(s.k); return g && g.qty ? g.value / g.qty : (s.r.price == null ? null : Number(s.r.price)); };
    const unit = allocateLotCost(stacks.map(s => ({ qty: s.r.quantity, market: marketOf(s) })), spend, doc && doc.alloc === "even" ? "even" : "market");
    return new Map(stacks.map((s, i) => [s.r, unit[i]]));
  }
  // Two sealed rows that are one now (a hold just came off): fold them together.
  function mergeSealedRows() {
    const keep = new Map(), out = [];
    for (const r of state.sealed) {
      const k = sealedKey(r);
      const m = keep.get(k);
      if (!m) { keep.set(k, r); out.push(r); continue; }
      m.quantity += r.quantity;
      m.costQty = (Number(m.costQty) || 0) + (Number(r.costQty) || 0);
      m.costTotal = round2((Number(m.costTotal) || 0) + (Number(r.costTotal) || 0));
      m.avgCost = m.costQty > 0 ? round2(m.costTotal / m.costQty) : null;
      m.listedQty = Math.min(m.quantity, (Number(m.listedQty) || 0) + (Number(r.listedQty) || 0));
    }
    state.sealed = out;
  }
  /* The desk closes it: every held stack gets its cost, the hold comes off (so
     the copies join any matching stack in their bin), and it becomes an
     ordinary posted lot receipt. Copies still in a tray stay there, now free
     stock; the close screen says how many. -> { doc, toPutAway } or null. */
  function closeReceiving(id) {
    const rc = receivingById(id);
    if (!rc) return null;
    const sum = receivingSummary(id);
    const plan = receivingCostPlan(id);
    const costed = plan.spend > 0;
    const unit4 = u => Math.round((Number(u) || 0) * 1e4) / 1e4;
    const held = heldStacks(id);
    const units = heldStackUnits(id, held);
    const where = new Map();   // card or product -> location id -> copies, for the receipt's lines
    const tally = (k, r) => { const m = where.get(k) || new Map(); m.set(r.locationId, (m.get(r.locationId) || 0) + r.quantity); where.set(k, m); };
    const note = "Receipt " + rc.receiptId + " closed";
    for (const r of held.cards) {
      const k = lineKey(Object.assign({ kind: "card" }, r));
      const each = units.get(r) || 0;
      tally(k, r);
      if (costed) {
        const uncosted = Math.max(0, r.quantity - (Number(r.costQty) || 0));
        if (r.quantity > uncosted) removeCost(r, r.quantity - uncosted);
        applyCost(r, r.quantity, each);
      }
      delete r.held;
      r.lastReceiptId = rc.receiptId;
      logAudit({ action: "cost", ...auditCard(r), qty: 0, oldQty: r.quantity, newQty: r.quantity, from: locName(r.locationId),
        cost: costed ? round2(each * r.quantity) : null, receiptId: rc.receiptId,
        note: note + (costed ? ": " + money(each) + " each" : ", no cost recorded") + ". Free to pick and list now" });
    }
    for (const r of held.sealed) {
      const k = lineKey({ kind: "sealed", tcgplayerProductId: r.tcgplayerProductId });
      const each = units.get(r) || 0;
      tally(k, r);
      if (costed) applyCost(r, r.quantity, each);
      delete r.held;
      logAudit({ action: "cost", name: r.name, qty: 0, oldQty: r.quantity, newQty: r.quantity, from: locName(r.locationId),
        cost: costed ? round2(each * r.quantity) : null, receiptId: rc.receiptId,
        note: note + (costed ? ": " + money(each) + " each" : ", no cost recorded") + ". Free to pick and list now" });
    }
    normalizeMerge({ silent: true });
    mergeSealedRows();
    const mostAt = (k, fallback) => {
      const m = where.get(k);
      if (!m) return fallback;
      return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    const lines = plan.lines.map((l, i) => {
      const k = lineKey(l);
      const base = { qty: l.qty, market: l.market, unitCost: unit4(costed ? plan.unit[i] : 0), locationId: mostAt(k, l.locationId), by: l.by || "" };
      return l.kind === "sealed"
        ? Object.assign({ item: "sealed", name: l.name, setCode: l.setCode, tcgplayerProductId: l.tcgplayerProductId }, base)
        : Object.assign({ set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition, name: l.name }, base);
    });
    const doc = recordReceipt({
      kind: lines.length && lines.every(l => l.item === "sealed") ? "sealed-lot" : "lot", receiptId: rc.receiptId,
      ts: rc.date ? new Date(rc.date + "T12:00:00").toISOString() : new Date().toISOString(),
      source: rc.source || "", note: rc.note || "", spend: costed ? plan.spend : 0, allocation: rc.alloc || "market",
      lines, floor: true, receivedBy: sum.receivers
    });
    state.receiving = state.receiving.filter(x => x !== rc);
    state.receivingLines = state.receivingLines.filter(l => l.receivingId !== id);
    logAudit({ action: "receipt", qty: doc.totalCards, receiptId: rc.receiptId,
      note: note + " at the desk: " + doc.totalCards + " booked in Warehouse Mode" + (sum.toPutAway ? ", " + sum.toPutAway + " still to put away" : "") });
    return { doc, toPutAway: sum.toPutAway, trays: sum.trays };
  }
  // Nothing booked yet: the desk can take it back.
  function discardReceiving(id) {
    const rc = receivingById(id);
    if (!rc || receivingLinesOf(id).length) return false;
    const held = heldStacks(id);
    if (held.cards.length || held.sealed.length) return false;
    state.receiving = state.receiving.filter(x => x !== rc);
    const ret = isReturnDoc(rc);
    logAudit({ action: ret ? "return" : "receipt", qty: 0, receiptId: rc.receiptId, note: "Open " + (ret ? "return " : "receipt ") + rc.receiptId + " removed with nothing booked" });
    return true;
  }
  /* On load: a hold whose receipt isn't open any more (a phone booked in the
     moment the desk closed it) comes off, and its booking goes. Copies are
     never lost, they're just free stock with no cost. */
  function tidyReceiving() {
    const open = new Set((state.receiving || []).map(r => r.id));
    let changed = false;
    for (const r of state.cards.concat(state.sealed)) if (r.held && !open.has(holdId(r.held))) { delete r.held; changed = true; }
    const before = (state.receivingLines || []).length;
    state.receivingLines = (state.receivingLines || []).filter(l => open.has(l.receivingId));
    if (state.sealed.length && changed) mergeSealedRows();
    return changed || state.receivingLines.length !== before;
  }

  /* ============================== Returns on the floor (#411) ==============================
     The desk opens a return (order, refund, cost per card, what the order says
     should come back); the phone ticks in what's really in the package, restock or
     damaged per card, and puts it away. It is a `receiving` doc of kind "return"
     (see isReturnDoc), so booking, the hold, put-away and undo are receiving's own.
     Copies are held until the desk closes it, which settles the cost and the
     refund and posts an ordinary return (recordReturn). Money never reaches the RF:
     the expected cost lives on the doc and only the desk's views read it. */
  const costKeyOf = l => [String(l.set || "").toLowerCase(), normNum(l.collector), normalizeFinish(l.finish) || "nonfoil"].join("|");
  function openReturn(o) {
    const src = o || {};
    const returnId = String(src.returnId || "").trim() || nextReturnId();
    if (state.returns.some(r => r.returnId === returnId) || (state.receiving || []).some(r => r.receiptId === returnId)) {
      throw new Error('A return numbered "' + returnId + '" already exists. Give this one a different ID.');
    }
    const refund = src.refundTotal === "" || src.refundTotal == null ? null : Number(src.refundTotal);
    if (refund != null && !(refund >= 0)) throw new Error("The refund has to be a number, $0 or more.");
    const expected = (src.expected || []).filter(l => l && l.set && l.collector && Math.floor(Number(l.qty)) > 0).map(l => ({
      id: uid(), set: String(l.set).toLowerCase(), collector: String(l.collector), lang: String(l.lang || "en").toLowerCase(),
      finish: normalizeFinish(l.finish) || "nonfoil", condition: CONDITIONS.includes(l.condition) ? l.condition : "NM",
      name: String(l.name || ""), qty: Math.floor(Number(l.qty)), image: String(l.image || ""),
      unitCost: l.unitCost == null || l.unitCost === "" || !(Number(l.unitCost) >= 0) ? null : round2(Number(l.unitCost))
    }));
    const doc = {
      id: uid(), kind: "return", receiptId: returnId, source: "", spend: 0, alloc: "market", date: "",
      note: String(src.note || "").trim().slice(0, 1000), reason: String(src.reason || "").trim().slice(0, 1000),
      orderId: String(src.orderId || ""), orderLabel: String(src.orderLabel || "").trim().slice(0, 200),
      buyer: String(src.buyer || "").trim().slice(0, 200), refundTotal: refund == null ? null : round2(refund),
      orderSnapshot: src.orderSnapshot || null, expected,
      openedAt: new Date().toISOString(), openedBy: meName()
    };
    if (!Array.isArray(state.receiving)) state.receiving = [];
    state.receiving.push(doc);
    logAudit({ action: "return", qty: 0, receiptId: returnId,
      note: "Return opened for Warehouse Mode" + (doc.orderLabel ? " against order " + doc.orderLabel : "") + (expected.length ? ", " + expected.reduce((n, e) => n + e.qty, 0) + " expected" : "") });
    return doc;
  }
  /* What the original sale cost per card, from the pick entries of the order's ticket
     (a pick list's own cogs is only a total). -> Map(costKey -> cost each). Async: it reads the log. */
  async function returnSaleCosts(orderId) {
    const out = new Map();
    const p = orderId ? pickListForOrder(orderId) : null;
    if (!p) return out;
    let entries = [];
    try { entries = (await queryAudit({ action: "pick", q: p.id, limit: 400, total: false })).entries; } catch (e) { return out; }
    const sums = new Map();
    for (const e of entries) {
      if (e.note !== "Picked for " + p.id || e.cost == null || !(e.qty < 0)) continue;
      const k = costKeyOf(e);
      const s = sums.get(k) || { cost: 0, qty: 0 };
      s.cost += -e.cost; s.qty += -e.qty;
      sums.set(k, s);
    }
    for (const [k, s] of sums) if (s.qty > 0 && s.cost > 0) out.set(k, round2(s.cost / s.qty));
    return out;
  }
  /* What an order says should come back: its pick ticket's card lines, else the order's own lines.
     -> [{ set, collector, lang, finish, condition, name, qty }], no money. */
  function returnExpectedFromOrder(order) {
    if (!order) return [];
    const p = pickListForOrder(order.id);
    const items = p ? (p.lines || []) : orderPickItems(order, true);
    return items.filter(i => i.kind !== "sealed" && i.set && i.collector && Number(i.qty) > 0).map(i => ({
      set: i.set, collector: i.collector, lang: i.lang || "en", finish: i.finish || "nonfoil", condition: i.condition || "", name: i.name || "", qty: i.qty
    }));
  }
  // For the desk: an open return, expected against received.
  function returnSummary(id) {
    const rc = receivingById(id);
    if (!isReturnDoc(rc)) return null;
    const base = receivingSummary(id);
    const lines = base.lines;
    const rows = (rc.expected || []).map(e => {
      const mine = lines.filter(l => l.expId === e.id);
      return Object.assign({}, e, { got: mine.reduce((n, l) => n + l.qty, 0), damaged: mine.filter(l => l.disposition === "damaged").reduce((n, l) => n + l.qty, 0) });
    });
    const extras = lines.filter(l => !l.expId || !(rc.expected || []).some(e => e.id === l.expId));
    return Object.assign(base, {
      rows, extras: extras.reduce((n, l) => n + l.qty, 0),
      received: lines.reduce((n, l) => n + l.qty, 0), damaged: lines.filter(l => l.disposition === "damaged").reduce((n, l) => n + l.qty, 0),
      expectedQty: rows.reduce((n, e) => n + e.qty, 0)
    });
  }
  /* The restock copies booked, one row per card and finish, with the cost the desk
     starts from (the expected line's, else blank): the close screen's cost inputs. */
  function returnCostRows(id) {
    const rc = receivingById(id);
    if (!isReturnDoc(rc)) return [];
    const by = new Map();
    for (const l of receivingLinesOf(id)) {
      if (l.disposition === "damaged") continue;
      const k = costKeyOf(l);
      const g = by.get(k) || { costKey: k, name: l.name, set: l.set, collector: l.collector, finish: l.finish, qty: 0, unitCost: null };
      g.qty += l.qty;
      by.set(k, g);
    }
    for (const e of rc.expected || []) {
      const g = by.get(costKeyOf(e));
      if (g && g.unitCost == null && e.unitCost != null) g.unitCost = e.unitCost;
    }
    return [...by.values()];
  }
  /* The desk closes it. o: { refundTotal, unitCosts: { costKey: cost each | null } }. Restock stacks
     take their cost, damaged ones none; the hold comes off; an ordinary return is recorded (its
     lines say restock or damaged each, `expected` says what was asked for). -> { doc, toPutAway, trays } or null. */
  function closeReturn(id, o) {
    const rc = receivingById(id);
    if (!isReturnDoc(rc)) return null;
    const opts = o || {};
    const sum = returnSummary(id);
    const costs = opts.unitCosts || {};
    const costOf = k => (costs[k] == null || costs[k] === "" || !(Number(costs[k]) > 0) ? null : round2(Number(costs[k])));
    const held = heldStacks(id);
    const note = "Return " + rc.receiptId + " closed";
    for (const r of held.cards) {
      const damaged = holdIsDamaged(r.held);
      const each = damaged ? null : costOf(costKeyOf(r));
      if (each != null) {
        const uncosted = Math.max(0, r.quantity - (Number(r.costQty) || 0));
        if (r.quantity > uncosted) removeCost(r, r.quantity - uncosted);
        applyCost(r, r.quantity, each);
      }
      delete r.held;
      r.lastReceiptId = rc.receiptId;
      logAudit({ action: "cost", ...auditCard(r), qty: 0, oldQty: r.quantity, newQty: r.quantity, from: locName(r.locationId),
        cost: each == null ? null : round2(each * r.quantity), receiptId: rc.receiptId,
        note: note + (damaged ? ": damaged, written off with no cost basis" : each != null ? ": " + money(each) + " each back in stock" : ", no cost recorded") +
          (damaged ? "" : ". Free to pick and list now") });
    }
    normalizeMerge({ silent: true });
    const where = new Map();
    const groups = new Map();
    for (const l of receivingLinesOf(id)) {
      const damaged = l.disposition === "damaged";
      const k = [costKeyOf(l), l.lang, l.condition, damaged ? "d" : "r"].join("|");
      const g = groups.get(k) || { set: l.set, collector: l.collector, lang: l.lang, finish: l.finish, condition: l.condition, name: l.name,
        qty: 0, unitCost: damaged ? null : costOf(costKeyOf(l)), disposition: damaged ? "damaged" : "restock", extra: !l.expId };
      g.qty += l.qty;
      groups.set(k, g);
      where.set(l.locationId, (where.get(l.locationId) || 0) + l.qty);
    }
    const lines = [...groups.values()];
    const locationId = [...where.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || "";
    const refund = opts.refundTotal === undefined ? rc.refundTotal : (opts.refundTotal === "" || opts.refundTotal == null ? null : Math.max(0, Number(opts.refundTotal) || 0));
    const doc = recordReturn({
      returnId: rc.receiptId, orderId: rc.orderId || "", orderLabel: rc.orderLabel || "", buyer: rc.buyer || "",
      disposition: lines.length && lines.every(l => l.disposition === "damaged") ? "damaged" : "restock",
      locationId, reason: rc.reason || "", note: rc.note || "", refundTotal: refund, lines, orderSnapshot: rc.orderSnapshot || null,
      expected: sum.rows.map(e => ({ name: e.name, set: e.set, collector: e.collector, finish: e.finish, qty: e.qty, got: e.got })),
      floor: true, receivedBy: sum.receivers
    });
    state.receiving = state.receiving.filter(x => x !== rc);
    state.receivingLines = state.receivingLines.filter(l => l.receivingId !== id);
    logAudit({ action: "return", qty: doc.totalQty, receiptId: rc.receiptId,
      note: note + " at the desk: " + doc.totalQty + " booked in Warehouse Mode" + (sum.expectedQty ? " of " + sum.expectedQty + " expected" : "") +
        (sum.damaged ? ", " + sum.damaged + " damaged" : "") + (sum.toPutAway ? ", " + sum.toPutAway + " still to put away" : "") });
    return { doc, toPutAway: sum.toPutAway, trays: sum.trays, restock: lines.some(l => l.disposition === "restock") };
  }
  // Nothing booked yet: the desk can take an open return back (discardReceiving's own rule).
  function discardReturn(id) {
    return isReturnDoc(receivingById(id)) && discardReceiving(id);
  }

  /* ---------- What the RF sees: no spend, no market, no cost ---------- */
  function rfReceivingList() {
    return openReceivings().map(rc => {
      const lines = receivingLinesOf(rc.id);
      return { id: rc.id, receiptId: rc.receiptId, source: rc.source || "",
        booked: lines.reduce((n, l) => n + l.qty, 0), mine: lines.filter(l => l.byId && l.byId === meId()).reduce((n, l) => n + l.qty, 0) };
    });
  }
  /* Open returns for the phone (#411): the order's label and counts, never a refund, cost or buyer. */
  function rfReturnList() {
    return openReturns().map(rc => {
      const lines = receivingLinesOf(rc.id);
      return { id: rc.id, returnId: rc.receiptId, orderLabel: rc.orderLabel || "",
        expected: (rc.expected || []).reduce((n, e) => n + e.qty, 0), booked: lines.reduce((n, l) => n + l.qty, 0) };
    });
  }
  function rfReturnView(id) {
    const rc = receivingById(id);
    if (!isReturnDoc(rc)) return null;
    const lines = receivingLinesOf(id);
    const mine = lines.filter(l => l.byId && l.byId === meId()).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    const expected = (rc.expected || []).map(e => {
      const got = lines.filter(l => l.expId === e.id).reduce((n, l) => n + l.qty, 0);
      return Object.assign(rfCardFields(e, null), { id: e.id, image: e.image || "", qty: e.qty, got, left: Math.max(0, e.qty - got) });
    });
    return { id: rc.id, returnId: rc.receiptId, orderLabel: rc.orderLabel || "", expected,
      booked: lines.reduce((n, l) => n + l.qty, 0), toPutAway: receivingSummary(id).toPutAway, trays: receivingSummary(id).trays.length,
      mine: mine.slice(0, RF_MINE_MAX).map(rfLineView), mineCount: mine.length };
  }
  function rfLineView(l) {
    const can = rfLineUndoable(l.id);
    return Object.assign(rfCardFields(l, null), {
      id: l.id, qty: l.qty, bin: locName(l.locationId), at: l.at || "", by: l.by || "", disposition: l.disposition || "",
      image: l.kind === "sealed" ? rfCardFields(l, null).image : (l.image || ""),
      undoable: can.ok, why: can.problem
    });
  }
  // `mine` is the newest few of this receiver's bookings (each looks its stack up), mineCount all of them.
  const RF_MINE_MAX = 15;
  function rfReceiptView(id) {
    const rc = receivingById(id);
    if (!rc) return null;
    const lines = receivingLinesOf(id);
    const mine = lines.filter(l => l.byId && l.byId === meId()).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return { id: rc.id, receiptId: rc.receiptId, source: rc.source || "",
      booked: lines.reduce((n, l) => n + l.qty, 0), receivers: [...new Set(lines.map(l => l.by).filter(Boolean))],
      mine: mine.slice(0, RF_MINE_MAX).map(rfLineView), mineCount: mine.length };
  }
  // The sorting trays a receiver can book into, in walk order.
  function rfReceivingTrays() {
    const counts = new Map();
    for (const r of state.cards) counts.set(r.locationId, (counts.get(r.locationId) || 0) + r.quantity);
    for (const r of state.sealed) counts.set(r.locationId, (counts.get(r.locationId) || 0) + r.quantity);
    return state.locations.filter(l => l.staging).sort((a, b) => walkCompare(a.id, b.id))
      .map(l => ({ id: l.id, name: l.name, items: counts.get(l.id) || 0 }));
  }

  /* ---------- Put-away: a tray, bin to bin in walk order ---------- */
  // Where a sealed product already sits (the bin with the most of it), else null.
  function rfSealedHome(productId, exceptId) {
    const at = new Map();
    for (const r of state.sealed) {
      if (r.tcgplayerProductId !== productId || r.locationId === exceptId || !(r.quantity > 0)) continue;
      const l = locById(r.locationId);
      if (!l || l.staging) continue;
      at.set(l.id, (at.get(l.id) || 0) + r.quantity);
    }
    const best = [...at.entries()].sort((a, b) => b[1] - a[1] || walkCompare(a[0], b[0]))[0];
    return best ? best[0] : null;
  }
  // Trays with anything in them, the desk's too: the put-away job's list.
  function rfPutawayTrays() {
    const totes = totesByStack();
    const by = new Map();
    const add = (id, n, held) => { const t = by.get(id) || { items: 0, held: 0 }; t.items += n; if (held) t.held += n; by.set(id, t); };
    for (const r of state.cards) { const n = shelfQty(r, totes); if (n > 0) add(r.locationId, n, !!r.held); }
    for (const r of state.sealed) if (r.quantity > 0) add(r.locationId, r.quantity, !!r.held);
    return state.locations.filter(l => l.staging && by.has(l.id)).sort((a, b) => walkCompare(a.id, b.id))
      .map(l => Object.assign({ id: l.id, name: l.name }, by.get(l.id)));
  }
  /* Every stop in one tray: a stack, the bin the Putaway rules suggest (cards)
     or where that product already sits (sealed, which has no rules), and how
     many go there. Rebuilt from stock on every draw, like the pick walk, so a
     stop the desk or another phone already filed is simply gone. In walk order
     of the suggested bin; no suggestion goes last. */
  function rfPutawayStops(trayId) {
    const tray = locById(trayId);
    if (!tray) return null;
    const totes = totesByStack();
    const stops = [];
    const plan = binPlan(trayId);
    for (const line of plan.lines) {
      const r = line.record;
      const movable = shelfQty(r, totes);
      if (!(movable > 0)) continue;
      const pick = line.picks.find(p => p.locationId !== trayId) || null;
      stops.push(Object.assign(rfStackView(r, totes), {
        kind: "card", held: !!r.held, toId: pick ? pick.locationId : null, toName: pick ? pick.name : "",
        take: pick ? Math.min(pick.take, movable) : movable, movable
      }));
    }
    for (const r of state.sealed) {
      if (r.locationId !== trayId || !(r.quantity > 0)) continue;
      const home = rfSealedHome(r.tcgplayerProductId, trayId);
      stops.push(Object.assign(rfCardFields(Object.assign({ kind: "sealed" }, r), null), {
        id: r.id, locationId: r.locationId, bin: tray.name, kind: "sealed", held: !!r.held,
        receiving: r.held ? ((receivingById(r.held) || {}).receiptId || "an open receipt") : "",
        toId: home, toName: home ? locName(home) : "", take: r.quantity, movable: r.quantity, book: r.quantity, onShelf: r.quantity
      }));
    }
    stops.sort((a, b) => (a.toId ? 0 : 1) - (b.toId ? 0 : 1) || (a.toId && b.toId ? walkCompare(a.toId, b.toId) : 0) ||
      a.name.localeCompare(b.name));
    return { id: tray.id, name: tray.name, stops, items: stops.reduce((n, s) => n + s.movable, 0) };
  }
  function rfPutawayStop(trayId, stackId) {
    const t = rfPutawayStops(trayId);
    return t ? t.stops.find(s => s.id === stackId) || null : null;
  }
  // Part of a sealed row to another bin: the cost slice and the hold go with it.
  function moveSealedCopies(rec, destId, n, why) {
    if (n >= rec.quantity) { moveSealedLocation(rec.id, destId); return; }
    const costEach = Number(rec.costQty) > 0 ? (Number(rec.costTotal) || 0) / rec.costQty : null;
    const costCopies = Math.min(n, Number(rec.costQty) || 0);
    removeCost(rec, costCopies);
    const from = locName(rec.locationId);
    rec.quantity -= n;
    if (rec.listedQty > rec.quantity) rec.listedQty = rec.quantity;
    const destKey = sealedKey({ tcgplayerProductId: rec.tcgplayerProductId, locationId: destId, held: rec.held });
    let dest = state.sealed.find(x => x !== rec && sealedKey(x) === destKey);
    if (!dest) {
      dest = Object.assign({}, rec, { id: uid(), locationId: destId, quantity: 0, listedQty: 0, costQty: 0, costTotal: 0, avgCost: null });
      state.sealed.push(dest);
    }
    dest.quantity += n;
    if (costEach != null && costCopies > 0) applyCost(dest, costCopies, costEach);
    logAudit({ action: "sealed-move", name: rec.name, qty: n, from, to: locName(destId), note: (why ? why + " — " : "") + "Moved " + n + " of " + (rec.quantity + n) });
  }
  /* Put copies from a tray into a bin, right now. Any bin is fine (owner: no
     reason needed for another one). Cards go through the desk's own move
     (rfMoveCards -> moveCopies), so a full bin is a warning, never a refusal.
     -> rfMoveCheck's shape, plus { moved, from, to }. */
  function rfPutawayCheck(kind, recordId, toId, qty) {
    if (kind !== "sealed") return rfMoveCheck(recordId, toId, qty);
    const rec = state.sealed.find(x => x.id === recordId);
    if (!rec) return { ok: false, problem: "gone", movable: 0 };
    const dest = locById(toId);
    if (!dest) return { ok: false, problem: "no-bin", movable: rec.quantity };
    if (dest.id === rec.locationId) return { ok: false, problem: "same-bin", movable: rec.quantity };
    const n = Math.floor(Number(qty) || 0);
    if (n < 1 || n > rec.quantity) return { ok: false, problem: "too-many", movable: rec.quantity };
    return { ok: true, problem: null, movable: rec.quantity, over: false, free: null, cap: null };
  }
  function rfPutaway(kind, recordId, toId, qty, suggestedId) {
    const why = "Put away in Warehouse Mode" + (suggestedId && suggestedId !== toId ? " (suggested " + locName(suggestedId) + ")" : "");
    if (kind !== "sealed") return rfMoveCards(recordId, toId, qty, why);
    const check = rfPutawayCheck(kind, recordId, toId, qty);
    if (!check.ok) return check;
    const rec = state.sealed.find(x => x.id === recordId);
    const from = locName(rec.locationId), n = Math.floor(Number(qty));
    moveSealedCopies(rec, toId, n, why);
    return Object.assign(check, { moved: n, from, to: locName(toId), merged: false });
  }

  /* ============================== Warehouse Mode: cycle count (#389) ==============================
     A blind count of one bin on the phone. The views here carry the item and
     never the book's quantity; the posting is the desk's own full count
     (applyCycleCountAdjustments / applySealedCycleCountAdjustments), so the two
     can't disagree. No money reaches the RF: a found sealed product's market
     figure is looked up on the way in and kept off every view. */
  const countKind = kind => (kind === "sealed" ? "sealed" : "cards");
  /* What's waiting: bins a short pick flagged first, then bins the desk sent to
     the floor, each oldest first. One entry per kind waiting. */
  function rfCountTasks() {
    const out = [];
    for (const kind of Object.keys(COUNT_FLAG)) {
      const field = COUNT_FLAG[kind];
      for (const l of state.locations) {
        const f = l[field];
        if (!f) continue;
        out.push({ id: l.id + "|" + kind, locationId: l.id, bin: l.name, kind, desk: f.src === "desk", time: wantedAt(l, field) });
      }
    }
    return out.sort((a, b) => (a.desk - b.desk) || (a.time - b.time) || a.bin.localeCompare(b.bin));
  }
  // The most overdue bin from the normal rotation, for when nothing is waiting.
  function rfCountNext(kind) {
    const loc = countKind(kind) === "sealed" ? pickSealedCycleCountBin() : pickCycleCountBin();
    return loc ? { locationId: loc.id, bin: loc.name, kind: countKind(kind) } : null;
  }
  function rfCountStacks(locationId, kind) {
    const sealed = countKind(kind) === "sealed";
    const totes = totesByStack();
    return (sealed ? sealedStacksInLocation(locationId) : stacksInLocation(locationId)).filter(r => shelfQty(r, totes) > 0)
      .map(r => ({ r, sig: String(shelfQty(r, totes)) }));
  }
  /* The stacks to walk in one bin, blind: the item only. `sig` is an opaque tag
     that changes only when the shelf count does (a picker's Finish moves the book
     and the tote together and leaves it alone), so the post can tell a stack moved
     under a count in progress and the page re-asks just that one. */
  function rfCountBin(locationId, kind) {
    const loc = locById(locationId);
    if (!loc) return null;
    const sealed = countKind(kind) === "sealed";
    const stacks = rfCountStacks(locationId, kind).map(({ r, sig }) =>
      Object.assign(rfCardFields(Object.assign({}, r, { kind: sealed ? "sealed" : "card" }), r), { id: r.id, sig }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.set.localeCompare(b.set) || a.finish.localeCompare(b.finish) || a.lang.localeCompare(b.lang) || a.condition.localeCompare(b.condition));
    return { locationId, bin: loc.name, kind: countKind(kind), stacks };
  }
  // Does this count agree with the book? Only yes or no: the number stays on the desk's side.
  function rfCountMatches(kind, recordId, counted) {
    const rec = (countKind(kind) === "sealed" ? state.sealed : state.cards).find(x => x.id === recordId);
    return !!rec && shelfQty(rec, totesByStack()) === Math.max(0, parseInt(counted, 10) || 0);
  }
  /* Post the finished count: o = { locationId, kind, counts: [{ recordId, sig, counted }],
     found: cards [{ set, collector, lang, finish, condition, qty }] or sealed
     [{ tcgplayerProductId, manapoolProductId, name, setCode, marketPrice, qty }] }.
     Refuses if the bin's stacks changed since the count began. */
  async function rfCountPost(o) {
    if (!locById(o.locationId)) return { ok: false, problem: "gone" };
    const sealed = countKind(o.kind) === "sealed";
    const now = new Map(rfCountStacks(o.locationId, o.kind).map(x => [x.r.id, x.sig]));
    const counts = o.counts || [];
    if (counts.length !== now.size || counts.some(c => now.get(c.recordId) !== c.sig)) return { ok: false, problem: "changed" };
    const rows = counts.map(c => ({ recordId: c.recordId, countedQty: c.counted }));
    const found = o.found || [];
    for (const f of found) {
      rows.push(sealed
        ? { recordId: null, tcgplayerProductId: f.tcgplayerProductId, manapoolProductId: f.manapoolProductId, name: f.name, setCode: f.setCode, price: f.marketPrice, countedQty: f.qty }
        : { recordId: null, set: f.set, collector: f.collector, lang: f.lang, finish: f.finish, condition: f.condition, countedQty: f.qty });
    }
    let out;
    try {
      out = sealed ? applySealedCycleCountAdjustments(o.locationId, rows) : await applyCycleCountAdjustments(o.locationId, rows);
    } catch (e) { return { ok: false, problem: "lookup", message: e.message || String(e) }; }
    addHistory({ id: uid(), ts: new Date().toISOString(), type: sealed ? "cycle-count-full-sealed" : "cycle-count-full",
      binId: o.locationId, binName: locName(o.locationId), adjusted: out.adjusted, added: out.added, via: "rf" });
    return { ok: true, adjusted: out.adjusted, added: out.added, stacks: counts.length, clean: !out.adjusted && !out.added };
  }

  /* ============================== Shipping weight ==============================
     Packaging weights for the Weigh & Manifest step - see BACKLOG.md #8
     (2026-09-01). Real Pitney Bowes label creation stays blocked on sandbox
     credentials, but this estimate is useful on its own (a real number to
     write on a package even before that's unblocked). */
  const SHIP_WEIGHTS = { card: 0.06, topLoader: 0.24, envelope: 0.2, packingList: 0.17, pickList: 0.17 };
  function estimateShipWeight(pickList, materials) {
    // Only card-kind lines count toward the per-card rate - a sealed line
    // (a booster box, not a 0.06oz card) has no per-unit weight anywhere in
    // the app yet, so including its quantity here would make the estimate
    // nonsensically low for a pick list with sealed lines on it rather than
    // just incomplete. Callers should check for a sealed line themselves
    // (pickList.lines.some(l => l.kind === "sealed")) and flag that the
    // estimate is card-only when true.
    const lines = (pickList && pickList.lines) || [];
    const cards = lines.filter(l => l.kind !== "sealed").reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const m = materials || {};
    let oz = cards * SHIP_WEIGHTS.card;
    if (m.topLoader) oz += SHIP_WEIGHTS.topLoader * (Number(m.topLoaderQty) || cards);
    if (m.envelope) oz += SHIP_WEIGHTS.envelope;
    if (m.packingList) oz += SHIP_WEIGHTS.packingList;
    if (m.pickList) oz += SHIP_WEIGHTS.pickList;
    return round2(oz);
  }

  /* ============================== Files ============================== */
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /* One CSV cell. A text cell starting with = + - @, a tab or a CR is run as
     a formula when the file is opened in Excel, Sheets or LibreOffice, and
     much of what lands in an export (bin names, notes, receipt ids) is typed
     by other people in a Store (#163). Those get a leading ' so they open as
     text. Real numbers, and text that is just a number ("-3", "-1.25"), are
     left alone so numeric columns stay numeric. parseTabularRows() takes the
     ' back off, so a Grimoire export still imports as it was. */
  const CSV_FORMULA_START = /^[=+\-@\t\r]/;
  const CSV_PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  // Plain RFC 4180 quoting with no formula guard (#173), for a file a
  // marketplace imports by machine (the TCGplayer export), where the text
  // comes from the card catalogue rather than from people and a leading '
  // would change what the importer reads ("+2 Mace" -> "'+2 Mace"). Every
  // file meant to be opened in a spreadsheet keeps csvCell.
  const csvRawCell = v => {
    v = v == null ? "" : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const csvCell = v => {
    v = v == null ? "" : String(v);
    return csvRawCell(CSV_FORMULA_START.test(v) && !CSV_PLAIN_NUMBER.test(v) ? "'" + v : v);
  };

  /* File.text() assumes UTF-8, which silently corrupts a file that's actually UTF-16
     (TCGplayer's Pull Sheet export is UTF-16LE with no BOM - see receive.page.js) -
     every character comes through with a stray \0 byte next to it, invisible once
     rendered but poisonous to parseInt/parseFloat on every numeric column. Sniff for
     that instead of assuming UTF-8, the same way the dedicated Pull Sheet importer
     already has to decode explicitly. */
  function decodeFileText(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    const sampleLen = Math.min(bytes.length, 256) & ~1; // even, so the byte-pairing below lines up
    let zeros = 0;
    for (let i = 1; i < sampleLen; i += 2) if (bytes[i] === 0) zeros++;
    if (sampleLen > 1 && zeros / (sampleLen / 2) > 0.8) return new TextDecoder("utf-16le").decode(bytes);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function pickFile(accept) {
    return new Promise(resolve => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = accept || "";
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return resolve(null);
        resolve({ name: f.name, text: decodeFileText(await f.arrayBuffer()), size: f.size });
      };
      inp.click();
    });
  }

  /* Delimited parser: quoted fields, "" escapes, CRLF/LF, BOM, comma vs tab. */
  function parseDelimited(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const nl = text.indexOf("\n");
    const firstLine = nl < 0 ? text : text.slice(0, nl);
    const delim = (firstLine.split("\t").length > firstLine.split(",").length) ? "\t" : ",";
    const rows = []; let row = []; let field = ""; let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === delim) { row.push(field); field = ""; }
        else if (ch === "\r") { /* handled at \n */ }
        else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else field += ch;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return { rows, delim };
  }
  const normHeader = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

  /* "foil" as a plain substring also matches "nonfoil"/"non-foil" - check for
     a "non" prefix first so those read as nonfoil, and "etched" before the
     plainer "foil" match so "Etched Foil" text doesn't fall through to the
     coarser foil bucket. Mirrors the server-side finishFromText()/
     isFoilText() in server/lib/integrations.js - kept in sync by hand since
     one is browser code and the other Node, but the logic must stay identical. */
  function finishFromText(v) {
    const s = String(v || "");
    if (/non.?foil/i.test(s)) return "nonfoil";
    if (/etched/i.test(s)) return "etched";
    if (/foil/i.test(s)) return "foil";
    return "nonfoil";
  }
  function isFoilText(v) { return finishFromText(v) !== "nonfoil"; }

  /* Shared bootstrap for every tabular (CSV/TSV) importer: map a file's own
     header row onto known field names via an alias dictionary, tolerant of
     case/spacing/punctuation differences (aliases are normalised the same
     way the header itself is, so a caller's alias list doesn't have to be
     pre-normalised). */
  function mapAliasHeaders(headers, aliasMap) {
    const idx = {};
    headers.forEach((h, i) => {
      const n = normHeader(h);
      for (const [field, aliases] of Object.entries(aliasMap)) {
        if (aliases.map(normHeader).includes(n) && idx[field] == null) idx[field] = i;
      }
    });
    return idx;
  }

  /* Parse a delimited file into a header row plus its data rows, dropping
     blank rows. Returns null for an empty/blank file so callers can show
     their own "the file appears to be empty" message. */
  function parseTabularRows(text) {
    const { rows } = parseDelimited(text);
    const data = rows.filter(r => r.some(c => String(c).trim() !== ""));
    if (!data.length) return null;
    // Undo csvCell's formula guard ('=..., '@..., '-x), so a bin called
    // "@Home" exported from Grimoire comes back as "@Home", not "'@Home".
    const unguard = c => typeof c === "string" && /^'[=+\-@\t\r]/.test(c) ? c.slice(1) : c;
    return { headers: data[0].map(h => String(h).trim()), dataRows: data.slice(1).map(r => r.map(unguard)) };
  }

  /* A whole number of 1 or more, or null - the "how many copies" check every
     tabular importer needs on its quantity column. */
  function parseWholeQty(raw) {
    const q = parseInt(raw, 10);
    return (isNaN(q) || q < 1) ? null : q;
  }

  /* ---------- Minimal XLSX writer (no libraries) ---------- */
  const CRC_TABLE = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) {
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name); const data = f.data; const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nameBytes, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push({ header: new Uint8Array(ch.buffer), nameBytes });
      offset += 30 + nameBytes.length + data.length;
    }
    const centralStart = offset; let centralSize = 0;
    for (const c of central) { parts.push(c.header, c.nameBytes); centralSize += c.header.length + c.nameBytes.length; }
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(4, 0, true); eo.setUint16(6, 0, true);
    eo.setUint16(8, central.length, true); eo.setUint16(10, central.length, true);
    eo.setUint32(12, centralSize, true); eo.setUint32(16, centralStart, true); eo.setUint16(20, 0, true);
    parts.push(new Uint8Array(eo.buffer));
    return new Blob(parts, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function colLetter(n) { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function buildSheetXml(rows) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach((row, r) => {
      xml += '<row r="' + (r + 1) + '">';
      row.forEach((cell, c) => {
        if (cell == null || cell.v === "" || cell.v == null) return;
        const ref = colLetter(c) + (r + 1);
        if (cell.t === "n") xml += '<c r="' + ref + '"><v>' + cell.v + "</v></c>";
        else xml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cell.v) + "</t></is></c>";
      });
      xml += "</row>";
    });
    return xml + "</sheetData></worksheet>";
  }
  function writeXlsx(sheetName, rows, fileName) {
    const enc = new TextEncoder();
    const files = [
      { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: "_rels/.rels", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: "xl/workbook.xml", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xmlEsc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: enc.encode(buildSheetXml(rows)) }
    ];
    downloadBlob(zipStore(files), fileName);
  }

  /* ---------- Exports ---------- */
  function exportExcel() {
    if (!state.cards.length) throw new Error("Nothing to export - the inventory is empty.");
    const S = v => ({ t: "s", v }); const N = v => ({ t: "n", v });
    const header = ["Set", "Collector #", "Language", "Finish", "Condition", "Card Name", "Set Name", "Rarity",
      "Price (USD)", "Quantity", "Listed Qty", "Location", "Location Type", "Row Total (USD)",
      "Copies With Cost", "Avg Cost (USD)", "Cost Total (USD)", "Unrealised Gain (USD)",
      "Scryfall ID", "Last Price Update"].map(S);
    const rows = [header];
    for (const r of state.cards) {
      const costed = Math.min(r.quantity, Number(r.costQty) || 0);
      const gain = (r.price != null && costed > 0) ? r.price * costed - (Number(r.costTotal) || 0) : null;
      rows.push([
        S(r.set.toUpperCase()), S(r.collector), S(LANG_NAMES[r.lang] || r.lang), S(FINISH_NAMES[r.finish] || "Non-foil"),
        S(CONDITION_NAMES[r.condition] || r.condition || "Near Mint"),
        S(r.name), S(r.setName), S(r.rarity),
        r.price == null ? S("") : N(round2(r.price)),
        N(r.quantity), N(r.listedQty || 0),
        S(locName(r.locationId)), S(locType(r.locationId)), N(round2(rowTotal(r))),
        N(costed), r.avgCost == null ? S("") : N(round2(r.avgCost)), N(round2(r.costTotal || 0)),
        gain == null ? S("") : N(round2(gain)),
        S(r.scryfallId || ""), S(r.priceUpdated || "")
      ]);
    }
    const tc = state.cards.reduce((s, r) => s + r.quantity, 0);
    const tl = state.cards.reduce((s, r) => s + (r.listedQty || 0), 0);
    const tv = state.cards.reduce((s, r) => s + rowTotal(r), 0);
    const tcost = state.cards.reduce((s, r) => s + (Number(r.costTotal) || 0), 0);
    // Column count went 19 -> 20 with the Condition column above; every index
    // here shifted by one (Rarity 6->7, Quantity 8->9, Listed Qty 9->10,
    // Row Total 12->13, Cost Total 15->16) to match.
    const totals = new Array(20).fill(null).map(() => S(""));
    totals[7] = S("TOTAL"); totals[9] = N(tc); totals[10] = N(tl);
    totals[13] = N(round2(tv)); totals[16] = N(round2(tcost));
    rows.push(totals);
    writeXlsx("Inventory", rows, "grimoire-inventory.xlsx");
    return state.cards.length;
  }

  function exportTcgCsv() {
    const forSale = r => Math.min(Number(r.listedQty) || 0, availableQty(r));   // never a lent copy (#336)
    const listed = state.cards.filter(r => forSale(r) > 0);
    if (!listed.length) throw new Error("No cards are listed For Sale yet.");
    const headers = ["TCGplayer Id", "Product Line", "Set Name", "Product Name", "Title", "Number", "Rarity",
      "Condition", "TCG Market Price", "TCG Direct Low", "TCG Low Price With Shipping", "TCG Low Price",
      "Total Quantity", "Add to Quantity", "TCG Marketplace Price", "Photo URL"];
    const lines = [headers.join(",")];
    for (const r of listed) {
      const cond = (CONDITION_NAMES[r.condition] || "Near Mint") +
        (r.finish === "etched" ? " Etched Foil" : r.finish === "foil" ? " Foil" : "");
      const rarity = r.rarity ? r.rarity.charAt(0).toUpperCase() + r.rarity.slice(1) : "";
      const price = r.price == null ? "" : r.price.toFixed(2);
      const mult = (state.settings.conditionPricing || {})[r.condition];
      const askPrice = r.price == null ? "" : (r.price * (mult == null ? 1 : mult)).toFixed(2);
      lines.push([r.tcgplayerId, "Magic", r.setName, r.name, "", r.collector, rarity, cond, price,
        "", "", "", forSale(r), forSale(r), askPrice, ""].map(csvRawCell).join(","));
    }
    downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }), "tcgplayer-forsale.csv");
    return { lines: listed.length, cards: listed.reduce((s, r) => s + r.listedQty, 0) };
  }

  /* A transfer file is what another Grimoire user imports to receive cards from
     you. It carries the printings, the quantities and (optionally) what they cost
     you, and nothing else - no locations, no audit trail, no buyer details. */
  function buildTransfer(rows, opts) {
    const o = opts || {};
    return {
      app: APP_NAME, kind: "transfer", transferVersion: 1,
      createdAt: new Date().toISOString(),
      fromUser: (me && me.username) || "",
      note: String(o.note || ""),
      includesCost: !!o.includeCost,
      lines: rows.map(r => {
        const line = {
          set: r.set, collector: r.collector, lang: r.lang, finish: r.finish || "nonfoil", condition: r.condition || "NM",
          name: r.name, setName: r.setName, scryfallId: r.scryfallId || "",
          qty: Number(o.qtyOf ? o.qtyOf(r) : r.quantity) || 0,
          price: r.price == null ? null : round2(r.price)
        };
        if (o.includeCost && Number(r.costQty) > 0) line.unitCost = round2(r.avgCost);
        return line;
      }).filter(l => l.qty > 0),
      totalCards: rows.reduce((s, r) => s + (Number(o.qtyOf ? o.qtyOf(r) : r.quantity) || 0), 0)
    };
  }

  function parseTransfer(text) {
    let doc;
    try { doc = JSON.parse(text); }
    catch (e) { throw new Error("That file is not valid JSON, so it is not a Grimoire transfer file."); }
    if (!doc || doc.kind !== "transfer" || !Array.isArray(doc.lines)) {
      throw new Error('That file is not a Grimoire transfer. Ask the sender to use "Export a transfer file".');
    }
    if (Number(doc.transferVersion) > 1) {
      throw new Error("That transfer file was written by a newer version of Grimoire.");
    }
    const lines = doc.lines.map(l => ({
      set: String(l.set || "").toLowerCase(),
      collector: String(l.collector || ""),
      lang: String(l.lang || "en").toLowerCase(),
      // A transfer file from before this migration only ever has `foil`.
      finish: normalizeFinish(l.finish) || (l.foil ? "foil" : "nonfoil"),
      condition: CONDITIONS.includes(l.condition) ? l.condition : "NM",
      name: String(l.name || ""),
      setName: String(l.setName || ""),
      scryfallId: String(l.scryfallId || ""),
      // A line that says 0 (or less) carries nothing, the same as
      // buildTransfer() leaving such lines out; a missing or unreadable
      // quantity still means 1 (#73).
      qty: Math.trunc(storedQty(l.qty)),
      price: l.price == null ? null : Number(l.price),
      unitCost: l.unitCost == null ? null : Number(l.unitCost)
    })).filter(l => l.set && l.collector && l.qty > 0);
    return {
      fromUser: String(doc.fromUser || "(unknown)"),
      createdAt: doc.createdAt || "",
      note: String(doc.note || ""),
      includesCost: !!doc.includesCost,
      lines,
      totalCards: lines.reduce((s, l) => s + l.qty, 0)
    };
  }

  /* ============================== Importing a v0.07 save ==============================
     v0.07 kept the whole collection in one JSON file you saved by hand. Its shape
     is a subset of v0.08's, so the file loads directly - but the things v0.08
     added did not exist in it, and pretending otherwise would be a lie. What does
     NOT come across, because there was nothing to come across:

       cost basis            every stack arrives with no known cost
       putaway rules         locations arrive with putaway switched off
       ceilings / per-card   unset
       sorting-tray flags    unset
       oracle ids            backfilled by the first "Refresh prices & data"
       receipts              v0.07 had no concept of one

     Locations DO come across, with their names and types intact - which is what
     matters, because the card rows point at them. */
  function parseLegacySave(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error("That file is not valid JSON, so it is not a " + APP_NAME + " save file."); }
    if (Array.isArray(data)) data = { locations: [], cards: data };   // very old: a bare array
    if (!data || typeof data !== "object") throw new Error("That file does not contain an inventory.");
    if (data.kind === "transfer") {
      throw new Error("That is a transfer file, not a save file. Import it on the Receive page " +
        "under “Receive inventory from a user”.");
    }
    if (data.app && data.app !== APP_NAME && !LEGACY_APP_NAMES.includes(data.app)) {
      throw new Error('That file belongs to "' + String(data.app).slice(0, 40) + '", not to ' + APP_NAME + ".");
    }
    if (!Array.isArray(data.cards) && !Array.isArray(data.locations)) {
      throw new Error("That file has no cards and no locations in it, so it is not an inventory save.");
    }
    if (Number(data.version) > SAVE_VERSION) {
      throw new Error("That file was written by a newer version of " + APP_NAME +
        " (v" + data.version + " against v" + SAVE_VERSION + ").");
    }
    return data;
  }

  /* Read a save file and describe what is in it, without touching any state. */
  function inspectLegacy(text) {
    const data = parseLegacySave(text);
    const cards = Array.isArray(data.cards) ? data.cards : [];
    const locs = Array.isArray(data.locations) ? data.locations : [];
    const qty = cards.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
    const value = cards.reduce((s, c) =>
      s + ((c.price == null ? 0 : Number(c.price)) * (Number(c.quantity) || 0)), 0);
    const existing = new Set(state.locations.map(l => l.name.trim().toLowerCase()));
    const matched = locs.filter(l => existing.has(String(l.name || "").trim().toLowerCase())).length;
    const locIds = new Set(locs.map(l => l.id));
    return {
      data,
      app: data.app || "(unnamed)",
      version: data.version == null ? "(none)" : data.version,
      savedAt: data.savedAt || "",
      locations: locs.length,
      locationsMatched: matched,
      locationsNew: locs.length - matched,
      stacks: cards.length,
      cards: qty,
      names: new Set(cards.map(c => String(c.name || "").toLowerCase())).size,
      value: round2(value),
      // Rows whose location is missing from the file - they land in "Unsorted".
      orphanStacks: cards.filter(c => !c.locationId || !locIds.has(c.locationId)).length,
      pickList: Array.isArray(data.pickList) ? data.pickList.length : 0,
      deckList: Array.isArray(data.deckList) ? data.deckList.length : 0,
      audit: Array.isArray(data.audit) ? data.audit.length : 0,
      history: Array.isArray(data.history) ? data.history.length : 0,
      withCost: cards.filter(c => Number(c.costQty) > 0).length,
      withMeta: cards.filter(c => c.typeLine).length,
      noMeta: cards.filter(c => !c.typeLine).length
    };
  }

  /* mode "replace": adopt the file as the whole collection. The version it
       displaces is kept as a server revision, so this is reversible.
     mode "merge": fold its locations and cards into what is already here.
       Locations are matched by name, so re-importing the same file twice
       duplicates cards but not bins. */
  function importLegacy(text, opts) {
    const o = opts || {};
    const info = inspectLegacy(text);
    const data = info.data;

    if (o.mode === "replace") {
      adoptState(data);
      // The file's own audit history (if any) goes to the server-side
      // store directly - it's not part of state.audit any more.
      importAuditBulk(data.audit);
      logAudit({
        action: "import",
        note: "Replaced the whole collection from a v" + info.version + " save file — " +
          info.stacks + " stack(s), " + info.cards + " card(s), " + info.locations + " location(s)"
      });
      persist("Import v0.07 save (replace)");
      return Object.assign({}, info, { mode: "replace", created: info.locations, mergedStacks: 0, added: info.cards });
    }

    const stacksBefore = state.cards.length;
    const locsBefore = state.locations.length;
    const map = new Map();
    for (const l of (data.locations || [])) {
      map.set(l.id, findOrCreateLocation(l.name || "Unsorted", l.type || "Other"));
    }
    let added = 0;
    for (const c of (data.cards || [])) {
      const locId = map.get(c.locationId) ||
        findOrCreateLocation(c.location || c.locationName || "Unsorted", c.locationType || "Other");
      const rec = normalizeCard(Object.assign({}, c, { id: uid(), locationId: locId }));
      state.cards.push(rec);
      added += rec.quantity;
    }
    normalizeMerge({ silent: true });
    const created = state.locations.length - locsBefore;
    const mergedStacks = Math.max(0, (stacksBefore + info.stacks) - state.cards.length);
    logAudit({
      action: "import", qty: added,
      note: "Merged a v" + info.version + " save file — " + info.stacks + " stack(s) / " + added +
        " card(s), " + created + " new location(s), " + mergedStacks + " folded into existing stacks"
    });
    persist("Import v0.07 save (merge)");
    return Object.assign({}, info, { mode: "merge", created, mergedStacks, added });
  }

  // Same mark as the in-app sidebar logo (ui.js's LOGO), redrawn in black-on-white
  // only - printers (thermal ones especially) don't do the app's purple/gold well,
  // and a coloring-book-style outline reproduces cleanly at picklist size.
  const LOGO_PRINT = "<svg viewBox='0 0 32 32' width='34' height='34' role='img' aria-label='Grimoire'>" +
    "<rect x='9' y='5' width='18' height='22' rx='2' fill='#fff' stroke='#000' stroke-width='1'/>" +
    "<rect x='5.5' y='4' width='19' height='24' rx='2.5' fill='none' stroke='#000' stroke-width='1.5'/>" +
    "<path d='M10.2 4.9v22.2' stroke='#000' stroke-width='1.2'/>" +
    "<path d='M17.4 11.2 20.8 16l-3.4 4.8L14 16z' fill='#000'/>" +
    "<path d='M17.4 22.7v1.6' stroke='#000' stroke-width='1.2'/></svg>";

  // #289: one place decides how a pick quantity looks. Above 1 it is a boxed
  // "\u00d7N" (.qty-multi: app.css on screen, printList's inline style on paper);
  // 1 stays a plain number so the odd line stands out.
  function qtyBadge(n) {
    const q = Number(n);
    return q > 1 ? "<span class='qty-multi'>\u00d7" + q + "</span>" : String(n);
  }
  // The on-screen Qty cell; data-v keeps the column sorting by number.
  function qtyTd(n) { return "<td class=\"num\" data-v=\"" + (Number(n) || 0) + "\">" + qtyBadge(n) + "</td>"; }

  function printList(title, headRow, bodyRows, subtitle, footer) {
    const w = window.open("", "_blank");
    if (!w) throw new Error("Pop-up blocked - allow pop-ups for this site to print.");
    const style = "body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#111}" +
      ".hdr{display:flex;align-items:flex-start;gap:10px;margin-bottom:14px}" +
      ".hdr svg{flex:none;margin-top:2px}h1{font-size:18px;margin:0 0 4px}" +
      ".sub{color:#666;font-size:12px;white-space:pre-line}table{border-collapse:collapse;width:100%;font-size:13px}" +
      "th,td{border:1px solid #bbb;padding:6px 9px;text-align:left;vertical-align:top}th{background:#eee}" +
      ".foot{margin-top:20px;padding-top:10px;border-top:1px solid #ddd;color:#888;font-size:11px;text-align:center;line-height:1.5}" +
      ".foot b{color:#555}" +
      // This popup is the ONLY thing that ever actually prints in this app -
      // every G.printList() caller (pick lists, putaway, receipts, returns,
      // deck lists) goes through this one self-contained window, never
      // window.print() on the main app page, so app.css's own @media print
      // block (BACKLOG.md #37) can never actually apply to anything. The
      // real gap was here: a long list (a big pick list, a multi-line
      // receipt) had no page-break handling at all, so a browser could
      // split a single row - or the footer block - visually across two
      // printed pages. thead already repeats on its own on every page
      // (native table behavior, nothing to add for that part).
      // The heavy black border carries .qty-multi with "print backgrounds" off.
      ".qty-multi{display:inline-block;border:3px solid #000;border-radius:2px;padding:1px 7px;font:bold 17px Consolas,monospace;" +
      "background:#000;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
      "@media print{tr{page-break-inside:avoid;break-inside:avoid}" +
      ".foot{page-break-inside:avoid;break-inside:avoid}}";
    const html = "<!DOCTYPE html><html><head><title>" + esc(title) + "</title><style>" + style + "</style></head><body>" +
      "<div class='hdr'>" + LOGO_PRINT + "<div><h1>" + esc(title) + "</h1><div class='sub'>" + new Date().toLocaleString() + " · Grimoire" +
      (subtitle ? "\n" + esc(subtitle) : "") + "</div></div></div>" +
      "<table><thead><tr>" + headRow.map(h => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" +
      bodyRows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>" +
      (footer ? "<div class='foot'>" + footer + "</div>" : "") +
      "</body></html>";
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 350);
  }

  /* ============================== Aggregations ============================== */
  function aggregateByName(query) {
    const map = new Map();
    for (const r of state.cards) {
      if (!matchesQuery(r, query)) continue;
      const key = r.name.toLowerCase();
      let a = map.get(key);
      if (!a) {
        a = { name: r.name, qty: 0, listed: 0, value: 0, cost: 0, costQty: 0,
          printings: new Set(), locs: new Set(), prices: [], hay: "", imageUrl: "", loans: [] };
        map.set(key, a);
      }
      a.qty += r.quantity;
      a.listed += (r.listedQty || 0);
      if (r.loans) a.loans.push(...r.loans);
      a.value += rowTotal(r);
      a.cost += Number(r.costTotal) || 0;
      a.costQty += Number(r.costQty) || 0;
      a.printings.add(r.set + "|" + r.collector + "|" + r.lang + "|" + r.finish);
      a.locs.add(r.locationId);
      if (r.price != null) a.prices.push(r.price);
      // Every member row here is already owned (this only ever iterates
      // state.cards) - so any one of them satisfies "pick art the person
      // actually has" for this summarized row; just keep the first seen.
      if (!a.imageUrl && r.imageUrl) a.imageUrl = r.imageUrl;
      a.hay += " " + r.name + " " + r.set + " " + r.setName + " " + r.collector;
    }
    return [...map.values()].map(a => ({
      name: a.name, qty: a.qty, listed: a.listed, value: round2(a.value),
      cost: round2(a.cost), costQty: a.costQty,
      printings: a.printings.size, locs: a.locs.size,
      low: a.prices.length ? Math.min.apply(null, a.prices) : null,
      high: a.prices.length ? Math.max.apply(null, a.prices) : null,
      imageUrl: a.imageUrl, loans: a.loans,
      hay: a.hay.toLowerCase()
    }));
  }

  /* The "storefront" grain - one row per sellable identity (same physical
     printing, language, finish and condition), storage location folded away.
     This is coarser than WMS (which has one row per stack per location) and a
     different axis than the by-name ERP rollup - it is the grain Manapool
     itself sells at, which is why the listed-quantity control lives here
     rather than on individual WMS rows. Grouped explicitly by
     set/collector/lang/finish/condition/name rather than manapoolIdentityKey
     (scryfallId-based) so a row with no scryfallId yet still groups correctly
     instead of collapsing into one phantom bucket with every other
     not-yet-matched card. */
  function aggregateStorefront(query) {
    const map = new Map();
    for (const r of state.cards) {
      if (!matchesQuery(r, query)) continue;
      const key = [r.set, normNum(r.collector), r.lang, r.finish, r.condition || "", r.name.toLowerCase()].join("|");
      let a = map.get(key);
      if (!a) {
        a = {
          set: r.set, collector: r.collector, setName: r.setName, lang: r.lang,
          finish: r.finish, condition: r.condition || "", name: r.name,
          qty: 0, listed: 0, prices: [], locs: new Set(), rep: r, loans: []
        };
        map.set(key, a);
      }
      a.qty += r.quantity;
      a.listed += (r.listedQty || 0);
      if (r.loans) a.loans.push(...r.loans);
      a.locs.add(r.locationId);
      if (r.price != null) a.prices.push(r.price);
    }
    return [...map.values()].map(a => ({
      set: a.set, collector: a.collector, setName: a.setName, lang: a.lang,
      finish: a.finish, condition: a.condition, name: a.name,
      qty: a.qty, listed: a.listed, locs: a.locs.size,
      price: a.prices.length ? a.prices[0] : null,
      imageUrl: a.rep.imageUrl, loans: a.loans,
      identityKey: manapoolIdentityKey(a.rep),
      hay: (a.name + " " + a.set + " " + a.setName + " " + a.collector).toLowerCase()
    }));
  }

  /* "3 cards have no price and aren't counted" with a link to just those
     cards (Card Inventory opens filtered with ?noprice=1). "" when none. */
  function unpricedNote(n, linked) {
    n = Number(n) || 0;
    if (n <= 0) return "";
    const txt = n.toLocaleString() + (n === 1 ? " card has" : " cards have") + " no price and " + (n === 1 ? "isn't" : "aren't") + " counted";
    return linked === false ? txt : '<a href="/inventory.html?noprice=1">' + txt + "</a>";
  }

  /* "Near Mint market price, updated Oct 27, 2026". Condition never changes a
     shown value; this only says what the numbers are (#326). */
  let priceBasisCache = null;
  function priceBasis() {
    if (!priceBasisCache) priceBasisCache = cardsApi.status().then(st => {
      const d = st && st.updatedAt ? new Date(st.updatedAt) : null;
      const when = d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
      return "Near Mint market price" + (when ? ", updated " + when : "");
    }).catch(() => "Near Mint market price");
    return priceBasisCache;
  }
  /* Fill every <span data-price-basis> under root with the line above. */
  function paintPriceBasis(root) {
    const spans = (root || document).querySelectorAll("[data-price-basis]");
    if (spans.length) priceBasis().then(t => spans.forEach(el => { el.textContent = t; }));
  }

  function summary(rows) {
    const list = rows || state.cards;
    const totalCards = state.cards.reduce((s, r) => s + r.quantity, 0);
    const totalValue = state.cards.reduce((s, r) => s + rowTotal(r), 0);
    // Cards with no price count as $0 in the totals; say how many, so a total
    // is never silently short (#326). Averages divide by the priced ones.
    const unpricedCards = state.cards.reduce((s, r) => s + (r.price == null ? r.quantity : 0), 0);
    return {
      unpricedCards,
      pricedCards: totalCards - unpricedCards,
      filteredUnpricedCards: list.reduce((s, r) => s + (r.price == null ? r.quantity : 0), 0),
      names: new Set(state.cards.map(r => r.name.toLowerCase())).size,
      cards: totalCards,
      stacks: state.cards.length,
      locations: state.locations.length,
      value: round2(totalValue),
      listedCards: state.cards.reduce((s, r) => s + (r.listedQty || 0), 0),
      listedValue: round2(state.cards.reduce((s, r) => s + (r.price == null ? 0 : r.price * (r.listedQty || 0)), 0)),
      filteredCards: list.reduce((s, r) => s + r.quantity, 0),
      filteredStacks: list.length,
      filteredValue: round2(list.reduce((s, r) => s + rowTotal(r), 0)),
      cost: costSummary(state.cards)
    };
  }

  /* ============================== Boot ============================== */
  /* Closing the tab, reloading, Back or a typed address with work unsaved:
     the browser's own "Leave site?" prompt (its wording is fixed; setting
     returnValue is what asks for it). In-app links never get here with
     anything unsaved: ui.js saves first. Nothing is sent from here (#174).
     The whole document used to go in a keepalive PUT, but a real collection
     is 2.7 to 7.8 MB against the browsers' 64 KiB keepalive limit, so it was
     refused; and on a small one it went out before the person answered, so
     pressing Stay then saved the same edit twice (#175). The save happens on
     pagehide below, once the page really is going; since patch saves (#181)
     it is usually small enough to go as keepalive and land after the page
     has gone. */
  window.addEventListener("beforeunload", e => {
    if (leaveConfirmed) return;
    // Held (holdSaves): the session may already point at another
    // inventory, so nothing may save from here. Still warn.
    if (held ? hasUnsaved() : (savePending || dirty)) { e.preventDefault(); e.returnValue = ""; }
  });

  /* The page is hidden (another tab or app, the phone locked) or being left:
     save now rather than after the debounce, while the page can still run
     the request. Phones need this most: iOS Safari doesn't reliably fire
     beforeunload, and a hidden page may be frozen or discarded without
     another event. The requests ask for keepalive, so a small body still
     reaches the server if the page goes away (see api()). A save that
     already failed keeps its own retry, and a conflict waits for its prompt,
     rather than being resent each time the page is hidden. */
  function saveOnLeave() {
    if (held || !loaded || leaveConfirmed) return;
    const inAir = saving;
    leaveFlush = true;
    try {
      // flushSave() sends pending audit entries too.
      if (savePending && !saving && !saveError) flushSave();
      else flushAudit();
    } finally { leaveFlush = false; }
    // Changed while a save was in the air: send it the moment that one lands.
    if (inAir && savePending && !saveError) saveAll(15000).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveOnLeave(); });
  window.addEventListener("pagehide", saveOnLeave);
  /* A page the browser brings back from its back/forward cache (Back, or a
     phone's back button) is shown exactly as it was drawn, without asking the
     server. On a device switched into kiosk mode since (#433) that would put
     a manager's page, costs and customers included, in front of the public,
     so every page with this file reloads instead: the server then sends the
     kiosk to its own screen, and anyone else gets a fresh page. */
  window.addEventListener("pageshow", e => { if (e.persisted) location.reload(); });

  return {
    // identity & lifecycle
    VERSION: SAVE_VERSION, APP_NAME, state, load, api, PATCH_KEYS,
    get me() { return me; },
    get mpBanner() { return mpBanner; },
    get isAdmin() { return !!me && me.role === "admin"; },
    get isModerator() { return !!me && (me.role === "moderator" || me.role === "admin"); },
    get simpleMode() { return pref("simpleMode") === true; },
    get prefsInAccount() { return !!personal; },
    get rev() { return rev; },
    get loaded() { return loaded; },
    // #185: Settings' Restore and revision list name the inventory too, and
    // a refusal stops this page saving the same way a refused save does.
    get loadedOwner() { return loadedOwner; },
    refusedForOwner,
    loadFetchedOrders, saveState, saveNow, overwriteServer, saveAll, holdSaves, hasUnsaved, leaveWithoutSaving, leaveForKiosk,
    on, off, emit,
    persist, persistSettings, pref, setPersonalPrefs, canManageStore,
    undo, redo, undoInfo,

    // helpers
    uid, money, pct, round2, rowTotal, rowCost, esc, sleep, debounce, latestOnly, planView, PLAN_ROW_CAP, sortRows, planFingerprint, ownedIndex,
    printFinishIndex, receiptMarket, sameKeySet,
    normNum, printKey, printingLabel, printingOptionLabel, printingChoiceLabel, groupPrintings, englishOf, sortPrintingsNewest, printingMatches, recPrinting, artCropUrl, csvCell, csvRawCell, downloadBlob, pickFile,
    parseDelimited, normHeader, printList, qtyBadge, qtyTd, writeXlsx, LANG_NAMES, cardName, CONDITION_NAMES, CONDITIONS, conditionCode,
    FINISH_NAMES, FINISHES, normalizeFinish, finishOf,
    isFoilText, finishFromText, mapAliasHeaders, parseTabularRows, parseWholeQty,
    MANAPOOL_BATCH_SIZE,
    defaultCondition, LOC_TYPES,

    // locations
    locById, locName, locType, normalizeWalkSeq, sortedLocations, locStats, moveOverCapacity, findOrCreateLocation, newLocation, createLocation, adoptState, idKey,
    LOC_SORT_FIELDS, LOC_SORT_PRESETS, LOC_SORT_MAX_LEVELS, normalizeSortMethod, locSortPresetOf, locSortSummary, locSortComparator, sortInLocationOrder,
    BINDER_TYPES, DEFAULT_PAGE_SIZE, isBinderType, binderPageSize, binderSpot, normalizePageSize, locationLayouts, buildLayout, placementNeighbourText, placementSectionText,

    // cards
    cards: cardsApi, lookupCard, priceOf, shapeForRuleTest, pickMeta, META_KEYS, cardCache,
    addCopies, deleteRecord, normalizeMerge, refreshPrices, COLLECTION_BATCH,

    // cost
    applyCost, removeCost, setCostBasis, allocateLotCost, lotSpend, costSummary,

    // audit
    logAudit, auditCard, addHistory, queryAudit, clearAuditLog, canClearAuditLog,
    canUndoAudit, undoAuditEntry, UNDOABLE_AUDIT_ACTIONS,

    // receipts
    nextReceiptId, recordReceipt, receiptById,
    mpReceivedPackages, mpPurchaseLot, ownedCopies, mpDupeDefault, costOwnedCopies,
    TRADES_MAX, normalizeTrade, tradeValue, tradesNewestFirst, recordTrade, deleteTrade,
    nextReturnId, recordReturn, returnById,

    // accounting
    pnlByMonth, saleShipCost, returnCostBack, returnRestoresCost, localDay, accountingPresetRange,

    // dashboard tiles (#298)
    dashLayout, dashLayoutClean, dayStartMs, monthStartMs, salesBetween, profitBetween, receiptsSince, returnsSince,
    nearlyFullLocations, copiesWithoutCost, topCardsByPrice, wantsInStock, heldChange, loadSoldMine, soldSales, soldOf, restockCandidates, restockHints, restockRequest, restockRows, daysLeftView, listedSellingFast, listedWithoutAsk,

    // putaway
    PUTAWAY_FIELDS, OPS_BY_KIND, fieldDef, opsFor, normalizeRule, newRule,
    matchRule, matchesCriteria, ruleText, criteriaExpressionText, criteriaConditions,
    normalizeCriteriaBox, newCriteriaBox, conditionRowEl, renderCriteriaBuilder,
    ruleFieldValue, typeParts, normColors, COLOR_LETTERS,
    suggestLocation, putawayPlan, ruleBreakers, whatBelongsHere, consolidatePlan, consolidateTarget, candidates, allocatePutaway, binPlan,
    applyPutawayLines, stagingBins, putawaySources, putawayLocationCount,
    stacksInLocation, totesByStack, shelfQty, toteWords, pickHolders, pickShortTote, catchUp, stampOwnSave, pickCycleCountBin, cycleSampleProgress, sampleBinStacks, matchStackInBin, applyCycleCountAdjustments,
    sameCardName, nameCountAt, oracleKey, putawayIndex, fitPutawayMoves, applySuggestedMoves,

    // listing engine
    normalizeListingRule, newListingRule, matchesListingRule, ruleForRecord, activeListingRules,
    normalizeKeepException, newKeepException, keepExceptionFor, keepExceptionIndex,
    listingTarget, listingPlan, listingPlanRows, applyListingPlan,
    manapoolIdentityKey, manapoolGroup, applyManapoolQuantity, applyManapoolPushToStacks, manapoolPushGroups, storefrontListedPush, syncManapoolListings,
    manapoolReservations, unsettledManapoolSold, setManapoolOrders, loadManapoolOrders, listableQty, manapoolListingTotals, pricePushQuantity,
    lentQty, availableQty, splitLoans, lendCopies, returnLoan, loanOverdue, allLoans, loanNameSuggestions,
    manapoolSealedListingTotals, sealedPricePushQuantity, manapoolLiveListings, manapoolPushAlreadyLive, splitManapoolPush,

    // bulk price engine
    PRICE_RULE_MODES, PRICE_BASES, normalizePriceRule, newPriceRule, matchesPriceRule,
    ruleForPriceRecord, activePriceRules, bulkPricePlan, recordManapoolAsks, backfillAskPricesFromManapool, askPriceBackfillPending, manapoolListPrice, manapoolListingAsks, delistAllPlan, applyDelistAll, delistUnprofitablePlan, applyDelistUnprofitable, belowCost, minProfitPct, minProfitWords,

    // sealed product
    normalizeSealedItem, addSealedCopies, moveSealedLocation, setSealedQuantity, setSealedListedQty, deleteSealedRow,
    moveAllSealedFromLocation, deleteSealedRowsAtLocation,
    sealedStacksInLocation, pickSealedCycleCountBin, matchSealedStackInBin, applySealedCycleCountAdjustments,
    refreshSealedPrices,

    // sealed pricing engine
    SEALED_PRICE_RULE_MODES, normalizeSealedPriceRule, newSealedPriceRule, matchesSealedPriceRule,
    ruleForSealedPriceRecord, sealedBulkPriceTarget, sealedBulkPricePlan, applySealedBulkPricePlan,
    sealedIdentityKey, sealedManapoolGroup, applySealedManapoolQuantity,

    // watch list
    normalizeWatchItem, watchKey, watchTargetHit,

    // customers, wants and restock matches (#50)
    normalizeCustomer, normalizeWant, normalizeRestockMatch, normalizeTombstone, normalizeAlias,
    wantNameKey, wantPrintKey, wantIsPrinting, wantLabel,
    wantAvailability, restockMatcher, checkRestocks, resetRestockBaseline, wantAvailableNow,
    addCustomer, updateCustomer, deleteCustomer, mergeCustomers, addWant, deleteWant,
    markRestockTold, untoldRestocks, customersWithUntold, TOLD_KEEP,
    orderBuyerId, syncCustomersFromOrders, customerOrders, refundsByOrder, orderRefundedOnManapool, orderIsOpen, ordersById, ordersNeedingDetail, tidyCustomers,

    // query
    fitFinish, unpricedNote, priceBasis, paintPriceBasis, emptyQuery, matchesQuery, queryFieldCount, numOrNull,

    // lists
    allocateFrom, allocatePick, allocatePickLine, pickListAllocOpts, pickAllocations, deckPlan, addToDeckList, pickKey,
    manapoolUrl, manapoolSearchUrl, manapoolPasteText, MANAPOOL_ADD_DECK, slugify,
    gotDeckPlan, addGotDeck, normalizeDeck, saveBuiltDeck, mergeDeckLines, deckByLocation, deleteDeck, deckEntries, deckMissing, isDeckBox,
    pickLists, newPickList, nextPickListId, addToPickList, currentManualPickList,
    completePickList, markPickListShipped, markPickListPacked,
    isManapoolOrderTicket, orderNeedsTracking, pickNeedsTracking, manapoolShipFailed, pushShippedToManapool,
    COUNTER_SOURCES, isCounterSale, PAY_METHODS, PAY_METHOD_NAMES, ORDER_SOURCE_NAMES, counterSaleName, counterOrderWord, counterContact, counterFree, counterFindCards,
    enterWalkInOrder, handOverCounterSale, counterSaleTotal, cancelCounterSale, orderEntryListingSync,
    orderWasCancelled, noteOrderStatuses, loadCancelledOrders, pickOrderCancelled, sortingTrays, cancelPickedOrder, rfCancelledOrders,
    saleDate, isOrderSale, awaitsShip,
    pickListIsShort, chasePickAdjust, pickListForOrder, ensureOrderPickList,
    binLabelText, binFromLabel, checkBinScan, keyBin, BIN_KEY_REASONS, binScanRequired, logBinCheck, requestBinCount, binsToCount,
    moveCopies, rfFindCards, rfCardWhere, rfStack, rfBinList, rfBinView, rfMoveCheck, rfMoveCards,
    openReturns, openReturn, closeReturn, discardReturn, returnSummary, returnCostRows, returnSaleCosts, returnExpectedFromOrder,
    rfReturnList, rfReturnView,
    openReceivings, openReceiving, receivingById, heldOn, receivingLinesOf, receivingTray, receivingSummary, receivingCostPlan,
    closeReceiving, discardReceiving, tidyReceiving, rfBookCard, rfBookSealed, rfLineUndoable, rfUndoLine,
    rfReceivingList, rfReceiptView, rfReceivingTrays, rfSealedHome, rfPutawayTrays, rfPutawayStops, rfPutawayStop,
    rfPutawayCheck, rfPutaway, moveSealedCopies,
    rfCountTasks, rfCountNext, rfCountBin, rfCountMatches, rfCountPost,
    pickListTag, pickListInHand, rfPickQueue, rfCanWork, rfPickerOf, rfPackedHere, rfNeedsStart, rfStartWork, rfCanRelease, rfRelease, rfTakeOver, rfPickWalk, rfConfirmPull, rfReversePull, rfPutBack, rfShortPick, rfFinishPicking, rfPackView, rfPackOrder, setUndoOff,
    setPickLinePicked, setPickLinesPicked, pickLinePicked, pickLineKeys, clearPickLineTicks, pickLinesUsingRecord, pickLineProgress, pickLinesProgress,
    pickBatchLists, createPickBatch, pickBatchBlockers, dissolvePickBatch, setPickBatchSorted, pickBatchSortProgress, pickBatchSheet, pickLineOrder,
    pickBatchAssignee, assignPickBatch, reassignPickBatch, pickBatchInHand, pickBatchIsOpen, pickBatchIsNamed, canWorkPickBatch, canWorkPickList, canReassignPickBatch, tidyPickBatches,
    pickListOrderLabel, sortBagOrders, shortOrderId, searchTerms, matchesTerms, customerNameByOrder, orderSearchText, pickListSearchText,
    SHIP_WEIGHTS, estimateShipWeight,

    // aggregation & export
    aggregateByName, aggregateStorefront, summary, exportExcel, exportTcgCsv, buildTransfer, parseTransfer,

    // importing an older save
    parseLegacySave, inspectLegacy, importLegacy
  };
})();
