import {
  BotIcon,
  GitBranchIcon,
  PlayIcon,
  SettingsIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { GitHubPlanningFeature } from "./features/github/github-planning-feature.tsx";
import { MembersFeature } from "./features/members/members-feature.tsx";
import { PresetsFeature } from "./features/presets/presets-feature.tsx";
import { RunnersFeature } from "./features/runners/runners-feature.tsx";
import { RunsFeature } from "./features/runs/runs-feature.tsx";
import { InvitationExchange } from "./features/setup/invitation-exchange.tsx";
import { SetupFeature } from "./features/setup/setup-feature.tsx";

const navigation = [
  { href: "/runs", label: "Runs", icon: PlayIcon },
  { href: "/github", label: "GitHub", icon: GitBranchIcon },
  { href: "/presets", label: "Presets", icon: WorkflowIcon },
  { href: "/runners", label: "Runners", icon: BotIcon },
  { href: "/settings/team", label: "Team & access", icon: UsersIcon },
] as const;

function AppShell() {
  const path = window.location.pathname;
  const content = path.startsWith("/settings/team") ? (
    <MembersFeature />
  ) : path.startsWith("/runners") ? (
    <RunnersFeature />
  ) : path.startsWith("/github") ? (
    <GitHubPlanningFeature />
  ) : path.startsWith("/presets") ? (
    <PresetsFeature />
  ) : (
    <RunsFeature />
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/runs" aria-label="Collab home">
          <span className="brand-mark">
            <WorkflowIcon aria-hidden="true" />
          </span>
          <span>
            <strong>Collab</strong>
            <small>Foundation team</small>
          </span>
        </a>
        <div className="project-switcher">
          <small>PROJECT</small>
          <strong>Collab</strong>
        </div>
        <nav aria-label="Primary navigation">
          <span className="nav-label">OPERATE</span>
          {navigation.map(({ href, label, icon: Icon }) => (
            <a key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}>
              <Icon aria-hidden="true" />
              {label}
            </a>
          ))}
        </nav>
        <a className="settings-link" href="/settings/team">
          <SettingsIcon aria-hidden="true" />
          Settings
        </a>
        <div className="member-chip">
          <span>TK</span>
          <div>
            <strong>Tim Kraus</strong>
            <small>Owner</small>
          </div>
        </div>
      </aside>
      <main className="workspace">{content}</main>
    </div>
  );
}

export function App() {
  const path = window.location.pathname;
  if (path === "/setup") return <SetupFeature />;
  if (path === "/join") return <InvitationExchange />;
  return <AppShell />;
}
