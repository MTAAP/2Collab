import { useEffect, useState } from "react";
type Item = Readonly<{
  subjectKey: string;
  safeSummary: string;
  category: string;
  unread: boolean;
}>;
export function InboxFeature() {
  const [items, setItems] = useState<readonly Item[]>([]);
  useEffect(() => {
    fetch("/api/v1/inbox")
      .then((value) => value.json())
      .then((value) => setItems(value.ok ? value.value : []))
      .catch(() => setItems([]));
  }, []);
  return (
    <div className="feature-page">
      <header className="page-header">
        <div>
          <small>PERSONAL ATTENTION</small>
          <h1>Inbox</h1>
          <p>Deduplicated source and run events requiring your attention.</p>
        </div>
      </header>
      <section aria-label="Inbox items">
        {items.map((item) => (
          <article key={`${item.category}:${item.subjectKey}`}>
            <h2>{item.safeSummary}</h2>
            <p>{item.category}</p>
            {item.unread && <strong>Unread</strong>}
          </article>
        ))}
      </section>
    </div>
  );
}
