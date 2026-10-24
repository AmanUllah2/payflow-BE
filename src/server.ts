import { config } from './config';
import { createApp } from './app';
import { logger } from './lib/logger';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, `API listening on http://localhost:${config.port}`);
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received, closing server');
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error while closing server');
      process.exit(1);
    }
    logger.info('Server closed');
    process.exit(0);
  });
  // Don't hang forever on keep-alive connections
  setTimeout(() => {
    logger.warn('Forcing exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
