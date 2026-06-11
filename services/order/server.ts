import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from './src/generated/client';
import { createEventBroker, IEventBroker, HttpEventBroker } from '../../shared/broker';
import { SystemEvent } from '../../shared/types';

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT) : 3002;
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

let broker: IEventBroker;

// Initialize infrastructure clients
async function initInfrastructure() {
  broker = await createEventBroker('order-service', port);

  // Subscribe to inventory.allocated
  await broker.subscribe('inventory.allocated', 'order_inventory_allocated_queue', async (event) => {
    const { orderId } = event.payload;
    console.log(`[Order] Received inventory.allocated for Order ${orderId}`);
    
    try {
      const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: { status: 'COMPLETED' },
      });

      console.log(`[Order] Order ${orderId} status set to COMPLETED`);

      // Publish system event order.completed
      await broker.publish('order.completed', { orderId });
    } catch (err: any) {
      console.error(`[Order] Failed to complete Order ${orderId}:`, err.message);
    }
  });

  // Subscribe to inventory.insufficient
  await broker.subscribe('inventory.insufficient', 'order_inventory_insufficient_queue', async (event) => {
    const { orderId, reason } = event.payload;
    console.log(`[Order] Received inventory.insufficient for Order ${orderId}. Reason: ${reason}`);
    
    try {
      const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED' },
      });

      console.log(`[Order] Order ${orderId} status set to CANCELLED`);

      // Publish system event order.cancelled
      await broker.publish('order.cancelled', { orderId, reason });
    } catch (err: any) {
      console.error(`[Order] Failed to cancel Order ${orderId}:`, err.message);
    }
  });
}

// REST: Get all orders
app.get('/api/orders', async (req: Request, res: Response) => {
  try {
    const orders = await prisma.order.findMany({
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// REST: Place a new order
app.post('/api/orders', async (req: Request, res: Response) => {
  const { items } = req.body; // Array of { productId, quantity }
  if (!items || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  try {
    // 1. Save order in PENDING status in DB
    const newOrder = await prisma.order.create({
      data: {
        status: 'PENDING',
        items: {
          create: items.map((item: any) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
        },
      },
      include: { items: true },
    });

    console.log(`[Order] Created Order ${newOrder.id} in PENDING state`);

    // 2. Publish order.created event
    await broker.publish('order.created', {
      orderId: newOrder.id,
      items: items.map((item: any) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    });

    res.status(201).json(newOrder);
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
  console.log(`[Order Service] Running on port ${port}`);
  try {
    await initInfrastructure();
  } catch (err) {
    console.error('[Order Service] Failed to initialize infrastructure:', err);
  }
});
