"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Database, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "@/trpc/routers/_app";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWebIdentity } from "@/components/web-identity-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type EmbeddingProfile = inferRouterOutputs<AppRouter>["embedding"]["list"][number];
type Scope = "global" | "project" | "personal";
type OwnerType = "human" | "agent";

type FormState = {
  name: string;
  scope: Scope;
  projectId: string;
  personalOwnerId: string;
  personalOwnerType: OwnerType;
  baseUrl: string;
  model: string;
  dimensions: string;
  secretRef: string;
  timeoutMs: string;
  batchSize: string;
  maxConcurrency: string;
  chunkSize: string;
  chunkOverlap: string;
  chunkingVersion: string;
  retentionGenerations: string;
};

type FieldName = keyof FormState;
type FieldErrors = Partial<Record<FieldName, string>>;

const defaultForm: FormState = {
  name: "",
  scope: "global",
  projectId: "",
  personalOwnerId: "",
  personalOwnerType: "human",
  baseUrl: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dimensions: "1536",
  secretRef: "env:OPENAI_API_KEY",
  timeoutMs: "30000",
  batchSize: "64",
  maxConcurrency: "2",
  chunkSize: "1200",
  chunkOverlap: "120",
  chunkingVersion: "text-v1",
  retentionGenerations: "2",
};

function formFor(profile: EmbeddingProfile | null | undefined, actor: { id: string; type: OwnerType }): FormState {
  if (!profile) {
    return {
      ...defaultForm,
      personalOwnerId: actor.id,
      personalOwnerType: actor.type,
    };
  }
  return {
    name: profile.name,
    scope: profile.scope,
    projectId: profile.projectId ?? "",
    personalOwnerId: profile.personalOwnerId ?? "",
    personalOwnerType: profile.personalOwnerType ?? "human",
    baseUrl: profile.baseUrl,
    model: profile.model,
    dimensions: String(profile.dimensions),
    secretRef: profile.secretRef,
    timeoutMs: String(profile.timeoutMs),
    batchSize: String(profile.batchSize),
    maxConcurrency: String(profile.maxConcurrency),
    chunkSize: String(profile.chunkSize),
    chunkOverlap: String(profile.chunkOverlap),
    chunkingVersion: profile.chunkingVersion,
    retentionGenerations: String(profile.retentionGenerations),
  };
}

function validateInteger(
  errors: FieldErrors,
  field: FieldName,
  value: string,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    errors[field] = `${label} must be an integer between ${minimum} and ${maximum}.`;
  }
}

function validateForm(form: FormState, editing: boolean): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "Name is required.";
  if (!editing && form.scope === "project" && !form.projectId) errors.projectId = "Select a project.";
  if (!editing && form.scope === "personal" && !form.personalOwnerId.trim()) {
    errors.personalOwnerId = "Personal owner ID is required.";
  }

  try {
    const url = new URL(form.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      errors.baseUrl = "Use an HTTP(S) URL without credentials, query parameters, or a fragment.";
    }
  } catch {
    errors.baseUrl = "Enter a valid HTTP(S) URL.";
  }

  if (!form.model.trim()) errors.model = "Model is required.";
  if (!/^[a-z][a-z0-9+.-]*:\S+$/i.test(form.secretRef)) {
    errors.secretRef = "Use an opaque reference such as env:OPENAI_API_KEY.";
  }
  if (!form.chunkingVersion.trim()) errors.chunkingVersion = "Chunking version is required.";

  validateInteger(errors, "dimensions", form.dimensions, "Dimensions", 1, 2000);
  validateInteger(errors, "timeoutMs", form.timeoutMs, "Timeout", 100, 120000);
  validateInteger(errors, "batchSize", form.batchSize, "Batch size", 1, 2048);
  validateInteger(errors, "maxConcurrency", form.maxConcurrency, "Max concurrency", 1, 32);
  validateInteger(errors, "chunkSize", form.chunkSize, "Chunk size", 100, 32000);
  validateInteger(errors, "chunkOverlap", form.chunkOverlap, "Chunk overlap", 0, 31999);
  validateInteger(errors, "retentionGenerations", form.retentionGenerations, "Retained generations", 1, 100);
  if (!errors.chunkSize && !errors.chunkOverlap && Number(form.chunkOverlap) >= Number(form.chunkSize)) {
    errors.chunkOverlap = "Chunk overlap must be smaller than chunk size.";
  }
  return errors;
}

