export type RunnerConnectionState =
  | "DISCONNECTED"
  | "AUTHENTICATING"
  | "NEGOTIATING"
  | "ACTIVE"
  | "BACKING_OFF"
  | "STOPPED";

export type DisconnectReason =
  | "NETWORK"
  | "RESTART"
  | "UNAVAILABLE"
  | "AUTHENTICATION"
  | "PROTOCOL"
  | "POLICY";

export class RunnerReconnectState {
  readonly #jitter: () => number;
  #attempt = 0;
  #activeSince: number | null = null;
  #stable = false;
  state: RunnerConnectionState = "DISCONNECTED";

  constructor(input: Readonly<{ jitter?: () => number }> = {}) {
    this.#jitter = input.jitter ?? Math.random;
  }

  authenticating(): void {
    if (this.state !== "DISCONNECTED" && this.state !== "BACKING_OFF") {
      throw new Error("RUNNER_CONNECTION_TRANSITION_INVALID");
    }
    this.state = "AUTHENTICATING";
  }

  negotiating(): void {
    if (this.state !== "AUTHENTICATING") throw new Error("RUNNER_CONNECTION_TRANSITION_INVALID");
    this.state = "NEGOTIATING";
  }

  active(now: number): void {
    if (this.state !== "NEGOTIATING" && this.state !== "AUTHENTICATING") {
      throw new Error("RUNNER_CONNECTION_TRANSITION_INVALID");
    }
    this.state = "ACTIVE";
    this.#activeSince = now;
    this.#stable = false;
  }

  markStable(now: number): void {
    if (this.state !== "ACTIVE" || this.#activeSince === null || now - this.#activeSince < 30) {
      throw new Error("RUNNER_CONNECTION_NOT_STABLE");
    }
    this.#attempt = 0;
    this.#stable = true;
  }

  disconnected(reason: DisconnectReason, _now: number): void {
    if (reason === "AUTHENTICATION" || reason === "PROTOCOL" || reason === "POLICY") {
      this.state = "STOPPED";
      return;
    }
    if (this.#stable) this.#attempt = 0;
    this.#attempt += 1;
    this.#activeSince = null;
    this.#stable = false;
    this.state = "BACKING_OFF";
  }

  retrying(): void {
    if (this.state !== "BACKING_OFF") throw new Error("RUNNER_CONNECTION_TRANSITION_INVALID");
    this.state = "AUTHENTICATING";
  }

  nextDelaySeconds(): number | null {
    if (this.state === "STOPPED") return null;
    if (this.state !== "BACKING_OFF") throw new Error("RUNNER_BACKOFF_NOT_ACTIVE");
    const base = Math.min(30, 2 ** Math.max(0, this.#attempt - 1));
    const jitter = Math.min(1, Math.max(0, this.#jitter()));
    return Math.min(30, Math.max(0.1, base * jitter));
  }
}
