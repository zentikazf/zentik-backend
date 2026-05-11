/**
 * Email templates for Zentikk platform.
 * All templates return raw HTML strings — no external dependencies.
 */

const BRAND_COLOR = '#6366f1';
const BRAND_BG = '#f8fafc';

function layout(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
<tr><td style="padding:32px 40px 24px;text-align:center;border-bottom:1px solid #e2e8f0">
  <h1 style="margin:0;font-size:22px;font-weight:700;color:${BRAND_COLOR}">Zentikk</h1>
</td></tr>
<tr><td style="padding:32px 40px">${content}</td></tr>
<tr><td style="padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
  &copy; ${new Date().getFullYear()} Zentikk. Todos los derechos reservados.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(text: string, url: string): string {
  return `<table cellpadding="0" cellspacing="0" style="margin:24px auto"><tr><td>
<a href="${url}" style="display:inline-block;padding:12px 32px;background:${BRAND_COLOR};color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px">${text}</a>
</td></tr></table>`;
}

// ─── TEMPLATES ────────────────────────────────────────────────────────

export function welcomeEmail(name: string, loginUrl: string): string {
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Bienvenido a Zentikk, ${name}</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">
  Tu cuenta fue creada exitosamente. Ya puedes acceder a la plataforma para gestionar tus proyectos y equipo.
</p>
${button('Iniciar sesion', loginUrl)}
<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">Si no creaste esta cuenta, puedes ignorar este correo.</p>
  `);
}

export function verifyEmailTemplate(name: string, verifyUrl: string): string {
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Verifica tu correo, ${name}</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">
  Gracias por registrarte en Zentikk. Para completar tu registro y activar tu cuenta, verifica tu correo electronico.
</p>
${button('Verificar correo', verifyUrl)}
<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">Si no creaste esta cuenta, puedes ignorar este correo. El enlace expira en 24 horas.</p>
  `);
}

export function teamInviteEmail(params: {
  memberName: string;
  invitedByName: string;
  organizationName: string;
  roleName: string;
  temporaryPassword: string;
  loginUrl: string;
}): string {
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Te invitaron a ${params.organizationName}</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
  <strong>${params.invitedByName}</strong> te invito a unirte al equipo como <strong>${params.roleName}</strong>.
</p>
<div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:0 0 16px">
  <p style="margin:0 0 8px;color:#475569;font-size:13px">Tus credenciales temporales:</p>
  <p style="margin:0;color:#1e293b;font-size:14px"><strong>Email:</strong> el correo donde recibiste este mensaje</p>
  <p style="margin:4px 0 0;color:#1e293b;font-size:14px"><strong>Contrasena temporal:</strong> <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:13px">${params.temporaryPassword}</code></p>
</div>
<p style="color:#ef4444;font-size:12px;margin:0 0 8px">Se te pedira cambiar la contrasena en tu primer inicio de sesion.</p>
${button('Aceptar invitacion', params.loginUrl)}
  `);
}

export function clientUserEmail(params: {
  clientName: string;
  organizationName: string;
  email: string;
  temporaryPassword: string;
  portalUrl: string;
}): string {
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Acceso al Portal de ${params.organizationName}</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
  Se creo una cuenta de acceso al portal de clientes para <strong>${params.clientName}</strong>.
  Desde el portal puedes ver el progreso de tus proyectos, crear tickets de soporte y comunicarte con el equipo.
</p>
<div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:0 0 16px">
  <p style="margin:0 0 8px;color:#475569;font-size:13px">Tus credenciales:</p>
  <p style="margin:0;color:#1e293b;font-size:14px"><strong>Email:</strong> ${params.email}</p>
  <p style="margin:4px 0 0;color:#1e293b;font-size:14px"><strong>Contrasena:</strong> <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:13px">${params.temporaryPassword}</code></p>
</div>
${button('Acceder al Portal', params.portalUrl)}
<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">Te recomendamos cambiar tu contrasena despues del primer ingreso.</p>
  `);
}

