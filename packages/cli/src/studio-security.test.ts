import type { IncomingMessage } from "node:http";

import { expect, it } from "vitest";

import { authorizeStudioMutation, createStudioSession, studioSessionHeader } from "./studio-security.js";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}

it("accepts only the process capability on the matching local origin and host", () => {
  const session = createStudioSession();
  session.origin = "http://127.0.0.1:4317";

  expect(authorizeStudioMutation(request({
    [studioSessionHeader()]: session.token,
    "content-type": "application/json; charset=utf-8",
    origin: session.origin,
    host: "127.0.0.1:4317",
    "sec-fetch-site": "same-origin"
  }), session)).toBeUndefined();
});

it("rejects missing capabilities, cross-site requests, and mismatched origins", () => {
  const session = createStudioSession();
  session.origin = "http://127.0.0.1:4317";
  const base = {
    [studioSessionHeader()]: session.token,
    "content-type": "application/json",
    host: "127.0.0.1:4317"
  };

  expect(authorizeStudioMutation(request({ ...base, [studioSessionHeader()]: "wrong" }), session)).toContain("capability");
  expect(authorizeStudioMutation(request({ ...base, "sec-fetch-site": "cross-site" }), session)).toContain("Cross-site");
  expect(authorizeStudioMutation(request({ ...base, origin: "http://attacker.invalid" }), session)).toContain("origin");
  expect(authorizeStudioMutation(request({ ...base, host: "127.0.0.1:9999" }), session)).toContain("host");
});

it("requires JSON so ordinary cross-site form posts cannot mutate Studio", () => {
  const session = createStudioSession();
  session.origin = "http://127.0.0.1:4317";

  expect(authorizeStudioMutation(request({
    [studioSessionHeader()]: session.token,
    "content-type": "application/x-www-form-urlencoded",
    host: "127.0.0.1:4317"
  }), session)).toContain("application/json");
});
