type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min = (process.env.LOG_LEVEL as Level) ?? 'info';

const fmt = (level: Level, mod: string, msg: string, extra?: unknown) => {
  if (ORDER[level] < ORDER[min]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${mod}] ${msg}`;
  if (extra !== undefined) console.log(line, safe(extra));
  else console.log(line);
};

const safe = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export const logger = (mod: string) => ({
  debug: (m: string, e?: unknown) => fmt('debug', mod, m, e),
  info: (m: string, e?: unknown) => fmt('info', mod, m, e),
  warn: (m: string, e?: unknown) => fmt('warn', mod, m, e),
  error: (m: string, e?: unknown) => fmt('error', mod, m, e),
});
