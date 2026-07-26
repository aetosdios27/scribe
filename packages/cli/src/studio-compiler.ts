import { Worker } from "node:worker_threads";

export interface StudioCompilerDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

interface PendingCompilation {
  readonly resolve: (diagnostics: StudioCompilerDiagnostic[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WorkerResult {
  readonly id: number;
  readonly diagnostics?: StudioCompilerDiagnostic[];
  readonly error?: string;
}

export class StudioCompiler {
  #worker: Worker | undefined;
  readonly #pending = new Map<number, PendingCompilation>();
  readonly #mdxModuleUrl: string;
  readonly #timeoutMilliseconds: number;
  #nextId = 0;
  #closed = false;
  #consecutiveFailures = 0;
  #circuitOpenUntil = 0;

  static readonly maximumConsecutiveFailures = 3;
  static readonly failureCooldownMilliseconds = 1_000;

  constructor(
    mdxModuleUrl = import.meta.resolve("@scribe-sdk/mdx"),
    timeoutMilliseconds = 30_000
  ) {
    this.#mdxModuleUrl = mdxModuleUrl;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#worker = this.#createWorker();
  }

  #createWorker(): Worker {
    const source = workerSource(this.#mdxModuleUrl);
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      name: "scribe-studio-compiler"
    });
    worker.on("message", (message: WorkerResult) => {
      if (this.#worker !== worker) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      this.#consecutiveFailures = 0;
      this.#circuitOpenUntil = 0;
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.diagnostics ?? []);
    });
    worker.on("error", (error) => this.#restartWorker(worker, error));
    worker.on("exit", (code) => {
      if (!this.#closed && this.#worker === worker) {
        this.#restartWorker(worker, new Error(`Studio compiler worker exited unexpectedly with code ${code}.`));
      }
    });
    return worker;
  }

  compile(path: string, source: string): Promise<StudioCompilerDiagnostic[]> {
    if (this.#closed) return Promise.reject(new Error("Studio compiler is closed."));
    let worker: Worker;
    try {
      worker = this.#availableWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#restartWorker(
          worker,
          new Error(`Studio compilation exceeded ${this.#timeoutMilliseconds}ms and the compiler worker was restarted.`)
        );
      }, this.#timeoutMilliseconds);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, path, source });
      } catch (error) {
        this.#restartWorker(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error("Studio compiler closed before validation completed."));
    await this.#worker?.terminate();
  }

  #restartWorker(worker: Worker, error: Error): void {
    if (this.#closed || this.#worker !== worker) return;
    this.#worker = undefined;
    this.#rejectPending(error);
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= StudioCompiler.maximumConsecutiveFailures) {
      this.#circuitOpenUntil = Date.now() + StudioCompiler.failureCooldownMilliseconds;
    }
    void worker.terminate();
  }

  #availableWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    if (Date.now() < this.#circuitOpenUntil) {
      throw new Error("Studio compiler is temporarily unavailable after repeated worker failures. Try again shortly.");
    }
    this.#worker = this.#createWorker();
    return this.#worker;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function workerSource(mdxModuleUrl: string): string {
  return `
import { parentPort } from "node:worker_threads";
import { compileScribeMdx } from ${JSON.stringify(mdxModuleUrl)};

parentPort.on("message", async ({ id, path, source }) => {
  try {
    const file = await compileScribeMdx({ path, value: source });
    parentPort.postMessage({
      id,
      diagnostics: file.messages.map((message) => ({
        severity: "warning",
        code: message.ruleId ?? "SCB0001",
        message: message.reason,
        ...(message.line === undefined ? {} : { line: message.line }),
        ...(message.column === undefined ? {} : { column: message.column })
      }))
    });
  } catch (error) {
    const diagnostic = error;
    parentPort.postMessage({
      id,
      diagnostics: [{
        severity: "error",
        code: diagnostic.ruleId ?? "SCB0001",
        message: diagnostic.reason ?? diagnostic.message ?? String(error),
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(diagnostic.column === undefined ? {} : { column: diagnostic.column })
      }]
    });
  }
});
`;
}
