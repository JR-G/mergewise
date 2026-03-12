function getApiKey(): string {
  const apiKey = process.env.API_KEY
  return apiKey + "/endpoint"
}

function getBaseUrl(): string {
  return process.env.BASE_URL + "/api"
}
