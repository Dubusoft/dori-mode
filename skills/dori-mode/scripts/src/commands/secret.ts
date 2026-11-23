import { SecretStore, SecretStoreError } from "../secret-store.ts";
import { MIN_KNOWN_SECRET } from "../redact.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori secret add|update|delete NAME | dori secret list [--json]`: the secrets shared with every lane at launch. */
export const secretCommand: CliCommand = {
  options: {
    json: { type: "boolean" },
  },
  run: async ({ flags }) => {
    const [action, name, ...extra] = flags.positionals;
    const usage = "usage: dori secret add NAME | dori secret update NAME | dori secret list [--json] | dori secret delete NAME";
    if (action === "env") die("SECRET_ENV_LANE_ONLY dori secret env runs inside a lane", 2);
    if (extra.length || Object.keys(flags.values).some((flag) => flag !== "json" || action !== "list")) die(usage, 2);
    const store = new SecretStore();
    try {
      if (action === "list" && name === undefined) {
        const entries = store.list();
        if (flags.values.json) console.log(JSON.stringify(entries.map(({ name: n, backend }) => ({ name: n, backend })), null, 2));
        else for (const entry of entries) console.log(`${entry.name} ${entry.backend}`);
      } else if (action === "delete" && name) {
        store.delete(name);
        console.log(`SECRET_DELETED ${name}`);
      } else if ((action === "add" || action === "update") && name) {
        let value: string;
        if (process.stdin.isTTY) {
          const { ttyPrompter } = await import("../setup-cli.ts");
          value = await ttyPrompter().secret(`value for ${name}`, false);
        } else {
          const text = await Bun.stdin.text();
          value = text.endsWith("\n") ? text.slice(0, -1) : text;
        }
        const entry = action === "add" ? await store.add(name, value) : await store.update(name, value);
        console.log(`${action === "add" ? "SECRET_ADDED" : "SECRET_UPDATED"} ${entry.name} backend=${entry.backend}`);
        if (value.length < MIN_KNOWN_SECRET) console.error(`SECRET_NOT_MASKED ${entry.name}: values shorter than ${MIN_KNOWN_SECRET} characters are not masked in outbound text`);
      } else die(usage, 2);
    } catch (e) {
      if (e instanceof SecretStoreError) die(e.message);
      throw e;
    }
  },
};
