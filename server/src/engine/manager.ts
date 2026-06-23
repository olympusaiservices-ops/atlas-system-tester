import { RunExecutor } from './runner.js';
import { selectTests } from '../catalog/index.js';
import { saveRun } from '../store/store.js';
import type { RunOptions, RunRecord } from './types.js';

type Listener = (event: string, data: unknown) => void;

/**
 * Owns the single active run (serialized — only one run executes at a time so
 * lifecycle var capture and the live cluster are not raced) and fans run events
 * out to connected SSE clients.
 */
class RunManager {
  private executor: RunExecutor | null = null;
  private listeners = new Set<Listener>();
  private last: RunRecord | null = null;

  get active(): boolean {
    return this.executor?.record.status === 'running';
  }

  current(): RunRecord | null {
    return this.executor?.record || this.last;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: string, data: unknown) {
    for (const l of this.listeners) l(event, data);
  }

  start(
    options: RunOptions,
    planMeta?: { id?: string; name?: string },
  ): RunRecord {
    if (this.active) {
      throw new Error('A run is already in progress.');
    }
    const tests = selectTests(options.testIds);
    const executor = new RunExecutor(tests, options, planMeta);
    this.executor = executor;

    executor.on('result', (r) => this.emit('result', r));
    executor.on('progress', (s) => this.emit('progress', s));
    executor.on('done', async (record: RunRecord) => {
      this.last = record;
      try {
        await saveRun(record);
      } catch {
        /* best-effort persistence */
      }
      this.emit('done', record);
    });

    this.emit('start', executor.record);
    // Fire and forget; events drive the UI.
    void executor.run();
    return executor.record;
  }

  abort() {
    this.executor?.abort();
  }
}

export const runManager = new RunManager();
