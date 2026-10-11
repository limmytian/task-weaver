"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import { uploadAttachment } from "@/lib/attachment-client";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownEditor } from "@/components/markdown-editor";

export function CreateDocumentDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
}) {
  const [form, setForm] = useState<"markdown" | "attachment">("markdown");
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const utils = trpc.useUtils();

  const createDocument = trpc.document.create.useMutation({
    onSuccess: () => {
      utils.document.list.invalidate();
      onOpenChange(false);
      setTitle("");
      setContent("");
      setTags("");
      toast.success("Document created");
    },
    onError: (err) => toast.error("Failed to create document", { description: err.message }),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (form === "attachment") {
      if (!file) return;
      setUploading(true);
      try {
        await uploadAttachment(file, { projectId, title: title.trim(), description, tags: tags.split(",").map(t => t.trim()).filter(Boolean), originalFilename: file.name, mimeType: file.type || "application/octet-stream" });
        await utils.document.list.invalidate(); onOpenChange(false); setTitle(""); setFile(null); setDescription(""); setTags(""); toast.success("Attachment created");
      } catch (error) { toast.error("Upload failed", { description: error instanceof Error ? error.message : "Please retry" }); }
      finally { setUploading(false); }
      return;
    }
    if (!content.trim()) return;
    createDocument.mutate({
      title: title.trim(),
      content: content.trim(),
      projectId,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Document</DialogTitle>
            <DialogDescription>
              Add a new document to the knowledge base. Use [[title]] for wiki-links.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <label className="block space-y-2 text-sm">Document form
              <select className="h-9 w-full rounded-md border bg-background px-3" value={form} onChange={e => setForm(e.target.value as "markdown" | "attachment")} disabled={uploading}>
                <option value="markdown">Markdown</option><option value="attachment">Attachment</option>
              </select>
            </label>
            <Input
              placeholder="Document title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            {form === "markdown" ? <MarkdownEditor
              content={content}
              onChange={setContent}
              placeholder="Start writing Markdown... (type [[ for wiki-links)"
              projectId={projectId}
            /> : <>
              <label className="block space-y-2 text-sm">Original file
                <Input type="file" disabled={uploading} onChange={e => { const selected = e.target.files?.[0] ?? null; setFile(selected); if (selected && !title) setTitle(selected.name); }} />
              </label>
              <Textarea aria-label="Attachment description" value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" maxLength={1000} />
              <p className="text-xs text-muted-foreground">PDF, raster images and plain text support previews. Other formats can be downloaded. The default upload limit is 50 MiB.</p>
            </>}
            <Input
              placeholder="Tags (comma separated)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!title.trim() || (form === "markdown" ? !content.trim() : !file) || createDocument.isPending || uploading}
            >
              {createDocument.isPending || uploading ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
