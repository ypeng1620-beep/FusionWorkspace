import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  PermissionPolicyEngine,
  type ChannelPolicy,
  type GroupPolicy,
  type UserPolicy,
} from './permissionPolicyEngine.js'

export const PERMISSION_POLICY_FIXTURE_SCHEMA_VERSION = 'permission-policy-fixture-0.1.0'

export interface PermissionPolicyFixture {
  schemaVersion: typeof PERMISSION_POLICY_FIXTURE_SCHEMA_VERSION
  channelPolicies?: ChannelPolicy[]
  userPolicies?: UserPolicy[]
  groupPolicies?: GroupPolicy[]
}

export function loadPermissionPolicyEngineFromFixture(path: string): PermissionPolicyEngine {
  const fixture = readPermissionPolicyFixture(path)
  const engine = new PermissionPolicyEngine()

  for (const policy of fixture.channelPolicies ?? []) {
    engine.registerChannelPolicy(policy)
  }
  for (const policy of fixture.userPolicies ?? []) {
    engine.registerUserPolicy(policy)
  }
  for (const policy of fixture.groupPolicies ?? []) {
    engine.registerGroupPolicy(policy)
  }

  return engine
}

export function readPermissionPolicyFixture(path: string): PermissionPolicyFixture {
  const fixturePath = resolve(path)
  const raw = readFileSync(fixturePath, 'utf8')
  const parsed = JSON.parse(raw) as { schemaVersion?: string }

  if (parsed.schemaVersion !== PERMISSION_POLICY_FIXTURE_SCHEMA_VERSION) {
    throw new Error(`Unsupported permission policy fixture schema: ${parsed.schemaVersion ?? 'missing'}`)
  }

  return parsed as PermissionPolicyFixture
}
