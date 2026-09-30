if (process.argv[2] === "pipe-holder") {
  await Bun.sleep(300);
} else {
  Bun.spawn([process.execPath, import.meta.path, "pipe-holder"], { stdin: "ignore", stdout: "inherit", stderr: "ignore" });
  process.stdout.write('r {"verified":true,"left":0}\n');
  await new Promise<void>(() => undefined);
}
