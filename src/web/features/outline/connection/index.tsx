export type OutlineConnectionView = Readonly<{
  workspaceName: string;
  identityKind: "MEMBER" | "BOT";
  identityName: string;
  grantedScopes: readonly string[];
  refreshStatus: "READY" | "REAUTHORIZATION_REQUIRED" | "REVOKED";
  expiresAt?: number;
}>;

export function OutlineConnection(
  props: Readonly<{
    connection: OutlineConnectionView;
    revoke(): Promise<void>;
  }>,
): React.JSX.Element {
  const { connection } = props;
  return (
    <section aria-labelledby="outline-connection-heading">
      <h2 id="outline-connection-heading">Outline connection</h2>
      <dl>
        <dt>Workspace</dt>
        <dd>{connection.workspaceName}</dd>
        <dt>Active identity</dt>
        <dd>
          {connection.identityKind === "MEMBER" ? "Delegated member" : "Team bot"}:{" "}
          {connection.identityName}
        </dd>
        <dt>Scopes</dt>
        <dd>{connection.grantedScopes.join(", ")}</dd>
        <dt>Refresh health</dt>
        <dd>{connection.refreshStatus}</dd>
        {connection.expiresAt ? (
          <>
            <dt>Expires</dt>
            <dd>{new Date(connection.expiresAt).toISOString()}</dd>
          </>
        ) : null}
      </dl>
      <button type="button" onClick={() => void props.revoke()}>
        Revoke
      </button>
    </section>
  );
}
