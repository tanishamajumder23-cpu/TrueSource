/**
 * Tiny structured logger.
 *
 * Deliberately dependency-free: a hackathon judge cloning this repo shouldn't
 * need a logging stack to read the output. Each line is prefixed with a level
 * and a scope so it's obvious which stage of the pipeline produced it.
 */

const LEVEL_STYLES = {
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
  debug: 'DEBUG',
};

function emit(level, scope, message, meta) {
  const time = new Date().toISOString();
  const line = `${time} ${LEVEL_STYLES[level]} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : console.log;
  if (meta !== undefined) sink(line, meta);
  else sink(line);
}

/** Create a logger bound to a scope, e.g. createLogger('evidence'). */
function createLogger(scope) {
  return {
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    debug: (msg, meta) => {
      if (process.env.DEBUG === 'true') emit('debug', scope, msg, meta);
    },
  };
}

module.exports = { createLogger };
