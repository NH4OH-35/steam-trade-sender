const INITIAL_BACKOFF = 30000;
const MAX_BACKOFF = 300000;

function rateLimited(error) {
  return Number(error.statusCode || error.status || error.response?.statusCode) === 429
    || Number(error.eresult) === 84
    || /429|RateLimitExceeded|rate.?limit|too many requests/i.test(error.message || '');
}

function retryDelay(error, previousBackoff, now) {
  const retryAfter = error.retryAfter || error.response?.headers?.['retry-after'];
  const requestedDelay = Number.isFinite(Number(retryAfter))
    ? Number(retryAfter) * 1000
    : Math.max(0, Date.parse(retryAfter) - now) || 0;
  const backoff = previousBackoff ? previousBackoff * 2 : INITIAL_BACKOFF;
  return Math.max(Math.min(backoff, MAX_BACKOFF), requestedDelay);
}

module.exports = { rateLimited, retryDelay };
