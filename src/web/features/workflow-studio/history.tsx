import { useCallback, useState } from "react";

export function useWorkflowHistory<T>(initial: T) {
  const [past, setPast] = useState<readonly T[]>([]);
  const [present, setPresent] = useState(initial);
  const [future, setFuture] = useState<readonly T[]>([]);
  const replace = useCallback(
    (next: T) => {
      setPast((items) => [...items, present]);
      setPresent(next);
      setFuture([]);
    },
    [present],
  );
  const undo = useCallback(() => {
    const prior = past.at(-1);
    if (prior === undefined) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [present, ...items]);
    setPresent(prior);
  }, [past, present]);
  const redo = useCallback(() => {
    const next = future[0];
    if (next === undefined) return;
    setFuture((items) => items.slice(1));
    setPast((items) => [...items, present]);
    setPresent(next);
  }, [future, present]);
  return {
    value: present,
    replace,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
  };
}
