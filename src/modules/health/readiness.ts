import { logger } from '../../lib/logger';

// A dependency check resolves if the dependency is usable and throws otherwise.
// The db and redis modules register theirs, e.g. `() => pool.query('select 1')`.
type ReadinessCheck = () => Promise<unknown>;

interface CheckResult {
  status: 'up' | 'down';
  latencyMs: number;
}

const CHECK_TIMEOUT_MS = 2_000;

const checks = new Map<string, ReadinessCheck>();
let shuttingDown = false;

export function registerReadinessCheck(name: string, check: ReadinessCheck) {
  checks.set(name, check);
}

// Called on SIGTERM so load balancers stop routing here while in-flight requests finish
export function markShuttingDown() {
  shuttingDown = true;
}

async function runCheck(name: string, check: ReadinessCheck): Promise<CheckResult> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    // Details stay in the logs; driver errors can include hosts or credentials
    logger.warn({ err, check: name }, 'Readiness check failed');
    return { status: 'down', latencyMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

export async function getReadiness() {
  const entries = await Promise.all(
    [...checks].map(async ([name, check]) => [name, await runCheck(name, check)] as const),
  );
  const results = Object.fromEntries(entries);
  const ready = !shuttingDown && entries.every(([, r]) => r.status === 'up');

  return {
    ready,
    body: {
      status: ready ? 'ready' : 'not_ready',
      ...(shuttingDown && { reason: 'shutting_down' }),
      checks: results,
      timestamp: new Date().toISOString(),
    },
  };
}
