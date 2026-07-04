import { RunExecutor } from './runner.js';
import { selectTests } from '../catalog/index.js';
import { saveRun } from '../store/store.js';
import { logger } from '../log.js';
import type { RunOptions, RunRecord, TestResult } from './types.js';

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

  /** Build + register an executor and wire event → SSE + structured logs. */
  private wire(
    options: RunOptions,
    planMeta?: { id?: string; name?: string },
  ): RunExecutor {
    if (this.active) {
      throw new Error('A run is already in progress.');
    }
    const tests = selectTests(options.testIds);
    const executor = new RunExecutor(tests, options, planMeta);
    this.executor = executor;

    logger.info(
      {
        runId: executor.record.id,
        total: tests.length,
        selection: options.testIds?.length ? options.testIds.length : 'all',
        enabledSafety: options.enabledSafety,
      },
      'run.start',
    );

    executor.on('result', (r: TestResult) => {
      logResult(executor.record.id, r);
      this.emit('result', r);
    });
    executor.on('progress', (s) => this.emit('progress', s));
    executor.on('done', async (record: RunRecord) => {
      this.last = record;
      logger.info(
        { runId: record.id, status: record.status, summary: record.summary },
        'run.done',
      );
      try {
        await saveRun(record);
      } catch {
        /* best-effort persistence */
      }
      this.emit('done', record);
    });

    return executor;
  }

  start(
    options: RunOptions,
    planMeta?: { id?: string; name?: string },
  ): RunRecord {
    const executor = this.wire(options, planMeta);
    this.emit('start', executor.record);
    // Fire and forget; events drive the UI.
    void executor.run();
    return executor.record;
  }

  /**
   * Start a run and resolve with the finished record — the headless path used by
   * the /agent API so a single HTTP call returns the full results.
   */
  startAndWait(
    options: RunOptions,
    planMeta?: { id?: string; name?: string },
  ): Promise<RunRecord> {
    const executor = this.wire(options, planMeta);
    this.emit('start', executor.record);
    // run() resolves with the record after emitting 'done' (which persists it).
    return executor.run();
  }

  abort() {
    this.executor?.abort();
  }
}

/** Per-test log line: info for fail/error (worth surfacing), debug otherwise. */
function logResult(runId: string, r: TestResult): void {
  const fields = {
    runId,
    testId: r.testId,
    service: r.service,
    outcome: r.outcome,
    status: r.status,
    durationMs: r.durationMs,
    ...(r.failures.length ? { failures: r.failures } : {}),
  };
  if (r.outcome === 'fail' || r.outcome === 'error') logger.warn(fields, 'run.result');
  else logger.debug(fields, 'run.result');
}

export const runManager = new RunManager();
