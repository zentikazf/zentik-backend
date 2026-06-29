import { sanitizeToolArgs, summarizeToolArgsForLog } from './sanitize-args';

/**
 * Tests del helper sanitizeToolArgs / summarizeToolArgsForLog. Feature #15
 * Capa 5 (R33, R34): los args que devuelve el LLM (where, filters, etc.)
 * pueden contener PII si el usuario hace queries como
 * `list_entity({ entity: 'Client', where: { email: 'x@y.com' } })`. Antes
 * de serializarlos al frontend o loggearlos en backend, redactamos los
 * valores cuyas keys matchean SENSITIVE_KEY_REGEX.
 */
describe('sanitizeToolArgs', () => {
  it('redacts top-level email key', () => {
    const out = sanitizeToolArgs({ email: 'user@x.com', limit: 10 });
    expect(out.email).toBe('[redacted]');
    expect(out.limit).toBe(10);
  });

  it('redacts nested where.email', () => {
    const out = sanitizeToolArgs({
      entity: 'Client',
      where: { email: 'user@x.com', name: 'Acme' },
    });
    expect((out.where as any).email).toBe('[redacted]');
    expect((out.where as any).name).toBe('Acme');
    expect(out.entity).toBe('Client');
  });

  it('redacts multiple sensitive keys (phone, token, password, secret)', () => {
    const out = sanitizeToolArgs({
      phone: '+541112345678',
      token: 'sess_abc',
      password: 'hunter2',
      secret: 'shh',
      apiKey: 'sk_live_xxx',
      keep: 'value',
    });
    expect(out.phone).toBe('[redacted]');
    expect(out.token).toBe('[redacted]');
    expect(out.password).toBe('[redacted]');
    expect(out.secret).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.keep).toBe('value');
  });

  it('redacts adminNotes / closeNote / notes / url', () => {
    const out = sanitizeToolArgs({
      adminNotes: 'private admin',
      closeNote: 'private close',
      notes: 'private',
      url: 'https://s3...',
      title: 'public',
    });
    expect(out.adminNotes).toBe('[redacted]');
    expect(out.closeNote).toBe('[redacted]');
    expect(out.notes).toBe('[redacted]');
    expect(out.url).toBe('[redacted]');
    expect(out.title).toBe('public');
  });

  it('returns {} for non-object input', () => {
    expect(sanitizeToolArgs(null)).toEqual({});
    expect(sanitizeToolArgs(undefined)).toEqual({});
    expect(sanitizeToolArgs('string')).toEqual({});
    expect(sanitizeToolArgs(42)).toEqual({});
    expect(sanitizeToolArgs([1, 2, 3])).toEqual({});
  });

  it('does not mutate input', () => {
    const input = { email: 'a@b.com', nested: { token: 't' } };
    const out = sanitizeToolArgs(input);
    expect(input.email).toBe('a@b.com');
    expect(input.nested.token).toBe('t');
    expect(out.email).toBe('[redacted]');
  });

  it('caps recursion at depth 2 (returns marker for deeper objects)', () => {
    const out = sanitizeToolArgs({
      level1: { level2: { level3: { deeplyNested: 'value' } } },
    });
    // El level2 entra como nested object, pero level3 ya excede depth 2 y
    // se reemplaza por '[object]'.
    expect((out.level1 as any).level2.level3).toBe('[object]');
  });

  it('handles arrays of objects', () => {
    const out = sanitizeToolArgs({
      filters: [{ email: 'a@b.com' }, { name: 'X' }],
    });
    expect((out.filters as any)[0].email).toBe('[redacted]');
    expect((out.filters as any)[1].name).toBe('X');
  });
});

describe('summarizeToolArgsForLog', () => {
  it('returns keys + types without values', () => {
    const out = summarizeToolArgsForLog({
      entity: 'Client',
      where: { email: 'x@y.com' },
      limit: 10,
      ids: ['a', 'b'],
      empty: null,
    });
    expect(out.argsKeys).toEqual(['entity', 'where', 'limit', 'ids', 'empty']);
    expect(out.argsTypes).toEqual({
      entity: 'string',
      where: 'object',
      limit: 'number',
      ids: 'array',
      empty: 'null',
    });
  });

  it('returns empty shape for non-object input', () => {
    expect(summarizeToolArgsForLog(null)).toEqual({ argsKeys: [], argsTypes: {} });
    expect(summarizeToolArgsForLog([1, 2])).toEqual({ argsKeys: [], argsTypes: {} });
  });
});
