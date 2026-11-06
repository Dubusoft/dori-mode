import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The lane boundary (design 3.3): supervisor modules reach lanes only through `lane-ops.ts`. A top-level `src/*.ts`
 * module outside the runner, the herdr primitives and the lead modules must not import a value from `./panes.ts` nor
 * carry the argv literal "herdr".
 */

const SRC = join(import.meta.dir, "..", "src");

/** Runner-side primitives and lead modules: herdr access there is not lane access through the supervisor. */
const EXEMPT: ReadonlySet<string> = new Set([
  "panes.ts", "session-id.ts", "herdr-machines.ts",
  "supervise-lead-lifecycle.ts", "supervise-push.ts", "supervise-delivery.ts", "status.ts", "doctor.ts", "setup.ts", "lane-reports.ts",
]);

type Offence = "herdr" | "panes";

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PANES_FROM = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']\.\/panes(?:\.ts)?["']/g;

/** Whether the module imports (or re-exports) a value, not only types, from ./panes.ts, statically or dynamically. */
const importsPanesValue = (code: string): boolean => {
  for (const m of code.matchAll(PANES_FROM)) {
    if (m[1]) continue;
    const spec = m[2] ?? "";
    const braces = /\{([\s\S]*)\}/.exec(spec);
    const named = braces ? (braces[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
    const outside = spec.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    if (outside || named.some((n) => !n.startsWith("type "))) return true;
  }
  return /import\(\s*["']\.\/panes(?:\.ts)?["']/.test(code);
};

const offences = (source: string): Offence[] => {
  const code = stripComments(source);
  return [
    ...(/\[\s*["']herdr["']/.test(code) ? ["herdr" as const] : []),
    ...(importsPanesValue(code) ? ["panes" as const] : []),
  ];
};

const scan = (): Record<string, Offence[]> => Object.fromEntries(
  readdirSync(SRC).filter((f) => f.endsWith(".ts") && !EXEMPT.has(f))
    .map((f) => [f, offences(readFileSync(join(SRC, f), "utf8"))] as const)
    .filter(([, o]) => o.length > 0),
);

describe("lane-ops boundary", () => {
  test("no supervisor module reaches herdr or the pane primitives", () => {
    expect(scan()).toEqual({});
  });

  test("the facade itself stays on the right side", () => {
    expect(offences(readFileSync(join(SRC, "lane-ops.ts"), "utf8"))).toEqual([]);
  });

  test("the scanner tells a value import from a type import and ignores comments", () => {
    expect(offences(`import { listPanes, type Pane } from "./panes.ts";`)).toEqual(["panes"]);
    expect(offences(`import type { Pane } from "./panes.ts";`)).toEqual([]);
    expect(offences(`import { type Pane,\n  type Delivery } from "./panes.ts";`)).toEqual([]);
    expect(offences(`export { readScreen } from "./panes.ts";`)).toEqual(["panes"]);
    expect(offences(`const p = await import("./panes.ts");`)).toEqual(["panes"]);
    expect(offences(`await run(["herdr", "pane", "list"]);`)).toEqual(["herdr"]);
    expect(offences(`// run(["herdr"])\n/* "herdr" */\nconst x = 1;`)).toEqual([]);
    expect(offences(`import { x } from "./panes-extra.ts";`)).toEqual([]);
  });
});
