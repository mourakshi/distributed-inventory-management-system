import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { createEventBroker, IEventBroker } from '../../shared/broker';
import { SystemEvent, EventType } from '../../shared/types';

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json());

// Create HTTP server to share port with WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Setup WebSockets upgrade handler
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Connected WebSocket clients
const wsClients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  console.log('[Gateway] Dashboard client connected via WebSockets');
  wsClients.add(ws);
  
  ws.on('close', () => {
    console.log('[Gateway] Dashboard client disconnected');
    wsClients.delete(ws);
  });
});

// Broadcast helper for WebSocket clients
function broadcastEvent(event: SystemEvent) {
  const message = JSON.stringify(event);
  wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ==========================================
// 1. IN-MEMORY FALLBACK MIDDLEWARE (Broker & Cache)
// ==========================================

// In-Memory cache map: key -> { value, expiresAt }
const localCache = new Map<string, { value: string; expiresAt?: number }>();

// Event Subscriptions map: eventType -> Set of callback URLs
const eventSubscriptions = new Map<string, Set<string>>();

// Cache Endpoints
app.get('/cache/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  const item = localCache.get(key);
  if (!item) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  
  if (item.expiresAt && Date.now() > item.expiresAt) {
    localCache.delete(key);
    res.status(404).json({ error: 'Key expired' });
    return;
  }
  
  res.json({ value: item.value });
});

app.post('/cache/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  const { value, ttl } = req.body;
  
  const expiresAt = ttl ? Date.now() + ttl * 1000 : undefined;
  localCache.set(key, { value, expiresAt });
  res.sendStatus(200);
});

app.delete('/cache/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  localCache.delete(key);
  res.sendStatus(200);
});

// HTTP Broker Webhook Endpoints
app.post('/broker/subscribe', (req: Request, res: Response) => {
  const { event, callbackUrl } = req.body;
  if (!event || !callbackUrl) {
    res.status(400).json({ error: 'event and callbackUrl are required' });
    return;
  }

  if (!eventSubscriptions.has(event)) {
    eventSubscriptions.set(event, new Set());
  }
  eventSubscriptions.get(event)!.add(callbackUrl);
  console.log(`[Broker Hub] Subscriber registered for event "${event}": ${callbackUrl}`);
  res.sendStatus(200);
});

app.post('/broker/publish', (req: Request, res: Response) => {
  const event = req.body as SystemEvent;
  
  // Forward to all subscribers
  const subs = eventSubscriptions.get(event.type);
  if (subs) {
    subs.forEach(async (url) => {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
      } catch (err: any) {
        console.warn(`[Broker Hub] Failed to dispatch event ${event.type} to ${url}: ${err.message}`);
      }
    });
  }

  // Also broadcast to WebSocket client dashboards
  broadcastEvent(event);
  res.sendStatus(200);
});

// ==========================================
// 2. ROUTE PROXYING TO MICROSERVICES
// ==========================================

const SERVICES = {
  inventory: 'http://localhost:3001',
  order: 'http://localhost:3002',
  analytics: 'http://localhost:3003',
};

// Generic proxy function using native fetch
async function proxyToService(targetUrl: string, req: Request, res: Response) {
  try {
    const url = new URL(req.originalUrl, targetUrl);
    
    // Convert body to string if present
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method) && Object.keys(req.body).length > 0;
    
    const response = await fetch(url.toString(), {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        // Forward auth headers or other context if needed
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });

    const contentType = response.headers.get('content-type');
    res.status(response.status);

    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      res.send(text);
    }
  } catch (err: any) {
    console.error(`[Gateway] Error proxying request to ${targetUrl}:`, err.message);
    res.status(502).json({ error: `Bad Gateway: Target service at ${targetUrl} is unreachable` });
  }
}

// REST routes mapping
app.all('/api/inventory*', (req, res) => proxyToService(SERVICES.inventory, req, res));
app.all('/api/orders*', (req, res) => proxyToService(SERVICES.order, req, res));
app.all('/api/analytics*', (req, res) => proxyToService(SERVICES.analytics, req, res));

// ==========================================
// 3. INFRASTRUCTURE EVENTS LISTENER
// ==========================================

let broker: IEventBroker;

async function initBrokerListener() {
  try {
    // Attempt to connect to RabbitMQ broker to listen and forward events to WebSockets
    broker = await createEventBroker('gateway-service', port);
    
    // In RabbitMQ mode, we want the gateway to subscribe to all queues and broadcast them.
    // If we're in HTTP Broker mode, this createEventBroker returns HttpEventBroker, and publish() already broadcasts.
    // So we only bind RabbitMQ consumers if the broker is indeed RabbitMQ.
    if ('connection' in broker) { 
      console.log('[Gateway] Binding RabbitMQ consumers for WebSocket streaming...');
      const topics: EventType[] = [
        'order.created',
        'order.completed',
        'order.cancelled',
        'inventory.allocated',
        'inventory.insufficient',
        'inventory.updated'
      ];
      for (const topic of topics) {
        await broker.subscribe(topic, `gateway_ws_queue_${topic.replace('.', '_')}`, async (event) => {
          broadcastEvent(event);
        });
      }
    }
  } catch (err: any) {
    console.warn('[Gateway] RabbitMQ not found. Operating solely as HTTP Broker Hub.');
  }
}

// Start Server
server.listen(port, async () => {
  console.log(`[API Gateway] Server running on http://localhost:${port}`);
  await initBrokerListener();
});
