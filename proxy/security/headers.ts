/**
 * Security header emitter + fingerprinting-header stripper.
 *
 * Preparatory re-export for Phase 12.
 *
 * Traces: FR-42.
 */
export {
  applySecurityHeaders,
  stripFingerprintingHeaders,
  pickApiCacheControl,
} from '../lib';
