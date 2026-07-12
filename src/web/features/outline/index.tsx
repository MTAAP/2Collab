import { OutlineSearch } from "./search/index.tsx";

type SearchResponse = Readonly<{
  ok: boolean;
  value?: Readonly<{
    results?: readonly Readonly<{
      reference: { documentId: string };
      title: string;
      snippet: string;
    }>[];
  }>;
}>;

export function OutlineFeature(): React.JSX.Element {
  return (
    <div className="feature-stack">
      <header>
        <p className="eyebrow">CONTEXT</p>
        <h1>Outline collaboration</h1>
        <p>Search the current authorized collections and open documents from their live source.</p>
      </header>
      <OutlineSearch
        search={async (query) => {
          const response = await fetch("/api/v1/outline/search", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: { query, limit: 20 } }),
          });
          const payload = (await response.json()) as SearchResponse;
          return (
            (payload.ok ? payload.value?.results : undefined)?.map((item) => ({
              documentId: item.reference.documentId,
              title: item.title,
              snippet: item.snippet,
            })) ?? []
          );
        }}
      />
    </div>
  );
}
