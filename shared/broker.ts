import amqp from 'amqplib';
import Redis from 'ioredis';
import { EventMap, EventType, SystemEvent } from './types';

// ==========================================
// 1. EVENT BROKER ABSTRACTION
// ==========================================

export interface IEventBroker {
  connect(): Promise<void>;
  publish<T extends EventType>(type: T, payload: EventMap[T]): Promise<void>;
  subscribe<T extends EventType>(
    type: T,
    queueName: string,
    callback: (event: SystemEvent<T>) => Promise<void>
  ): Promise<void>;
}

// Actual RabbitMQ implementation
export class RabbitMQEventBroker implements IEventBroker {
  private connection?: any;
  private channel?: any;
  private url = 'amqp://localhost:5672';
  private serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  async connect(): Promise<void> {
    console.log(`[Broker] Connecting to RabbitMQ at ${this.url}...`);
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createChannel();
    console.log(`[Broker] Connected to RabbitMQ successfully.`);
  }

  async publish<T extends EventType>(type: T, payload: EventMap[T]): Promise<void> {
    if (!this.channel) throw new Error('Broker not connected');
    
    // RabbitMQ uses exchange-bound routing. We use a fanout exchange for broadcast, or direct routing.
    // To make it simple and aligned with standard microservices, we will use a topic exchange "dims_events".
    const exchange = 'dims_events';
    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    
    const event: SystemEvent<T> = {
      id: Math.random().toString(36).substring(2, 11),
      type,
      payload,
      timestamp: new Date().toISOString(),
      service: this.serviceName,
    };
    
    this.channel.publish(exchange, type, Buffer.from(JSON.stringify(event)));
    console.log(`[Broker] Published event ${type} to RabbitMQ`);
  }

  async subscribe<T extends EventType>(
    type: T,
    queueName: string,
    callback: (event: SystemEvent<T>) => Promise<void>
  ): Promise<void> {
    if (!this.channel) throw new Error('Broker not connected');
    
    const exchange = 'dims_events';
    await this.channel.assertExchange(exchange, 'topic', { durable: true });
    
    // Assert queue and bind it to the exchange with the event routing key (type)
    const q = await this.channel.assertQueue(queueName, { durable: true });
    await this.channel.bindQueue(q.queue, exchange, type);
    
    // Also bind queue to wildcard or other patterns if needed, but here we bind directly to the event type.
    await this.channel.consume(q.queue, async (msg: any) => {
      if (msg) {
        try {
          const event: SystemEvent<T> = JSON.parse(msg.content.toString());
          await callback(event);
          this.channel?.ack(msg);
        } catch (err) {
          console.error(`[Broker] Error handling event ${type}:`, err);
          // Requeue on failure
          this.channel?.nack(msg, false, true);
        }
      }
    });
    console.log(`[Broker] Subscribed to ${type} on queue ${queueName} via RabbitMQ`);
  }
}

// Fallback HTTP Event Broker implementation (Gateway acts as message broker hub)
export class HttpEventBroker implements IEventBroker {
  private gatewayUrl = 'http://localhost:3000';
  private serviceName: string;
  private localServicePort: number;

  // Static registry to route incoming HTTP webhook event deliveries to matching callbacks
  private static callbacks = new Map<string, Array<(event: any) => Promise<void>>>();

  static async handleIncomingEvent(event: SystemEvent<any>): Promise<void> {
    const list = HttpEventBroker.callbacks.get(event.type);
    if (list) {
      for (const cb of list) {
        try {
          await cb(event);
        } catch (err: any) {
          console.error(`[HttpEventBroker] Callback failed:`, err.message);
        }
      }
    }
  }

  constructor(serviceName: string, localServicePort: number) {
    this.serviceName = serviceName;
    this.localServicePort = localServicePort;
  }

  async connect(): Promise<void> {
    console.log(`[Broker] RabbitMQ unavailable. Initializing HTTP Webhook Broker Client...`);
    // Ensure we can reach gateway (we'll let standard fetch handle checks during subscriptions)
  }

