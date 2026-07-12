import type {
  ConsecutiveMatchState,
  PredicateResult,
  StopPolicy,
  StopPolicyFacts,
} from "../../../shared/contracts/stop-policies.ts";

export function and(results: readonly PredicateResult[]): PredicateResult {
  if (results.includes("FALSE")) return "FALSE";
  return results.includes("UNKNOWN") ? "UNKNOWN" : "TRUE";
}
export function or(results: readonly PredicateResult[]): PredicateResult {
  if (results.includes("TRUE")) return "TRUE";
  return results.includes("UNKNOWN") ? "UNKNOWN" : "FALSE";
}
const not = (result: PredicateResult): PredicateResult =>
  result === "UNKNOWN" ? "UNKNOWN" : result === "TRUE" ? "FALSE" : "TRUE";

export function evaluateStopPolicy(
  policy: StopPolicy,
  facts: StopPolicyFacts,
  state: ConsecutiveMatchState,
): Readonly<{ result: PredicateResult; state: ConsecutiveMatchState }> {
  switch (policy.kind) {
    case "SOURCE":
      return { result: facts.source[policy.predicate.key] ?? "UNKNOWN", state };
    case "AGENT_OUTCOME":
      return {
        result:
          facts.agentOutcome === undefined
            ? "UNKNOWN"
            : facts.agentOutcome === policy.value
              ? "TRUE"
              : "FALSE",
        state,
      };
    case "NOT": {
      const evaluated = evaluateStopPolicy(policy.condition, facts, state);
      return { result: not(evaluated.result), state: evaluated.state };
    }
    case "ALL":
    case "ANY": {
      let nextState = state;
      const results: PredicateResult[] = [];
      for (const condition of policy.conditions) {
        const evaluated = evaluateStopPolicy(condition, facts, nextState);
        results.push(evaluated.result);
        nextState = evaluated.state;
      }
      return {
        result: policy.kind === "ALL" ? and(results) : or(results),
        state: nextState,
      };
    }
    case "CONSECUTIVE_MATCHES": {
      if (!Number.isInteger(policy.count) || policy.count < 1)
        throw new Error("STOP_POLICY_BOUND_INVALID");
      const evaluated = evaluateStopPolicy(policy.condition, facts, { matches: 0 });
      if (evaluated.result === "UNKNOWN") return { result: "UNKNOWN", state };
      const matches = evaluated.result === "TRUE" ? state.matches + 1 : 0;
      return {
        result: matches >= policy.count ? "TRUE" : "FALSE",
        state: { matches },
      };
    }
  }
}
