import { afterEach, describe, expect, test } from "bun:test";
import { addKnownSecrets, redactSecrets, replaceKnownSecrets } from "../src/redact.ts";

afterEach(() => replaceKnownSecrets([]));

describe("known secret-store values", () => {
  test("masks values registered by the supervisor or local runner", () => {
    addKnownSecrets(["dori-test-throwaway-123"]);
    expect(redactSecrets("x dori-test-throwaway-123 y")).toBe("x [REDACTED] y");
  });

  test("does not register values shorter than eight characters", () => {
    addKnownSecrets(["short"]);
    expect(redactSecrets("x short y")).toBe("x short y");
  });

  test("replacement removes previously registered values", () => {
    addKnownSecrets(["throwawayvalue"]);
    expect(redactSecrets("x throwawayvalue y")).toBe("x [REDACTED] y");
    replaceKnownSecrets([]);
    expect(redactSecrets("x throwawayvalue y")).toBe("x throwawayvalue y");
  });
});
