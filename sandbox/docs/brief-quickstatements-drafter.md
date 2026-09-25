# Brief: QuickStatements drafter with batch tracking

A task for an agent working in this repo. It's a prototype: keep it small and
disposable, inside `sandbox/`.

## Read first

1. `CLAUDE.md`: the phase notice at the top, and the "Wikidata domain" section.
2. `sandbox/docs/prototyping.md`: the CCRU graph and the existing tools.
3. `sandbox/docs/zotero-to-wikidata-pipeline.md`: the user's workflow.
4. `sandbox/scripts/ccru.ts`: follow its style. It runs on plain `node`
   (v25 strips types), has no dependencies and sends a User-Agent. Reuse its
   helpers where you can. Moving shared code into a module in
   `sandbox/scripts/` is fine.

## Problem

The user annotates quotes in Zotero, reviews them with an agent, and then has
the agent write QuickStatements (QS) batches freehand. They run the batches
one chunk at a time in the QS web tool, and often stop partway to revise or
to add references by hand. Two things are missing today:

- A repeatable way to turn reviewed annotations into correct QS lines with
  complete references.
- A record of which parts of a batch have run, so work can pause and resume
  across sessions.

## What to build

A script at `sandbox/scripts/qs.ts` with roughly these commands:

- **`draft <input.json>`** reads a list of intended statements and writes a
  batch file.
- **`check <batch>`** checks a batch before the user runs it (see Checks).
- **`verify <batch>`** checks each chunk against live Wikidata and updates its
  status.

The command names and shapes are suggestions. Change them if something
simpler works.

### Input: intended statements

For now the input is a JSON file that the agent fills in from Zotero with the
user. Nothing produces it automatically yet: an "annotation digest" tool is
planned separately. Keep the format minimal and document it. Each entry
should carry:

- the subject QID, property, value, and optional qualifiers
- the source: reference URL, retrieved date, `stated in` QID if the source
  work has one, title, and the quote
- provenance: the Zotero item key and annotation key it came from, which
  never go into the QS text

Don't define a tag vocabulary or a mapping from tags to properties. That is
deliberately undecided.

### Output: the QS lines

Use QS v1 tab-separated syntax. These property datatypes have been verified
on Wikidata:

| Part          | Property | Datatype        | QS form                           |
| ------------- | -------- | --------------- | --------------------------------- |
| reference URL | P854     | url             | `S854` `"https://…"`              |
| stated in     | P248     | wikibase-item   | `S248` `Q…`                       |
| retrieved     | P813     | time            | `S813` `+2026-09-25T00:00:00Z/11` |
| title         | P1476    | monolingualtext | `S1476` `en:"…"`                  |
| quotation     | P1683    | monolingualtext | `S1683` `en:"…"`                  |

- Qualifiers use a `P` prefix. Dates use QS time syntax with the right
  precision (`/9` year, `/10` month, `/11` day).
- Quote text needs cleaning: collapse newlines and tabs, and deal with double
  quotes inside the text, because QS v1 cannot escape them. Flag anything
  that can't be cleaned safely. Don't silently change the quote.
- Check the length limit for monolingual text on Wikidata (believed to be
  1,500 characters) and flag quotes that exceed it.
- Language defaults to `en`. Allow it to be overridden per entry.
- Test the exact syntax against the QS documentation, or against a small run
  the user does. Don't rely on memory.

### Batch file and tracking

Write one file per batch to `sandbox/statements/<YYYY-MM-DD>-<slug>.md`.
Make the statements folder git ignored - these are meant to be messy folders/files that will only be used once and never picked up again.

- A header with the goal, the target items, the Zotero collection it came
  from, and the snapshot `crawledAt` it was checked against.
- Numbered **chunks**, usually one per target item or topic. A chunk is small
  enough to paste into QS and check in one go. Each chunk has:
  - a status: `pending`, `run`, `verified`, `revised`, `skipped` or
    `done-manually`
  - a fenced block of QS lines, ready to paste
  - a provenance list linking each line to its Zotero annotation
  - notes on anything flagged by `check`
- **Resume**: a new session reads the file and continues from the first chunk
  that isn't finished.
- **Revisions**: when the user stops to change something, edit the chunk and
  mark it `revised`. Don't create a new batch.
- **References added by hand**: `verify` should notice statements or
  references on Wikidata that the batch didn't produce, and record them in the
  chunk rather than treating them as errors.
- `verify` compares against live Wikidata, not the graph snapshot, since the
  snapshot lags until the user re-crawls.

## Checks

These are warnings, not blockers. The user decides.

- Every QID and PID exists, and each value matches its property's datatype
  (`wbgetentities`). Never guess an ID. The `wikidata-query` skill helps here.
- The statement is not already on Wikidata. If it is, the line adds a
  reference to it, which QS does automatically, so say so.
- The quote or URL is not already cited: run `node sandbox/scripts/ccru.ts
ref <quote|URL>`.
- The graph will draw it: the subject is in `scope`, the property is in
  `EDGE_PROPERTIES` and the target is cached (`ccru.ts item`). Explain when it
  won't, for example "subject not in scope; needs a seed or a tier".
- Each statement has at least a URL or a `stated in`, and a retrieved date.

## Out of scope

- Writing to Wikidata. The user runs every batch themselves in QS.
- Plugin code (`src/`, `addon/`), a fixed schema or a tag vocabulary.
- Reading Zotero automatically. That's the separate digest tool, and the
  input format is where the two will meet.

## Done when

- `qs.ts` drafts, checks and verifies a small real batch that the user picks,
  one they would actually run.
- The batch file survives a stop partway, a revision, and a resume in a new
  session.
- The input format and the commands are documented in
  `sandbox/docs/prototyping.md`, with a dated note on what the first real use
  taught.
- `npm run lint:check` passes.
