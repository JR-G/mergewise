interface User {
  name: string
  age: number
}

const STATUS = "active" as const

function isUser(data: unknown): data is User {
  const candidate = data as User
  return typeof candidate.name === "string" && typeof candidate.age === "number"
}

function castSafely(data: unknown): Record<string, string> {
  return data as unknown as Record<string, string>
}
