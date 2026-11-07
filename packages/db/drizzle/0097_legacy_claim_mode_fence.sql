CREATE FUNCTION "task_weaver"."guard_legacy_task_claim_mode"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_mode text;
BEGIN
  SELECT p.worker_mode INTO current_mode
  FROM "task_weaver"."projects" p JOIN "task_weaver"."tasks" t ON t.project_id = p.id
  WHERE t.id = NEW.task_id FOR UPDATE OF p;
  IF current_mode = 'thin' THEN
    RAISE EXCEPTION 'Legacy acquisition is disabled for this project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "guard_legacy_task_claim_mode" BEFORE INSERT OR UPDATE ON "task_weaver"."task_claims"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."guard_legacy_task_claim_mode"();
--> statement-breakpoint
CREATE FUNCTION "task_weaver"."guard_legacy_requirement_claim_mode"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE current_mode text;
BEGIN
  SELECT p.worker_mode INTO current_mode
  FROM "task_weaver"."projects" p JOIN "task_weaver"."requirements" r ON r.project_id = p.id
  WHERE r.id = NEW.requirement_id FOR UPDATE OF p;
  IF current_mode = 'thin' THEN
    RAISE EXCEPTION 'Legacy acquisition is disabled for this project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "guard_legacy_requirement_claim_mode" BEFORE INSERT OR UPDATE ON "task_weaver"."requirement_claims"
FOR EACH ROW EXECUTE FUNCTION "task_weaver"."guard_legacy_requirement_claim_mode"();
