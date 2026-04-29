export type Logger = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

export function createLogger(level = 'info'): Logger {
  const quiet = level === 'silent';
  return {
    info(message, fields = {}) {
      if (!quiet) writeLog('info', message, fields);
    },
    error(message, fields = {}) {
      if (!quiet) writeLog('error', message, fields);
    },
  };
}

function writeLog(level: string, message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}
