// Fails when the runner bundle can reach supervisor or store-conversion modules (references/runner-protocol.md: the
// bundle is "a single file holding only the runner"). Dynamic imports count: bundling follows them too.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const FORBIDDEN = /\/src\/(store-import|supervise[^/]*|claude-quota)\.ts$/;

/** Breadth-first walk of relative imports under `srcRoot`; maps each reached file to its import chain from `entry`. */
export function walk(entry: string, srcRoot: string): Map<string, string[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  for (const file of queue) {
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (!path.startsWith(".")) continue;
      const target = Bun.resolveSync(path, dirname(file));
      if (!target.startsWith(`${srcRoot}/`) || chains.has(target)) continue;
      chains.set(target, [...chains.get(file)!, target]);
      queue.push(target);
    }
  }
  return chains;
}

if (import.meta.main) {
  const srcRoot = join(process.argv[2] ?? join(import.meta.dir, ".."));
  const chains = walk(join(srcRoot, "runner/bin.ts"), srcRoot);
  const bad = [...chains].filter(([file]) => FORBIDDEN.test(file));
  for (const [file, chain] of bad) console.error(`runner graph reaches ${relative(dirname(srcRoot), file)}: ${chain.map((f) => relative(dirname(srcRoot), f)).join(" -> ")}`);
  if (bad.length) process.exit(1);
  console.log(`runner graph ok: ${chains.size} modules`);
}
