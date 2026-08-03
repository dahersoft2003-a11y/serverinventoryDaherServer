import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import {
  clearInvoiceDraftInternal,
  getInvoiceDraftInternal,
  saveInvoiceDraftInternal,
} from "./controllers/invoiceDraft.controller";
import { CurrentUser, getUserFromToken } from "./utils/currentUser";

const getStringValue = (value: unknown) => {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }

  return typeof value === "string" ? value : "";
};

const getSocketUser = (socket: Socket): CurrentUser | null => {
  const auth = socket.handshake.auth || {};
  const query = socket.handshake.query || {};
  const token = getStringValue(auth.token || query.token);
  const tokenUser = getUserFromToken(token);

  if (tokenUser) {
    return tokenUser;
  }

  const username = getStringValue(auth.username || query.username);
  const userId = getStringValue(auth.userId || query.userId || username);

  if (!username && !userId) {
    return null;
  }

  return {
    userId: userId || username,
    username: username || userId,
  };
};

const getInvoiceDraftRoom = (userId: string) => `invoice-draft:${userId}`;

const toTimestamp = (value: unknown) => {
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const shouldIgnoreAlreadySavedDraft = (currentDraft: any, incomingDraft: any) => {
  const clearedAt = toTimestamp(currentDraft?.clearedAt);

  if (!clearedAt) {
    return false;
  }

  const incomingUpdatedAt = toTimestamp(incomingDraft?.updatedAt);

  return !incomingUpdatedAt || incomingUpdatedAt <= clearedAt;
};

export const configureSocket = (server: HttpServer) => {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE"],
    },
  });

  io.on("connection", (socket) => {
    const user = getSocketUser(socket);

    if (!user) {
      socket.disconnect(true);
      return;
    }

    const room = getInvoiceDraftRoom(user.userId);
    socket.join(room);

    socket.on("invoice-draft:join", () => {
      socket.join(room);
    });

    socket.on("invoice-draft:update", async (payload: any = {}) => {
      try {
        const currentDraft = payload.alreadySaved
          ? await getInvoiceDraftInternal(user.userId)
          : null;
        const draft =
          payload.alreadySaved &&
          shouldIgnoreAlreadySavedDraft(currentDraft, payload.draft)
            ? currentDraft
            : payload.alreadySaved
              ? payload.draft
              : await saveInvoiceDraftInternal(
                  user.userId,
                  payload.draft || payload,
                  user.username,
                );

        socket.to(room).emit("invoice-draft:changed", {
          clientId: payload.clientId,
          draft,
        });
      } catch (error: any) {
        socket.emit("invoice-draft:error", {
          message: error?.message || "تعذر مزامنة مسودة الفاتورة",
        });
      }
    });

    socket.on("invoice-draft:clear", async (payload: any = {}) => {
      try {
        const draft = payload.alreadySaved
          ? payload.draft
          : await clearInvoiceDraftInternal(user.userId, user.username);

        socket.to(room).emit("invoice-draft:cleared", {
          clientId: payload.clientId,
          draft,
        });
      } catch (error: any) {
        socket.emit("invoice-draft:error", {
          message: error?.message || "تعذر تفريغ مسودة الفاتورة",
        });
      }
    });
  });

  return io;
};
