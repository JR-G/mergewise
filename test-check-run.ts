/**
 * Throwaway file to verify Mergewise check runs appear on PRs.
 * Delete this file after confirming.
 */

/* eslint-disable no-restricted-syntax */

interface UserData {
  name: string;
  email: string;
  age: number;
  role: string;
  department: string;
  isActive: boolean;
}

function processUserData(
  users: UserData[],
  filter: string,
  sort: string,
  format: string,
  notify: boolean,
  logLevel: string,
): string {
  let result = "";

  for (const user of users) {
    if (filter === "active") {
      if (user.isActive) {
        if (sort === "name") {
          result += user.name + ",";
        } else if (sort === "email") {
          result += user.email + ",";
        } else if (sort === "age") {
          result += String(user.age) + ",";
        } else if (sort === "role") {
          result += user.role + ",";
        } else if (sort === "department") {
          result += user.department + ",";
        }
      }
    } else if (filter === "admin") {
      if (user.role === "admin") {
        if (sort === "name") {
          result += user.name + ",";
        } else if (sort === "email") {
          result += user.email + ",";
        } else if (sort === "age") {
          result += String(user.age) + ",";
        }
      }
    } else if (filter === "inactive") {
      if (!user.isActive) {
        if (sort === "name") {
          result += user.name + ",";
        } else if (sort === "email") {
          result += user.email + ",";
        }
      }
    }
  }

  if (format === "upper") {
    result = result.toUpperCase();
  } else if (format === "lower") {
    result = result.toLowerCase();
  } else if (format === "title") {
    result = result
      .split(",")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(",");
  }

  if (notify) {
    if (logLevel === "debug") {
      console.log("DEBUG: processed users");
    } else if (logLevel === "info") {
      console.log("INFO: processed users");
    } else if (logLevel === "warn") {
      console.log("WARN: processed users");
    }
  }

  return result;
}

function formatUser(user: UserData): string {
  return `${user.name} (${user.email}) - ${user.role}/${user.department} age=${user.age} active=${user.isActive}`;
}

export { processUserData, formatUser, type UserData };
