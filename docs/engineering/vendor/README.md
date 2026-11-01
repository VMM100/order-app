# Outside guidance (read-only)

Text written by others that AI assistants on this project read as reference. Nothing here is installed or
run: only Markdown was copied, at a fixed version, and every file is fingerprinted in its folder's
MANIFEST.sha256. Sources, versions and licences are listed in vendor/SOURCES.md.

Wasabi's own documents always win: CLAUDE.md, DESIGN.md (look, words, touch sizes) and docs/security/.
Use these as checklists and second opinions, never as a reason to change the Wasabi look or voice.

| Folder | Use it for |
| --- | --- |
| agent-skills/ | Before a release or launch: security hardening, shipping, performance, code review |
| impeccable/ | UI review and polish of a screen (audit, critique, polish, clarify, harden, layout, typeset). Its SKILL.md asks to run a "launcher" (scripts/impeccable): it was **not** copied and must never be fetched or run. Follow its "Launcher unavailable" path: read DESIGN.md directly. |
| design-md/ | Google's DESIGN.md format (tokens plus rules). Reference for keeping our DESIGN.md in a form any design tool can read. The CLI linter was not copied. |
| stop-slop/ | Checking prose (marketing copy, emails, docs) for AI-sounding patterns. Its absolute rules (no adverbs, no passive voice, no em dashes) are guidance; for app screens DESIGN.md's word rules decide. |
| humanizer/ | Same job as stop-slop, more thorough (26 patterns from Wikipedia's "Signs of AI writing"). Edits for readers, not to fool AI detectors. |
