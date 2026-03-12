interface User {
  name: string
  age: number
}

function getUser(data: unknown): User {
  return data as User
}

function processResponse(response: unknown): string {
  const result = response as Record<string, string>
  return result.value
}
