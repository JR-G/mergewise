interface User {
  role: "admin" | "editor" | "viewer";
  active: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: Date | null;
}

function canPerformAction(user: User, action: string, resource: string): boolean {
  if (user.active) {
    if (user.emailVerified) {
      if (user.role === "admin") {
        return true;
      } else if (user.role === "editor") {
        if (action === "read" || action === "write") {
          if (resource !== "settings" && resource !== "billing") {
            return true;
          } else {
            return false;
          }
        } else {
          return false;
        }
      } else {
        if (action === "read" && resource !== "settings" && resource !== "billing" && resource !== "users") {
          return true;
        } else {
          return false;
        }
      }
    } else {
      return false;
    }
  } else {
    return false;
  }
}

function isEligibleForPromotion(user: User): boolean {
  return user.active && user.emailVerified && user.twoFactorEnabled && user.role !== "admin" && user.lastLoginAt !== null && (new Date().getTime() - user.lastLoginAt.getTime()) < 30 * 24 * 60 * 60 * 1000;
}
