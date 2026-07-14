export type PredicateResult = "TRUE" | "FALSE" | "UNKNOWN";
export type SourcePredicate = Readonly<{
  kind: "GITHUB_CHECK" | "GITHUB_ISSUE_STATE" | "OUTLINE_DOCUMENT_REVISION";
  key: string;
}>;
export type StopPolicy =
  | Readonly<{ kind: "ALL"; conditions: readonly StopPolicy[] }>
  | Readonly<{ kind: "ANY"; conditions: readonly StopPolicy[] }>
  | Readonly<{ kind: "NOT"; condition: StopPolicy }>
  | Readonly<{ kind: "SOURCE"; predicate: SourcePredicate }>
  | Readonly<{
      kind: "AGENT_OUTCOME";
      value: "CONTINUE" | "GOAL_ACHIEVED" | "ESCALATE";
    }>
  | Readonly<{ kind: "CONSECUTIVE_MATCHES"; condition: StopPolicy; count: number }>;

export type StopPolicyFacts = Readonly<{
  source: Readonly<Record<string, PredicateResult>>;
  agentOutcome?: "CONTINUE" | "GOAL_ACHIEVED" | "ESCALATE";
}>;
export type ConsecutiveMatchState = Readonly<{ matches: number }>;
