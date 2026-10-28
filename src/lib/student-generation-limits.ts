// The "Try again" throttle (see the top of student-questions-core.ts). A
// set normally takes 1 call (the SDK's own retries happen inside it), so 3
// calls in 10 minutes is room for two failures in a row (given back or
// not), and 6 answered calls in all bound what one student can cost on one
// reading however long the model keeps failing.
//
// In a module of their own, with no imports: class-status.ts (and through
// it the challenge queue, a client component) needs the call limit, and
// student-questions-core.ts imports the model and server logging code.
export const STUDENT_GENERATION_WINDOW_LIMIT = 3;
export const STUDENT_GENERATION_WINDOW_MINUTES = 10;
export const STUDENT_GENERATION_CALL_LIMIT = 6;
