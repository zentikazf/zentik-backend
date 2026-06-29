import { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  /**
   * @deprecated Use `organizationIds` (array). Legacy alias = `organizationIds[0]`.
   * Kept for backwards-compat with modules that still read singular org.
   */
  organizationId?: string;
  /**
   * Array completo de organizationIds del user (todas sus memberships).
   * SIEMPRE definido (puede ser `[]` si el user no tiene membresias).
   * Feature #15 (admin-mcp-multi-tenant-hardening) — Capa 1.
   */
  organizationIds: string[];
  /**
   * Client al que pertenece el user (portal user). `null` si no es portal user.
   * Feature #15.
   */
  clientId: string | null;
  roleId?: string;
  roleName?: string;
  permissions?: string[];
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  correlationId: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface Result<T, E = Error> {
  ok: boolean;
  value?: T;
  error?: E;
}
