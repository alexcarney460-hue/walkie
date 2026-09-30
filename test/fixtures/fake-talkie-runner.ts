// Test-only uid switch: production invokes talkie-runner through sudo as TALKIE_UID.
// These tests create no OS user, so model only the runner process's reported uid.
import { TALKIE_UID } from "../../src/daemon/seats/talkie-user.ts";
import { runTalkieRunner } from "../../src/daemon/seats/talkie-runner.ts";

const getuid = process.getuid;
process.getuid = () => TALKIE_UID;
const running = runTalkieRunner();
process.getuid = getuid;
process.exit(await running);
