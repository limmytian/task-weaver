import { z } from 'zod';

export const deliveryInsightsQuerySchema = z.object({
  projectId: z.string().uuid(), requirementId: z.string().uuid().optional(),
  since: z.string().datetime().optional(), until: z.string().datetime().optional(),
}).strict().refine(value => !value.since || !value.until || Date.parse(value.since) < Date.parse(value.until), 'Invalid time window');
