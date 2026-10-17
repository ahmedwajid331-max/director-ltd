import { z } from "zod";

// Per-user CRM state patch shared by the single-company and bulk state routes.
export const statePatchSchema = z
  .object({
    followed: z.boolean().optional(),
    trashed: z.boolean().optional(),
    saved: z.boolean().optional(),
    redFlagged: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to change" });

export type StatePatch = z.infer<typeof statePatchSchema>;

// Follow and Trash are mutually exclusive, per user:
//  - trashing a followed company removes it from Followed (it moves to Trash);
//  - following a trashed company restores it from Trash;
//  - restoring (trashed:false) leaves the company un-followed.
// Saved and Red Flag are independent of both and are never touched here.
export function resolveStatePatch(patch: StatePatch): StatePatch {
  const next = { ...patch };
  if (next.trashed === true) next.followed = false;
  if (next.followed === true) next.trashed = false;
  return next;
}
