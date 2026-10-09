import "dotenv/config";
import jwt, { SignOptions } from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "secret";

const tokenLifetime = (): NonNullable<SignOptions["expiresIn"]> => {
  const value = process.env.JWT_EXPIRES_IN?.trim() || "7d";

  // Bare numbers are seconds. jsonwebtoken otherwise treats numeric strings as ms.
  const parts = /^([1-9]\d*)(s|m|h|d|w)?$/.exec(value);
  if (parts) {
    const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
    const seconds = Number(parts[1]) * unitSeconds[parts[2] || "s"];
    if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
  }

  throw new Error("JWT_EXPIRES_IN must be positive seconds or a duration such as 12h or 7d");
};

const JWT_EXPIRES_IN = tokenLifetime();

export const generateToken = (payload: object) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

export const verifyToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET);
};