export function passwordResetEmail(params: {
  name: string;
  resetUrl: string;
  expiresInHours: number;
  requestIp?: string;
}): string {
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Restablecer tu contrasena</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">
  Hola ${params.name}, recibimos una solicitud para restablecer la contrasena de tu cuenta.
  Si fuiste tu, haz clic en el boton de abajo para crear una nueva contrasena.
</p>
${button('Restablecer contrasena', params.resetUrl)}
<p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:16px 0 0">
  El enlace expira en <strong>${params.expiresInHours} ${params.expiresInHours === 1 ? 'hora' : 'horas'}</strong> por seguridad.
  ${params.requestIp ? `Solicitud originada desde IP <strong>${params.requestIp}</strong>.` : ''}
</p>
<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">
  Si no solicitaste este cambio, puedes ignorar este correo — tu contrasena seguira siendo la misma.
  Por seguridad, te recomendamos revisar tus sesiones activas si no reconoces esta actividad.
</p>
  `);
}

export function passwordChangedEmail(params: {
  name: string;
  changedAt: Date;
  ipAddress?: string;
  supportUrl: string;
}): string {
  const formattedDate = params.changedAt.toLocaleString('es-PY', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'America/Asuncion',
  });
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Tu contrasena fue actualizada</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
  Hola ${params.name}, la contrasena de tu cuenta fue cambiada exitosamente.
</p>
<div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:0 0 16px">
  <p style="margin:0;color:#475569;font-size:13px"><strong>Fecha:</strong> ${formattedDate}</p>
  ${params.ipAddress ? `<p style="margin:8px 0 0;color:#475569;font-size:13px"><strong>Direccion IP:</strong> ${params.ipAddress}</p>` : ''}
</div>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
  Por seguridad, todas las otras sesiones activas fueron cerradas automaticamente.
  Deberas iniciar sesion nuevamente en tus otros dispositivos.
</p>
<div style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:4px;padding:12px 16px;margin:16px 0">
  <p style="margin:0;color:#991b1b;font-size:13px;line-height:1.6">
    <strong>Si no fuiste tu</strong>, tu cuenta puede estar comprometida.
    Restablece tu contrasena inmediatamente y contacta a soporte.
  </p>
</div>
${button('Contactar a soporte', params.supportUrl)}
  `);
}

