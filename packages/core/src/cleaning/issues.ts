export type IssueSeverity = "info" | "warn" | "error";

/** A problem or correction found while cleaning; `error` issues force review. */
export interface Issue {
  code: string;
  field?: string;
  message: string;
  severity: IssueSeverity;
  original?: string;
  rows?: number[];
}

export const issue = (
  code: string,
  severity: IssueSeverity,
  message: string,
  extra: Partial<Pick<Issue, "field" | "original" | "rows">> = {},
): Issue => ({ code, severity, message, ...extra });
