# Prototyping reference

The working reference for the experimental phase. Everything here is
provisional. It records what we're trying, not decisions. When a tool or
convention has proven itself in real sessions, it becomes a candidate for the
formal plugin.

## Layout

- `sandbox/docs/`: this file and
  [zotero-to-wikidata-pipeline.md](zotero-to-wikidata-pipeline.md), which
  describes the current workflow and the one we want.
- `sandbox/scripts/`: small read-only tools for agent sessions. They run with
  plain `node` (v25 strips TypeScript types) and need no dependencies.

## The workflow in one line

Zotero annotations (quotes on snapshots and PDFs) → reviewed with an agent →
QuickStatements batches with references → run by the user → re-crawled into
the CCRU graph on hijinx.world.

## The CCRU graph (hijinx-world-website)

The graph sets the target shape: an edit only matters once the graph can
draw it. Read the graph's schema before inventing one here.

- Sibling repo: `../hijinx-world-website` (override with `HIJINX_REPO`).
- The schema is `src/components/ccru-graph/schema.ts`. It holds
  `EDGE_PROPERTIES` (drawn PIDs, `invert`, `via` bridges, `coreOnly`,
  `enabled`), `NODE_CLASSES` (P31 to class, first match wins) and the date
  properties. Read this file rather than copying it.
- The snapshot is `public/interactive/2026-ccru-graph/graph.json` in the repo
  and https://hijinx.world/interactive/2026-ccru-graph/graph.json live.
  Its shape is described in `src/components/ccru-graph/types.ts`. References
  keep `url` (P854), `statedIn` (P248), `title` (P1476) and `quotations`
  (P1683). Those last ones are the annotation quotes.
- Only items in `scope` emit edges. The scope is the SPARQL tiers in
  `scripts/ccru/seeds.json` plus its hand-kept seeds. A statement drawn from
  an out-of-scope item, or pointing at an uncached target, is silently not
  drawn. `coreOnly` properties only draw from root plus the tier-1 roster.
- Refresh with `pnpm ccru:crawl --refresh` in that repo. It is the user's
  step to run.

## Tools

### `sandbox/scripts/ccru.ts`

A read-only CLI over the graph. It imports `schema.ts` from the hijinx repo,
so its edge rules match the site's.

```sh
node sandbox/scripts/ccru.ts status        # repo vs live snapshot drift
node sandbox/scripts/ccru.ts find <text>   # label search, marks scope/pruned/label-only
node sandbox/scripts/ccru.ts item <QID>    # class, scope, drawn edges + refs, why not drawn
node sandbox/scripts/ccru.ts wd <QID>      # snapshot vs live Wikidata, incl. incoming (SPARQL)
node sandbox/scripts/ccru.ts ref <text|URL|QID>  # every statement citing a quote, URL or source
```

Add `--live` to read the published JSON. Use `wd` after an edit to see
whether it reached Wikidata and whether a re-crawl is needed. Use `ref` before
drafting a statement from an annotation, to check whether that quote or URL is
already cited. It ignores differences in quote marks, spacing and URL scheme.
A QID lists everything whose reference says "stated in" that source.

### `sandbox/scripts/qs.ts`

Drafts QuickStatements batches from reviewed annotations and tracks which
chunks have run. It never writes to Wikidata. Shared helpers (snapshot,
schema, `wbgetentities`, citation search) live in `sandbox/scripts/lib.ts`,
which `ccru.ts` uses too.

```sh
node sandbox/scripts/qs.ts draft <input.json>      # write sandbox/statements/<date>-<slug>.md
node sandbox/scripts/qs.ts check <batch.md> [n]    # warnings per line, before running
node sandbox/scripts/qs.ts verify <batch.md> [n]   # compare with live Wikidata, update status
node sandbox/scripts/qs.ts next <batch.md>         # progress, and the first unfinished chunk
node sandbox/scripts/qs.ts mark <batch.md> <n> <status> [note]
```

`sandbox/statements/` is git-ignored: batches and their input files are
one-off working files. Put the input JSON next to the batch.

