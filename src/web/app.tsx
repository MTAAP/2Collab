import {
  BotIcon,
  BookOpenIcon,
  GitBranchIcon,
  InboxIcon,
  LayoutDashboardIcon,
  PlayIcon,
  SettingsIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { GitHubPlanningFeature } from "./features/github/github-planning-feature.tsx";
import { InboxFeature } from "./features/inbox/index.tsx";
import { CommandCenterFeature } from "./features/command-center/index.tsx";
import { MembersFeature } from "./features/members/members-feature.tsx";
import { PresetsFeature } from "./features/presets/presets-feature.tsx";
import { RunnersFeature } from "./features/runners/runners-feature.tsx";
import { RunsFeature } from "./features/runs/runs-feature.tsx";
import { InvitationExchange } from "./features/setup/invitation-exchange.tsx";
import { DeviceAuthorization } from "./features/setup/device-authorization.tsx";
import { LoginFeature } from "./features/setup/login-feature.tsx";
import { RecoveryFeature } from "./features/setup/recovery-feature.tsx";
import { SetupFeature } from "./features/setup/setup-feature.tsx";
import { OutlineFeature } from "./features/outline/index.tsx";
import { WorkflowStudioFeature } from "./features/workflow-studio/editor.tsx";
import { BoundedAutomationJourney } from "./features/workflows/execution.tsx";
import { PlanningWorkflowJourney } from "./features/workflows/plan-artifact.tsx";
import { authClient } from "./auth-client.ts";

const navigation = [
  { href: "/runs", label: "Runs", icon: PlayIcon },
  { href: "/github", label: "GitHub", icon: GitBranchIcon },
  { href: "/inbox", label: "Inbox", icon: InboxIcon },
  {
    href: "/command-center",
    label: "Command Center",
    icon: LayoutDashboardIcon,
  },
  { href: "/presets", label: "Presets", icon: WorkflowIcon },
  { href: "/workflows", label: "Workflows", icon: WorkflowIcon },
  { href: "/runners", label: "Runners", icon: BotIcon },
  { href: "/outline", label: "Outline", icon: BookOpenIcon },
  { href: "/settings/team", label: "Team & access", icon: UsersIcon },
] as const;

function AppShell({ displayName }: Readonly<{ displayName: string }>) {
  const path = window.location.pathname;
  const content = path.startsWith("/settings/team") ? (
    <MembersFeature />
  ) : path.startsWith("/runners") ? (
    <RunnersFeature />
  ) : path.startsWith("/github") ? (
    <GitHubPlanningFeature />
  ) : path.startsWith("/inbox") ? (
    <InboxFeature />
  ) : path.startsWith("/command-center") ? (
    <CommandCenterFeature />
  ) : path.startsWith("/presets") ? (
    <PresetsFeature />
  ) : path === "/workflows/planning" ? (
    <PlanningWorkflowJourney />
  ) : path === "/workflows/journey" ? (
    <BoundedAutomationJourney />
  ) : path.startsWith("/workflows") ? (
    <WorkflowStudioFeature />
  ) : path.startsWith("/outline") ? (
    <OutlineFeature />
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
          <span>{displayName.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{displayName}</strong>
            <small>Team member</small>
          </div>
        </div>
      </aside>
      <main className="workspace">{content}</main>
    </div>
  );
}

function AuthenticatedShell() {
  const session = authClient.useSession();
  if (session.isPending)
    return (
      <main className="setup-page">
        <p>Checking session…</p>
      </main>
    );
  if (!session.data) {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return (
      <main className="setup-page">
        <header className="setup-header">
          <strong>Collab</strong>
          <span>Sign in</span>
        </header>
        <div className="setup-layout">
          <section className="setup-panel">
            <p className="utility">TEAM ACCESS</p>
            <h1>Authentication required</h1>
            <a className="primary-button" href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>
              Sign in with passkey
            </a>
          </section>
        </div>
      </main>
    );
  }
  return <AppShell displayName={session.data.user.name} />;
}

export function App() {
  const path = window.location.pathname;
  if (path === "/setup") return <SetupFeature />;
  if (path === "/join") return <InvitationExchange />;
  if (path === "/login") return <LoginFeature />;
  if (path === "/recover") return <RecoveryFeature />;
  const userCode = new URLSearchParams(window.location.search).get("user_code");
  if (path === "/device" && userCode && /^[A-Za-z0-9-]{1,128}$/.test(userCode))
    return <DeviceAuthorization userCode={userCode} />;
  return <AuthenticatedShell />;
}
