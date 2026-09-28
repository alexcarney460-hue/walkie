// SETUP-TTY fixture: the `walkie seats enable` sequence of terminal reads, with the real prompt code — the person-only
// confirmation (TERMINAL.ask), a sudo-like child that reads the terminal itself (echo off, one wrong password first),
// the hidden Claude-token question (askHidden) and a y/N (askLine). Prints what each one got.
import { TERMINAL } from "../../src/cli/context.ts";
import { askHidden, askLine } from "../../src/cli/prompt.ts";

const SUDO = `
tries=0
while :; do
  printf 'Password:' > /dev/tty; stty -echo < /dev/tty; IFS= read -r pw < /dev/tty; stty echo < /dev/tty; echo > /dev/tty
  tries=$((tries+1))
  [ "$pw" = right ] && { echo "SUDO=ok after $tries"; exit 0; }
  echo 'Sorry, try again.' > /dev/tty
  [ "$tries" -ge 3 ] && exit 1
done`;

const confirm = await TERMINAL.ask("type yes to confirm: ");
console.log(`CONFIRM=${confirm}`);
const sudo = Bun.spawnSync(["/bin/sh", "-c", SUDO], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
console.log(`SUDO_EXIT=${sudo.exitCode}`);
const token = await askHidden("Claude token for seats: ");
console.log(`TOKEN=${token.text} (${token.how})`);
const yn = await askLine("Switch accounts? (y/N) [n] ");
console.log(`YN=${yn.text} (${yn.how})`);
