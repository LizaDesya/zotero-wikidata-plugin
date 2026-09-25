---
name: batch-session
description: Start or resume a Zotero-to-Wikidata QuickStatements session for one Wikidata item. Gathers the annotations carrying a Zotero tag, the item's current statements and the graph's view of it, maps quotes to statements, lists the new items the quotes call for, then writes the qs.ts input and drafts a checked batch. Use when the user says "start a batch/session for <item or tag>", "continue batch <file>", or invokes /batch-session.
argument-hint: <zotero tag, e.g. p:monterre-zelda> | <batch.md to resume>
---

# Batch session

Sandbox workflow for this repo. It is provisional, so change this file when a
session shows a better way. Read `sandbox/docs/prototyping.md` first. It
covers the tools, the `qs.ts` input format and the QuickStatements (QS)
syntax rules this skill relies on.

**Argument:** a Zotero tag (e.g. `p:monterre-zelda`) or a batch file.

- The slug is the tag's part after its last `:` (`monterre-zelda`).
- The input file is `sandbox/statements/<slug>.input.json`.
- Batches are `sandbox/statements/<date>-<slug>.md`.
- If no argument is given, ask for the tag.

Tags are the user's own. Read a co-tag like `p:hurston-zora` or
`org:cthulhu-club` as a hint that the quote also concerns that subject.
Don't treat tags as a vocabulary or map them to properties.

## Hard rules

- Never write to Wikidata, and never edit Zotero unless the user asks. The
  user runs every chunk in QS.
- Never guess a QID or PID. Verify every one with
  `python ~/.claude/skills/wikidata-query/wd.py labels …`, check datatypes
  with `wd.py prop …`, and find items with `wd.py search …`.
- Quotes go in exactly as highlighted. Don't trim, fix or paraphrase them.
  Don't wrap them in quote marks either. `qs.ts` strips marks that wrap the
  whole quote and keeps the original's own curly quotes.
- Stop for the user's confirmation at each **Checkpoint** below.

## 0. Resume or start?

If `sandbox/statements/*-<slug>.md` exists (or a batch file was passed), this
is a resume:

1. Run `node sandbox/scripts/qs.ts next <batch.md>`.
2. Summarise where things stand and wait. When the user says they ran chunk
   n, run `qs.ts mark <batch> n run`, then `qs.ts verify <batch> n`, and
   report what landed and what is extra.
3. For a revision, edit the chunk's `qs` block and keep its provenance
   numbering in step. Then run `mark n revised` and `check <batch> n`.

Otherwise start a new session, as below.

## 1. Gather (read-only, run in parallel)

- **Input file**, if the user started one: the subject QID(s), `goal`,
  `collection`, and any statements already listed.
- **Annotations:** `node sandbox/scripts/zotero.ts tag <tag>` gives a digest
  grouped by source work, with each annotation's text, comment and co-tags.
  Use `--json` later, when writing the input. If Zotero's local API doesn't
  answer, ask the user to start Zotero, or fall back to the Zotero MCP
  (`zotero_search_by_tag` with `item_type="annotation"`, then
  `zotero_get_item_metadata` per key).
- **The item on Wikidata:** `wd.py item <QID>`, which marks statements
  `<unreferenced>`. These unreferenced statements are usually the user's
  baseline waiting for references.
- **The graph:** `node sandbox/scripts/ccru.ts item <QID>` (scope, drawn
  edges, why not drawn) and `ccru.ts find <label>`. A new item is usually
  not in scope yet. Say so early, because nothing it states will draw until
  it gets a seed or a tier in `scripts/ccru/seeds.json` in the hijinx repo.
- **Each source work:** its QID for `S248 stated in`. Look for a `QID:` line
  in Extra (the digest shows it), otherwise `wd.py search "<title>"`. Get its
  URL for `S854`, and run `ccru.ts ref <url>` to see what already cites it.

## 2. Map quotes to statements

Build one table in chat, not a file:

| Statement (existing or proposed) | Supporting annotation(s) | Status |
| -------------------------------- | ------------------------ | ------ |

- Every baseline statement: which quotes support it, or **no quote yet**.
- Every annotation: which statement(s) it supports. One quote can back
  several, e.g. a birth date and a birthplace.
- Proposed new statements the quotes support, with property and value
  verified.
- Quotes that point at something without a Wikidata item (a person, place,
  organisation, school or work). These go into step 3.
- Annotation comments are the user's notes to the agent: follow them.

Suggest reference parts per source: `url`, `statedIn`, and a `title` only
when it names something narrower than the stated-in work (a chapter or web
page).

**Checkpoint:** show the table and agree on what goes in the batch.

## 3. New items the quotes call for

For each one:

1. Rule out an existing item: run `wd.py search` under its name and aliases,
   and `ccru.ts find`.
2. Propose a label, description, `P31`, and the one or two statements that
   identify it, sourced from the same quotes.
3. The user creates it, either by hand or from a separate `CREATE` / `LAST`
   QS block you write in chat. `qs.ts` doesn't handle `CREATE`, so this
   block stays out of the batch file.
4. Once the user reports the QIDs, verify them with `wd.py labels`.

Don't let this block the rest. Statements that don't need new items can be
drafted and run first. Put the ones that do in later chunks, using a
`chunk` name like "needs new items". Draft them only once the QIDs exist.

**Checkpoint:** new items created and verified, or deliberately deferred.

## 4. Write the input and draft

1. Update `sandbox/statements/<slug>.input.json`. Keep the user's `goal` and
   `collection`. Fill in `statements` from the `--json` records:
   - the `zotero` keys `item`, `attachment` and `annotation`
   - the quote text exactly as given
   - the source's `url`, `statedIn` and `title`
   - `retrieved`, which defaults to today
   - optionally a `chunk` name, to keep each paste to about 5–8 lines
     grouped by topic (life, relations, works, …)
2. Run `node sandbox/scripts/qs.ts draft sandbox/statements/<slug>.input.json`.
3. Read every chunk's check section and deal with the warnings:
   - A **reference with the same URL already on the statement** means QS
     would add a second reference. Tell the user.
   - **Quote flagged to check by hand**: ask the user.
   - **Won't draw**: explain why and what the fix in the hijinx repo is.
4. Fix lines in the batch file, then re-run `qs.ts check <batch> <n>`.

**Checkpoint:** hand over the batch file path, and run `qs.ts next` to show
the first chunk. The user pastes each chunk into QS as V1 commands, keeping
the tabs. From here the session continues as a resume (step 0).

## 5. Wrap up

When every chunk is finished:

- Remind the user to run `pnpm ccru:crawl --refresh` in hijinx-world-website,
  then run `ccru.ts item <QID>` to confirm the edges draw.
- Add a dated note to "Notes and lessons" in `sandbox/docs/prototyping.md`
  if the session taught something. Update this skill if a step was wrong or
  missing.
