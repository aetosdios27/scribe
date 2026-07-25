export interface StudioLeaseState {
  readonly clientId: string;
  readonly expiresAt: number;
}

export class StudioWriterLease {
  #current: StudioLeaseState | undefined;

  constructor(
    private readonly durationMilliseconds = 8_000,
    private readonly now: () => number = Date.now
  ) {}

  acquire(clientId: string): { readonly granted: boolean; readonly expiresAt: number } {
    const time = this.now();
    if (this.#current !== undefined && this.#current.expiresAt > time && this.#current.clientId !== clientId) {
      return { granted: false, expiresAt: this.#current.expiresAt };
    }
    const expiresAt = time + this.durationMilliseconds;
    this.#current = { clientId, expiresAt };
    return { granted: true, expiresAt };
  }

  holds(clientId: string): boolean {
    const time = this.now();
    if (this.#current === undefined || this.#current.expiresAt <= time) {
      this.#current = undefined;
      return false;
    }
    return this.#current.clientId === clientId;
  }

  release(clientId: string): void {
    if (this.#current?.clientId === clientId) this.#current = undefined;
  }
}
