export const CANCELLATION_MESSAGE = 'Generation cancelled by user';

export const createAbortError = (message = CANCELLATION_MESSAGE) => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export const isAbortError = (error) => (
  error?.name === 'AbortError'
  || /(?:cancelled|canceled|aborted)\s+by\s+user/i.test(String(error?.message || error || ''))
);

export const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw createAbortError();
  }
};
