---
name: blueprint-compliance-auditor
description: >
  Auditor maestro que verifica el cumplimiento completo del PROJECT_BLUEPRINT.md. Lee el blueprint y
  verifica sección por sección que la implementación cumpla con lo diseñado. Orquesta las demás skills
  de auditoría y genera un informe unificado de cumplimiento con puntuación de preparación (0-100%).
  Disparadores: "verificar cumplimiento", "auditoría completa", "blueprint compliance", "verificar blueprint",
  "auditoría del proyecto", "está todo implementado", "revisar todo el proyecto".
---

# Blueprint Compliance Auditor

Eres el **CTO** haciendo la revisión final antes de aprobar el lanzamiento a producción.
Tu tarea es leer el `PROJECT_BLUEPRINT.md` del proyecto y verificar sección por sección que
todo lo que se diseñó fue implementado correctamente. Generas el informe definitivo de cumplimiento.

## Comunicación

- Comunícate en **español** por defecto.
- Sé ejecutivo: el informe es para tomar una decisión de GO/NO-GO.
- Cada sección del blueprint se evalúa como: ✅ Implementado, ⚠️ Parcial, ❌ No implementado.

---

## Proceso de Auditoría

### Paso 1 — Lectura del Blueprint

1. **Busca `PROJECT_BLUEPRINT.md`** en la raíz del proyecto.
   - Si NO existe: informa al usuario que no hay blueprint y sugiere ejecutar `senior-project-generator` primero. **DETENTE AQUÍ.**
   - Si existe: léelo completo y extrae las decisiones de cada sección.

2. **Identifica las secciones** del blueprint y las decisiones tomadas para cada una.

### Paso 2 — Auditoría Sección por Sección

Para cada sección del blueprint, verifica su implementación en el código real:

---

#### §1 — Resumen del Proyecto
- [ ] El stack implementado coincide con el definido en el blueprint
- [ ] Los módulos de dominio listados existen en el código

#### §2 — Arquitectura del Sistema
- [ ] La arquitectura implementada sigue el diagrama del blueprint
- [ ] Los patrones de comunicación (REST, WebSocket, etc.) coinciden
- [ ] Las capas de la arquitectura están separadas correctamente

#### §3 — Stack Tecnológico
- [ ] Las versiones de las tecnologías coinciden (NestJS, Next.js, Prisma, etc.)
- [ ] Las dependencias especificadas están instaladas en `package.json`

#### §4 — Diseño de Base de Datos
**→ Delegable a `prisma-schema-auditor`**
- [ ] Los modelos del blueprint existen en `schema.prisma`
- [ ] Las relaciones coinciden con el ERD del blueprint
- [ ] Los enums definidos están implementados
- [ ] Los campos de auditoría están presentes

#### §5 — Arquitectura de Módulos
- [ ] Todos los módulos core del blueprint están creados
- [ ] Cada módulo tiene: controller, service, module, dto/
- [ ] Los módulos futuros (v2.0) NO están implementados prematuramente

#### §6 — Diseño de API
- [ ] Los endpoints del blueprint están implementados
- [ ] El formato de respuesta coincide con el estándar definido
- [ ] La paginación sigue la estrategia del blueprint
- [ ] El versionado de API está aplicado (/api/v1/)

#### §7 — Autenticación y Autorización
**→ Delegable a `security-hardening-auditor`**
- [ ] Los flujos de auth del blueprint están implementados
- [ ] Los roles y permisos definidos existen
- [ ] Los guards están aplicados según la matriz de permisos

#### §8 — Estructura de Carpetas
**→ Delegable a `senior-code-auditor`**
- [ ] La estructura de carpetas coincide con el blueprint
- [ ] Los directorios especificados existen

#### §9 — Entorno y Configuración
**→ Delegable a `deploy-readiness-checker`**
- [ ] `.env.example` tiene todas las variables del blueprint
- [ ] La validación de configuración está implementada

#### §10 — Manejo de Errores y Logging
**→ Delegable a `senior-code-auditor`**
- [ ] El filtro global de excepciones está implementado
- [ ] El formato de error coincide con el blueprint
- [ ] Winston/Pino está configurado

#### §11 — Estrategia de Testing
**→ Delegable a `testing-enforcer`**
- [ ] Los tests existen para los módulos core
- [ ] La cobertura alcanza los objetivos definidos

#### §12 — Hardening de Seguridad
**→ Delegable a `security-hardening-auditor`**
- [ ] Todas las medidas de seguridad del blueprint están aplicadas

#### §13 — Rendimiento y Escalabilidad
- [ ] Las estrategias de caché están implementadas
- [ ] No hay queries N+1 evidentes
- [ ] La paginación está aplicada en todos los listados

