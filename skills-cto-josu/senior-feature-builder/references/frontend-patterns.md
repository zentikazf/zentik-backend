# Frontend Patterns — Next.js (Senior Feature Builder)

Referencia de patrones senior para implementar features en Next.js 14+ (App Router). Aplica estas reglas durante la Fase 4.

---

## Regla Fundamental — Server vs Client Components

```
¿El componente necesita estado, hooks de React, o eventos del browser?
  SÍ → Client Component ('use client')
  NO → Server Component (por defecto, sin directiva)
```

**Tabla de decisión rápida:**

| Necesita | Tipo |
|----------|------|
| `useState`, `useEffect`, `useReducer` | Client |
| Event handlers (onClick, onChange, etc.) | Client |
| Fetch de datos sin interactividad | Server |
| SEO / metadata | Server |
| Acceso a cookies/headers | Server |
| `useRouter`, `usePathname`, `useSearchParams` | Client |
| Renders estáticos o de lista | Server (preferido) |

**Regla:** Mantén Client Components lo más abajo posible en el árbol. Que los padres sean Server Components siempre que puedas.

---

## Estructura de una Página Nueva

```
app/(dashboard)/
└── feature-name/
    ├── page.tsx               ← Server Component (fetch + layout)
    ├── loading.tsx            ← Skeleton obligatorio
    ├── error.tsx              ← 'use client', error boundary
    └── [id]/
        └── page.tsx           ← Detalle del recurso
```

```typescript
// page.tsx — Server Component
import { FeatureList } from '@/components/feature/feature-list';
import { getFeatures } from '@/services/feature.service';

export const metadata = { title: 'Feature Name | App' };

export default async function FeaturePage() {
  const features = await getFeatures(); // Fetch directo en Server Component

  return (
    <div>
      <h1>Features</h1>
      <FeatureList features={features} />  {/* Pasa datos como props */}
    </div>
  );
}
```

```typescript
// loading.tsx — Obligatorio en cada página
export default function Loading() {
  return <Skeleton className="h-64 w-full rounded-xl" />;
}
```

```typescript
// error.tsx — Obligatorio en cada página
'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <p>Error: {error.message}</p>
      <button onClick={reset}>Reintentar</button>
    </div>
  );
}
```

---

## API Client — Cómo Consumir el Backend

Siempre usa el `api-client` centralizado, NUNCA `fetch` directo con URLs hardcodeadas.

```typescript
// services/feature.service.ts
import { api, ApiError } from '@/lib/api-client';

export async function getFeatures() {
  const res = await api.get('/features');
  return res.data;
}

export async function createFeature(data: CreateFeatureInput) {
  const res = await api.post('/features', data);
  return res.data;
}

export async function updateFeature(id: string, data: UpdateFeatureInput) {
  const res = await api.patch(`/features/${id}`, data);
  return res.data;
}

export async function deleteFeature(id: string) {
  await api.delete(`/features/${id}`);
}
```

---

## Client Component — Patrón con Manejo de Errores y Revalidación

```typescript
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from '@/hooks/use-toast';
import { ApiError } from '@/lib/api-client';
import { createFeature } from '@/services/feature.service';

export function CreateFeatureForm() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (data: CreateFeatureInput) => {
    setLoading(true);
    try {
      await createFeature(data);
      toast.success('Feature creado correctamente');
      router.refresh(); // ← CRÍTICO: revalida los Server Components para mostrar datos nuevos
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Error inesperado';
      toast.error('Error', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={...}>
      {/* UI */}
      <Button disabled={loading}>
        {loading ? 'Guardando...' : 'Guardar'}
      </Button>
    </form>
  );
}
```

**Reglas de error handling en frontend:**
- SIEMPRE `try/catch` en operaciones async de Client Components
- SIEMPRE usa `toast.error()` para mostrar errores al usuario
- SIEMPRE muestra `err instanceof ApiError ? err.message : 'Error inesperado'`
- NUNCA muestra stack traces al usuario
- SIEMPRE deshabilita el botón de submit durante la operación (`disabled={loading}`)
- SIEMPRE llama a `router.refresh()` después de una mutación exitosa para revalidar Server Components
- NUNCA uses `window.location.reload()` — usa `router.refresh()` que es más eficiente

---

## Tipos TypeScript Compartidos

Define los tipos del feature en un archivo dedicado:

```typescript
// types/feature.types.ts
export interface Feature {
  id: string;
  name: string;
  description?: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  createdAt: string;
  createdBy: {
    id: string;
    name: string;
    email: string;
  };
}

export interface CreateFeatureInput {
  name: string;
  description?: string;
  status?: Feature['status'];
}

export interface UpdateFeatureInput extends Partial<CreateFeatureInput> {}
```

**Reglas:**
- NUNCA uses `any` — si no conoces el tipo exacto, usa `unknown` y castea después
- Tipos de respuesta de API con `string` para fechas (ISO 8601), no `Date`
- IDs siempre `string`, NUNCA `number`
- Usa `interface` para objetos, `type` para unions/intersections/mapeos

---

## Data Fetching — Patrones

```typescript
// ✅ BIEN — Fetch en Server Component (preferido para datos iniciales)
export default async function Page() {
  const data = await getFeatures(); // directo, sin useEffect
  return <FeatureList features={data} />;
}

// ✅ BIEN — Fetch paralelo para evitar waterfalls
export default async function Page() {
  const [features, categories] = await Promise.all([
    getFeatures(),
    getCategories(),
  ]);
  return <FeatureView features={features} categories={categories} />;
}

// ✅ BIEN — Refetch en Client Component después de una mutación
const [features, setFeatures] = useState(initialFeatures);
const handleCreate = async () => {
  await createFeature(data);
  const updated = await getFeatures(); // Re-fetch después de mutar
  setFeatures(updated);
};

// ❌ MAL — useEffect para el fetch inicial (usa Server Component en su lugar)
useEffect(() => {
  fetch('/api/features').then(r => r.json()).then(setFeatures);
}, []);
```

---

## Anti-Patterns a Evitar

```typescript
// ❌ Componente async Client
'use client';
export default async function BadComponent() { // INVÁLIDO
  const data = await fetch('/api/features');
}

// ❌ Props no serializables entre Server y Client
// props como funciones, clases, Dates (objeto), Map, Set — no pueden pasar del Server al Client

// ❌ URL hardcodeada en fetch
fetch('http://localhost:3001/api/v1/features'); // NUNCA

// ❌ Sin manejo de loading state
const handleClick = async () => {
  await deleteFeature(id); // Sin setLoading, el botón puede clickearse múltiples veces
};
```
