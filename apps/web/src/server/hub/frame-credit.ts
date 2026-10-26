export const FRAMES_IN_FLIGHT = 2;
export const FRAME_BACKLOG_BYTES = 256 * 1024;

export type FrameCredit = { acks: boolean; inFlight: number; behind: boolean };

export function frameCredit(acks: boolean): FrameCredit {
  return { acks, inFlight: 0, behind: false };
}

export function takeFrameSlot(credit: FrameCredit, bufferedAmount: number): boolean {
  const room = bufferedAmount < FRAME_BACKLOG_BYTES && (!credit.acks || credit.inFlight < FRAMES_IN_FLIGHT);
  credit.behind = !room;
  if (room && credit.acks) credit.inFlight += 1;
  return room;
}

export function frameAcked(credit: FrameCredit): boolean {
  credit.inFlight = Math.max(0, credit.inFlight - 1);
  return credit.behind;
}
