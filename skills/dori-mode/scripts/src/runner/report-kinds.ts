export const REPORT_KINDS = ["progress", "question", "blocked", "milestone", "done"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const isReportKind = (value: unknown): value is ReportKind => typeof value === "string" && (REPORT_KINDS as readonly string[]).includes(value);
