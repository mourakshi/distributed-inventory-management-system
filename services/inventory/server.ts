import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from './src/generated/client';
import { createEventBroker, createCacheClient, IEventBroker, ICacheClient, HttpEventBroker } from '../../shared/broker';
import { SystemEvent } from '../../shared/types';

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

let broker: IEventBroker;
let cache: ICacheClient;

// Cache keys helper
const CACHE_KEY_ALL_INVENTORY = 'inventory:all';
const getProductCacheKey = (productId: string) => `inventory:product:${productId}`;

// Initialize infrastructure clients
async function initInfrastructure() {
  broker = await createEventBroker('inventory-service', port);
  cache = await createCacheClient();

  // Seed default inventory items if database is empty
  const count = await prisma.productStock.count();
  if (count === 0) {
    console.log('[Inventory] Seeding default products...');
    await prisma.productStock.createMany({
      data: [
        { productId: 'prod-laptop', name: 'Developer Laptop X1', quantity: 25, warehouse: 'Warehouse Alpha' },
        { productId: 'prod-monitor', name: 'UltraWide 34 Inch Monitor', quantity: 40, warehouse: 'Warehouse Alpha' },
        { productId: 'prod-keyboard', name: 'Mechanical Keyboard Blue Switch', quantity: 75, warehouse: 'Warehouse Beta' },
        { productId: 'prod-mouse', name: 'Wireless Ergonomic Mouse', quantity: 120, warehouse: 'Warehouse Beta' },
      ],
    });
  }

  // Subscribe to order.created events
  await broker.subscribe('order.created', 'inventory_order_created_queue', async (event) => {
    const { orderId, items } = event.payload;
    console.log(`[Inventory] Received order.created event for Order ${orderId}`);
    
    try {
      // Perform transactional check and deduction to ensure ACID compliance
      await prisma.$transaction(async (tx) => {
        // 1. Fetch current stock levels for all products in the order
        for (const item of items) {
          const stock = await tx.productStock.findUnique({
            where: { productId: item.productId },
          });

          if (!stock || stock.quantity < item.quantity) {
            throw new Error(`Insufficient stock for product ${item.productId}. Available: ${stock?.quantity ?? 0}, Requested: ${item.quantity}`);
          }
        }

        // 2. Deduct stock levels
        for (const item of items) {
          await tx.productStock.update({
            where: { productId: item.productId },
            data: {
              quantity: {
                decrement: item.quantity,
              },
            },
          });
        }
      });

      // 3. Invalidate cache on successful stock deduction
      await cache.del(CACHE_KEY_ALL_INVENTORY);
      for (const item of items) {
        await cache.del(getProductCacheKey(item.productId));
      }

      console.log(`[Inventory] Successfully allocated stock for Order ${orderId}`);

      // 4. Publish allocation success event
      await broker.publish('inventory.allocated', {
        orderId,
        allocatedItems: items,
      });

    } catch (err: any) {
      console.warn(`[Inventory] Allocation failed for Order ${orderId}: ${err.message}`);
      
      // Publish allocation failure event
      await broker.publish('inventory.insufficient', {
        orderId,
        reason: err.message || 'Unknown stock deduction error',
      });
    }
  });
}

// REST: Get entire inventory (with read-through caching)
app.get('/api/inventory', async (req: Request, res: Response) => {
  try {
    // Check cache first
    const cachedData = await cache.get(CACHE_KEY_ALL_INVENTORY);
    if (cachedData) {
      console.log('[Cache Hit] Returned inventory list from cache');
      res.json({ source: 'cache', data: JSON.parse(cachedData) });
      return;
    }

    // Cache miss: query database
    console.log('[Cache Miss] Querying SQLite for inventory list');
    const inventory = await prisma.productStock.findMany();
    
    // Store in cache with 10-second TTL
    await cache.set(CACHE_KEY_ALL_INVENTORY, JSON.stringify(inventory), 10);
    
    res.json({ source: 'database', data: inventory });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// REST: Update inventory levels manually (invalidates cache)
app.post('/api/inventory/update', async (req: Request, res: Response) => {
  const { productId, quantity, warehouse } = req.body;
  if (!productId || quantity === undefined) {
    res.status(400).json({ error: 'productId and quantity are required' });
    return;
  }

  try {
    const updated = await prisma.productStock.update({
      where: { productId },
      data: {
        quantity,
        ...(warehouse && { warehouse }),
      },
    });

    // Invalidate cache
    await cache.del(CACHE_KEY_ALL_INVENTORY);
    await cache.del(getProductCacheKey(productId));

    console.log(`[Inventory] Updated stock for ${productId} to ${quantity}`);

    // Publish event
    await broker.publish('inventory.updated', {
      productId,
      quantity,
      warehouse: updated.warehouse,
    });

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// WEBHOOK HANDLER: HTTP Event Broker Fallback Listener
app.post('/events', async (req: Request, res: Response) => {
  res.sendStatus(200);
  await HttpEventBroker.handleIncomingEvent(req.body);
});

// Boot the server
app.listen(port, async () => {
  console.log(`[Inventory Service] Running on port ${port}`);
  try {
    await initInfrastructure();
  } catch (err) {
    console.error('[Inventory Service] Failed to initialize infrastructure:', err);
  }
});
