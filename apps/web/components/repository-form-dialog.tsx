"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { GitFork } from "lucide-react";
import { trpc } from "@/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";

export type EditableRepository = {
  id: string;
  displayName: string;
  description: string | null;
  provider: string;
  host: string;
  namespace: string;
  name: string;
  webUrl: string | null;
  httpsCloneUrl: string | null;
  sshCloneUrl: string | null;
  defaultBranch: string | null;
  tags: string[] | null;
  visibility: "instance" | "restricted" | "private";
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository?: EditableRepository | null;
  onSaved?: (repositoryId: string) => void;
};

type RepositoryFormState = {
  displayName: string;
  description: string;
  provider: string;
  host: string;
  namespace: string;
  name: string;
  webUrl: string;
  httpsCloneUrl: string;
  sshCloneUrl: string;
  defaultBranch: string;
  tags: string;
  visibility: "instance" | "restricted" | "private";
};

const emptyForm: RepositoryFormState = {
  displayName: "",
  description: "",
  provider: "generic",
  host: "",
  namespace: "",
  name: "",
  webUrl: "",
  httpsCloneUrl: "",
  sshCloneUrl: "",
  defaultBranch: "main",
  tags: "",
  visibility: "instance" as const,
};

type RepositoryField = "host" | "namespace" | "name" | "webUrl" | "httpsCloneUrl" | "sshCloneUrl";
type RepositoryFieldErrors = Partial<Record<RepositoryField, string>>;

const secretEndpointPattern = /:\/\/[^/@\s]+:[^/@\s]+@|[?&](?:access_?token|api_?key|password|secret|token)=|#/i;

function formFor(repository?: EditableRepository | null): RepositoryFormState {
  return repository ? {
    displayName: repository.displayName,
    description: repository.description ?? "",
    provider: repository.provider,
    host: repository.host,
    namespace: repository.namespace,
    name: repository.name,
    webUrl: repository.webUrl ?? "",
    httpsCloneUrl: repository.httpsCloneUrl ?? "",
    sshCloneUrl: repository.sshCloneUrl ?? "",
    defaultBranch: repository.defaultBranch ?? "",
    tags: repository.tags?.join(", ") ?? "",
    visibility: repository.visibility,
  } : emptyForm;
}

function validate(form: RepositoryFormState): RepositoryFieldErrors {
  const errors: RepositoryFieldErrors = {};
  if (!form.host.trim()) errors.host = "Host is required.";
  if (!form.namespace.trim()) errors.namespace = "Namespace or owner is required.";
  if (!form.name.trim()) errors.name = "Repository name is required.";
  for (const field of ["webUrl", "httpsCloneUrl", "sshCloneUrl"] as const) {
    if (form[field] && secretEndpointPattern.test(form[field])) {
      errors[field] = "Remove credentials, secret query parameters, and URL fragments. Credentials are configured on the daemon node.";
    }
  }
  return errors;
}

