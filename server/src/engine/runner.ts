import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { auth } from '../atlas/auth.js';
import { send, redactHeaders, type HttpResult } from '../atlas/client.js';
import { interpolate, hasUnresolved, tag } from './helpers.js';
import type {
  RunOptions,
  RunRecord,
  TestCase,
  TestResult,
  SafetyLevel,
  VarBag,
} from './types.js';

const ALWAYS_ON: SafetyLevel = 'read';

function emptySummary() {
  return { total: 0, pass: 0, fail: 0, skip: 0, error: 0 };
}

export class RunExecutor extends EventEmitter {
  readonly record: RunRecord;
  private aborted = false;
  private vars: VarBag;

  constructor(tests: TestCase[], options: RunOptions, planMeta?: { id?: string; name?: string }) {
    super();
    this.record = {
      id: `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      planId: planMeta?.id,
      planName: planMeta?.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      options,
      summary: { ...emptySummary(), total: tests.length },
      results: [],
    };
    this.tests = tests;
    this.vars = {
      appId: auth.appId,
      currentUserId: auth.userId,
      adminEmail: auth.adminEmail,
      runTag: tag(),
    };
  }

  private tests: TestCase[];

  abort() {
    this.aborted = true;
  }

  private enabled(level: SafetyLevel, options: RunOptions): boolean {
    if (level === ALWAYS_ON) return true;
    return options.enabledSafety.includes(level);
  }

  async run(): Promise<RunRecord> {
    const { options } = this.record;
    for (const test of this.tests) {
      if (this.aborted) {
        this.record.status = 'aborted';
        break;
      }
      const result = await this.runOne(test, options);
      this.record.results.push(result);
      this.bumpSummary(result.outcome);
      this.emit('result', result);
      this.emit('progress', this.record.summary);

      if (
        options.stopOnFailure &&
        (result.outcome === 'fail' || result.outcome === 'error')
      ) {
        break;
      }
    }
    if (this.record.status === 'running') this.record.status = 'done';
    this.record.finishedAt = new Date().toISOString();
    this.emit('done', this.record);
    return this.record;
  }

  private bumpSummary(outcome: TestResult['outcome']) {
    this.record.summary[outcome] += 1;
  }

  private skeleton(test: TestCase): TestResult {
    return {
      testId: test.id,
      name: test.name,
      endpoint: test.endpoint,
      service: test.service,
      suite: test.suite,
      safety: test.safety,
      outcome: 'skip',
      durationMs: 0,
      failures: [],
      startedAt: new Date().toISOString(),
    };
  }

  private async runOne(test: TestCase, options: RunOptions): Promise<TestResult> {
    const result = this.skeleton(test);

    // Safety gate.
    if (!this.enabled(test.safety, options)) {
      result.outcome = 'skip';
      result.failures.push(`safety level "${test.safety}" not enabled for this run`);
      return result;
    }

    // Auth availability gate.
    const cred = auth.tokenFor(test.auth);
    if (test.auth === 'user' && !cred.token) {
      result.failures.push('no user token (not connected)');
      return result;
    }
    if (test.auth === 'app' && !cred.token) {
      result.failures.push('no app token available (app provisioning failed)');
      return result;
    }
    if (test.auth === 'refresh' && !cred.cookie) {
      result.failures.push('no refresh cookie available');
      return result;
    }

    // Prerequisite variables.
    for (const v of test.requiresVars || []) {
      if (this.vars[v] === undefined || this.vars[v] === null) {
        result.failures.push(`missing prerequisite "${v}" (an earlier step did not produce it)`);
        return result;
      }
    }

    const spec = test.request(this.vars);
    const path = interpolate(spec.path, this.vars);
    if (hasUnresolved(path)) {
      result.failures.push(`unresolved path placeholders: ${path}`);
      return result;
    }

    const body =
      typeof spec.body === 'function'
        ? (spec.body as (v: VarBag) => unknown)(this.vars)
        : spec.body;

    const res: HttpResult = await send({
      service: test.service,
      method: spec.method,
      path,
      query: spec.query,
      body,
      headers: spec.headers,
      token: cred.token,
      cookie: cred.cookie,
      idempotent: spec.method === 'POST' && path.includes('messages:send'),
    });

    result.durationMs = res.durationMs;
    result.status = res.status;
    result.expected = test.expectStatus || [200];
    result.request = {
      method: spec.method,
      url: `${test.service}:${path}`,
      headers: spec.headers ? redactHeaders(spec.headers) : undefined,
      body: body ?? undefined,
    };
    result.response = {
      status: res.status,
      headers: res.headers,
      body: truncate(res.body),
    };

    // Transport failure.
    if (res.status === 0) {
      result.outcome = 'error';
      result.failures.push(res.error || 'transport error');
      return result;
    }

    const expected = test.expectStatus || [200];
    const statusOk = expected.includes(res.status);
    const assertFails = test.assert ? test.assert(res.body, res.status, this.vars) : [];

    if (statusOk && assertFails.length === 0) {
      result.outcome = 'pass';
      // Only capture from a passing response, so downstream steps get real ids.
      if (test.capture) {
        try {
          test.capture(res.body, this.vars);
        } catch (err) {
          result.failures.push(`capture error: ${(err as Error).message}`);
        }
      }
    } else {
      result.outcome = 'fail';
      if (!statusOk) {
        result.failures.push(
          `expected status ${expected.join(' or ')}, got ${res.status}`,
        );
      }
      result.failures.push(...assertFails);
    }
    return result;
  }
}

/** Keep stored response bodies from ballooning run history files. */
function truncate(body: unknown, max = 8000): unknown {
  try {
    const json = JSON.stringify(body);
    if (json && json.length > max) {
      return { _truncated: true, preview: json.slice(0, max) + '…' };
    }
  } catch {
    /* non-serialisable */
  }
  return body;
}
