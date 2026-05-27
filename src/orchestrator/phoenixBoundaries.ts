export const PHOENIX_BOUNDARY_CONTRACT_VERSION = 'phoenix-boundary-0.1.0'

export interface PhoenixBoundaryContract {
  version: typeof PHOENIX_BOUNDARY_CONTRACT_VERSION
  execution: 'advisory_only'
  canApprovePermissions: false
  canExecuteTools: false
  canExecuteSkills: false
  canWriteMemory: false
  canDeleteMemory: false
  canActivateAntibodies: false
  canRetryAutomatically: false
  canHideOriginalErrors: false
}

type BoundaryField =
  | 'canApprovePermission'
  | 'canExecuteTool'
  | 'canExecuteSkill'
  | 'canWriteMemory'
  | 'canDeleteMemory'
  | 'canActivateAntibody'
  | 'canRetryAutomatically'
  | 'canBypassPermission'
  | 'hideOriginalError'
  | 'canAffectExecution'

const PHOENIX_BOUNDARY_CONTRACT: PhoenixBoundaryContract = Object.freeze({
  version: PHOENIX_BOUNDARY_CONTRACT_VERSION,
  execution: 'advisory_only',
  canApprovePermissions: false,
  canExecuteTools: false,
  canExecuteSkills: false,
  canWriteMemory: false,
  canDeleteMemory: false,
  canActivateAntibodies: false,
  canRetryAutomatically: false,
  canHideOriginalErrors: false,
})

const FORBIDDEN_TRUE_FIELDS: BoundaryField[] = [
  'canApprovePermission',
  'canExecuteTool',
  'canExecuteSkill',
  'canWriteMemory',
  'canDeleteMemory',
  'canActivateAntibody',
  'canRetryAutomatically',
  'canBypassPermission',
  'hideOriginalError',
  'canAffectExecution',
]

export function getPhoenixBoundaryContract(): PhoenixBoundaryContract {
  return PHOENIX_BOUNDARY_CONTRACT
}

export function assertPhoenixBoundaryDecision(decision: Record<string, unknown>): void {
  for (const field of FORBIDDEN_TRUE_FIELDS) {
    if (decision[field] === true) {
      throw new Error(`Phoenix boundary violation: ${field} must not be true`)
    }
  }
}
