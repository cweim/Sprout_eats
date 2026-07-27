# Discovery Bot — Project Instructions

## Knowledge Graph First

Before answering any question about the codebase (architecture, data flow, how something works, what calls what, where something is defined, bug investigation, etc.):

1. Check if `graphify-out/graph.json` exists in the project root.
2. If it exists → use the graphify skill to query it: run `/graphify query "<question>"` and answer from the graph output.
3. If it does not exist → answer normally using file reads and searches.

This applies to all codebase questions, not just explicit `/graphify` invocations.
