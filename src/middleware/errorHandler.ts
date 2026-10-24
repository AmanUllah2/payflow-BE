import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, notFound } from '../lib/errors';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    traceId: string;
    details?: unknown;
  };
}

// Errors raised by express.json() (body-parser) carry a `type` and `status`
interface BodyParserError extends Error {
  type: string;
  status: number;
}

const isBodyParserError = (err: unknown): err is BodyParserError =>
  err instanceof Error && typeof (err as BodyParserError).type === 'string' && 'status' in err;

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.flatten());
  }

  if (isBodyParserError(err)) {
    if (err.type === 'entity.parse.failed') {
      return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    }
    if (err.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (err.status < 500) {
      return new AppError(err.status, 'BAD_REQUEST', err.message);
    }
  }

  // Unknown error: never leak its message or stack to the client
  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Response already streaming: let Express close the connection
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);

  if (appError.status >= 500) {
    req.log.error({ err }, 'Unhandled error');
  } else {
    req.log.debug({ err }, 'Request failed');
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      traceId: String(req.id),
      ...(appError.details !== undefined && { details: appError.details }),
    },
  };

  res.status(appError.status).json(body);
};
