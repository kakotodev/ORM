/** Runs async tasks strictly one after another, in call order. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    // A failing task must not poison the queue.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
