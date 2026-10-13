---
description: Compress stale context now with DCP
argument-hint: [focus]
---

Compress the conversation's stale, low-value context now by calling the `compress` tool once, following its own instructions for choosing ranges and writing summaries.

Focus (optional): $ARGUMENTS

Report what the tool's result says. If the tool is described as unavailable, or its result says nothing was compressed, tell the user DCP is not active in this session and that restarting Claude Code activates it; do not claim anything was compressed.
