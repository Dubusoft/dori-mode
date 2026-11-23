import { type CliCommand, die, messengerToken } from "./context.ts";

/** `dori decision open|close|list`: decision-cli.ts reads its own flags. */
export const decisionCommand: CliCommand = {
  options: {},
  ownFlags: true,
  run: async ({ deps, rest }) => {
    const { decisionMain } = await import("../decision-cli.ts");
    const code = await decisionMain(rest, { flow: deps, die, messengerToken });
    if (code !== 0) process.exit(code);
  },
};
