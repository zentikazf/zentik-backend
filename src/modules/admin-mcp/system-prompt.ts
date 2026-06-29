import { ToolDefinition } from './providers/llm-provider.interface';

/**
 * Builder puro del system prompt del asistente admin-mcp.
 *
 * R13: el system prompt SIEMPRE se construye server-side. NUNCA aceptamos
 * `role: 'system'` desde el cliente (la validacion del DTO lo rechaza con 422).
 *
 * El prompt es minimal y deliberado:
 *  (a) define rol read-only del asistente,
 *  (b) lista nombres y descripciones de tools (sin schemas — el LLM ya los recibe),
 *  (c) prohibe inventar datos y escribir,
 *  (d) impone respuesta en espanol.
 *
 * Feature #15 (R8): si se pasa `ctx`, el prompt agrega user/org context
 * para que el LLM tenga conciencia explicita de QUE usuario y QUE orgs
 * tiene visibilidad. NO incluimos email/name/token (defense-in-depth).
 */
export interface SystemPromptContext {
  userId: string;
  orgIds: string[];
  clientId: string | null;
}

export function buildSystemPrompt(
  tools: ToolDefinition[],
  ctx?: SystemPromptContext,
): string {
  const toolList = tools.length === 0
    ? '(no hay tools disponibles en este momento)'
    : tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

  const lines: string[] = [
    'Sos el Asistente Zentik, un consultor read-only sobre la base de datos interna de Zentik.',
    'Tu objetivo es responder consultas del equipo interno (Owner, Project Manager, Developer)',
    'sobre datos del sistema (clientes, proyectos, tickets, horas, usuarios) usando exclusivamente',
    'las tools que tenes disponibles. NO sos un agente de escritura: nunca podes crear, modificar,',
    'borrar ni mutar nada. Si te piden hacerlo, explica que sos read-only.',
    '',
    'Reglas:',
    '1. Si necesitas un dato concreto, llama a la tool apropiada. NO inventes numeros, IDs ni nombres.',
    '2. Si una tool devuelve un error o no encontras la informacion, decilo claramente. NO improvises.',
    '3. Responde SIEMPRE en espanol, en tono profesional y conciso.',
    '4. Si la pregunta es ambigua, pedi clarificacion antes de llamar a una tool.',
    '5. NUNCA expongas tokens, IDs sensibles, ni asumas roles de otros usuarios.',
    '',
    'Tools disponibles:',
    toolList,
  ];

  if (ctx) {
    // R8: ctx visible al LLM para razonamiento, pero SOLO ids — no email/name.
    // El scope multi-tenant lo aplica el MCP server-side; este prompt es
    // unicamente para que el LLM entienda en que org "vive" el usuario.
    const orgIdsRepr = ctx.orgIds.length > 0
      ? `[${ctx.orgIds.join(', ')}]`
      : '[]';
    lines.push(
      '',
      'Contexto del usuario llamante:',
      `- userId: ${ctx.userId}`,
      `- orgIds: ${orgIdsRepr}`,
      `- clientId: ${ctx.clientId ?? 'null'}`,
      'Las tools aplican filtros multi-tenant automaticamente segun este contexto.',
      'Si una entidad pertenece a otra organizacion, simplemente no la veras.',
    );
  }

  return lines.join('\n');
}
