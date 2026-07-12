import {
  type PublicProjectionMessage,
  PublicProjectionMessageSchema,
} from "../shared/contracts/projections.ts";

export function subscribeToProjections(
  onMessage: (message: PublicProjectionMessage) => void,
): () => void {
  const stream = new EventSource("/api/v1/events", { withCredentials: true });
  const receive = (event: MessageEvent<string>) => {
    try {
      const parsed = PublicProjectionMessageSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) onMessage(parsed.data);
    } catch {
      // Malformed or non-public events are ignored at the browser boundary.
    }
  };
  stream.addEventListener("projection", receive as EventListener);
  stream.addEventListener("reset", receive as EventListener);
  return () => stream.close();
}
