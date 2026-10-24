import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from './logger';

const NS_PER_MS = 1e6;
const toMs = (ns: number) => Math.round((ns / NS_PER_MS) * 100) / 100;

// Samples event-loop delay and logs a summary of each window, then resets so
// every log line covers only the last `intervalMs` rather than the whole uptime.
export function startEventLoopMonitor({ intervalMs = 10_000, resolutionMs = 10 } = {}) {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  const timer = setInterval(() => {
    logger.info(
      {
        eventLoopLagMs: {
          p50: toMs(histogram.percentile(50)),
          p99: toMs(histogram.percentile(99)),
          max: toMs(histogram.max),
        },
      },
      `Event loop lag p99 ${toMs(histogram.percentile(99))}ms`,
    );
    histogram.reset();
  }, intervalMs);
  // Monitoring alone shouldn't keep the process alive
  timer.unref();

  return function stop() {
    clearInterval(timer);
    histogram.disable();
  };
}
