import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Teacher } from "@/db/schema";
import { atClassLimit } from "./classes";

function teacher(plan: Teacher["plan"]): Teacher {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    clerkUserId: "user_test",
    name: null,
    email: "test@example.invalid",
    plan,
    createdAt: new Date(0),
  };
}

describe("atClassLimit", () => {
  it("lets a free teacher with no classes create one", () => {
    assert.equal(atClassLimit(teacher("free"), 0), false);
  });

  it("stops a free teacher at 1 class", () => {
    assert.equal(atClassLimit(teacher("free"), 1), true);
    assert.equal(atClassLimit(teacher("free"), 2), true);
  });

  it("never limits a paid teacher", () => {
    for (const count of [0, 1, 2, 50, 1000]) {
      assert.equal(atClassLimit(teacher("paid"), count), false);
    }
  });
});
