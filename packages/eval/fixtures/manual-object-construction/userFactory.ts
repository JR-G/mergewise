import type { EventEmitter } from "node:events";

type Permission = "read" | "write" | "delete" | "admin";

interface User {
  role: string;
  permissions: Permission[];
  createdAt: Date;
  active: boolean;
  auditLog: string[];
  lastLogin: Date | null;
}

function seedUsers(emitter: EventEmitter): User[] {
  const adminUser: User = {
    role: "admin",
    permissions: ["read", "write", "delete", "admin"],
    createdAt: new Date("2024-01-01"),
    active: true,
    auditLog: [],
    lastLogin: null,
  };

  const editorUser: User = {
    role: "editor",
    permissions: ["read", "write"],
    createdAt: new Date("2024-01-01"),
    active: true,
    auditLog: [],
    lastLogin: null,
  };

  const viewerUser: User = {
    role: "viewer",
    permissions: ["read"],
    createdAt: new Date("2024-01-01"),
    active: true,
    auditLog: [],
    lastLogin: null,
  };

  const auditorUser: User = {
    role: "auditor",
    permissions: ["read"],
    createdAt: new Date("2024-01-01"),
    active: false,
    auditLog: [],
    lastLogin: null,
  };

  const users = [adminUser, editorUser, viewerUser, auditorUser];
  emitter.emit("users:seeded", users.length);
  return users;
}

export { seedUsers };
