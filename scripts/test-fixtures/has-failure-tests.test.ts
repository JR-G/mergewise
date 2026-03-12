import { describe, test, expect } from "bun:test"

describe("calculator", () => {
  test("adds two numbers", () => {
    expect(1 + 2).toBe(3)
  })

  test("throws when input is invalid", () => {
    expect(() => divide(1, 0)).toThrow("Division by zero")
  })
})

function divide(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new Error("Division by zero")
  }
  return numerator / denominator
}
