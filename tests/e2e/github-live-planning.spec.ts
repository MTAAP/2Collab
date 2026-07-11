import { liveGitHubObligation } from "./github-live-evidence.ts";

liveGitHubObligation("github-live-planning-projections", "PLANNING_PROJECTIONS");
for (const mutation of [
  "CREATE_ISSUE",
  "EDIT_ISSUE",
  "ADD_COMMENT",
  "SET_LABELS",
  "SET_ASSIGNEES",
  "SET_MILESTONE",
  "SET_ISSUE_STATE",
  "CREATE_MILESTONE",
  "EDIT_MILESTONE",
  "ADD_PROJECT_ITEM",
  "REMOVE_PROJECT_ITEM",
  "SET_PROJECT_FIELD",
  "MOVE_PROJECT_ITEM",
] as const)
  liveGitHubObligation(`github-live-mutation-${mutation}`, `MUTATION_${mutation}`);
liveGitHubObligation("github-live-assignment-delegation", "ASSIGNMENT_DELEGATION");
liveGitHubObligation("github-live-stale-cas-rejected", "STALE_CAS_REJECTED");
