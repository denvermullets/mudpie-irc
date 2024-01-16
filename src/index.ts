import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createClient, RedisClientType } from "redis";
import * as net from "net";

const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/api/ws/" });

const pubClient: RedisClientType = createClient({ url: REDIS_URL });
const subClient: RedisClientType = pubClient.duplicate();

const initPubSub = async () => {
  await Promise.all([pubClient.connect(), subClient.connect()]);
  await subClient.subscribe("irc_messages", (message) => {
    console.log(`pubsub message: ${message}`);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });
};

initPubSub();

pubClient.on("error", (err) => console.error("Redis pubClient Error:", err));
subClient.on("error", (err) => console.error("Redis subClient Error:", err));

const connectToIRC = (
  sessionId: string,
  nickname: string,
  username: string,
  password: string,
  channel: string
) => {
  const ircServer = "irc.libera.chat";
  const ircPort = 6667;

  const client = new net.Socket();
  client.connect(ircPort, ircServer, () => {
    console.log(`User ${sessionId} connected to IRC`);
    client.write(`NICK ${nickname}\r\n`);
    client.write(`USER ${username} 0 * :${username}\r\n`);
    client.write(`JOIN #${channel}\r\n`);
  });

  client.on("data", (data) => {
    console.log("data from IRC: ", data.toString());
    const message = data.toString().trim();
    console.log(`message:`, message);

    if (message.startsWith("PING")) {
      // respond to PING messages to keep the connection alive
      client.write(`PONG ${message.split(" ")[1]}\r\n`);
    }

    // publish data to the Redis channel
    // TODO: convert to a stringified json response for client
    pubClient.publish("irc_messages", `Session ${sessionId}: ${message}`);
  });

  client.on("error", (error) => {
    console.error(`Error for user ${sessionId}:`, error.message);
    wss.clients.forEach((wsClient) => {
      if (wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ status: "error", message: error.message }));
      }
    });
  });

  client.on("close", () => {
    console.log(`Connection closed for user ${sessionId}`);
    wss.clients.forEach((wsClient) => {
      if (wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ status: "closed", sessionId }));
      }
    });
  });

  return client;
};

wss.on("connection", (ws) => {
  console.log("Client connected");
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const { command, sessionId, nickname, username, password, channel } = message;

    if (command === "connect") {
      connectToIRC(sessionId, nickname, username, password, channel);
    }
  });
  ws.on("close", () => console.log("Client disconnected"));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
