---
name: whatsapp-web
description: Use the person's web messaging session for a requested conversation.
uses: [browser_open, browser_read, browser_click, browser_type, browser_confirm_plan]
---

## Procedure

Open the web app only when the person requests it and the machine's browser policy permits it. If the app is denied or needs a login, report the block; do not seek another session. Read the chat title and recent context before composing. Re-read to verify the recipient and current conversation after every navigation.

Draft the exact message for the person to inspect. Sending is a browser write: queue the steps and call `browser_confirm_plan`. Wait for the person's direct confirmation and retry only that confirmed plan. Afterward read the conversation to verify the message appeared; if the outcome is uncertain, report uncertainty without sending it again.

Automation of this web app may break its terms. The person decides whether to use it. Do not search unrelated chats or disclose their content.
