import { z } from "zod";

export const TASK_WEAVER_MODULE_API_VERSION = "task-weaver.dev/v1alpha1" as const;

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/;
const migrationNamespacePattern = /^[a-z][a-z0-9_]*$/;

export const modulePermissionSchema = z.object({
  id: z.string().regex(capabilityPattern),
  description: z.string().min(1),
}).strict();

export const taskWeaverModuleManifestSchema = z.object({
  apiVersion: z.literal(TASK_WEAVER_MODULE_API_VERSION),
  id: z.string().regex(identifierPattern),
  name: z.string().min(1),
  version: z.string().min(1),
  supportedCoreVersion: z.string().min(1),
  description: z.string().min(1).optional(),
  homepage: z.string().url().optional(),
  license: z.string().min(1).optional(),
  capabilities: z.array(z.string().regex(capabilityPattern)).default([]),
  permissions: z.array(modulePermissionSchema).default([]),
  migrationNamespace: z.string().regex(migrationNamespacePattern).optional(),
}).strict().superRefine((manifest, context) => {
  const capabilitySet = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (capabilitySet.has(capability)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate capability '${capability}' in module manifest`,
        path: ["capabilities"],
      });
    }
    capabilitySet.add(capability);
  }

  const permissionSet = new Set<string>();
  for (const permission of manifest.permissions) {
    if (permissionSet.has(permission.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate permission '${permission.id}' in module manifest`,
        path: ["permissions"],
      });
    }
    permissionSet.add(permission.id);
  }
});

export type ModulePermission = z.infer<typeof modulePermissionSchema>;
export type TaskWeaverModuleManifestInput = z.input<typeof taskWeaverModuleManifestSchema>;
export type TaskWeaverModuleManifest = z.output<typeof taskWeaverModuleManifestSchema>;
