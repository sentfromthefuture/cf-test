import { Logger } from '../functions/_shared/collector/index.ts';
export const silentLogger: Logger = { info() {}, warn: (m, e) => console.warn('warn', m, JSON.stringify(e ?? {})), error: (m, e) => console.error('error', m, JSON.stringify(e ?? {})) };
