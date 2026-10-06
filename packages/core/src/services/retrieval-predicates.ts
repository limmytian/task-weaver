import type { SQL } from "drizzle-orm";

/** Private implementation boundary: predicates are built from live verified authority. */
export interface RetrievalPredicates {
  tasks?: SQL;
  requirements?: SQL;
  documents?: SQL;
  profiles?: SQL;
}
