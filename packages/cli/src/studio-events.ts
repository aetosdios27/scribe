export class StudioEventHub {
  readonly #listeners = new Set<(revision: number) => void>();
  readonly #closeListeners = new Set<() => void>();

  publish(revision: number): void {
    for (const listener of this.#listeners) {
      try {
        listener(revision);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch {
        // One failed transport must not prevent the remaining clients from closing.
      }
    }
    this.#listeners.clear();
    this.#closeListeners.clear();
  }
}
