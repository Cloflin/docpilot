#!/usr/bin/env node
/**
 * Cuts one release's section out of CHANGELOG.md so the GitHub release for a
 * tag says what that npm version actually changed.
 *
 *   node scripts/changelog-section.js            # the version in package.json
 *   node scripts/changelog-section.js 1.0.0      # a specific one
 *   node scripts/changelog-section.js v1.0.0     # tag names work too
 *
 * REPOSITORY-INTERNAL, and deliberately not shipped: `package.json#files` does
 * not list `scripts/`. This is release plumbing, not a consumer artifact.
 *
 * WHAT IT IS FOR. `.github/workflows/publish.yml` fires on a `v*` tag and, until
 * this existed, published to npm and stopped there — the GitHub release page was
 * either absent or a bare tag with no body, so the only record of what a version
 * contains lived in CHANGELOG.md and nowhere a reader of the releases page would
 * look. The workflow now pipes this script's stdout into `gh release create
 * --notes-file`, which makes the changelog the single source and keeps the two
 * from drifting: there is no second place to forget to update.
 *
 * WHAT COUNTS AS A SECTION. Everything after the `## x.y.z` heading up to the
 * next `## ` heading, trailing blank lines trimmed. The heading line itself is
 * dropped — GitHub renders it as the release title, and repeating it inside the
 * body reads as a duplicate. `## Unreleased` and any other non-version `##`
 * heading terminates a section but is never itself selectable.
 *
 * FAILURE IS LOUD. A missing file, an unparseable version, an absent heading and
 * an empty body all exit 1 with a message on stderr and nothing on stdout, so a
 * shell redirect writes an empty notes file and `gh` is never reached. That is
 * the point: a release whose notes silently came out blank is worse than a
 * workflow that stops and says which heading it wanted.
 *
 * SIZE. GitHub caps a release body at 125 000 characters. A section over that is
 * truncated at a paragraph boundary and gains a pointer to CHANGELOG.md rather
 * than being rejected by the API mid-publish, after npm already has the tarball.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const abs = (rel) => path.join(root, rel)

/** GitHub's documented ceiling for a release body. */
const BODY_LIMIT = 125_000

const die = (message, fix) => {
  console.error(`[docpilot] ${message}`)
  if (fix) console.error(`[docpilot]        fix: ${fix}`)
  process.exit(1)
}

const raw = process.argv[2]
let version
if (raw) {
  version = raw.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    die(`"${raw}" is not a version`, 'pass a version like 1.0.0, a tag like v1.0.0, or nothing at all')
  }
} else {
  try {
    version = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8')).version
  } catch (error) {
    die(`cannot read package.json: ${error.message}`)
  }
}

let changelog
try {
  changelog = fs.readFileSync(abs('CHANGELOG.md'), 'utf8')
} catch (error) {
  die(`cannot read CHANGELOG.md: ${error.message}`, 'write CHANGELOG.md with a `## x.y.z — YYYY-MM-DD` heading for this release')
}

const lines = changelog.split(/\r?\n/)
// A heading is a section boundary whatever it says; only a version heading opens
// the section we want, so `## Unreleased` above a release still ends the one
// above it without ever being returned itself.
const isHeading = (line) => /^##\s+/.test(line)
const opens = (line) => line.match(/^##\s+(\d+\.\d+\.\d+)/)?.[1] === version

const start = lines.findIndex(opens)
if (start === -1) {
  const seen = lines.map((l) => l.match(/^##\s+(\d+\.\d+\.\d+)/)?.[1]).filter(Boolean)
  die(
    `CHANGELOG.md has no "## ${version}" heading`,
    seen.length
      ? `add one, or pick a version it does have: ${seen.slice(0, 8).join(', ')}`
      : `add a heading of the form "## ${version} — YYYY-MM-DD"`,
  )
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (isHeading(lines[i])) {
    end = i
    break
  }
}

let body = lines.slice(start + 1, end).join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '')
if (!body) {
  die(
    `CHANGELOG.md's "## ${version}" section is empty`,
    'write what the release changed under that heading',
  )
}

if (body.length > BODY_LIMIT) {
  const pointer = `\n\n_Truncated — the full entry is in [CHANGELOG.md](https://github.com/Cloflin/docpilot/blob/v${version}/CHANGELOG.md)._`
  const room = BODY_LIMIT - pointer.length
  // Cut at a paragraph break so the body never ends mid-sentence or, worse, in
  // the middle of an unterminated fenced code block.
  const cut = body.lastIndexOf('\n\n', room)
  body = body.slice(0, cut > 0 ? cut : room) + pointer
}

process.stdout.write(`${body}\n`)
