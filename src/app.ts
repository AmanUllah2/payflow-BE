import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import { healthRouter } from './modules/health/health.routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.headers['x-request-id'] ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health checks are polled constantly; keep them out of info-level logs
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return req.url === '/health' ? 'debug' : 'info';
      },
    }),
  );
  app.use(express.json());

  app.use('/health', healthRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    req.log.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errorHandler);

  return app;
}
