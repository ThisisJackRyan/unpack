// Placeholder for the bot check on joining (v1 spec: "Joining a class is
// rate limited per IP and per code, with a bot check"). Always passes for
// now; the abuse PR replaces it with a real check (for example a Turnstile
// token in the form). The join action already calls it before recording
// the attempt, so swapping it in needs no other change.

export type JoinBotCheckInput = { ipHash: string };

export async function verifyJoinBotCheck(input: JoinBotCheckInput): Promise<{ ok: true }> {
  void input;
  return { ok: true };
}
