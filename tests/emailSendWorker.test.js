jest.mock('../src/services/database', () => ({
  updateEmailLogStatus: jest.fn(),
}));

jest.mock('../src/services/redis', () => ({
  getRedisClient: jest.fn(),
}));

jest.mock('../src/services/emailService', () => ({
  EMAIL_QUEUE_KEY: 'queue:email_send',
  sendEmail: jest.fn(),
  isRetryableError: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../src/services/database');
const emailService = require('../src/services/emailService');
const { processEmail, processQueuedJob, promoteDueRetries, recoverInFlight } = require('../src/workers/emailSendWorker');

describe('emailSendWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks a delivered email as sent', async () => {
    emailService.sendEmail.mockResolvedValue({ messageId: 'mail-1' });

    await processEmail({
      to: 'recipient@example.com',
      subject: 'Test',
      emailLogId: 21,
      attempts: 0,
    }, {});

    expect(db.updateEmailLogStatus).toHaveBeenCalledWith(21, 'sent', {
      attempts: 1,
      messageId: 'mail-1',
      lastError: null,
    });
  });

  test('schedules transient failures without sleeping the worker', async () => {
    emailService.sendEmail.mockRejectedValue(new Error('SMTP temporarily unavailable'));
    emailService.isRetryableError.mockReturnValue(true);
    const redis = { zadd: jest.fn().mockResolvedValue(1), lpush: jest.fn() };

    await processEmail({
      to: 'recipient@example.com',
      subject: 'Test',
      emailLogId: 22,
      attempts: 0,
    }, redis);

    expect(redis.zadd).toHaveBeenCalledWith('queue:email_send:delayed', expect.any(Number), expect.any(String));
    expect(db.updateEmailLogStatus).toHaveBeenCalledWith(22, 'retrying', {
      attempts: 1,
      lastError: 'SMTP temporarily unavailable',
    });
  });

  test('moves permanent failures to the dead-letter queue', async () => {
    emailService.sendEmail.mockRejectedValue(Object.assign(new Error('Invalid payload'), { code: 'EMAIL_RECIPIENT_INVALID' }));
    emailService.isRetryableError.mockReturnValue(false);
    const redis = { lpush: jest.fn().mockResolvedValue(1), zadd: jest.fn() };

    await processEmail({
      to: 'bad-address',
      subject: 'Test',
      emailLogId: 23,
      attempts: 0,
    }, redis);

    expect(redis.lpush).toHaveBeenCalledWith('queue:email_send:dead', expect.any(String));
    expect(db.updateEmailLogStatus).toHaveBeenCalledWith(23, 'failed', {
      attempts: 1,
      lastError: 'Invalid payload',
    });
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  test('uses atomic redis scripts to recover and promote jobs', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(2) };

    await expect(recoverInFlight(redis)).resolves.toBe(2);
    await expect(promoteDueRetries(redis)).resolves.toBe(2);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[0][2]).toMatch(/^queue:email_send:processing:/);
    expect(redis.eval.mock.calls[0][3]).toBe('queue:email_send');
    expect(redis.eval.mock.calls[1][2]).toBe('queue:email_send:delayed');
  });

  test('returns a job to the pending queue if Redis fails while processing', async () => {
    emailService.sendEmail.mockRejectedValue(new Error('SMTP unavailable'));
    emailService.isRetryableError.mockReturnValue(true);
    const redis = {
      zadd: jest.fn().mockRejectedValue(new Error('Redis connection lost')),
      lrem: jest.fn().mockResolvedValue(1),
      lpush: jest.fn().mockResolvedValue(1),
    };
    const raw = JSON.stringify({ to: 'recipient@example.com', subject: 'Test', attempts: 0 });

    await expect(processQueuedJob(raw, redis)).rejects.toThrow('Redis connection lost');

    expect(redis.lrem).toHaveBeenCalledWith(expect.stringMatching(/processing:/), 1, raw);
    expect(redis.lpush).toHaveBeenCalledWith('queue:email_send', raw);
  });
});