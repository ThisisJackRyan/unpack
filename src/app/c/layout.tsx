import { StudentShell } from "@/components/student-shell";

export default function StudentLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <StudentShell>{children}</StudentShell>;
}
