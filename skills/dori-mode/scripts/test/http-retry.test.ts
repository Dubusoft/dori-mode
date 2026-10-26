import { expect, test } from "bun:test";

import { fetchHttp, HTTP_TIMEOUT_MS, type Http, type HttpRequest, type HttpResponse, withBackoff } from "../src/messenger/http.ts";
import { fakeClock } from "./fakes.ts";

const response = (status: number, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: "" });

test("429 retry jitter adds between zero and 25 percent", async () => {
  for (const [random, expected] of [[0, 1_000], [1, 1_250]] as const) {
    const waits: number[] = [];
    const clock = { ...fakeClock(0), sleep: async (ms: number) => { waits.push(ms); } };
    let calls = 0;
    const http: Http = async (_req: HttpRequest) => ++calls === 1 ? response(429) : response(200);

    await withBackoff(http, clock, { method: "GET", url: "https://example.test" }, undefined, undefined, () => random);
    expect(waits).toEqual([expected]);
  }
});

test("fetchHttp uses a default 30-second timeout signal", async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal;
    return new Response("ok");
  }) as typeof fetch;
  try {
    await fetchHttp({ method: "GET", url: "https://example.test" });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(HTTP_TIMEOUT_MS).toBe(30_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
