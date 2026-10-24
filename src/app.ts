import { randomUUID } from 'node:crypto';
import express, { type Request } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './modules/health/health.routes';

// Only trust a client-supplied request id if it looks like an id, so it can't
// be used to inject junk into logs or error responses
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Health checks are polled constantly; keep them out of info-level logs
      customLogLevel: (req, res, err) => {
        // Express rewrites req.url inside mounted routers, so match on originalUrl
        const path = ((req as Request).originalUrl ?? req.url ?? '').split('?')[0] ?? '';
        const isHealth = path === '/health' || path.startsWith('/health/');
        // A 503 from /health/ready is expected while draining, not a server error
        if (isHealth && !err) return res.statusCode >= 400 ? 'warn' : 'debug';
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );
  // Health probes are mounted before body parsing, auth and rate limiting so
  // orchestrators can always reach them and they never consume a client's quota
  app.use('/health', healthRouter);

  // Rate limiting and auth middleware go here, after health

  app.use(express.json());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
