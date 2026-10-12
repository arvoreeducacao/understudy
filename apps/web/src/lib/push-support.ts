export type PushSupport = "supported" | "install-first" | "unsupported";

export type PushEnvironment = {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasPushApi: boolean;
};

export function isAppleTouchDevice(userAgent: string, maxTouchPoints: number) {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export function pushSupport(environment: PushEnvironment): PushSupport {
  if (environment.hasPushApi) return "supported";
  if (isAppleTouchDevice(environment.userAgent, environment.maxTouchPoints) && !environment.standalone) return "install-first";
  return "unsupported";
}
