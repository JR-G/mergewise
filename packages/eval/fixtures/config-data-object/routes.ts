import type { RequestHandler } from "express";
import { handleGetUsers } from "./handlers/users";
import { handleGetProducts } from "./handlers/products";
import { handleGetOrders } from "./handlers/orders";
import { handleHealthCheck } from "./handlers/health";

interface RouteDefinition {
  readonly method: "get" | "post" | "put" | "delete";
  readonly path: string;
  readonly handler: RequestHandler;
  readonly requiresAuth: boolean;
}

export const ROUTES: readonly RouteDefinition[] = [
  { method: "get", path: "/api/users", handler: handleGetUsers, requiresAuth: true },
  { method: "get", path: "/api/products", handler: handleGetProducts, requiresAuth: false },
  { method: "get", path: "/api/orders", handler: handleGetOrders, requiresAuth: true },
  { method: "get", path: "/health", handler: handleHealthCheck, requiresAuth: false },
];

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORISED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
} as const;

export const RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60 * 1000,
  maxRequests: 100,
  skipPaths: ["/health", "/api/docs"],
} as const;
