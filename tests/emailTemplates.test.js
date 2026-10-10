const {
  createPasswordResetEmail,
  createAssignmentEmail,
  createInternalForwardEmail,
  escapeHtml,
} = require('../src/services/emailTemplates');

describe('emailTemplates', () => {
  test('escapes dynamic HTML content', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'safe'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;safe&#39;',
    );

    const email = createInternalForwardEmail({
      solicitudId: 3,
      userName: '<img src=x onerror=alert(1)>',
      phone: '50612345678',
      message: '<script>alert(1)</script>\nhello',
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>hello');
  });

  test('only creates links for HTTP(S) URLs', () => {
    const assignment = createAssignmentEmail({
      solicitudId: 42,
      agenteNombre: 'Ana',
      tenantNombre: 'Acme',
      loginUrl: 'javascript:alert(1)',
    });
    const reset = createPasswordResetEmail({
      agenteNombre: 'Ana',
      tenantNombre: 'Acme',
      resetUrl: 'https://portal.example/reset?token=a&next=b',
      expiresAt: new Date('2026-10-10T12:00:00Z'),
    });

    expect(assignment.html).not.toContain('href=');
    expect(reset.html).toContain('href="https://portal.example/reset?token=a&amp;next=b"');
  });
});