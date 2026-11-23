import { envFilePath, resolveCredential } from "../credentials.ts";
import { fetchHttp } from "../messenger/http.ts";
import { discordPresence, openDiscordGateway } from "../messenger/discord-gateway.ts";
import { acquireDiscordGateway } from "../messenger/discord-lock.ts";
import { DiscordCommands } from "../messenger/discord-commands.ts";
import { quotaReport } from "../claude-quota.ts";
import { sharedQuotaLookup } from "../quota-cache.ts";
import { realTimers } from "../messenger/typing.ts";
import { lookupStatus } from "../status.ts";
import { defaultRunnerDir } from "../runner/fs-safety.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori presence [discord]`: keep the bot shown as online until stopped. */
export const presenceCommand: CliCommand = {
  options: {},
  run: async ({ config, deps, key }) => {
    if ((key ?? "discord") === "discord") {
      const token = resolveCredential("DORI_DISCORD_TOKEN") ?? die(`DORI_DISCORD_TOKEN is not set in the environment or in ${envFilePath()}`);
      const release = acquireDiscordGateway(token);
      let presence: ReturnType<typeof discordPresence> | undefined;
      try {
        if (!config.discord) console.warn("PRESENCE_WARNING discord slash commands skipped: config.discord is missing; run dori setup");
        const commands = config.discord ? new DiscordCommands(fetchHttp, token, config.discord, quotaReport(sharedQuotaLookup(config), config.displayTimeZone), undefined, config.discordChannels, lookupStatus({ ...deps, runnerDir: defaultRunnerDir() })) : undefined;
        await commands?.register();
        presence = discordPresence(openDiscordGateway, token, realTimers, commands ? (data) => commands.handle(data) : undefined);
        console.log("PRESENCE_READY discord");
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
      } finally {
        presence?.close();
        await presence?.settled();
        release();
      }
    } else die(`unknown platform ${key}`);
  },
};
