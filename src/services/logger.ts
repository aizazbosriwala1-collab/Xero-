type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function maskSensitive(val: string): string {
  if (!val) return '';
  if (val.length <= 8) return '***';
  return `${val.substring(0, 3)}...${val.substring(val.length - 3)}`;
}

export function sanitizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Check if string looks like a token, secret, or URL with credentials
    if (/postgres(ql)?:\/\/.*:.*@/i.test(obj)) {
      return obj.replace(/(postgres(?:ql)?:\/\/)(.*?:)(.*?)(@)/i, '$1***:***$4');
    }
    if (/redis:\/\/.*:.*@/i.test(obj)) {
      return obj.replace(/(redis:\/\/)(.*?:)(.*?)(@)/i, '$1***:***$4');
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  if (typeof obj === 'object') {
    const sensitiveKeys = [
      'key', 'secret', 'token', 'authorization', 'password', 'signature',
      'apikey', 'api_key', 'api_secret', 'webhook_secret', 'credential',
      'credentials', 'receiverid', 'receiver_id', 'binance_transaction_id',
      'delivery_encryption_key', 'encryption_key', 'encryptionkey', 'delivered_items',
      'content', 'plaintext'
    ];
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = k.toLowerCase();
      if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
        result[k] = typeof v === 'string' ? maskSensitive(v) : '[REDACTED]';
      } else {
        result[k] = sanitizeObject(v);
      }
    }
    return result;
  }
  return obj;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const sanitizedMeta = meta ? sanitizeObject(meta) : undefined;
    const output = {
      timestamp,
      level: level.toUpperCase(),
      context: this.context,
      message,
      ...(sanitizedMeta ? { meta: sanitizedMeta } : {}),
    };

    if (level === 'error') {
      console.error(JSON.stringify(output));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(output));
    } else {
      console.log(JSON.stringify(output));
    }
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>) {
    this.log('error', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.log('debug', message, meta);
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}
