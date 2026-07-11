import { useEffect, useState } from "react";
type Card = Readonly<{ subjectKey: string; summary: string; lane: string; draggable: false }>;
export function CommandCenterFeature() {
  const [cards, setCards] = useState<readonly Card[]>([]);
  useEffect(() => {
    fetch("/api/v1/command-center")
      .then((value) => value.json())
      .then((value) => setCards(value.ok ? value.value : []))
      .catch(() => setCards([]));
  }, []);
  return (
    <div className="feature-page">
      <header className="page-header">
        <div>
          <small>DERIVED VIEW</small>
          <h1>Command Center</h1>
          <p>Operational lanes derived from authoritative source and run state.</p>
        </div>
      </header>
      {["NEEDS_ATTENTION", "ACTIVE_NOW", "WAITING_AND_SCHEDULED", "RECENTLY_FINISHED"].map(
        (lane) => (
          <section key={lane} aria-label={lane.replaceAll("_", " ")}>
            <h2>{lane.replaceAll("_", " ")}</h2>
            {cards
              .filter((card) => card.lane === lane)
              .map((card) => (
                <article key={card.subjectKey} draggable={false}>
                  <h3>{card.summary}</h3>
                </article>
              ))}
          </section>
        ),
      )}
    </div>
  );
}
