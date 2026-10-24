import { Router } from 'express';
import { getReadiness } from './readiness';

export const healthRouter = Router();

// Liveness: the process is up and the event loop is responding. Never checks
// dependencies, so a Postgres outage doesn't get the process restarted.
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Readiness: every registered dependency is reachable and we aren't shutting down.
// 503 tells a load balancer to stop sending traffic without restarting the process.
healthRouter.get('/ready', async (_req, res) => {
  const { ready, body } = await getReadiness();
  res.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json(body);
});
