"use strict";
/* #253: odd spellings of a page URL (/admin.html/, %2F, %2E, /ADMIN.HTML,
   ::$DATA, ADMIN~1.HTM, a backslash...) slipped past the exact-match page
   sign-in gate in server/index.js, and the file lookup then opened the page
   anyway. Fix: one plain spelling per file (httpu.isCanonicalStaticPath),
   checked by the gate AND by serveStatic(), plus serveStatic() refusing a
   file whose on-disk name differs from the requested one. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const httpu = require(path.join(__dirname, "..", "server", "lib", "http"));

// What server/index.js gates on: the WHATWG pathname of the raw request target.
const pathnameOf = (raw) => new URL(raw, "http://localhost").pathname;

/* Each of these resolved to a real page file before #253 (or would on some
   OS), under a name the gate didn't list. */
const ODD = [
  "/admin.html/", "/settings.html/", "/bulk-price.html/", "/welcome.html/", "/index.html/", "/admin.html//",
  "/inventory/bulk-price/", "/js//core.js", "/js/core.js/",
  "/admin.html%2F", "/admin.html%2f", "/admin%2Ehtml", "/admin%2ehtml", "/%61dmin.html", "/bulk%2Dprice.html",
  "/admin.html.", "/admin.html%2E", "/admin.html%20", "/admin.html%00", "/admin.html%5C",
  "/admin.html::$DATA", "/admin.html%3A%3A%24DATA", "/ADMIN~1.HTM", "/admin~1.htm",
  "/admin.html\\", "/.hidden", "/js/.hidden"
];

test("isCanonicalStaticPath: every odd spelling of a page URL is refused", () => {
  for (const raw of ODD) {
    assert.equal(httpu.isCanonicalStaticPath(pathnameOf(raw)), false, raw + " -> " + pathnameOf(raw));
  }
  assert.equal(httpu.isCanonicalStaticPath(""), false);
  assert.equal(httpu.isCanonicalStaticPath("admin.html"), false, "no leading slash");
  assert.equal(httpu.isCanonicalStaticPath(undefined), false);
});

test("isCanonicalStaticPath: the plain page, alias and asset URLs still pass", () => {
  for (const p of ["/", "/index.html", "/admin.html", "/login.html", "/welcome.html", "/inventory/bulk-price",
    "/css/app.css", "/js/core.js", "/js/moversPicks.js", "/icons/icon-192.png", "/sw.js", "/favicon.ico",
    "/manifest.webmanifest", "/fonts/LICENSE-OFL.txt"]) {
    assert.equal(httpu.isCanonicalStaticPath(pathnameOf(p)), true, p);
  }
  // A query string is not part of the pathname the gate sees.
  assert.equal(httpu.isCanonicalStaticPath(pathnameOf("/js/core.js?v=123")), true);
});

test("isCanonicalStaticPath: every file shipped under public/ has a servable name", () => {
  const root = path.join(__dirname, "..", "public");
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const f of walk(root)) {
    const url = "/" + path.relative(root, f).split(path.sep).join("/");
    assert.equal(httpu.isCanonicalStaticPath(url), true, url + " could never be served; rename it");
  }
});

/* serveStatic() on its own, over real HTTP, with no gate in front: it must
   still refuse every alias of a file, so a caller that forgets the gate's
   check can't be tricked into opening a page under another name. */
test("serveStatic: serves a file only under its exact name", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grimoire-static-"));
  fs.mkdirSync(path.join(root, "js"));
  fs.writeFileSync(path.join(root, "admin.html"), "<!doctype html><title>admin</title>");
  fs.writeFileSync(path.join(root, "js", "moversPicks.js"), "// js");
  const server = http.createServer(async (req, res) => {
    const served = await httpu.serveStatic(req, res, root, new URL(req.url, "http://localhost").pathname);
    if (!served) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: p }, (res) => { res.resume(); resolve(res.statusCode); })
      .on("error", reject);
  });

  assert.equal(await get("/admin.html"), 200);
  assert.equal(await get("/js/moversPicks.js"), 200);
  assert.equal(await get("/js/moversPicks.js?v=1"), 200);
  for (const p of ODD.concat(["/ADMIN.HTML", "/Admin.html", "/admin.HTML", "/JS/moversPicks.js", "/js/moverspicks.js"])) {
    assert.notEqual(await get(p), 200, p + " must not be served");
  }
});

/* Wiring in server/index.js: the canonical check runs before the page gate
   reads APP_PAGES, so nothing reaches the gate in an unlisted spelling. */
test("server/index.js refuses non-canonical page URLs before the sign-in gate", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  const section = src.slice(src.indexOf("// --- Pages & assets ---"));
  const check = section.indexOf("httpu.isCanonicalStaticPath(pathname)");
  const gate = section.indexOf("APP_PAGES.has(pathname)");
  assert.ok(check > 0 && gate > 0, "both the check and the gate exist");
  assert.ok(check < gate, "the check comes first");
  assert.match(section.slice(check, gate), /sendError\(res, 404/);
});
