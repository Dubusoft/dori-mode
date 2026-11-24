import { run } from "../run.ts";
import { transcribe } from "../messenger/voice.ts";
import { type CliCommand, die } from "./context.ts";

/** `dori transcribe <audio-file>`: run hooks.transcribe and print the text. */
export const transcribeCommand: CliCommand = {
  options: {},
  run: async ({ config, key }) => {
    console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
  },
};
