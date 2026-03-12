function processInput(raw: string): number {
  const value = parseInt(raw, 10)
  if (!Number.isFinite(value)) {
    throw new Error("Invalid input")
  }
  return value * 2
}

function convertCount(input: string): number {
  const count = Number(input)
  if (isNaN(count)) {
    return 0
  }
  return count + 1
}

function parseAge(raw: string): number {
  const age = parseInt(raw, 10)
  if (age < 0 || age > 150) {
    throw new Error("Age out of range")
  }
  return age
}
