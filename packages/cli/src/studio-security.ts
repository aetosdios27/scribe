import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const sessionHeader = "x-scribe-studio-session";

export interface StudioSession {
  readonly token: string;
  origin?: string;
}

export function createStudioSession(): StudioSession {
  return { token: randomBytes(32).toString("base64url") };
}

export function authorizeStudioMutation(request: IncomingMessage, session: StudioSession): string | undefined {
  const suppliedToken = request.headers[sessionHeader];
  if (typeof suppliedToken !== "string" || !safeEqual(suppliedToken, session.token)) {
    return "This Studio mutation is missing a valid session capability.";
  }

  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    return "Studio mutations require Content-Type: application/json.";
  }

  if (request.headers["sec-fetch-site"] === "cross-site") {
    return "Cross-site Studio mutations are not allowed.";
  }

  const origin = request.headers.origin;
  if (origin !== undefined && session.origin !== undefined && origin !== session.origin) {
    return "The Studio mutation origin does not match this local session.";
  }

  if (session.origin !== undefined) {
    const expectedHost = new URL(session.origin).host;
    if (request.headers.host !== expectedHost) {
      return "The Studio mutation host does not match this local session.";
    }
  }

  return undefined;
}

export function studioSessionHeader(): string {
  return sessionHeader;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
