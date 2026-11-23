import { type CliCommand, die } from "./context.ts";

/** `dori review audit [--json]`: read-only audit of the stored review history. */
export const reviewCommand: CliCommand = {
  options: {
    json: { type: "boolean" },
  },
  run: async ({ config, flags }) => {
    const [action, ...extra] = flags.positionals;
    if (action !== "audit" || extra.length || Object.keys(flags.values).some((k) => k !== "json")) die("usage: dori review audit [--json]", 2);
    const { auditReviewHistory, formatReviewAudit } = await import("../review-audit.ts");
    const audit = auditReviewHistory(config.stateDir);
    console.log(flags.values.json ? JSON.stringify(audit, null, 2) : formatReviewAudit(audit));
    process.exit(audit.violations.length > 0 ? 1 : 0);
  },
};
