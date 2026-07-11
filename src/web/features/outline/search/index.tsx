import { useState } from "react";

export function OutlineSearch(
  props: Readonly<{
    search(
      query: string,
    ): Promise<readonly Readonly<{ documentId: string; title: string; snippet: string }>[]>;
  }>,
): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    readonly Readonly<{ documentId: string; title: string; snippet: string }>[]
  >([]);
  return (
    <section aria-labelledby="outline-search-heading">
      <h2 id="outline-search-heading">Outline</h2>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setResults(await props.search(query));
        }}
      >
        <label>
          Search documents
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
      <ul>
        {results.map((result) => (
          <li key={result.documentId}>
            <strong>{result.title}</strong>
            <p>{result.snippet}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
