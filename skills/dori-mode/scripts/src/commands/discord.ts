import { type CliCommand, die, messengerToken } from "./context.ts";

/** `dori ack|reported|handled|send|thread|typing`: discord-cli.ts checks these shared flags per command and parses the rest itself. */
export const discordCommand: CliCommand = {
  options: {
    text: { type: "string" },
    append: { type: "string" },
    to: { type: "string" },
    thread: { type: "string" },
    note: { type: "string" },
    edit: { type: "string" },
    buttons: { type: "string" },
    message: { type: "string" },
    name: { type: "string" },
    final: { type: "boolean" },
    "no-redirect": { type: "boolean" },
    force: { type: "boolean" },
    "drop-notice": { type: "boolean" },
  },
  ownFlags: true,
  run: async ({ deps, flags, key, opt, need }) => {
    const { discordMain } = await import("../discord-cli.ts");
    const code = await discordMain(process.argv.slice(2), { flow: deps, die, messengerToken, flags, opt, need, key });
    if (code !== 0) process.exit(code);
  },
};
