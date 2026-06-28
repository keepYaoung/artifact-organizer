#!/usr/bin/env node
/**
 * publish.mjs — publish an artifact-organizer deck into YOUR own repo's GitHub
 * Pages, under a sub-path. No standalone repos are ever created.
 *
 *   node publish.mjs --store <deck.json> [--repo <owner/name>] [--path <subpath>] [--confirm]
 *
 * Model: every deck deploys into the `gh-pages` branch of one repo (default:
 * <your-gh-user>/artifact-organizer — i.e. your fork), each deck in its own
 * sub-folder. So forking the project just works: your decks land at
 *   https://<you>.github.io/artifact-organizer/<deck>/
 * The target repo must already exist (it's your fork); this never creates one.
 *
 * Idempotent: the first deploy creates the gh-pages branch + enables Pages;
 * later deploys update only that deck's sub-folder, leaving other decks intact.
 *
 * SAFE BY DEFAULT: without --confirm it is a DRY RUN — prints the plan and the
 * git/gh commands it WOULD run, and touches nothing. Publishing is public.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, cpSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

/** Filesystem/repo-safe slug (ascii + Hangul). */
export function slugify(s) {
  return String(s || "deck").toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "") || "deck";
}

const DEFAULT_REPO = "artifact-organizer";
const BRANCH = "gh-pages";

/**
 * Compute a publish plan (pure: reads the filesystem to decide, mutates nothing).
 * Decides the target repo, the sub-path, the local gh-pages working clone, and
 * whether this is the first deploy into that clone or an update.
 */
export function planPublish({ storeAbs, store = {}, htmlAbs, repo, path, includeSources, owner = "<owner>", repoName }) {
  const dir = dirname(storeAbs);
  const baseName = basename(storeAbs).replace(/\.json$/i, "");
  const sourcesDir = join(dir, `${baseName}-sources`);
  const recorded = (store.meta && store.meta.publish) || {};

  // Target repo: --repo "owner/name" | "name" overrides; else recorded; else default.
  if (repo && repo.includes("/")) { const [o, n] = repo.split("/"); owner = o || owner; repoName = n; }
  else if (repo) { repoName = repo; }
  repoName = repoName || recorded.repoName || DEFAULT_REPO;
  if (!recorded.repoName && recorded.owner) owner = owner; // keep resolved owner

  const subpath = slugify(path || recorded.subpath || baseName);
  // One local working clone of the repo's gh-pages branch, shared across decks.
  const pagesDir = join(dir, `.pages-${repoName}`);
  const hasClone = existsSync(join(pagesDir, ".git"));

  const ownerLc = owner.toLowerCase();
  const url = `https://${ownerLc}.github.io/${repoName}/${subpath}/`;
  const mode = hasClone ? "update" : "deploy";
  const commitMsg = `Publish ${subpath}`;
  const withSources = !!includeSources && existsSync(sourcesDir);

  const commands = [
    mode === "deploy"
      ? `git clone (gh-pages of ${owner}/${repoName}) → ${basename(pagesDir)}/`
      : `git -C ${basename(pagesDir)} fetch && reset --hard origin/${BRANCH}`,
    `cp ${basename(htmlAbs)} → ${subpath}/index.html` + (withSources ? ` (+ ${subpath}/sources/)` : ""),
    `git add -A && commit -m "${commitMsg}" && push origin ${BRANCH}`,
    `gh api -X POST repos/${owner}/${repoName}/pages -f "source[branch]=${BRANCH}" -f "source[path]=/"  (first deploy only)`,
  ];

  return { baseName, owner, repoName, repo: `${owner}/${repoName}`, branch: BRANCH, subpath, pagesDir, sourcesDir, htmlAbs, includeSources: withSources, url, mode, commitMsg, commands };
}

/**
 * Lay out the deck inside the gh-pages working clone: <pagesDir>/<subpath>/index.html
 * (+ /sources). Replaces only this deck's sub-folder. Returns written paths.
 */
