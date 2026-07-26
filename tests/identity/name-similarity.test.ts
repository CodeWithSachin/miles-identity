import { test, expect, describe } from "bun:test";
import { nameSimilarity } from "@/identity/name-similarity";

describe("nameSimilarity", () => {
  test("identical names score 1", () => {
    expect(nameSimilarity("Ananya Rao", "Ananya Rao")).toBe(1);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(nameSimilarity("Ananya Rao", "  ANANYA   RAO ")).toBe(1);
  });

  test("a one-character typo scores at or above the 0.9 dedup threshold", () => {
    expect(nameSimilarity("Ananya Rao", "Ananya Rao ")).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity("Sachin Singh", "Sachin Singg")).toBeGreaterThanOrEqual(0.9);
  });

  test("unrelated names score low", () => {
    expect(nameSimilarity("Ananya Rao", "Priya Sharma")).toBeLessThan(0.9);
  });

  test("two empty names are identical", () => {
    expect(nameSimilarity("", "   ")).toBe(1);
  });

  test("one empty and one non-empty name are maximally dissimilar", () => {
    expect(nameSimilarity("", "Ananya Rao")).toBe(0);
  });

  test("idempotent: re-normalising an already-normalised name does not change the score", () => {
    const a = "Ananya Rao";
    const b = "Priya Sharma";
    const score = nameSimilarity(a, b);
    expect(nameSimilarity(a.trim().toLowerCase(), b)).toBe(score);
  });
});
