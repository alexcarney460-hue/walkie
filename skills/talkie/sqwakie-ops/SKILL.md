---
name: sqwakie-ops
description: Help operate machines, daemon health, updates, accounts and the vault.
uses: [walkie_cli, walkie_who, walkie_ask]
---

## Procedure

Start with the relevant read-only Sqwakie status: machine roster, daemon health, seats or accounts. Check the current machine and owner before proposing any change. For a new machine, explain the existing member and teammate paths; request a link or invite only when the person asks, and direct private credentials to the person's normal delivery surface.

If a daemon does not answer, distinguish a slow response from a stopped process. Check current work and retry a read with a longer timeout. Never restart a daemon in a loop or launch a second controller. If a command reports an uncertain outcome, read current state before retrying a write.

Updates and vault changes use the person's own controls. `walkie_cli` may refuse commands reserved for a person; explain that refusal and the one action the person should take. Do not print credentials, move account secrets into chat, or treat a skill as permission to change a setting.
