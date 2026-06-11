export type OrderStatus = 'PENDING' | 'COMPLETED' | 'CANCELLED';

export interface OrderItem {
  productId: string;
  quantity: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  items: OrderItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductStock {
  productId: string;
  name: string;
  quantity: number;
  warehouse: string;
}

// Event-driven message schemas
export interface EventMap {
  'order.created': {
    orderId: string;
    items: OrderItem[];
  };
  'order.completed': {
    orderId: string;
  };
  'order.cancelled': {
    orderId: string;
    reason: string;
  };
  'inventory.allocated': {
    orderId: string;
    allocatedItems: OrderItem[];
  };
  'inventory.insufficient': {
    orderId: string;
    reason: string;
  };
  'inventory.updated': {
    productId: string;
    quantity: number;
    warehouse: string;
  };
}

export type EventType = keyof EventMap;

export interface SystemEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  payload: EventMap[T];
  timestamp: string;
  service: string; // The service that published the event
}
