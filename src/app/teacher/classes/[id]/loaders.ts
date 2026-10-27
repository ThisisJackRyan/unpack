import { cache } from "react";
import { notFound } from "next/navigation";
import { getClassForTeacher } from "@/lib/classes";
import { getReadingForTeacher } from "@/lib/readings";
import { getOrCreateTeacher } from "@/lib/teacher";

// Cached per request so generateMetadata and the page share one query.
// Both 404 when the class (or reading) isn't the teacher's, or the id is
// malformed.

export const loadClass = cache(async (id: string) => {
  const teacher = await getOrCreateTeacher();
  const found = await getClassForTeacher(id, teacher.id);
  if (!found) notFound();
  return found;
});

export const loadReading = cache(async (classId: string, readingId: string) => {
  const teacher = await getOrCreateTeacher();
  const found = await getReadingForTeacher(classId, readingId, teacher.id);
  if (!found) notFound();
  return found;
});
