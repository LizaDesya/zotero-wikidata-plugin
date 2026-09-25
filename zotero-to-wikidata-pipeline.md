# Zotero to Wikidata Pipeline

## Current user experience

- In Zotero, only one mega library exists in the active zotero collection: CCRU Wikidata Project
- Organized by writings, events, people, etv, each node will typically get their own subfolder usually
- Collect sources, websites always with snapshots, or publication PDFs
- annotate a potential quotation that would support a wikidata reference
- Manually add annotation tags based on invented schema, not designed for wikidata
- Add a rough commment for either myself or an agent to clean up later
- have an agent look through annotations that ive specified, bridge the gaps and figure out whats missing, we go through manual zotero edits together
- then the agent makes a plan, then compiles all the reference urls, quotes, and converts into Batch Query statements
- One by one, I run the batch statements by the agent's side, often stopping in the middle of each one for refvisions, or folding in references I've added manually
- Once a big bacth is done, I move to the hijinx-world-website repo
- pnpm ccru:crawl --refresh
- see if the nodes made it into the schema, sometimes I need add new edges or accepted items to make it work

Sometimes I start a session with these requests

- I am adding new [specific item] to Wikidata. Look at [specific folder] in zotero and review my annotations, check whats missing
- Compile all the annotations in [specific section] and prepapre batch statement with instructions
- I just made this edit. Check my work through the live query.

## Desired user experience

- When investigating an ID, the agent should easily cross reference the ccru graph's json live on hijinx world, and dev repo version, and live Wikidata,
- agent uses small dynamic scripts that it can use as a foundation for achieving specific tasks
