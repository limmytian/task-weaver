CREATE FUNCTION "task_weaver"."guard_thin_execution_slice_write"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_mode text;
BEGIN
  SELECT p.worker_mode INTO current_mode
  FROM "task_weaver"."projects" p JOIN "task_weaver"."requirements" r ON r.project_id = p.id
  WHERE r.id = NEW.requirement_id FOR UPDATE OF p;
  IF current_mode = 'thin' THEN
    RAISE EXCEPTION 'Execution slices are historical in thin worker projects' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "guard_thin_execution_slice_write" BEFORE INSERT OR UPDATE ON "task_weaver"."execution_slices"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."guard_thin_execution_slice_write"();
--> statement-breakpoint
CREATE FUNCTION "task_weaver"."guard_thin_task_slice_assignment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_mode text;
BEGIN
  IF NEW.execution_slice_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.execution_slice_id IS NOT DISTINCT FROM OLD.execution_slice_id THEN RETURN NEW; END IF;
  SELECT worker_mode INTO current_mode FROM "task_weaver"."projects" WHERE id = NEW.project_id FOR UPDATE;
  IF current_mode = 'thin' THEN
    RAISE EXCEPTION 'Execution slices are historical in thin worker projects' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "guard_thin_task_slice_assignment" BEFORE INSERT OR UPDATE ON "task_weaver"."tasks"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."guard_thin_task_slice_assignment"();
