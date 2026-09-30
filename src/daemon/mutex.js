// Every browser touch (generation jobs, MCP tool calls, health probes) runs through one Mutex.
export class Mutex {
  #tail = Promise.resolve();
  #pending = 0;

  get busy() {
    return this.#pending > 0;
  }

  run(fn) {
    this.#pending += 1;
    const result = this.#tail.then(() => fn());
    this.#tail = result.then(() => undefined, () => undefined).finally(() => { this.#pending -= 1; });
    return result;
  }
}
