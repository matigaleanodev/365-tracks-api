import {
  ceilingPolicy,
  CEILING_NAME,
  foundationCloudformationPolicy,
  foundationPipelinePolicy,
  foundationTrust,
  PREFIX,
} from './delivery.ts';

/** Documentos IAM que debe crear una persona con permisos de administración (prerrequisitos). */
export function adminDocuments(): Record<string, unknown> {
  return {
    [`${CEILING_NAME}.policy.json`]: ceilingPolicy(),
    [`${PREFIX}foundation.policy.json`]: foundationPipelinePolicy(),
    [`${PREFIX}foundation.trust.json`]: foundationTrust('foundation'),
    [`${PREFIX}foundation-cloudformation.policy.json`]: foundationCloudformationPolicy(),
    [`${PREFIX}foundation-cloudformation.trust.json`]: foundationTrust('foundation-cloudformation'),
  };
}
