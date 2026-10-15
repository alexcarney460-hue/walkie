---
name: skill-creation
description: Help the person draft a reusable skill for later review.
uses: [walkie_skill, walkie_skill_draft]
---

## Procedure

Ask what repeated task the skill should guide, which tools it needs, and what a successful run proves. Draft a concise `SKILL.md` with one-line name and description, a `uses` list of existing Sqwakie tool names, and specific steps with failure handling. Check the named tools exist. A skill changes guidance only; it grants no access.

Show the proposed text to the person. Use `walkie_skill_draft` only when they ask to save it. That tool requests their direct confirmation before placing the file in the local drafts directory. A draft is never loaded by Talkie. Do not present it as an installed skill or invoke instructions from it.
