/** Tiny least-busy worker pool for codec jobs (transfers results back zero-copy). */
export class CodecPool {
  private workers: { w: Worker; busy: number }[] = [];
  private handlers = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private nextId = 1;

  warm: Promise<void> = Promise.resolve();

  constructor(size: number) {
    const created: Worker[] = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./codec-worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const data = e.data as { id: number; t: string; message?: string };
        const h = this.handlers.get(data.id);
        if (!h) return;
        this.handlers.delete(data.id);
        const slot = this.workers.find((x) => x.w === w);
        if (slot) slot.busy--;
        if (data.t === "error") h.rej(new Error(data.message ?? "codec error"));
        else h.res(e.data);
      };
      w.onerror = () => {
        const slot = this.workers.find((x) => x.w === w);
        if (slot) slot.busy = 0;
      };
      this.workers.push({ w, busy: 0 });
      created.push(w);
    }
    // Sequentially pre-warm each codec worker (concurrent cold WASM boots race).
    this.warm = created.reduce(
      (chain, w) =>
        chain.then(() => {
          const slot = this.workers.find((x) => x.w === w);
          if (!slot) return;
          slot.busy++;
          const id = this.nextId++;
          return new Promise<void>((res) => {
            this.handlers.set(id, { res: () => res(), rej: () => res() });
            w.postMessage({ t: "warm", id });
          }).then(() => {
            slot.busy--;
          });
        }),
      Promise.resolve(),
    );
  }

  get size() {
    return this.workers.length;
  }

  stats() {
    return { workers: this.workers.length, busy: this.workers.filter((w) => w.busy > 0).length };
  }

  run<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    let target = this.workers[0];
    for (const w of this.workers) if (w.busy < target.busy) target = w;
    target.busy++;
    return new Promise<T>((res, rej) => {
      this.handlers.set(id, { res, rej });
      target.w.postMessage({ ...msg, id }, transfer);
    });
  }

  terminate() {
    for (const w of this.workers) w.w.terminate();
    this.workers = [];
  }
}