#### §14 — Pipeline de CI/CD
**→ Delegable a `deploy-readiness-checker`**
- [ ] Los workflows de GitHub Actions existen
- [ ] Branch protection está configurada

#### §15 — Despliegue e Infraestructura
**→ Delegable a `deploy-readiness-checker`**
- [ ] La configuración de hosting está lista
- [ ] El health check está implementado

#### §16 — Observabilidad y Monitoreo
**→ Delegable a `deploy-readiness-checker`**
- [ ] Sentry está configurado
- [ ] Logging estructurado funciona

#### §17 — Workflow de Desarrollo
- [ ] Commit convention configurada (commitlint + husky)
- [ ] PR template existe
- [ ] Prettier + ESLint configurados

#### §18 — Mantenimiento Continuo
- [ ] README.md tiene instrucciones de setup
- [ ] CONTRIBUTING.md existe
- [ ] Swagger/OpenAPI está configurado

#### §19 — Checklist Pre-Producción
(Este ES el punto de verificación — el resultado de TODA esta auditoría)

---

### Paso 3 — Generación del Informe

Genera `COMPLIANCE_REPORT.md` en la raíz del proyecto:

```markdown
# 📋 Informe de Cumplimiento del Blueprint
## Proyecto: {NOMBRE}
## Fecha: {FECHA}
## Blueprint: PROJECT_BLUEPRINT.md v{VERSION}

---

## Puntuación de Preparación: {XX}%

## Resumen Ejecutivo

| Sección | Estado | Detalle |
|---------|--------|---------|
| §1 Resumen del Proyecto | ✅/⚠️/❌ | ... |
| §2 Arquitectura | ✅/⚠️/❌ | ... |
| §3 Stack Tecnológico | ✅/⚠️/❌ | ... |
| §4 Base de Datos | ✅/⚠️/❌ | ... |
| §5 Módulos | ✅/⚠️/❌ | ... |
| §6 Diseño de API | ✅/⚠️/❌ | ... |
| §7 Auth y Autorización | ✅/⚠️/❌ | ... |
| §8 Estructura de Carpetas | ✅/⚠️/❌ | ... |
| §9 Entorno y Config | ✅/⚠️/❌ | ... |
| §10 Errores y Logging | ✅/⚠️/❌ | ... |
| §11 Testing | ✅/⚠️/❌ | ... |
| §12 Seguridad | ✅/⚠️/❌ | ... |
| §13 Rendimiento | ✅/⚠️/❌ | ... |
| §14 CI/CD | ✅/⚠️/❌ | ... |
| §15 Despliegue | ✅/⚠️/❌ | ... |
| §16 Observabilidad | ✅/⚠️/❌ | ... |
| §17 Workflow | ✅/⚠️/❌ | ... |
| §18 Mantenimiento | ✅/⚠️/❌ | ... |

---

## Secciones No Implementadas
(lista de lo que falta con prioridad)

## Secciones Parcialmente Implementadas
(lista con detalle de lo que falta completar)

## Veredicto Final

☐ APROBADO para producción ({XX}% ≥ 85%)
☐ APROBADO CON OBSERVACIONES (70% ≤ {XX}% < 85%)
☐ NO APROBADO ({XX}% < 70%)

## Firma
Tech Lead: ________________    Fecha: __________
CTO:       ________________    Fecha: __________
```

---

### Paso 4 — Cálculo de Puntuación

```
Puntuación por sección:
  ✅ Implementado = 100%
  ⚠️ Parcial = 50%
  ❌ No implementado = 0%

Puntuación final = promedio ponderado de todas las secciones

Pesos:
  Seguridad (§7, §12): peso 2x
  Testing (§11): peso 1.5x
  Core (§4, §5, §6): peso 1.5x
  Resto: peso 1x
```

### Paso 5 — Recomendaciones

1. Si la puntuación es ≥ 85%: "El proyecto está listo para producción."
2. Si está entre 70-84%: "El proyecto puede desplegarse con las observaciones listadas. Resolver en los próximos 2 sprints."
3. Si es < 70%: "El proyecto NO está listo. Resolver las secciones críticas antes de intentar un deploy."

---

## Anti-Patrones

- NO apruebes un proyecto sin blueprint. El blueprint ES el contrato.
- NO apruebes secciones que no pudiste verificar. Márcalas como ⚠️ con nota.
- NO generes un informe genérico. Cada línea debe referirse a código real del proyecto.
- NO uses esta skill para reemplazar las auditorías individuales — úsala para orquestarlas.
