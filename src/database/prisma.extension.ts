import { Prisma } from '@prisma/client';

// Custom Prisma client extension (no-op placeholder)
export function prismaExtension() {
  return Prisma.defineExtension({});
}
