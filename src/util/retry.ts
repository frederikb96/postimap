export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitter: boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelay: 1_000,
  maxDelay: 300_000,
  jitter: true,
};

export function computeDelay(attempt: number, opts: RetryOptions): number {
  const exponential = Math.min(opts.baseDelay * 2 ** attempt, opts.maxDelay);
  if (!opts.jitter) return exponential;
  const jitterFactor = 1 + Math.random() * 0.3;
  return Math.min(exponential * jitterFactor, opts.maxDelay);
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts?: Partial<RetryOptions>,
): Promise<T> {
  const options: RetryOptions = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === options.maxRetries) break;
      const delay = computeDelay(attempt, options);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
