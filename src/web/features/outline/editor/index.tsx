import { useState } from "react";

export function OutlineEditor(
  props: Readonly<{
    title: string;
    initialBody: string;
    revision: string;
    save(
      input: Readonly<{ body: string; revision: string }>,
    ): Promise<Readonly<{ ok: boolean; currentRevision?: string }>>;
  }>,
): React.JSX.Element {
  const [body, setBody] = useState(props.initialBody);
  const [conflict, setConflict] = useState<string>();
  return (
    <section aria-labelledby="outline-editor-heading">
      <h2 id="outline-editor-heading">{props.title}</h2>
      <textarea
        aria-label="Document body"
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
      />
      <button
        type="button"
        onClick={async () => {
          const result = await props.save({ body, revision: props.revision });
          setConflict(result.ok ? undefined : result.currentRevision);
        }}
      >
        Save as me
      </button>
      {conflict ? (
        <p role="alert">
          The document changed in Outline at revision {conflict}. Your change was not applied.
        </p>
      ) : null}
    </section>
  );
}
