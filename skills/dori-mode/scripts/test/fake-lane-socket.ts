import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { listenUnix } from "../src/runner/unix-transport.ts";

export type LaneSocketRequest = Record<string, unknown>;

/**
 * A runner's lane socket at `<home>/.dori/runner/sock/lane` for a spawned `dori` with `HOME=<home>`: records every
 * request line and answers each with `answer(request)` (default `{ok: true}`).
 */
export const fakeLaneSocket = (home: string, answer: (request: LaneSocketRequest) => object = () => ({ ok: true })) => {
  const path = join(home, ".dori", "runner", "sock", "lane");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: LaneSocketRequest[] = [];
  const listener = listenUnix(path);
  listener.onConnection((link) => {
    link.onLine((line) => {
      const request = JSON.parse(line) as LaneSocketRequest;
      requests.push(request);
      link.send(`${JSON.stringify(answer(request))}\n`);
    });
  });
  return { path, requests, close: () => { listener.close(); } };
};