export function clientSubUserEmail(params: {
  userName: string;
  clientName: string;
  organizationName: string;
  email: string;
  temporaryPassword: string;
  portalUrl: string;
}): string {
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">Invitacion al Portal — ${params.organizationName}</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 16px">
  Fuiste agregado como usuario de <strong>${params.clientName}</strong> en la plataforma de ${params.organizationName}.
</p>
<div style="background:#f1f5f9;border-radius:8px;padding:16px;margin:0 0 16px">
  <p style="margin:0 0 8px;color:#475569;font-size:13px">Tus credenciales:</p>
  <p style="margin:0;color:#1e293b;font-size:14px"><strong>Email:</strong> ${params.email}</p>
  <p style="margin:4px 0 0;color:#1e293b;font-size:14px"><strong>Contrasena temporal:</strong> <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:13px">${params.temporaryPassword}</code></p>
</div>
<p style="color:#ef4444;font-size:12px;margin:0 0 8px">Deberas cambiar la contrasena en tu primer inicio de sesion.</p>
${button('Acceder al Portal', params.portalUrl)}
  `);
}

/**
 * Template parametrizable para notificaciones por email.
 * Espejo del push del navegador: mismo titulo, mismo mensaje, mismo link.
 * Siempre incluye footer con link a preferencias para opt-out granular.
 */
export function notificationEmail(params: {
  title: string;
  message: string;
  ctaUrl?: string;
  ctaLabel?: string;
  preferencesUrl: string;
}): string {
  const cta = params.ctaUrl ? button(params.ctaLabel ?? 'Ver detalle', params.ctaUrl) : '';
  return layout(`
<h2 style="margin:0 0 16px;font-size:18px;color:#1e293b">${escapeHtml(params.title)}</h2>
<p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">
  ${escapeHtml(params.message)}
</p>
${cta}
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0">
  <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.5">
    Recibiste este correo porque tienes activadas las notificaciones por email para este tipo de evento.
    <a href="${params.preferencesUrl}" style="color:${BRAND_COLOR};text-decoration:none">Administrar notificaciones</a>.
  </p>
</div>
  `);
}

/** Escapa caracteres HTML para prevenir inyeccion en templates */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Template ULTRA-profesional para emails enviados al cliente final del portal.
 * Branding de la organizacion (no de Zentikk). Logo personalizado, saludo personalizado,
 * preview del mensaje real, badge de estado y CTA hacia el portal.
 *
 * Diferencias con notificationEmail() (template team):
 * - Header con logo/nombre de la ORGANIZACION (no "Zentikk")
 * - Saludo personalizado al cliente
 * - Quote block del mensaje real
 * - Badge de estado opcional
 * - Footer menciona Zentikk solo como "plataforma usada por {Org}"
 */
export function clientNotificationEmail(params: {
  organizationName: string;
  organizationLogo: string | null;
  clientName: string;
  contextLine: string;
  quoteContent?: string;
  statusBadge?: { label: string; tone: 'info' | 'success' | 'warning' };
  ctaPrimary: { label: string; url: string };
  ctaSecondary?: { label: string; url: string };
  preferencesUrl: string;
}): string {
  const orgName = escapeHtml(params.organizationName);
  const header = params.organizationLogo
    ? `<img src="${escapeHtml(params.organizationLogo)}" alt="${orgName}" style="max-height:36px;max-width:180px;display:inline-block" />`
    : `<span style="font-size:20px;font-weight:700;color:#1e293b;letter-spacing:-0.01em">${orgName}</span>`;

  const quote = params.quoteContent
    ? `
<blockquote style="margin:16px 0 20px;padding:14px 18px;background:#f8fafc;border-left:3px solid ${BRAND_COLOR};border-radius:4px;color:#475569;font-size:14px;line-height:1.6;font-style:italic">
  ${escapeHtml(params.quoteContent)}
</blockquote>`
    : '';

  const badge = params.statusBadge
    ? `
<div style="margin:0 0 20px">
  <span style="display:inline-block;padding:4px 10px;background:${badgeBg(params.statusBadge.tone)};color:${badgeText(params.statusBadge.tone)};font-size:12px;font-weight:600;border-radius:6px">${escapeHtml(params.statusBadge.label)}</span>
</div>`
    : '';

  const secondary = params.ctaSecondary
    ? `
<p style="text-align:center;margin:8px 0 0">
  <a href="${escapeHtml(params.ctaSecondary.url)}" style="color:${BRAND_COLOR};font-size:13px;text-decoration:none">${escapeHtml(params.ctaSecondary.label)}</a>
</p>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">

<tr><td style="padding:28px 40px 22px;border-bottom:1px solid #e2e8f0">
  ${header}
</td></tr>

<tr><td style="padding:32px 40px">
  <p style="margin:0 0 8px;color:#0f172a;font-size:16px;font-weight:600">Hola ${escapeHtml(params.clientName)},</p>
  <p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6">${escapeHtml(params.contextLine)}</p>
  ${quote}
  ${badge}
  ${button(params.ctaPrimary.label, params.ctaPrimary.url)}
  ${secondary}
</td></tr>

<tr><td style="padding:20px 40px 28px;background:#fafbfc;border-top:1px solid #e2e8f0">
  <p style="color:#94a3b8;font-size:11px;margin:0 0 6px;line-height:1.6">
    Recibis este correo porque <strong style="color:#64748b">${orgName}</strong> usa Zentikk como su plataforma de gestion y soporte.
  </p>
  <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.6">
    <a href="${escapeHtml(params.preferencesUrl)}" style="color:${BRAND_COLOR};text-decoration:none">Administrar notificaciones</a>
    &middot; &copy; ${new Date().getFullYear()} ${orgName}
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function badgeBg(tone: 'info' | 'success' | 'warning'): string {
  if (tone === 'success') return '#dcfce7';
  if (tone === 'warning') return '#fef3c7';
  return '#dbeafe';
}

function badgeText(tone: 'info' | 'success' | 'warning'): string {
  if (tone === 'success') return '#166534';
  if (tone === 'warning') return '#92400e';
  return '#1e40af';
}