export function buildSite(plan) {
  const destDir = join(plan.pagesDir, plan.subpath);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const written = [join(destDir, "index.html")];
  copyFileSync(plan.htmlAbs, join(destDir, "index.html"));
  if (plan.includeSources) {
    cpSync(plan.sourcesDir, join(destDir, "sources"), { recursive: true });
    written.push(join(destDir, "sources") + "/");
  }
  return written;
}

function run(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function tryRun(file, args, opts = {}) {
  try { return { ok: true, out: run(file, args, opts) }; }
  catch (e) { return { ok: false, err: String(e.stderr || e.message || "").trim(), code: e.status }; }
}

function parseArgs(argv) {
  const a = { store: null, repo: null, path: null, html: null, includeSources: false, confirm: false, dryRun: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--store": a.store = argv[++i]; break;
      case "--repo": a.repo = argv[++i]; break;
      case "--path": a.path = argv[++i]; break;
      case "--html": a.html = argv[++i]; break;
      case "--include-sources": a.includeSources = true; break;
      case "--confirm": a.confirm = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--quiet": a.quiet = true; break;
      case "--help":
        console.log(`Usage: publish --store <deck.json> [options]

Deploy a rendered deck into YOUR repo's GitHub Pages, under a sub-path.
No standalone repo is created — it publishes into your own (forked) repo.
SAFE BY DEFAULT: prints the plan and runs nothing unless --confirm is given.

Options:
  --store <path>        The deck store JSON (its <name>.html must already exist) [required]
  --repo <owner/name>   Target repo (default: <your-gh-user>/artifact-organizer)
  --path <subpath>      Sub-path under the repo (default: the deck's slug)
  --include-sources     Also publish the kept originals (→ <subpath>/sources)
  --confirm             Actually publish (push gh-pages / enable Pages). Omit = dry run.
  --dry-run             Force a dry run even with --confirm
  --html <path>         Deck HTML to publish (default: <store>.html)
  --quiet               Only print the final URL`);
        process.exit(0);
    }
  }
  return a;
}

function printPlan(plan, { dryRun }) {
  const lines = [
    `${dryRun ? "DRY RUN — nothing will change." : "Publishing…"}`,
    ``,
    `  repo        ${plan.repo}  (branch: ${plan.branch})`,
    `  sub-path    /${plan.subpath}/` + (plan.includeSources ? "  (+ sources)" : ""),
    `  mode        ${plan.mode === "deploy" ? "first deploy (create gh-pages + enable Pages)" : "update this deck's sub-folder"}`,
    `  URL         ${plan.url}`,
    ``,
    `  commands ${dryRun ? "that WOULD run" : ""}:`,
    ...plan.commands.map(c => `    $ ${c}`),
  ];
  if (dryRun) lines.push(``, `  Re-run with --confirm to publish.`);
  console.error(lines.join("\n"));
}