**Input.** The agent writes it from Zotero with the user. Nothing produces it
automatically yet: the planned annotation digest tool will. There is no tag
vocabulary. Each entry says what to state, and nothing maps tags to
properties.

```jsonc
{
  "goal": "Parisi membership refs", // batch title; slug comes from it unless "slug" is set
  "collection": "CCRU Wikidata Project / People / Luciana Parisi",
  "retrieved": "2026-09-25", // default S813 date (default: today)
  "lang": "en", // default language for titles and quotes
  "statements": [
    {
      "chunk": "Parisi", // optional; defaults to one chunk per subject
      "subject": "Q112500788",
      "property": "P463",
      "value": "Q24942459", // QID, or a plain value formatted by the property's datatype
      "qualifiers": { "P580": "1995" }, // value or array of values
      "source": {
        // or "sources": [ ... ] for several references (one line each)
        "url": "https://…",
        "statedIn": "Q…",
        "title": "…",
        "quote": "…", // or an array
        "retrieved": "2026-09-25",
        "lang": "en",
      },
      "lang": "en",
      "zotero": { "item": "KEY", "attachment": "KEY", "annotation": "KEY" },
      "note": "free text, shown under the provenance line",
    },
  ],
}
```

Plain values follow the property's datatype, looked up live: dates as
`YYYY`, `YYYY-MM` or `YYYY-MM-DD` (QS precision `/9`, `/10`, `/11`),
strings and URLs quoted, monolingual text as `lang:"…"`. The `"…"` is QS
syntax and isn't saved. Quotations go on Wikidata without enclosing quote
marks, so `draft` strips a pair that wraps the whole quote (`"…"`, `“…”`,
`'…'`, `‘…’`, `«…»`) and notes it under the line's provenance. Quote marks
that belong to the original text stay, curly ones included. A quote like
`“Hyperstition” and “Lemurian time”` starts and ends with quote marks
without being wrapped. When the same marks also appear inside, `draft`
leaves the text alone and flags it to check by hand. `check` warns about a
quote still wrapped, or ambiguous, after a revision by hand. Zotero keys never
enter the QS text. They go in the provenance list, with `zotero://` links.

**Batch file.** A header (goal, targets, collection, snapshot `crawledAt`,
input path), then `## Chunk n: …` sections, each with `Status:`, a fenced
`qs` block ready to paste, a provenance list numbered by line, generated
`<!-- check -->` and `<!-- verify -->` sections, and a `Log:` list. Anything
outside the generated sections is yours to edit, and the script only rewrites
the status line, those sections and the log.

- Statuses: `pending`, `run`, `verified`, `revised`, `skipped`,
  `done-manually`. A session resumes at the first chunk that is not
  `verified`, `skipped` or `done-manually` (`next`).
- To revise, edit the chunk's `qs` block, keep its provenance numbering in
  step, `mark <n> revised`, then `check <n>`. Don't draft a new batch.
- `verify` reads live Wikidata, not the snapshot. It moves `pending` to `run`
  when some lines are there, and moves `pending`, `run` or `revised` to
  `verified` when every line, qualifier and reference is there. It never
  moves a chunk back. A reference that also holds a source its line didn't
  name reports as "merged with another source in one reference", which is a
  failure, not a pass. It records references and statements the batch didn't
  write. Those not in the snapshot either are flagged as probably added by
  hand. Older ones are just counted.
- Keep the tabs. An editor that turns them into spaces breaks the lines, and
  `check` says so. VS Code's Q# extension claims `.qs` files and its
  format-on-save flattened them onto one line, so `.vscode/settings.json`
  maps `sandbox/statements/*.qs` to plain text. (`sandbox/statements` is
  also in `.prettierignore`, for the batch `.md` files.)

**Checks** (warnings only): IDs exist and aren't redirects, values match
their property's datatype, text length (1,500 limit), quote hazards (see
below), each reference has a URL or `stated in` plus a retrieved date, the
statement already on Wikidata (QS then adds the reference to it, and a
reference with the same URL would become a second one), the URL or quote
already cited in the snapshot, and whether the graph will draw it, with the
reason if not.

**QS syntax, as verified 2026-09-25** against the help page and both
parsers' source (QS 2 `quickstatements.php`, QS 3.0
`core/parsers/base.py`, `v1.py`):

