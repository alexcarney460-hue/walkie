// SETUP-TTY r2 (PRE5 RC, Opus MEDIUM): a question that times out must leave nothing reading the terminal. Modes:
//   two <line|hidden|confirm>: that question times out, then a y/N (askLine) is answered: its answer must arrive;
//   child <line|hidden|confirm>: that question times out, then a sudo-like child reads the terminal: it gets its line;
//   cancels: four confirmations answered Ctrl-Z, Ctrl-\, Ctrl-D and "yes" (a keystroke that ends a question closes its
//   descriptor mid-poll: the next read must not land on a reused, blocking descriptor);
//   gate: one confirmation (run without a controlling terminal: the prompt goes to stderr, the answer is read from
//   stdin's own terminal device).
import { TERMINAL } from "../../src/cli/context.ts";
import { askHidden, askLine } from "../../src/cli/prompt.ts";

const [mode, kind] = process.argv.slice(2);
if (kind === "line") console.log(`A1=${(await askLine("Q1 (y/N) ", { timeoutMs: 1200 })).how}`);
if (kind === "hidden") console.log(`A1=${(await askHidden("TOKEN: ", { timeoutMs: 1200 })).how}`);
if (kind === "confirm") {
  try { await TERMINAL.ask("type yes to confirm: "); } catch (e) { console.log(`A1=${(e as Error).message}`); }
}
if (mode === "cancels" || mode === "gate") {
  for (let i = 0; i < (mode === "gate" ? 1 : 4); i++) {
    try { console.log(`C${i}=${await TERMINAL.ask(`confirm${i}: `)}`); } catch (e) { console.log(`C${i}=threw ${(e as Error).message}`); }
  }
}
if (mode === "two") {
  const b = await askLine("Q2 (y/N) ", { timeoutMs: 8000 });
  console.log(`A2=${b.how}:${b.text}`);
}
if (mode === "child") {
  const r = Bun.spawnSync(["/bin/sh", "-c", 'printf "Password:" > /dev/tty; IFS= read -r pw < /dev/tty; echo "CHILD_GOT=[$pw]"'],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  console.log(`CHILD_EXIT=${r.exitCode}`);
}
process.exit(0);
