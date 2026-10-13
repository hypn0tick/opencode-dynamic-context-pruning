import { start } from "./loader"
import { guard } from "./selfclean"

// Bundled to dist/claude/claude-loader.mjs and loaded as a Bun preload. Errors are
// swallowed so a broken loader leaves Claude Code working.
try {
    if (guard() === "start") start()
} catch {}