- `S854 "url"`, `S248 Q…`, `S813 +2026-09-25T00:00:00Z/11`,
  `S1476 en:"…"`, `S1683 en:"…"`. Qualifiers use `P`. The help page says
  `!S` starts a new reference group, but in practice (2026-09-25) QS saved
  it into the same reference as the first. So `draft` writes each further
  reference as a repeated statement line, and `check` warns about `!S`.
- Both parsers read string values greedily (`^"(.*)"$`), so straight double
  quotes inside a quote survive. There is no escape, and QS 3.0 only guards
  `|` inside quotes that pair up. `check` warns rather than altering the text.
- QS 3.0 replaces curly `“ ”` with straight quotes before parsing, so a
  quote saved through it changes silently. QS 2 keeps them. `verify` reports
  a saved value that differs only in quote marks or spacing.
- `/* … */` at the end of a line becomes the edit summary.
- Wikidata limits strings, URLs and monolingual text to 1,500 characters
  (`wmgWikibaseStringLimits` in wmf-config).

### `sandbox/scripts/zotero.ts`

A minimal, read-only annotation digest over Zotero's local API
(`localhost:23119`). It needs Zotero running with "Allow other applications
on this computer to communicate with Zotero" turned on. One request fetches
every annotation carrying a tag. The script groups them by source work and
shows each annotation's key, text, comment, co-tags, and the source's URL
and `QID:` line from Extra.

```sh
node sandbox/scripts/zotero.ts tag p:monterre-zelda          # readable digest
node sandbox/scripts/zotero.ts tag p:monterre-zelda --json   # records for a qs.ts input
```

The local API ignores `itemKey`, so the script fetches parent items one at a
time. This is a first cut of the planned annotation digest, not its design.

### `/batch-session` skill

`.claude/skills/batch-session/SKILL.md` starts or resumes a session for one
item, from a Zotero tag (`/batch-session p:monterre-zelda`) or a batch file.
It works in four steps:

1. Gather the annotations, the item's live statements and the graph's view
   of the item.
2. Map quotes to statements, then check with the user.
3. Deal with any new items the quotes need, then check with the user.
4. Write the input and draft, then hand the batch over.

A resume runs `qs.ts next`, `mark` and `verify`.

### Also available in agent sessions

- **Zotero MCP**: collections, items, annotations, tags and item edits.
- **`wikidata-query` skill**: verifying QIDs and PIDs, summarising an item's
  statements, running SPARQL, checking constraint violations.

## Notes and lessons

Add dated entries as sessions teach us something.

- 2026-09-25: Wikidata's API refuses `maxlag` requests while the query
  service lags, and the lag can last minutes. Leave `maxlag` off one-off
  reads. It belongs on writes and bulk jobs.
- 2026-09-25: Built `qs.ts` and tested it on a throwaway batch against live
  Wikidata (draft, check, mark, a revision, verify, resume). Its first real
  batch hasn't been run yet, so add that lesson here when it happens. So far:
  the QS syntax rules had to come from the parsers' source, because the help
  page doesn't cover quotes inside V1 strings. `wbgetentities` fails the whole
  request if one ID doesn't exist, so `lib.ts` drops that ID and retries. A
  statement that already exists with the same reference URL gets a second
  reference from QS, not a merged one, and `check` now warns about it.
- 2026-09-25, first real batch (Madame Centauri, `p:monterre-zelda`): a line
  with two `!S` reference groups was saved as one reference holding both
  `stated in` values and both quotes, and `verify` passed it, because each
  part was present. Reading the parsers' source didn't predict this, so trust
  the saved result over the syntax docs. `verify` now flags a reference that
  holds a source its group didn't name, and `draft` writes one line per
  reference. Confirmed in use: a repeated line added a separate reference. The Q# VS Code extension also claims `.qs` files and flattened
  them on save. `wd.py` caches responses for a day, so after an edit it
  showed the item as it was before. Check edits with `qs.ts verify`, or pass
  `wd.py --refresh`.

## Candidates for the plugin

Tools or conventions that have held up across several sessions. Empty until
something earns a place.
