"use client";

import type { ComponentProps } from "react";
import { deferView } from "./deferred-view";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type Props = ComponentProps<typeof import("./task-detail-sheet").TaskDetailSheet>;

export const DeferredTaskDetailSheet = deferView<Props>(
  () => import("./task-detail-sheet").then(module => module.TaskDetailSheet),
  {
    shouldLoad: props => props.open,
    fallback: (props, failed, retry) => (
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader><SheetTitle>Task Details</SheetTitle></SheetHeader>
          {failed ? <div role="alert" className="py-4">
            <p>Unable to load task details.</p>
            <Button type="button" variant="outline" className="mt-2" onClick={retry}>Retry</Button>
          </div> : <p role="status" className="py-4 text-sm text-muted-foreground">Loading task details...</p>}
        </SheetContent>
      </Sheet>
    ),
  },
);
