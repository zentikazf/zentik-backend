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
