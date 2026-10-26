import { expect, test } from "bun:test";

import type { Runner } from "../src/run.ts";
import { sampleHost } from "../src/host-guard.ts";

test("sampleHost reads Linux memory and swap from injected meminfo", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 2097152", err: "" };
  };
  const sample = await sampleHost(
    run,
    "/data",
    async () => 3,
    async (path) => {
      expect(path).toBe("/proc/meminfo");
      return "MemTotal:       8000000 kB\nMemAvailable:   2000000 kB\nSwapTotal:      4000000 kB\nSwapFree:       1048576 kB\n";
    },
  );

  expect(sample).toMatchObject({ memFreePct: 25, diskFreeGb: 2, swapFreeGb: 1, panes: 3 });
  expect(calls).toEqual([["df", "-k", "/data"]]);
});
