import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from './src/generated/client';
import { createEventBroker, IEventBroker, HttpEventBroker } from '../../shared/broker';
import { SystemEvent, EventType } from '../../shared/types';

dotenv.config();

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT) : 3003;
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

let broker: IEventBroker;

// Utility functions to manage metrics stored in SQLite
async function getMetric(key: string, defaultValue: string = '0'): Promise<string> {
  const metric = await prisma.metric.findUnique({ where: { key } });
  return metric ? metric.value : defaultValue;
}

async function setMetric(key: string, value: string): Promise<void> {
  await prisma.metric.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

async function incrementMetric(key: string): Promise<number> {
  const currentValStr = await getMetric(key);
  const newVal = parseInt(currentValStr) + 1;
  await setMetric(key, newVal.toString());
  return newVal;
}

// Log incoming events to Audit database and recalculate metrics
async function handleSystemEvent(event: SystemEvent<any>) {
  console.log(`[Analytics] Logging event ${event.type} (${event.id}) from service ${event.service}`);
  
  try {
    // 1. Write to AuditLog table
    await prisma.auditLog.create({
      data: {
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event.payload),
        timestamp: new Date(event.timestamp),
        service: event.service,
      },
    });

    // 2. Update stats based on event type
    await incrementMetric('total_events_processed');

    if (event.type === 'order.created') {
      await incrementMetric('total_orders');
    } else if (event.type === 'order.completed') {
      await incrementMetric('completed_orders');
    } else if (event.type === 'order.cancelled') {
      await incrementMetric('cancelled_orders');
    } else if (event.type === 'inventory.allocated') {
      await incrementMetric('total_successful_allocations');
    } else if (event.type === 'inventory.insufficient') {
      await incrementMetric('total_failed_allocations');
    }
  } catch (err: any) {
    console.error('[Analytics] Failed to record event audit log:', err.message);
  }
}

// Initialize subscriptions
async function initInfrastructure() {
  broker = await createEventBroker('analytics-service', port);

  // Subscribe to all event topics
  const eventTypes: EventType[] = [
    'order.created',
    'order.completed',
    'order.cancelled',
    'inventory.allocated',
    'inventory.insufficient',
    'inventory.updated',
  ];

  for (const type of eventTypes) {
    await broker.subscribe(type, `analytics_queue_${type.replace('.', '_')}`, async (event) => {
      await handleSystemEvent(event);
    });
  }
}

// REST: Get recent logs
app.get('/api/analytics/logs', async (req: Request, res: Response) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// REST: Get aggregated system metrics
app.get('/api/analytics/metrics', async (req: Request, res: Response) => {
  try {
    const totalEvents = parseInt(await getMetric('total_events_processed'));
    const totalOrders = parseInt(await getMetric('total_orders'));
    const completedOrders = parseInt(await getMetric('completed_orders'));
    const cancelledOrders = parseInt(await getMetric('cancelled_orders'));
    const successfulAllocations = parseInt(await getMetric('total_successful_allocations'));
    const failedAllocations = parseInt(await getMetric('total_failed_allocations'));

    res.json({
      totalEvents,
      totalOrders,
      completedOrders,
      cancelledOrders,
      successfulAllocations,
      failedAllocations,
      successRate: totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(1) + '%' : '100%',
    });
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
  console.log(`[Analytics Service] Running on port ${port}`);
  try {
    await initInfrastructure();
  } catch (err) {
    console.error('[Analytics Service] Failed to initialize infrastructure:', err);
  }
});
