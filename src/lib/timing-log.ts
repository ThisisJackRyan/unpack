// Structured timing logs: one JSON line per event through console.info,
// with an "event" field, so the Vercel log search can filter on it. Ids,
// durations, counts and enums only: never reading text, questions,
// answers, names, emails, birth months or years, or class codes. Values
// are strings, numbers and booleans; undefined fields are left out. No
// imports except types, so tests drive it with a fake writer and clock.

import type { WriteReport } from "./ai/questions";
import type { QuestionMode } from "./question-modes";
import type { StudentReadingView } from "./student-reading-view";

export type LogValue = string | number | boolean | undefined;
export type LineWriter = (line: string) => void;
export type Clock = () => number;

// Monotonic milliseconds, for durations only.
export const monotonicNow: Clock = () => performance.now();

export function elapsedMs(start: number, now: Clock = monotonicNow): number {
  return Math.round(now() - start);
}

// Never throws: a log line must not break a page or a write.
export function logEvent(event: string, fields: Record<string, LogValue>, write: LineWriter = console.info): void {
  try {
    write(JSON.stringify({ event, ...fields }));
  } catch {
    // Nothing to do; the event is lost.
  }
}

// "shared": a teacher's set (or a per-student reading's sample, with
// intent "sample"); "per_student": a student's own set; "self": a
// self-learner's set.
export type GenerateMode = QuestionMode | "self";

// The teacher's button, for writes from the questions panel.
export type GenerateIntent = "generate" | "regenerate_all" | "regenerate_one" | "sample";

// questions.generate, once per question write (success or failure), from
// writeValidated's report. readingId is the reading's uuid.
export function questionsGenerateReporter(
  fields: { readingId: string; mode: GenerateMode; intent?: GenerateIntent },
  write?: LineWriter,
): (report: WriteReport) => void {
  return (report) =>
    logEvent(
      "questions.generate",
      {
        readingId: fields.readingId,
        mode: fields.mode,
        intent: fields.intent,
        outcome: report.outcome,
        durationMs: report.durationMs,
        attempts: report.attempts,
        // HTTP requests to the gateway, SDK retries included; left out
        // when the model doesn't report them (the fakes in checks).
        httpRequests: report.httpRequests || undefined,
      },
      write,
    );
}

// Where the page's questions came from: the shared set, the student's
// saved set, a set written in this request, another request still
// writing it, a failed write, a limit, or no such reading.
export type PageReadySource = "shared" | "cached" | "generated" | "pending" | "error" | "limited" | "not_found";

export function pageReadySource(view: StudentReadingView, mode: GenerateMode | undefined, generated: boolean): PageReadySource {
  switch (view.kind) {
    case "questions":
      return mode === "shared" ? "shared" : generated ? "generated" : "cached";
    case "pending":
      return "pending";
    case "error":
    case "unavailable":
      return "error";
    case "limit_reached":
    case "throttled":
    case "calls_used_up":
      return "limited";
    case "not_found":
      return "not_found";
  }
}

// How the request reached the page: a full page load, or a client
// navigation or router.refresh (the pending view's refreshes; an RSC
// request), from Next's own request headers.
export type PageRequestKind = "document" | "rsc" | "prefetch";

export function pageRequestKind(headers: Pick<Headers, "get">): PageRequestKind {
  if (headers.get("next-router-prefetch")) return "prefetch";
  return headers.get("rsc") === "1" ? "rsc" : "document";
}

// How long this server instance has been up: small on a cold start.
export function instanceAgeMs(): number | undefined {
  return typeof process !== "undefined" && typeof process.uptime === "function"
    ? Math.round(process.uptime() * 1000)
    : undefined;
}

// questions.page_ready, once per student reading page render, after its
// data is loaded. questionsMs covers resolving the questions (the shared
// read, or the per-student lookup and any write); totalMs covers the
// page's server data from its start (session, reading, questions,
// progress). readingId only when it is a uuid (it comes from the URL).
export function logPageReady(
  fields: {
    readingId?: string;
    mode?: GenerateMode;
    path: "class" | "self";
    source: PageReadySource;
    questionsMs: number;
    totalMs: number;
    request: PageRequestKind;
    instanceAgeMs?: number;
  },
  write?: LineWriter,
): void {
  logEvent("questions.page_ready", fields, write);
}