/** Prepare a local working clone of the repo's gh-pages branch (orphan if new). */
function preparePagesClone(plan) {
  const dir = plan.pagesDir, cwd = { cwd: dir };
  const repoUrl = `https://github.com/${plan.owner}/${plan.repoName}.git`;
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    run("git", ["init", "-b", plan.branch], cwd);
    run("git", ["remote", "add", "origin", repoUrl], cwd);
  }
  tryRun("git", ["fetch", "origin", plan.branch, "--depth", "1"], cwd);
  if (tryRun("git", ["rev-parse", "--verify", `origin/${plan.branch}`], cwd).ok) {
    run("git", ["checkout", "-B", plan.branch, `origin/${plan.branch}`], cwd);
    run("git", ["reset", "--hard", `origin/${plan.branch}`], cwd);
  } else {
    // No gh-pages yet → start an empty orphan branch.
    tryRun("git", ["checkout", "--orphan", plan.branch], cwd);
    tryRun("git", ["rm", "-rf", "--cached", "."], cwd);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.store) { console.error("Missing --store <deck.json>"); process.exit(2); }

  const storeAbs = resolve(args.store);
  if (!existsSync(storeAbs)) { console.error(`Store not found: ${storeAbs}`); process.exit(2); }
  const store = JSON.parse(readFileSync(storeAbs, "utf8"));

  const htmlAbs = resolve(args.html || storeAbs.replace(/\.json$/i, "") + ".html");
  if (!existsSync(htmlAbs)) {
    console.error(`Rendered deck not found: ${htmlAbs}\nRender it first (organize.mjs / render.mjs), then publish.`);
    process.exit(2);
  }

  const dryRun = args.dryRun || !args.confirm;

  // Resolve the GitHub owner. Only touch gh when actually publishing.
  let owner = (store.meta && store.meta.publish && store.meta.publish.owner) || "<owner>";
  if (!dryRun) {
    if (!tryRun("gh", ["--version"]).ok) { console.error("gh CLI not found. Install it (https://cli.github.com) or publish manually."); process.exit(5); }
    if (!tryRun("gh", ["auth", "status"]).ok) { console.error("gh is not authenticated. Run: gh auth login"); process.exit(5); }
    const who = tryRun("gh", ["api", "user", "--jq", ".login"]);
    if (!who.ok) { console.error(`Could not resolve your GitHub user: ${who.err}`); process.exit(5); }
    owner = who.out;
  }

  const plan = planPublish({ storeAbs, store, htmlAbs, repo: args.repo, path: args.path, includeSources: args.includeSources, owner });

  if (dryRun) { printPlan(plan, { dryRun: true }); process.exit(0); }
  if (!args.quiet) printPlan(plan, { dryRun: false });

  // Target repo must exist (it's your fork). Never create one here.
  if (!tryRun("gh", ["repo", "view", plan.repo], {}).ok) {
    console.error(`Target repo ${plan.repo} not found.\nFork keepYaoung/artifact-organizer (or create ${plan.repo}), then re-run — or pass --repo <owner/name>.`);
    process.exit(5);
  }

  try {
    preparePagesClone(plan);
    buildSite(plan);
    const cwd = { cwd: plan.pagesDir };
    run("git", ["add", "-A"], cwd);
    const dirty = run("git", ["status", "--porcelain"], cwd);
    if (dirty) {
      run("git", ["commit", "-m", plan.commitMsg], cwd);
      run("git", ["push", "-u", "origin", plan.branch], cwd);
    } else if (!args.quiet) {
      console.error("  (no changes to push)");
    }
    // Enable Pages (first deploy). Tolerate "already enabled".
    const pg = tryRun("gh", ["api", "-X", "POST", `repos/${plan.owner}/${plan.repoName}/pages`, "-f", `source[branch]=${plan.branch}`, "-f", "source[path]=/"]);
    if (!pg.ok && !/already|409|exists/i.test(pg.err)) {
      console.error(`Note: enabling Pages reported: ${pg.err}\nIf needed, set Settings → Pages → branch ${plan.branch} / root.`);
    }
  } catch (e) {
    console.error(`Publish failed: ${String(e.stderr || e.message).trim()}`);
    process.exit(6);
  }

  // Record the live URL + target on the store.
  store.meta = store.meta || {};
  store.meta.publish = { owner, repoName: plan.repoName, repo: plan.repo, branch: plan.branch, subpath: plan.subpath, url: plan.url, includeSources: plan.includeSources };
  try { writeFileSync(storeAbs, JSON.stringify(store, null, 2) + "\n", "utf8"); } catch (e) { console.error(`Could not record URL on store: ${e.message}`); }

  if (args.quiet) console.log(plan.url);
  else console.error(`\n✓ Live at ${plan.url}  (Pages can take ~1 min on first deploy)`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
