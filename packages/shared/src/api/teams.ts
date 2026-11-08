// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Teams (05 §7): name, colour, members — people values `team:<id>` and "my teams" in filters and visibility. */
export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  member_ids: z.array(z.string()),
});
export type Team = z.infer<typeof teamSchema>;
export const teamListSchema = z.object({ data: z.array(teamSchema) });

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().max(32).nullable().optional(),
  member_ids: z.array(z.string()).max(1000).optional(),
});
export const updateTeamSchema = createTeamSchema.partial();
