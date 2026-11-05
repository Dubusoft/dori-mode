#!/usr/bin/env bun
// The entry point bundled for worker machines (`dori runner install`): `bun dori.js runner serve|probe ...`.
import { runnerHostMain } from "./main.ts";

const args = process.argv.slice(2);
process.exit(await runnerHostMain(args[0] === "runner" ? args.slice(1) : args));
