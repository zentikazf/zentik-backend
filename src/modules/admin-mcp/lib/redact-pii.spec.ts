import { redactPII } from './redact-pii';

/**
 * Tests del helper redactPII. Feature #15 Capa 5 (R30): redacta strings
 * sueltos que pueden contener PII antes de loggear.
 */
describe('redactPII', () => {
  it('redacts emails', () => {
    expect(redactPII('hola user@x.com')).toBe('hola [email]');
    expect(redactPII('a@b.co,c@d.io')).toBe('[email],[email]');
  });

  it('redacts Bearer tokens', () => {
    expect(redactPII('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer [token]',
    );
    expect(redactPII('BEARER xyz')).toBe('Bearer [token]');
  });

  it('redacts long hex sequences (>=32 chars)', () => {
    expect(redactPII('sha=abcdef0123456789abcdef0123456789ab')).toBe('sha=[hex]');
  });

  it('does not redact short hex (<32 chars)', () => {
    // Solo strings hex muy largos (session tokens, sha256, etc.) son ataque.
    // IDs cortos como cuids (cl_xxx) no matchean.
    expect(redactPII('id=cl1234')).toBe('id=cl1234');
  });

  it('no-op for clean strings', () => {
    expect(redactPII('no pii here')).toBe('no pii here');
  });

  it('handles combined payloads', () => {
    const input = 'unauthorized for user@x.com Bearer abc.def.ghi';
    expect(redactPII(input)).toBe('unauthorized for [email] Bearer [token]');
  });
});
