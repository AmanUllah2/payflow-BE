import { Router } from 'express';

export const healthRouter = Router();

// Liveness only: reports that the process is up, not that Postgres/Redis are reachable
healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