export function EmbeddingProfileDialog({
  open,
  onOpenChange,
  profile,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile?: EmbeddingProfile | null;
  onSaved: (profileId: string) => void;
}) {
  const actor = useWebIdentity();
  const editing = Boolean(profile);
  const initialForm = useMemo(() => formFor(profile, actor), [actor, profile]);
  const [form, setForm] = useState<FormState>(initialForm);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { data: projects } = trpc.project.list.useQuery({ status: "active" }, { enabled: open && !editing });
  const utils = trpc.useUtils();
  const create = trpc.embedding.create.useMutation();
  const update = trpc.embedding.update.useMutation();
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (!open) return;
    // Reset the reusable dialog when switching between create and edit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(initialForm);
    setFieldErrors({});
    setSubmitError(null);
  }, [initialForm, open]);

  const setField = <K extends FieldName>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setSubmitError(null);
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = validateForm(form, editing);
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;

    const configuration = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      dimensions: Number(form.dimensions),
      secretRef: form.secretRef.trim(),
      timeoutMs: Number(form.timeoutMs),
      batchSize: Number(form.batchSize),
      maxConcurrency: Number(form.maxConcurrency),
      chunkSize: Number(form.chunkSize),
      chunkOverlap: Number(form.chunkOverlap),
      chunkingVersion: form.chunkingVersion.trim(),
      retentionGenerations: Number(form.retentionGenerations),
    };

    try {
      const saved = profile
        ? await update.mutateAsync({
            id: profile.id,
            data: { ...configuration, expectedVersion: profile.version },
          })
        : form.scope === "project"
          ? await create.mutateAsync({
              ...configuration,
              provider: "openai_compatible",
              enabled: false,
              scope: "project",
              projectId: form.projectId,
            })
          : form.scope === "personal"
            ? await create.mutateAsync({
                ...configuration,
                provider: "openai_compatible",
                enabled: false,
                scope: "personal",
                personalOwnerId: form.personalOwnerId.trim(),
                personalOwnerType: form.personalOwnerType,
              })
            : await create.mutateAsync({
                ...configuration,
                provider: "openai_compatible",
                enabled: false,
                scope: "global",
              });

      await utils.embedding.list.invalidate();
      toast.success(editing ? "Embedding profile updated" : "Embedding profile created");
      onOpenChange(false);
      onSaved(saved.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Embedding profile could not be saved";
      setSubmitError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={submit} className="space-y-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              {editing ? "Edit embedding profile" : "Create embedding profile"}
            </DialogTitle>
            <DialogDescription>
              Configure an OpenAI-compatible embedding provider. Credentials remain external and are referenced by name only.
            </DialogDescription>
          </DialogHeader>

          <section className="space-y-4">
            <SectionHeading title="Identity and scope" description="Choose which documents this profile can index." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Profile name" htmlFor="embedding-name" required error={fieldErrors.name}>
                <Input
                  id="embedding-name"
                  autoFocus
                  value={form.name}
                  onChange={(event) => setField("name", event.target.value)}
                  placeholder="Primary embeddings"
                  aria-invalid={Boolean(fieldErrors.name)}
                />
              </Field>
              <Field
                label="Scope"
                htmlFor="embedding-scope"
                description={editing ? "Scope cannot be changed after creation." : undefined}
              >
                <Select
                  value={form.scope}
                  onValueChange={(value) => setField("scope", value as Scope)}
                  disabled={editing}
                >
                  <SelectTrigger id="embedding-scope" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="project">Project</SelectItem>
                    <SelectItem value="personal">Personal</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {!editing && form.scope === "project" && (
                <Field label="Project" htmlFor="embedding-project" required error={fieldErrors.projectId}>
                  <Select value={form.projectId} onValueChange={(value) => setField("projectId", value)}>
                    <SelectTrigger id="embedding-project" className="w-full" aria-invalid={Boolean(fieldErrors.projectId)}>
                      <SelectValue placeholder="Select a project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects?.map((project) => (
                        <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {!editing && form.scope === "personal" && (
                <>
                  <Field label="Owner ID" htmlFor="embedding-owner" required error={fieldErrors.personalOwnerId}>
                    <Input
                      id="embedding-owner"
                      value={form.personalOwnerId}
                      onChange={(event) => setField("personalOwnerId", event.target.value)}
                      aria-invalid={Boolean(fieldErrors.personalOwnerId)}
                    />
                  </Field>
                  <Field label="Owner type" htmlFor="embedding-owner-type">
                    <Select value={form.personalOwnerType} onValueChange={(value) => setField("personalOwnerType", value as OwnerType)}>
                      <SelectTrigger id="embedding-owner-type" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="human">Human</SelectItem>
                        <SelectItem value="agent">Agent</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </>
              )}
            </div>
          </section>

          <section className="space-y-4 border-t pt-5">
            <SectionHeading title="Provider" description="The endpoint must expose an OpenAI-compatible embeddings API." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Base URL" htmlFor="embedding-base-url" required error={fieldErrors.baseUrl}>
                <Input
                  id="embedding-base-url"
                  value={form.baseUrl}
                  onChange={(event) => setField("baseUrl", event.target.value)}
                  placeholder="https://api.openai.com/v1"
                  aria-invalid={Boolean(fieldErrors.baseUrl)}
                />
              </Field>
              <Field label="Model" htmlFor="embedding-model" required error={fieldErrors.model}>
                <Input
                  id="embedding-model"
                  value={form.model}
                  onChange={(event) => setField("model", event.target.value)}
                  placeholder="text-embedding-3-small"
                  aria-invalid={Boolean(fieldErrors.model)}
                />
              </Field>
              <Field label="Dimensions" htmlFor="embedding-dimensions" required error={fieldErrors.dimensions}>
                <Input
                  id="embedding-dimensions"
                  type="number"
                  min={1}
                  max={2000}
                  value={form.dimensions}
                  onChange={(event) => setField("dimensions", event.target.value)}
                  aria-invalid={Boolean(fieldErrors.dimensions)}
                />
              </Field>
              <Field
                label="Secret reference"
                htmlFor="embedding-secret-ref"
                required
                error={fieldErrors.secretRef}
                description="Reference an environment variable or secret manager entry; never paste the credential itself."
              >
                <Input
                  id="embedding-secret-ref"
                  value={form.secretRef}
                  onChange={(event) => setField("secretRef", event.target.value)}
                  placeholder="env:OPENAI_API_KEY"
                  aria-invalid={Boolean(fieldErrors.secretRef)}
                />
              </Field>
            </div>
          </section>

          <section className="space-y-4 border-t pt-5">
            <SectionHeading title="Indexing and runtime" description="Tune chunking, throughput, and generation retention." />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField field="chunkSize" label="Chunk size" minimum={100} maximum={32000} form={form} errors={fieldErrors} setField={setField} />
              <NumberField field="chunkOverlap" label="Chunk overlap" minimum={0} maximum={31999} form={form} errors={fieldErrors} setField={setField} />
              <Field label="Chunking version" htmlFor="embedding-chunking-version" error={fieldErrors.chunkingVersion}>
                <Input
                  id="embedding-chunking-version"
                  value={form.chunkingVersion}
                  onChange={(event) => setField("chunkingVersion", event.target.value)}
                  aria-invalid={Boolean(fieldErrors.chunkingVersion)}
                />
              </Field>
              <NumberField field="batchSize" label="Batch size" minimum={1} maximum={2048} form={form} errors={fieldErrors} setField={setField} />
              <NumberField field="maxConcurrency" label="Max concurrency" minimum={1} maximum={32} form={form} errors={fieldErrors} setField={setField} />
              <NumberField field="timeoutMs" label="Timeout (ms)" minimum={100} maximum={120000} form={form} errors={fieldErrors} setField={setField} />
              <NumberField field="retentionGenerations" label="Retained generations" minimum={1} maximum={100} form={form} errors={fieldErrors} setField={setField} />
            </div>
          </section>

          {editing && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
              Changing provider, model, dimensions, credentials, or chunking settings disables this profile. Rebuild and activate a compatible generation before enabling it again.
            </div>
          )}
          {submitError && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {submitError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Create profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-start gap-2">
      <SlidersHorizontal className="mt-0.5 h-4 w-4 text-muted-foreground" />
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function NumberField({
  field,
  label,
  minimum,
  maximum,
  form,
  errors,
  setField,
}: {
  field: "timeoutMs" | "batchSize" | "maxConcurrency" | "chunkSize" | "chunkOverlap" | "retentionGenerations";
  label: string;
  minimum: number;
  maximum: number;
  form: FormState;
  errors: FieldErrors;
  setField: <K extends FieldName>(field: K, value: FormState[K]) => void;
}) {
  const id = `embedding-${field}`;
  return (
    <Field label={label} htmlFor={id} error={errors[field]}>
      <Input
        id={id}
        type="number"
        min={minimum}
        max={maximum}
        value={form[field]}
        onChange={(event) => setField(field, event.target.value)}
        aria-invalid={Boolean(errors[field])}
      />
    </Field>
  );
}

function Field({
  label,
  htmlFor,
  children,
  error,
  description,
  required = false,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  error?: string;
  description?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}{required && <span aria-hidden="true" className="text-destructive"> *</span>}
      </label>
      {children}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {error && <p id={`${htmlFor}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