export function RepositoryFormDialog({ open, onOpenChange, repository, onSaved }: Props) {
  const [form, setForm] = useState<RepositoryFormState>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<RepositoryFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const utils = trpc.useUtils();
  const editing = Boolean(repository);
  const initialForm = useMemo(() => formFor(repository), [repository]);
  const dirty = open && JSON.stringify(form) !== JSON.stringify(initialForm);

  useEffect(() => {
    if (!open) return;
    // Reset the reusable dialog whenever it opens for a different catalog entry.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(initialForm);
    setFieldErrors({});
    setSubmitError(null);
    setDiscardOpen(false);
  }, [initialForm, open]);

  const canonicalPreview = useMemo(() => {
    const host = form.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const namespace = form.namespace.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
    const name = form.name.trim().replace(/\.git$/i, "").toLowerCase();
    return [host, namespace, name].filter(Boolean).join("/");
  }, [form.host, form.namespace, form.name]);

  const create = trpc.repository.create.useMutation();
  const update = trpc.repository.update.useMutation();
  const pending = create.isPending || update.isPending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = validate(form);
    setFieldErrors(errors);
    setSubmitError(null);
    if (Object.keys(errors).length > 0) return;
    const tags = form.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    try {
      const saved = repository
        ? await update.mutateAsync({
            id: repository.id,
            data: {
              displayName: form.displayName,
              description: form.description || null,
              provider: form.provider,
              host: form.host,
              namespace: form.namespace,
              name: form.name,
              webUrl: form.webUrl || null,
              httpsCloneUrl: form.httpsCloneUrl || null,
              sshCloneUrl: form.sshCloneUrl || null,
              defaultBranch: form.defaultBranch || null,
              tags,
              visibility: form.visibility,
            },
          })
        : await create.mutateAsync({
            displayName: form.displayName || form.name,
            description: form.description || undefined,
            provider: form.provider,
            host: form.host,
            namespace: form.namespace,
            name: form.name,
            webUrl: form.webUrl || undefined,
            httpsCloneUrl: form.httpsCloneUrl || undefined,
            sshCloneUrl: form.sshCloneUrl || undefined,
            defaultBranch: form.defaultBranch || undefined,
            tags,
            visibility: form.visibility,
            authPolicy: {},
          });
      await utils.repository.invalidate();
      toast.success(editing ? "Repository updated" : "Repository created");
      onOpenChange(false);
      onSaved?.(saved.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Repository could not be saved";
      setSubmitError(message);
      toast.error(message);
    }
  };

  const set = (key: Exclude<keyof RepositoryFormState, "visibility">, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setField = (key: Exclude<keyof RepositoryFormState, "visibility">, value: string) => {
    set(key, value);
    setSubmitError(null);
    if (key in fieldErrors) setFieldErrors((current) => ({ ...current, [key]: undefined }));
  };

  const requestOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && dirty && !pending) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(nextOpen);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby="repository-form-description">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitFork className="h-5 w-5" />
              {editing ? "Edit repository" : "Add repository"}
            </DialogTitle>
            <DialogDescription id="repository-form-description">
              Store identity and non-secret endpoints only. Credentials are resolved locally by trusted daemon nodes.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name" htmlFor="repo-display-name">
              <Input id="repo-display-name" autoFocus value={form.displayName} onChange={(event) => setField("displayName", event.target.value)} placeholder="Task Weaver" />
            </Field>
            <Field label="Provider" htmlFor="repo-provider">
              <Select value={form.provider} onValueChange={(value) => setField("provider", value)}>
                <SelectTrigger id="repo-provider"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="generic">Generic Git</SelectItem>
                  <SelectItem value="github">GitHub</SelectItem>
                  <SelectItem value="gitea">Gitea</SelectItem>
                  <SelectItem value="gitlab">GitLab</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Host" htmlFor="repo-host" error={fieldErrors.host} required>
              <Input id="repo-host" value={form.host} onChange={(event) => setField("host", event.target.value)} placeholder="git.example.com" aria-invalid={Boolean(fieldErrors.host)} aria-describedby={fieldErrors.host ? "repo-host-error" : undefined} />
            </Field>
            <Field label="Namespace / owner" htmlFor="repo-namespace" error={fieldErrors.namespace} required>
              <Input id="repo-namespace" value={form.namespace} onChange={(event) => setField("namespace", event.target.value)} placeholder="platform" aria-invalid={Boolean(fieldErrors.namespace)} aria-describedby={fieldErrors.namespace ? "repo-namespace-error" : undefined} />
            </Field>
            <Field label="Repository name" htmlFor="repo-name" error={fieldErrors.name} required>
              <Input id="repo-name" value={form.name} onChange={(event) => setField("name", event.target.value)} placeholder="task-weaver" aria-invalid={Boolean(fieldErrors.name)} aria-describedby={fieldErrors.name ? "repo-name-error" : undefined} />
            </Field>
            <Field label="Default branch" htmlFor="repo-default-branch">
              <Input id="repo-default-branch" value={form.defaultBranch} onChange={(event) => setField("defaultBranch", event.target.value)} placeholder="main" />
            </Field>
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm" aria-live="polite">
            <span className="text-muted-foreground">Canonical identity: </span>
            <code className="break-all">{canonicalPreview || "Complete host, namespace, and name"}</code>
          </div>

          <Field label="Description" htmlFor="repo-description">
            <Textarea id="repo-description" value={form.description} onChange={(event) => setField("description", event.target.value)} rows={3} />
          </Field>
          <div className="grid gap-4">
            <Field label="Web URL" htmlFor="repo-web-url" error={fieldErrors.webUrl}><Input id="repo-web-url" value={form.webUrl} onChange={(event) => setField("webUrl", event.target.value)} placeholder="https://git.example.com/platform/task-weaver" aria-invalid={Boolean(fieldErrors.webUrl)} aria-describedby={fieldErrors.webUrl ? "repo-web-url-error" : undefined} /></Field>
            <Field label="HTTPS clone URL" htmlFor="repo-https-url" error={fieldErrors.httpsCloneUrl}><Input id="repo-https-url" value={form.httpsCloneUrl} onChange={(event) => setField("httpsCloneUrl", event.target.value)} placeholder="https://git.example.com/platform/task-weaver.git" aria-invalid={Boolean(fieldErrors.httpsCloneUrl)} aria-describedby={fieldErrors.httpsCloneUrl ? "repo-https-url-error" : undefined} /></Field>
            <Field label="SSH clone URL" htmlFor="repo-ssh-url" error={fieldErrors.sshCloneUrl}><Input id="repo-ssh-url" value={form.sshCloneUrl} onChange={(event) => setField("sshCloneUrl", event.target.value)} placeholder="git@git.example.com:platform/task-weaver.git" aria-invalid={Boolean(fieldErrors.sshCloneUrl)} aria-describedby={fieldErrors.sshCloneUrl ? "repo-ssh-url-error" : undefined} /></Field>
            <Field label="Tags" htmlFor="repo-tags"><Input id="repo-tags" value={form.tags} onChange={(event) => setField("tags", event.target.value)} placeholder="platform, typescript" /></Field>
          </div>

          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Visibility: <span className="font-medium text-foreground">{form.visibility}</span>. Visibility ownership is managed by the API in this release.
          </div>

          {submitError && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{submitError}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => requestOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Add repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={discardOpen}
      onOpenChange={setDiscardOpen}
      title="Discard repository changes?"
      description="Your unsaved repository identity and endpoint changes will be lost."
      confirmLabel="Discard changes"
      destructive
      onConfirm={() => {
        setDiscardOpen(false);
        onOpenChange(false);
      }}
    />
    </>
  );
}

function Field({ label, htmlFor, children, error, required = false }: { label: string; htmlFor: string; children: React.ReactNode; error?: string; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}{required && <span aria-hidden="true" className="text-destructive"> *</span>}</label>
      {children}
      {error && <p id={`${htmlFor}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
