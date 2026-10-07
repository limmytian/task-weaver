CREATE TABLE task_weaver.project_preferences (
  actor_id uuid NOT NULL REFERENCES task_weaver.auth_actors(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES task_weaver.projects(id) ON DELETE CASCADE,
  pinned_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, project_id)
);
