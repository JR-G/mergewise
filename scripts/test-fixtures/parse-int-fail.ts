function processInput(raw: string): number {
  const value = parseInt(raw, 10)
  return value * 2
}

function convertCount(input: string): number {
  const count = Number(input)
  return count + 1
}
