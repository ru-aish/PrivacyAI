export class BoundedQueue {
  constructor(maxEntries, label = "queue") {
    const normalized = Number(maxEntries);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new TypeError(`${label} capacity must be a positive safe integer.`);
    }
    this.maxEntries = normalized;
    this.values = [];
    this.dropped = 0;
  }

  push(value) {
    if (this.values.length >= this.maxEntries) {
      this.values.shift();
      this.dropped += 1;
    }
    this.values.push(value);
  }

  drain() {
    const values = this.values;
    this.values = [];
    return values;
  }

  get size() {
    return this.values.length;
  }
}
