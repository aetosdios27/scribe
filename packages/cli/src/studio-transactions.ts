export interface StudioMutationRequest {
  readonly clientId: string;
  readonly operationId: string;
  readonly baseRevision: number;
}

export type StudioMutationDecision<T> =
  | { readonly accepted: true; readonly value: T }
  | { readonly accepted: false; readonly value: T };

export type StudioMutationResult<T> =
  | { readonly kind: "accepted"; readonly revision: number; readonly value: T }
  | { readonly kind: "rejected"; readonly revision: number; readonly value: T }
  | { readonly kind: "stale"; readonly revision: number };

const retainedOperationLimit = 2_048;

export class StudioTransactionCoordinator {
  readonly #operations = new Map<string, Promise<StudioMutationResult<unknown>>>();
  #tail: Promise<void> = Promise.resolve();
  #revision: number;

  constructor(initialRevision: number) {
    this.#revision = initialRevision;
  }

  get revision(): number {
    return this.#revision;
  }

  mutate<T>(
    request: StudioMutationRequest,
    operation: () => Promise<StudioMutationDecision<T>>
  ): Promise<StudioMutationResult<T>> {
    const key = `${request.clientId}\0${request.operationId}`;
    const existing = this.#operations.get(key);
    if (existing !== undefined) return existing as Promise<StudioMutationResult<T>>;

    const result = this.#enqueue(async (): Promise<StudioMutationResult<T>> => {
      if (request.baseRevision !== this.#revision) {
        return { kind: "stale", revision: this.#revision };
      }
      const decision = await operation();
      if (!decision.accepted) {
        return { kind: "rejected", revision: this.#revision, value: decision.value };
      }
      this.#revision += 1;
      return { kind: "accepted", revision: this.#revision, value: decision.value };
    });
    const cached = result as Promise<StudioMutationResult<unknown>>;
    this.#operations.set(key, cached);
    void cached.catch(() => {
      if (this.#operations.get(key) === cached) this.#operations.delete(key);
    });
    this.#trimOperations();
    return result;
  }

  system<T>(
    operation: (nextRevision: number) => Promise<{ readonly changed: boolean; readonly value: T }>
  ): Promise<{ readonly changed: boolean; readonly revision: number; readonly value: T }> {
    return this.#enqueue(async () => {
      const nextRevision = this.#revision + 1;
      const result = await operation(nextRevision);
      if (result.changed) this.#revision = nextRevision;
      return { changed: result.changed, revision: this.#revision, value: result.value };
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #trimOperations(): void {
    while (this.#operations.size > retainedOperationLimit) {
      const oldest = this.#operations.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#operations.delete(oldest);
    }
  }
}
