// Shared scaffolding for tests that need a spawnable agent without a model.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Agent, AgentEvent } from "../src/agents/agents.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Relay spawns an agent by its name, resolved on PATH, exactly as it does for
 * claude. A shim called `fake` puts the scripted CLI there.
 */
export function putFakeOnPath(): void {
  const bin = mkdtempSync(join(tmpdir(), "relay-bin-"));
  writeFileSync(join(bin, "fake"), `#!/bin/sh\nexec ${process.execPath} ${join(here, "fake-agent.ts")} "$@"\n`, {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "relay-test-"));
}

export function fixture(name: string): string {
  return join(here, "fixtures", name);
}

/** `{session}` and `{native}` stand in for what Relay passes at spawn time. */
export function fake(start: string[], resume: string[] = start): Agent {
  return {
    name: "fake",
    start: (sessionId) => start.map((arg) => arg.replaceAll("{session}", sessionId)),
    resume: (nativeId) => resume.map((arg) => arg.replaceAll("{native}", nativeId)),
    parse: (line): AgentEvent | null => {
      const event = JSON.parse(line) as { type?: string; id?: string; text?: string };
      if (event.type === "session" && event.id) return { nativeId: event.id };
      if (event.type === "text" && typeof event.text === "string") return { text: event.text };
      return null;
    },
  };
}

/** An agent that replays a recorded capture through a real parser. */
export function replaying(capture: string, parse: Agent["parse"]): Agent {
  const argv = ["--replay", fixture(capture), "--chunk", "7"];
  return { name: "fake", start: () => argv, resume: () => argv, parse };
}
