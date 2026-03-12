import { describe, test, expect } from "bun:test"

describe("calculator", () => {
  test("adds two numbers", () => {
    expect(1 + 2).toBe(3)
  })

  test("multiplies two numbers", () => {
    expect(2 * 3).toBe(6)
  })
})
