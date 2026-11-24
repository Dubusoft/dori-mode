import { Repos } from "../repos.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori repos add|remove <owner/repo> | dori repos list`: this machine's watched GitHub repos. */
export const reposCommand: CliCommand = {
  options: {},
  run: async ({ config, flags }) => {
    const [action, repo, ...extra] = flags.positionals;
    const repos = new Repos(config.stateDir);
    if (Object.keys(flags.values).length || extra.length ||
        (action === "list" ? repo !== undefined : !repo || (action !== "add" && action !== "remove"))) {
      die("usage: dori repos add/remove <owner/repo> | dori repos list");
    }
    switch (action) {
      case "add": repos.add(repo ?? die("repos add needs owner/repo")); break;
      case "remove": repos.remove(repo ?? die("repos remove needs owner/repo")); break;
      case "list": break;
      default: die("usage: dori repos add/remove <owner/repo> | dori repos list");
    }
    console.log(JSON.stringify(repos.list(), null, 2));
  },
};
