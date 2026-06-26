function ts() {
  return new Date().toISOString();
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[${ts()}] ${msg}`, meta ? JSON.stringify(meta) : ""),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[${ts()}] ${msg}`, meta ? JSON.stringify(meta) : ""),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(`[${ts()}] ${msg}`, meta ? JSON.stringify(meta) : ""),
};
