import os from 'node:os';
import path from 'node:path';

/** Runtime configuration, read once at startup from env vars and CLI flags. */
export interface Config {
  host: string;
  port: number;
  /** Path of the JWT that flipper-server writes; re-read on every reconnect. */
  tokenPath: string;
  /** Explicit token (overrides tokenPath). */
  token?: string;
  buffers: {
    logs: number;
    network: number;
    prefs: number;
    flux: number;
    events: number;
  };
  /** Bytes of body kept in previews (get_network_request without full=true). */
  bodyPreviewBytes: number;
  /** Bodies larger than this are not stored at all (only their size). */
  maxStoredBodyBytes: number;
  /** Max chars of a log message returned by get_logs. */
  logMessageMaxChars: number;
  /** HTTP header used to correlate requests with Flux actions. */
  traceHeader: string;
  /** Plugins initialised automatically on every app connection. */
  autoInitPlugins: string[];
  /** Re-send `init` for autoInitPlugins this often (another UI may have sent `deinit`). */
  reinitIntervalMs: number;
  execTimeoutMs: number;
  /** When set, every raw WS frame is appended to this JSONL file. */
  recordPath?: string;
}

const DEFAULT_AUTO_INIT = ['Network', 'Preferences', 'ui-debugger', 'FluxDispatcher'];

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

export function defaultTokenPath(home = os.homedir()): string {
  return path.join(home, '.flipper', 'certs', 'auth.token');
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): Config {
  const autoInit = env.FLIPPER_AUTO_INIT_PLUGINS;
  return {
    host: flag(argv, '--host') ?? env.FLIPPER_HOST ?? 'localhost',
    port: int(flag(argv, '--port') ?? env.FLIPPER_PORT, 52342, 'FLIPPER_PORT'),
    tokenPath: env.FLIPPER_TOKEN_PATH || defaultTokenPath(),
    token: env.FLIPPER_TOKEN || undefined,
    buffers: {
      logs: int(env.FLIPPER_LOG_BUFFER, 5000, 'FLIPPER_LOG_BUFFER'),
      network: int(env.FLIPPER_NETWORK_BUFFER, 500, 'FLIPPER_NETWORK_BUFFER'),
      prefs: int(env.FLIPPER_PREFS_BUFFER, 500, 'FLIPPER_PREFS_BUFFER'),
      flux: int(env.FLIPPER_FLUX_BUFFER, 1000, 'FLIPPER_FLUX_BUFFER'),
      events: int(env.FLIPPER_EVENT_BUFFER, 200, 'FLIPPER_EVENT_BUFFER'),
    },
    bodyPreviewBytes: int(env.FLIPPER_BODY_PREVIEW_BYTES, 2048, 'FLIPPER_BODY_PREVIEW_BYTES'),
    maxStoredBodyBytes: int(env.FLIPPER_MAX_BODY_BYTES, 1024 * 1024, 'FLIPPER_MAX_BODY_BYTES'),
    logMessageMaxChars: int(env.FLIPPER_LOG_MAX_CHARS, 1000, 'FLIPPER_LOG_MAX_CHARS'),
    traceHeader: (env.FLIPPER_TRACE_HEADER || 'x-flux-trace-id').toLowerCase(),
    autoInitPlugins: autoInit
      ? autoInit.split(',').map((p) => p.trim()).filter(Boolean)
      : DEFAULT_AUTO_INIT,
    reinitIntervalMs: int(env.FLIPPER_REINIT_MS, 5000, 'FLIPPER_REINIT_MS'),
    execTimeoutMs: int(env.FLIPPER_EXEC_TIMEOUT_MS, 15000, 'FLIPPER_EXEC_TIMEOUT_MS'),
    recordPath: flag(argv, '--record') ?? (env.FLIPPER_RECORD || undefined),
  };
}
