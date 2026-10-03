// Runs ONE Bun.build in a process of its own: `bun web/test/browser-bundle-worker.ts <config.json>` (browser-bundle.ts starts it).
// Bun.build inside `bun test` shares the test runner's resolver and module state, so a second build in one test process fails
// with `EISDIR reading file …/react/index.js`; a build in a fresh process of its own cannot be damaged by (or damage) the others.
import { resolve } from "node:path";

const config = JSON.parse(await Bun.file(process.argv[2] as string).text()) as { entry: string; outdir: string; root: string; tsconfig: string };
const built = await Bun.build({
  entrypoints: [config.entry], outdir: config.outdir, root: config.root, naming: "fixture.[ext]", target: "browser", tsconfig: config.tsconfig,
  plugins: [{ name: "absolute-source-paths", setup(build) { build.onResolve({ filter: /^\..*\.tsx?$/ }, (args) => ({ path: resolve(args.resolveDir, args.path) })); } }],
});
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
