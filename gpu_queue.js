// SPDX-License-Identifier: GPL-2.0-or-later
// Bounded queue for a single producer. Acquire capacity BEFORE encoding or
// queue.write* calls; retry after waitForCapacity(). No scene data is retained
// here: the suspended C++ caller owns it until submission succeeds.
export class GpuQueue {
  constructor(queue, { maxInFlight = 6, now = () => performance.now(),
    timeoutMs = 15000, onEvent = () => {}, onFailure = () => {} } = {}) {
    this.queue = queue;
    this.limit = maxInFlight;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.submitted = 0;
    this.completed = 0;
    this.pending = null;
    this.failure = null;
    this.metrics = { peakInFlight: 0, queueWaits: 0, queueWaitMs: 0, queueWaitMaxMs: 0,
      completionProbes: 0, completionLastMs: 0, completionMaxMs: 0 };
    this.completionTotalMs = 0;
  }

  hasCapacity() {
    if (this.failure) throw this.failure;
    return this.limit === 0 || this.submitted - this.completed < this.limit;
  }

  submit(commands) {
    if (!this.hasCapacity()) throw new Error('GPU queue capacity must be acquired before encoding');
    this.queue.submit(commands);
    ++this.submitted;
    this.metrics.peakInFlight = Math.max(this.metrics.peakInFlight, this.submitted - this.completed);
    this.onEvent('submit', `#${this.submitted}`);
    this.probe();
  }

  probe() {
    if (this.pending) return this.pending.promise;
    if (this.failure || this.completed === this.submitted) return Promise.resolve();
    const probe = { serial: this.submitted, started: this.now() };
    probe.promise = new Promise(resolve => { probe.resolve = resolve; });
    this.pending = probe;
    probe.timer = setTimeout(() => this.fail(new Error(
      `GPU queue made no observed progress for ${this.timeoutMs} ms (through ${probe.serial})`)), this.timeoutMs);
    try {
      this.queue.onSubmittedWorkDone().then(() => {
        if (this.pending !== probe) return; // lost/failed device; ignore late completion
        clearTimeout(probe.timer);
        const elapsed = this.now() - probe.started;
        ++this.metrics.completionProbes;
        this.metrics.completionLastMs = elapsed;
        this.metrics.completionMaxMs = Math.max(this.metrics.completionMaxMs, elapsed);
        this.completionTotalMs += elapsed;
        // A probe covers only submissions made BEFORE its registration.
        this.completed = probe.serial;
        this.pending = null;
        this.onEvent('completed', `through=${probe.serial} observed_ms=${elapsed.toFixed(1)}`);
        // Track the remaining tail immediately, even if the guest stops
        // submitting. Never leave capacity stale until a stats timer fires.
        this.probe();
        probe.resolve();
      }, error => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
    return probe.promise;
  }

  async waitForCapacity() {
    if (this.hasCapacity()) return;
    const started = this.now();
    ++this.metrics.queueWaits;
    try {
      while (!this.hasCapacity()) await this.probe();
    } finally {
      const elapsed = this.now() - started;
      this.metrics.queueWaitMs += elapsed;
      this.metrics.queueWaitMaxMs = Math.max(this.metrics.queueWaitMaxMs, elapsed);
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve(); // waiters recheck hasCapacity(), which throws
      this.pending = null;
    }
    this.onEvent('queue-error', this.failure.message);
    this.onFailure(this.failure);
  }

  snapshot() {
    return { ...this.metrics, submitSerial: this.submitted, completedSerial: this.completed,
      inFlight: this.submitted - this.completed, maxInFlight: this.limit,
      completionAvgMs: this.metrics.completionProbes ? this.completionTotalMs / this.metrics.completionProbes : 0,
      completionPendingMs: this.pending ? this.now() - this.pending.started : 0 };
  }
}
