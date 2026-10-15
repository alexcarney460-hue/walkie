---
name: telegram-web
description: Use the person's web messaging session for a requested conversation.
uses: [browser_open, browser_read, browser_click, browser_type, browser_confirm_plan]
---

## Procedure

Open the web app only for the person's request and within the machine's browser policy. If access is denied or a login is missing, stop and explain it. Use a fresh page snapshot to locate the requested conversation. Check its name and context before composing.

Present the exact draft to the person. Queue any compose and send steps, show the plan with `browser_confirm_plan`, and wait for their direct confirmation. Verify the result in the chat after execution. If execution is uncertain, inspect the chat before any retry so a message is not duplicated.

Automation of this web app may break its terms. The person decides whether to use it. Keep unrelated conversations private.
