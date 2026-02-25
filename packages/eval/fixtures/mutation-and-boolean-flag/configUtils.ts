interface Config {
  timeout: number;
  retries: number;
  verbose: boolean;
}

function applyDefaults(config: Config): Config {
  config.timeout ??= 3000;
  config.retries ??= 3;
  config.verbose ??= false;
  return config;
}

interface User { id: string; name: string; active: boolean }

function getUsers(includeInactive: boolean): User[] {
  const allUsers: User[] = [];
  if (includeInactive) {
    return allUsers;
  }
  return allUsers.filter(u => u.active);
}
