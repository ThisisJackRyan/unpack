import "server-only";
import { cache } from "react";
import type { Teacher } from "@/db/schema";
import { requireArea } from "./account";

// Server-only: the signed-in teacher's row, for every teacher page,
// layout, and action. Guards the role on the server: an account with no
// role is sent to /welcome, and a self-learner to /learn (see
// account-role.ts), so a self-learner never reaches a class page or a
// teacher action. Creating the row on a first visit is in account.ts.
export const getOrCreateTeacher = cache(async (): Promise<Teacher> => requireArea("teacher"));
