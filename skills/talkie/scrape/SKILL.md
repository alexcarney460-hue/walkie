---
name: scrape
description: Extract requested information from public pages with bounded browser reads.
uses: [browser_open, browser_read, browser_click]
---

## Procedure

Clarify the fields the person wants, then open the page and read only the relevant visible content. Follow public links for pagination only when needed; take a fresh snapshot before each navigation. Keep a short source trail in the answer and distinguish what the page said from your inference.

Pace repeated reads. Respect a site's terms and its automated-access rules. Stop if the site blocks automation or requires a login the person has not supplied through the normal browser session. Do not try another identity, hidden endpoint, or access route. If the page is incomplete, say which fields could not be observed. This is a read-only workflow; leave forms and account changes alone.
