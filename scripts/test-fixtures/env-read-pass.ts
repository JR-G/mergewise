function getApiKey(): string {
  const apiKey = process.env.API_KEY
  if (!apiKey) {
    throw new Error("Missing API_KEY")
  }
  return apiKey + "/endpoint"
}

function getBaseUrl(): string {
  return process.env.BASE_URL ?? "http://localhost:3000"
}

function getTimeout(): string {
  return process.env.TIMEOUT || "5000"
}

function getEnv(): string {
  return process.env.NODE_ENV
}