  async publish<T extends EventType>(type: T, payload: EventMap[T]): Promise<void> {
    const event: SystemEvent<T> = {
      id: Math.random().toString(36).substring(2, 11),
      type,
      payload,
      timestamp: new Date().toISOString(),
      service: this.serviceName,
    };

    try {
      const response = await fetch(`${this.gatewayUrl}/broker/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        console.warn(`[Broker] HTTP Publish returned status ${response.status}`);
      } else {
        console.log(`[Broker] Published event ${type} via HTTP Broker`);
      }
    } catch (err) {
      console.error(`[Broker] Failed to publish event via HTTP Gateway:`, err);
    }
  }

  async subscribe<T extends EventType>(
    type: T,
    queueName: string,
    callback: (event: SystemEvent<T>) => Promise<void>
  ): Promise<void> {
    // Store callback locally
    const list = HttpEventBroker.callbacks.get(type) || [];
    list.push(callback);
    HttpEventBroker.callbacks.set(type, list);

    // Register webhook listener endpoint at the Gateway
    const callbackUrl = `http://localhost:${this.localServicePort}/events`;
    
    // We register the subscription asynchronously with a retry loop
    const register = async () => {
      try {
        const response = await fetch(`${this.gatewayUrl}/broker/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: type, callbackUrl }),
        });
        if (response.ok) {
          console.log(`[Broker] Registered HTTP subscription for ${type} to ${callbackUrl}`);
        } else {
          throw new Error(`Status ${response.status}`);
        }
      } catch (err) {
        // Retry in 2 seconds if gateway is not up yet
        setTimeout(register, 2000);
      }
    };
    
    await register();
  }
}

// ==========================================
// 2. CACHE CLIENT ABSTRACTION
// ==========================================

export interface ICacheClient {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

// Actual Redis cache client
export class RedisCacheClient implements ICacheClient {
  private client?: Redis;

  async connect(): Promise<void> {
    console.log('[Cache] Connecting to Redis at redis://localhost:6379...');
    this.client = new Redis({
      host: 'localhost',
      port: 6379,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
    });
    // Check connection
    await this.client.ping();
    console.log('[Cache] Connected to Redis successfully.');
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Cache client not connected');
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) throw new Error('Cache client not connected');
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) throw new Error('Cache client not connected');
    await this.client.del(key);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch (err) {}
    }
  }
}

// HTTP Fallback Cache client (stores cache inside the Gateway process memory)
export class HttpCacheClient implements ICacheClient {
  private gatewayUrl = 'http://localhost:3000';

  async connect(): Promise<void> {
    console.log('[Cache] Redis unavailable. Initializing HTTP Cache Client...');
  }

  async get(key: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.gatewayUrl}/cache/${encodeURIComponent(key)}`);
      if (response.status === 404) return null;
      const data = (await response.json()) as any;
      return data.value;
    } catch (err) {
      console.error(`[Cache] Error getting key ${key} from HTTP Cache:`, err);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      await fetch(`${this.gatewayUrl}/cache/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, ttl: ttlSeconds }),
      });
    } catch (err) {
      console.error(`[Cache] Error setting key ${key} in HTTP Cache:`, err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await fetch(`${this.gatewayUrl}/cache/${encodeURIComponent(key)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      console.error(`[Cache] Error deleting key ${key} from HTTP Cache:`, err);
    }
  }
}

// ==========================================
// 3. FACTORY BUILDERS
// ==========================================

export async function createEventBroker(serviceName: string, localServicePort: number): Promise<IEventBroker> {
  const broker = new RabbitMQEventBroker(serviceName);
  try {
    await broker.connect();
    return broker;
  } catch (err) {
    const fallback = new HttpEventBroker(serviceName, localServicePort);
    await fallback.connect();
    return fallback;
  }
}

export async function createCacheClient(): Promise<ICacheClient> {
  const cache = new RedisCacheClient();
  try {
    await cache.connect();
    return cache;
  } catch (err) {
    await cache.disconnect();
    const fallback = new HttpCacheClient();
    await fallback.connect();
    return fallback;
  }
}
