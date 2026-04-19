/**
 * Origin allowlist + preview/same-origin bypass helpers.
 *
 * Preparatory re-exports for Phase 12 (FR-42 AC-42.2). Live implementations
 * currently in proxy/lib.ts; this file gives consumers a stable final
 * import path. When Phase 12 completes lib.ts, the implementations move
 * here and this file is no longer a re-export.
 *
 * Traces: FR-42 AC-42.1/AC-42.2 (module topology).
 */
export {
  isOriginAllowed,
  isPreviewEnv,
  isSameOriginBypass,
} from '../lib';
