# v0.1.3 - current
- implemented [phase-2](.planning/0.1.3/phase-2.md) — shadow retrieval operations (getRecentChunks, getMostAccessedChunks, getImportantChunks)
- implemented [phase-3](.planning/0.1.3/phase-3.md) — clip shadow chunk text at 200 chars, inject top-5 chunks into system prompt, overhaul tool descriptions
- implemented [phase-4](.planning/0.1.3/phase-4.md) — concept dedup on store/merge, UNIQUE(name) constraint, unlink_concept tool, migration for existing DBs
- hotfix debugging to make the plugin work with opencode
- implemented [phase-5](.planning/0.1.3/phase-5.md) — fix default limit (args.limit ?? 5 guard) and older_than date format (normalize T → space before SQL comparison)

# v0.0.2
- implemented [phase-0](.planning/0.0.2/plase-0.md)
- packages are ready for npm publish
- github workflows are functional

# v0.0.1
- implemented [phase-1](.planning/0.0.1/phase-1.md)
- implemented [phase-0](.planning/0.0.1/phase-0.md)
