import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logLevel,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  // Pretty output for local dev; plain JSON lines everywhere else
  ...(config.isProduction || config.env === 'test'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }),
});
