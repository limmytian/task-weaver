import { test } from 'node:test'
import assert from 'node:assert'
import {
  listSkillPackagesSchema,
  reindexSkillPackageSchema,
  registerSkillPackageSchema,
  skillPackagePathSchema,
  verifySkillPackageStorageSchema,
} from './skill-packages.js'

const entryContent = Buffer.from('# Skill\n').toString('base64')

test('skill package path validation rejects traversal', () => {
  const result = skillPackagePathSchema.safeParse('../SKILL.md')
  assert.equal(result.success, false)
})

test('skill package registration requires entry file', () => {
  const result = registerSkillPackageSchema.safeParse({
    name: 'missing-entry',
    entryPath: 'SKILL.md',
    files: [
      { path: 'README.md', contentBase64: entryContent },
    ],
  })

  assert.equal(result.success, false)
})

test('skill package registration rejects mixed project and personal scope', () => {
  const result = registerSkillPackageSchema.safeParse({
    name: 'mixed-scope',
    projectId: '00000000-0000-4000-8000-000000000001',
    personalOwnerId: 'agent-1',
    personalOwnerType: 'agent',
    files: [
      { path: 'SKILL.md', contentBase64: entryContent },
    ],
  })

  assert.equal(result.success, false)
})

test('skill package list coerces includeGlobal query booleans', () => {
  const result = listSkillPackagesSchema.safeParse({
    projectId: '00000000-0000-4000-8000-000000000001',
    includeGlobal: 'false',
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.data.includeGlobal, false)
  }
})

test('skill package maintenance schemas validate package paths', () => {
  const health = verifySkillPackageStorageSchema.safeParse({
    packageId: '00000000-0000-4000-8000-000000000001',
  })
  const reindex = reindexSkillPackageSchema.safeParse({
    packageId: '00000000-0000-4000-8000-000000000001',
    paths: ['SKILL.md', '../escape.md'],
  })

  assert.equal(health.success, true)
  assert.equal(reindex.success, false)
})

test('skill package list supports allProjects and rejects conflicting scopes', () => {
  const valid = listSkillPackagesSchema.safeParse({
    allProjects: 'true',
    includeGlobal: 'true',
  })
  assert.equal(valid.success, true)
  if (valid.success) {
    assert.equal(valid.data.allProjects, true)
    assert.equal(valid.data.includeGlobal, true)
  }

  const conflictingWithProject = listSkillPackagesSchema.safeParse({
    projectId: '00000000-0000-4000-8000-000000000001',
    allProjects: 'true',
  })
  assert.equal(conflictingWithProject.success, false)

  const conflictingWithPersonal = listSkillPackagesSchema.safeParse({
    allProjects: 'true',
    personalOwnerId: 'agent-1',
    personalOwnerType: 'agent',
  })
  assert.equal(conflictingWithPersonal.success, false)
})
