/**
 * @typedef {{ time: number, type: string, [key: string]: unknown }} SimEvent
 */

const MAX_EVENTS_PER_TIMESTAMP = 10_000;

/**
 * Stable min-priority queue. Equal-time events leave in insertion order.
 * Every dequeue counts toward the per-timestamp limit, regardless of whether
 * the event was pre-enqueued or added later by a handler. The count resets
 * whenever the timestamp of the dequeued event changes. Exactly 10,000 are
 * allowed at a timestamp; dequeueing event 10,001 throws a descriptive RangeError.
 */
export class EventQueue {
  #heap = [];
  #nextSequence = 0;
  #processedTime = null;
  #processedAtTime = 0;

  get size() {
    return this.#heap.length;
  }

  get isEmpty() {
    return this.#heap.length === 0;
  }

  /**
   * @param {SimEvent} event
   * @returns {number} The insertion sequence assigned to the event.
   */
  enqueue(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("event must be an object");
    }
    if (!Number.isSafeInteger(event.time) || event.time < 0) {
      throw new RangeError("event.time must be a non-negative safe integer");
    }
    if (this.#nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("event insertion sequence exhausted");
    }

    const node = {
      time: event.time,
      sequence: this.#nextSequence,
      event: Object.freeze({ ...event }),
    };
    this.#nextSequence += 1;
    this.#heap.push(node);
    this.#siftUp(this.#heap.length - 1);
    return node.sequence;
  }

  /** @param {SimEvent} event */
  push(event) {
    return this.enqueue(event);
  }

  /** @returns {SimEvent|null} */
  peek() {
    return this.#heap[0]?.event ?? null;
  }

  /** @returns {SimEvent|null} */
  dequeue() {
    if (this.#heap.length === 0) return null;
    const first = this.#heap[0];
    if (first.time !== this.#processedTime) {
      this.#processedTime = first.time;
      this.#processedAtTime = 0;
    }
    if (this.#processedAtTime >= MAX_EVENTS_PER_TIMESTAMP) {
      throw new RangeError(
        `EventQueue exceeded ${MAX_EVENTS_PER_TIMESTAMP} processed events at simulated time ${first.time}; refusing event ${this.#processedAtTime + 1}`,
      );
    }
    this.#processedAtTime += 1;

    const last = this.#heap.pop();
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
    return first.event;
  }

  /** @returns {SimEvent|null} */
  pop() {
    return this.dequeue();
  }

  clear() {
    this.#heap.length = 0;
  }

  #siftUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#compare(this.#heap[parent], this.#heap[index]) <= 0) break;
      [this.#heap[parent], this.#heap[index]] = [this.#heap[index], this.#heap[parent]];
      index = parent;
    }
  }

  #siftDown(index) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.#heap.length && this.#compare(this.#heap[left], this.#heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.#heap.length && this.#compare(this.#heap[right], this.#heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) return;
      [this.#heap[index], this.#heap[smallest]] = [this.#heap[smallest], this.#heap[index]];
      index = smallest;
    }
  }

  #compare(left, right) {
    return left.time - right.time || left.sequence - right.sequence;
  }
}
