import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { slugify, planPublish, buildSite } from "../plugins/artifact-organizer/scripts/publish.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/artifact-organizer/scripts/publish.mjs", import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ao-publish-"));
  writeFileSync(join(dir, "a-doc.json"), JSON.stringify({ template: "canvas", meta: { title: "My Deck" } }));
  writeFileSync(join(dir, "a-doc.html"), "<!doctype html><title>My Deck</title><h1>deck</h1>");
  return dir;
}

test("slugify: ascii + Hangul kept, rest collapsed", () => {
  assert.equal(slugify("March Growth!"), "march-growth");
  assert.equal(slugify("분기 리포트 Q2"), "분기-리포트-q2");
  assert.equal(slugify("///"), "deck");
});

test("planPublish: default target is <owner>/artifact-organizer at /<slug>/", () => {
  const dir = fixture();
  const plan = planPublish({ storeAbs: join(dir, "a-doc.json"), store: {}, htmlAbs: join(dir, "a-doc.html"), owner: "alice" });
  assert.equal(plan.repo, "alice/artifact-organizer");
  assert.equal(plan.branch, "gh-pages");
  assert.equal(plan.subpath, "a-doc");
  assert.equal(plan.url, "https://alice.github.io/artifact-organizer/a-doc/");
  assert.equal(plan.mode, "deploy"); // no local clone yet
});

test("planPublish: never produces a 'gh repo create' command (no standalone repos)", () => {
  const dir = fixture();
  const plan = planPublish({ storeAbs: join(dir, "a-doc.json"), store: {}, htmlAbs: join(dir, "a-doc.html"), owner: "alice" });
  assert.ok(!plan.commands.some(c => /gh repo create/.test(c)), "must not create a standalone repo");
  assert.ok(plan.commands.some(c => /gh-pages/.test(c)));
});

test("planPublish: --repo owner/name + --path override; owner lowercased in URL", () => {
  const dir = fixture();
  const plan = planPublish({ storeAbs: join(dir, "a-doc.json"), store: {}, htmlAbs: join(dir, "a-doc.html"), owner: "ignored", repo: "Self-made-Orange/artifact-organizer", path: "Cool Report" });
  assert.equal(plan.repo, "Self-made-Orange/artifact-organizer");
  assert.equal(plan.subpath, "cool-report");
  assert.equal(plan.url, "https://self-made-orange.github.io/artifact-organizer/cool-report/");
});

test("planPublish: recorded publish reuses repo + subpath", () => {
  const dir = fixture();
  const store = { meta: { publish: { owner: "alice", repoName: "artifact-organizer", subpath: "a-doc" } } };
  const plan = planPublish({ storeAbs: join(dir, "a-doc.json"), store, htmlAbs: join(dir, "a-doc.html"), owner: "alice" });
  assert.equal(plan.subpath, "a-doc");
  assert.equal(plan.repo, "alice/artifact-organizer");
});

test("buildSite: lays the deck into <pagesDir>/<subpath>/index.html (+ sources)", () => {
  const dir = fixture();
  mkdirSync(join(dir, "a-doc-sources"));
  writeFileSync(join(dir, "a-doc-sources", "orig.html"), "<h1>original</h1>");
  const plan = planPublish({ storeAbs: join(dir, "a-doc.json"), store: {}, htmlAbs: join(dir, "a-doc.html"), owner: "alice", includeSources: true });
  mkdirSync(plan.pagesDir, { recursive: true });
  buildSite(plan);
  assert.ok(existsSync(join(plan.pagesDir, "a-doc", "index.html")));
  assert.match(readFileSync(join(plan.pagesDir, "a-doc", "index.html"), "utf8"), /<h1>deck<\/h1>/);
  assert.ok(existsSync(join(plan.pagesDir, "a-doc", "sources", "orig.html")));
});

test("buildSite: replaces only this deck's sub-folder, leaving siblings intact", () => {
  const dir = fixture();
  const plan = planPublish({ storeAbs: join(dir, "a-doc.json"), store: {}, htmlAbs: join(dir, "a-doc.html"), owner: "alice" });
  mkdirSync(join(plan.pagesDir, "other-deck"), { recursive: true });
  writeFileSync(join(plan.pagesDir, "other-deck", "index.html"), "sibling");
  buildSite(plan);
  assert.ok(existsSync(join(plan.pagesDir, "other-deck", "index.html")), "sibling deck must survive");
  assert.ok(existsSync(join(plan.pagesDir, "a-doc", "index.html")));
});

test("CLI dry-run is the default and has NO side effects (no pages clone, no git/gh)", () => {
  const dir = fixture();
  const out = execFileSync("node", [SCRIPT, "--store", join(dir, "a-doc.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(existsSync(join(dir, ".pages-artifact-organizer")), false);
  assert.deepEqual(readdirSync(dir).sort(), ["a-doc.html", "a-doc.json"]);
  assert.equal(out, "");
});

test("CLI: missing rendered deck html → clear error, exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "ao-publish-"));
  writeFileSync(join(dir, "a-doc.json"), JSON.stringify({ template: "canvas", meta: {} }));
  let code = 0, stderr = "";
  try { execFileSync("node", [SCRIPT, "--store", join(dir, "a-doc.json"), "--confirm"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 2);
  assert.match(stderr, /Render it first|not found/);
});
