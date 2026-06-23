import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { RunRecord, TestPlan } from '../engine/types.js';

/**
 * File-backed persistence on the mounted PVC. Test plans are individual JSON
 * files (matching the "save to a test configuration file" requirement, so they
 * can be exported/imported); run history is also one JSON file per run plus a
 * lightweight index for listing.
 */

const plansDir = () => path.join(config.dataDir, 'plans');
const runsDir = () => path.join(config.dataDir, 'runs');

async function ensureDirs() {
  await fs.mkdir(plansDir(), { recursive: true });
  await fs.mkdir(runsDir(), { recursive: true });
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48) || 'plan'
  );
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ───────────────────────────── Plans ─────────────────────────────

export async function listPlans(): Promise<TestPlan[]> {
  await ensureDirs();
  const files = await fs.readdir(plansDir());
  const plans: TestPlan[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = await readJson<TestPlan>(path.join(plansDir(), f));
    if (p) plans.push(p);
  }
  plans.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return plans;
}

export async function getPlan(id: string): Promise<TestPlan | null> {
  await ensureDirs();
  return readJson<TestPlan>(path.join(plansDir(), `${id}.json`));
}

export async function savePlan(
  input: Omit<TestPlan, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string;
  },
): Promise<TestPlan> {
  await ensureDirs();
  const now = new Date().toISOString();
  const id = input.id || `${slug(input.name)}-${randomUUID().slice(0, 6)}`;
  const existing = input.id ? await getPlan(input.id) : null;
  const plan: TestPlan = {
    id,
    name: input.name,
    description: input.description,
    testIds: input.testIds,
    enabledSafety: input.enabledSafety,
    stopOnFailure: input.stopOnFailure,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await fs.writeFile(
    path.join(plansDir(), `${id}.json`),
    JSON.stringify(plan, null, 2),
  );
  return plan;
}

export async function deletePlan(id: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(plansDir(), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── Runs ──────────────────────────────

export interface RunIndexEntry {
  id: string;
  planName?: string;
  startedAt: string;
  finishedAt?: string;
  status: RunRecord['status'];
  summary: RunRecord['summary'];
}

export async function saveRun(run: RunRecord): Promise<void> {
  await ensureDirs();
  await fs.writeFile(
    path.join(runsDir(), `${run.id}.json`),
    JSON.stringify(run, null, 2),
  );
}

export async function getRun(id: string): Promise<RunRecord | null> {
  await ensureDirs();
  return readJson<RunRecord>(path.join(runsDir(), `${id}.json`));
}

export async function listRuns(limit = 50): Promise<RunIndexEntry[]> {
  await ensureDirs();
  const files = (await fs.readdir(runsDir()))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);
  const entries: RunIndexEntry[] = [];
  for (const f of files) {
    const r = await readJson<RunRecord>(path.join(runsDir(), f));
    if (r) {
      entries.push({
        id: r.id,
        planName: r.planName,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        status: r.status,
        summary: r.summary,
      });
    }
  }
  entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return entries;
}
