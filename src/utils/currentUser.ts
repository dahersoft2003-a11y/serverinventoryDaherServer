import { Request } from "express";
import { JwtPayload } from "jsonwebtoken";
import { verifyToken } from "./jwt";

export interface CurrentUser {
  userId: string;
  username: string;
  role?: string;
  permissions?: string[];
}

const getStringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";

const getHeaderStringValue = (value: unknown) => {
  const headerValue = getStringValue(value);

  if (!headerValue) return "";

  try {
    return decodeURIComponent(headerValue).trim();
  } catch {
    return headerValue;
  }
};

export const sanitizeFirebaseKey = (key: string) =>
  key.replace(/[.#$\/\[\]]/g, "_");

export const getUserFromToken = (token?: string): CurrentUser | null => {
  if (!token) return null;

  try {
    const payload = verifyToken(token) as JwtPayload & {
      userId?: string;
      username?: string;
      role?: string;
      permissions?: unknown;
    };

    const username = getStringValue(payload.username || payload.userId || payload.sub);
    const userId = getStringValue(payload.userId || payload.username || payload.sub);

    if (!username && !userId) return null;

    return {
      userId: userId || username,
      username: username || userId,
      role: getStringValue(payload.role),
      permissions: Array.isArray(payload.permissions)
        ? payload.permissions
            .filter(
              (permission): permission is string =>
                typeof permission === "string" && Boolean(permission.trim()),
            )
            .map((permission) => permission.trim())
        : [],
    };
  } catch (error) {
    return null;
  }
};

export const getCurrentUserFromRequest = (req: Request): CurrentUser | null => {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const tokenUser = getUserFromToken(token);

  if (tokenUser) {
    return tokenUser;
  }

  const username = getHeaderStringValue(
    req.headers["x-inventory-username"] || req.headers["x-username"],
  );
  const userId = getHeaderStringValue(
    req.headers["x-inventory-user-id"] || req.headers["x-user-id"] || username,
  );
  const role = getStringValue(
    req.headers["x-inventory-role"] || req.headers["x-user-role"],
  );
  const rawPermissions = getStringValue(
    req.headers["x-inventory-permissions"] || req.headers["x-user-permissions"],
  );

  if (!username && !userId) {
    return null;
  }

  return {
    userId: userId || username,
    username: username || userId,
    role,
    permissions: rawPermissions
      ? rawPermissions
          .split(",")
          .map((permission) => permission.trim())
          .filter(Boolean)
      : [],
  };
};

export const requireCurrentUser = (req: Request): CurrentUser => {
  const user = getCurrentUserFromRequest(req);

  if (!user) {
    throw new Error("USER_REQUIRED");
  }

  return user;
};
