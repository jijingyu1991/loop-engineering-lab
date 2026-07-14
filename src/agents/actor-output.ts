import { z } from "zod";

import { ACT_OUTCOMES } from "../domain/loop-step.js";

/** SDK 在 final output 边界校验该 schema，避免把任意非空说明文本误认成成功。 */
export const actorOutputSchema = z.object({
  output: z.string().min(1),
  outcome: z.enum(ACT_OUTCOMES),
});

export type ActorOutput = z.infer<typeof actorOutputSchema>;
