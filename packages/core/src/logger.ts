import pino from 'pino';

export const createLogger = (level = 'info') =>
  pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  });
