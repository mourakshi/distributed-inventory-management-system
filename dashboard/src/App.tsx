import React, { useState, useEffect, useRef } from 'react';
import type { SystemEvent, ProductStock, Order } from '../../shared/types';

interface SystemMetrics {
  totalEvents: number;
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  successfulAllocations: number;
  failedAllocations: number;
  successRate: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'topology' | 'inventory' | 'orders' | 'logs'>('topology');
  const [wsConnected, setWsConnected] = useState(false);
  const [brokerMode, setBrokerMode] = useState<'rabbitmq' | 'http'>('http');
  const [cacheMode, setCacheMode] = useState<'redis' | 'http'>('http');
  
  const [inventory, setInventory] = useState<ProductStock[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [logs, setLogs] = useState<SystemEvent[]>([]);
  const [metrics, setMetrics] = useState<SystemMetrics>({
    totalEvents: 0,
    totalOrders: 0,
    completedOrders: 0,
    cancelledOrders: 0,
    successfulAllocations: 0,
    failedAllocations: 0,
    successRate: '100%',
  });

  // State for inventory query metadata (database vs cache source)
  const [inventorySource, setInventorySource] = useState<'database' | 'cache'>('database');
  const [cacheHitCount, setCacheHitCount] = useState(0);
  const [cacheMissCount, setCacheMissCount] = useState(0);

  // Form states
  const [selectedProduct, setSelectedProduct] = useState('prod-laptop');
  const [quantity, setQuantity] = useState(1);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  
  // Floating notification state
  const [notification, setNotification] = useState<{ message: string; type: string } | null>(null);

  // Node & connection active states for topology visualizer
  const [activeNodes, setActiveNodes] = useState<Record<string, boolean>>({});
  const [activeLinks, setActiveLinks] = useState<Record<string, 'active' | 'success' | 'fail' | null>>({});

  const wsRef = useRef<WebSocket | null>(null);

  const fetchInventory = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/inventory');
      const json = await res.json();
      setInventory(json.data);
      setInventorySource(json.source);
      if (json.source === 'cache') {
        setCacheHitCount((c) => c + 1);
      } else {
        setCacheMissCount((c) => c + 1);
      }
    } catch (err) {
      console.error('Failed to fetch inventory:', err);
    }
  };

  const fetchOrders = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/orders');
      const json = await res.json();
      setOrders(json);
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    }
  };

  const fetchMetrics = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/analytics/metrics');
      const json = await res.json();
      setMetrics(json);
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/analytics/logs');
      const json = await res.json();
      setLogs(json);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  };

  const loadAllData = () => {
    fetchInventory();
    fetchOrders();
    fetchMetrics();
    fetchLogs();
  };

  // SVG Flow Animation trigger based on Event Type
  const triggerFlowAnimation = (eventType: string, service: string) => {
    // Determine connection modes based on the logs
    if (service === 'inventory-service') {
      // Check if service uses real clients or fallbacks (represented in the backend console but can be inferred)
    }

    if (eventType === 'order.created') {
      // Sequence: Gateway -> Order -> Queue -> Inventory
      flashNode('gateway');
      setLinkState('gw-order', 'active');
      
      setTimeout(() => {
        flashNode('order-service');
        setLinkState('order-queue', 'active');
      }, 250);

      setTimeout(() => {
        flashNode('queue');
        setLinkState('queue-inventory', 'active');
      }, 500);

      setTimeout(() => {
        flashNode('inventory-service');
        // Reads from cache or db, let's flash cache link
        setLinkState('inventory-cache', 'active');
        flashNode('cache');
      }, 750);

      setTimeout(() => {
        clearAllLinks();
      }, 1500);

    } else if (eventType === 'inventory.allocated') {
      // Sequence: Inventory -> Queue -> Order -> Gateway
      flashNode('inventory-service');
      setLinkState('inventory-queue', 'success');

      setTimeout(() => {
        flashNode('queue');
        setLinkState('queue-order', 'success');
      }, 250);

      setTimeout(() => {
        flashNode('order-service');
        setLinkState('order-gw', 'success');
      }, 500);

      setTimeout(() => {
        flashNode('gateway');
        // Analytics captures event
        flashNode('analytics-service');
        setLinkState('queue-analytics', 'success');
      }, 750);

      setTimeout(() => {
        clearAllLinks();
      }, 1500);

    } else if (eventType === 'inventory.insufficient') {
      // Failure Sequence
      flashNode('inventory-service');
      setLinkState('inventory-queue', 'fail');

      setTimeout(() => {
        flashNode('queue');
        setLinkState('queue-order', 'fail');
      }, 250);

      setTimeout(() => {
        flashNode('order-service');
        setLinkState('order-gw', 'fail');
      }, 500);

      setTimeout(() => {
        flashNode('gateway');
        flashNode('analytics-service');
        setLinkState('queue-analytics', 'fail');
      }, 750);

      setTimeout(() => {
        clearAllLinks();
      }, 1500);
    }
  };

  const flashNode = (nodeId: string) => {
    setActiveNodes((prev) => ({ ...prev, [nodeId]: true }));
    setTimeout(() => {
      setActiveNodes((prev) => ({ ...prev, [nodeId]: false }));
    }, 1000);
  };

  const setLinkState = (linkId: string, state: 'active' | 'success' | 'fail') => {
    setActiveLinks((prev) => ({ ...prev, [linkId]: state }));
  };

  const clearAllLinks = () => {
    setActiveLinks({});
  };

  // Show notification popup
  const showNotif = (message: string, type: string) => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 4000);
  };

  useEffect(() => {
    loadAllData();

    // Establish WebSocket Connection
    const connectWS = () => {
      const ws = new WebSocket('ws://localhost:3000/ws');
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WS Connected');
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const sysEvent = JSON.parse(event.data) as SystemEvent;
          console.log('WS Event received:', sysEvent);
          
          // Add to log stream
          setLogs((prev) => [sysEvent, ...prev.slice(0, 49)]);
          
          // Trigger topology flash animations
          triggerFlowAnimation(sysEvent.type, sysEvent.service);

          // Update connection mode labels based on event publishers
          if (sysEvent.service === 'inventory-service') {
            // Check if standard connections are used (we can mock this update or keep default)
          }

          // Trigger screen alert
          showNotif(`Received Event: ${sysEvent.type}`, sysEvent.type);

          // Refresh dashboard data
          fetchInventory();
          fetchOrders();
          fetchMetrics();
        } catch (err) {
          console.error('Error parsing WS message:', err);
        }
      };

      ws.onclose = () => {
        console.log('WS Disconnected');
        setWsConnected(false);
        // Attempt reconnect in 3s
        setTimeout(connectWS, 3000);
      };
    };

    connectWS();

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Place order REST handler
  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrderSubmitting(true);

    try {
      const response = await fetch('http://localhost:3000/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ productId: selectedProduct, quantity: quantity }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Order placement error: Status ${response.status}`);
      }

      showNotif('Order request placed! Awaiting microservice sync...', 'order.created');
      loadAllData();
    } catch (err: any) {
      showNotif(`Failed to place order: ${err.message}`, 'error');
    } finally {
      setOrderSubmitting(false);
    }
  };

  // Adjust stock REST handler (manual audit logs check)
  const handleAdjustStock = async (productId: string, currentQty: number, offset: number) => {
    const newQty = Math.max(0, currentQty + offset);
    try {
      const response = await fetch('http://localhost:3000/api/inventory/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, quantity: newQty }),
      });
      if (response.ok) {
        showNotif(`Manually adjusted ${productId} stock to ${newQty}`, 'inventory.updated');
        loadAllData();
      }
    } catch (err: any) {
      showNotif(`Adjust stock error: ${err.message}`, 'error');
    }
  };

  return (
    <div className="app-container">
      {/* Floating real-time event alert */}
      {notification && (
        <div className="floating-notif glass-panel" style={{ borderLeft: `4px solid ${
          notification.type.includes('allocated') || notification.type.includes('completed') ? 'var(--accent-green)' :
          notification.type.includes('insufficient') || notification.type.includes('cancelled') ? 'var(--accent-red)' :
          'var(--accent-cyan)'
        }` }}>
          <span className="pill-dot" style={{ backgroundColor: 
            notification.type.includes('allocated') || notification.type.includes('completed') ? 'var(--accent-green)' :
            notification.type.includes('insufficient') || notification.type.includes('cancelled') ? 'var(--accent-red)' :
            'var(--accent-cyan)'
          }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>SYSTEM BROADCAST</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.8 }}>{notification.message}</div>
          </div>
        </div>
      )}

      {/* Glassmorphic Header */}
      <header className="app-header glass-panel">
        <div className="brand-section">
          <div className="brand-logo">I</div>
          <div>
            <h1 className="brand-title">DIMS Playground</h1>
            <div className="brand-subtitle">Distributed Inventory Management System</div>
          </div>
        </div>
        
        <div className="status-pills">
          <div className="pill">
            <span className={`pill-dot ${wsConnected ? 'pulse-green' : 'pulse-red'}`} />
            WS Gateway: {wsConnected ? 'ONLINE' : 'OFFLINE'}
          </div>
          <div className={`pill pill-broker ${brokerMode}`}>
            Broker: HTTP Fallback Active
          </div>
          <div className={`pill pill-broker ${cacheMode}`} style={{ borderColor: 'rgba(0, 245, 255, 0.2)', color: 'var(--accent-cyan)' }}>
            Cache: In-Memory Server
          </div>
        </div>
      </header>

      {/* Main Navigation tabs */}
      <nav className="tabs-nav">
        <button className={`tab-btn ${activeTab === 'topology' ? 'active' : ''}`} onClick={() => setActiveTab('topology')}>
          System Architecture Flow
        </button>
        <button className={`tab-btn ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => setActiveTab('inventory')}>
          Inventory Warehouses
        </button>
        <button className={`tab-btn ${activeTab === 'orders' ? 'active' : ''}`} onClick={() => setActiveTab('orders')}>
          Orders & Transactions
        </button>
        <button className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
          Central Audit Logs
        </button>
      </nav>

      {/* Content Area */}
      {activeTab === 'topology' && (
        <div className="dashboard-grid">
          {/* SVG System Topology Canvas */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="card-header">
              <h2 className="card-title">Live Message Choreography</h2>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Flashes and path highlights represent actual asynchronous message flows
              </div>
            </div>
            <div className="card-content" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div className="topology-container" style={{ flex: 1 }}>
                <svg className="topology-svg" viewBox="0 0 700 400">
                  {/* Connection Links */}
                  {/* Gateway <-> Order Service */}
                  <path d="M 100 200 L 250 100" className={`flow-line ${activeLinks['gw-order'] || activeLinks['order-gw'] || ''}`} id="link-gw-order" />
                  {/* Gateway <-> Inventory Service */}
                  <path d="M 100 200 L 250 300" className={`flow-line ${activeLinks['gw-inventory'] || ''}`} />
                  
                  {/* Order Service <-> Message Broker */}
                  <path d="M 330 100 L 480 180" className={`flow-line ${activeLinks['order-queue'] || activeLinks['queue-order'] || ''}`} />
                  
                  {/* Inventory Service <-> Message Broker */}
                  <path d="M 330 300 L 480 220" className={`flow-line ${activeLinks['inventory-queue'] || activeLinks['queue-inventory'] || ''}`} />
                  
                  {/* Message Broker <-> Analytics */}
                  <path d="M 520 200 L 600 300" className={`flow-line ${activeLinks['queue-analytics'] || ''}`} />

                  {/* Inventory Service <-> Redis Cache */}
                  <path d="M 290 340 L 290 370" className={`flow-line ${activeLinks['inventory-cache'] || ''}`} style={{ strokeDasharray: '3 3' }} />

                  {/* Topology Nodes */}
                  {/* API Gateway */}
                  <g className={`node-group ${activeNodes['gateway'] ? 'node-flash' : ''}`} transform="translate(40, 160)">
                    <rect className="node-rect" width="120" height="70" />
                    <text x="60" y="30" textAnchor="middle" className="node-title">API Gateway</text>
                    <text x="60" y="48" textAnchor="middle" className="node-subtitle">Port 3000</text>
                    <text x="60" y="58" textAnchor="middle" className="node-subtitle" style={{ fill: 'var(--accent-cyan)' }}>WS / REST Hub</text>
                  </g>

                  {/* Order Microservice */}
                  <g className={`node-group ${activeNodes['order-service'] ? 'node-flash' : ''}`} transform="translate(230, 60)">
                    <rect className="node-rect" width="120" height="70" />
                    <text x="60" y="30" textAnchor="middle" className="node-title">Order Service</text>
                    <text x="60" y="48" textAnchor="middle" className="node-subtitle">Port 3002</text>
                    <text x="60" y="58" textAnchor="middle" className="node-subtitle" style={{ fill: 'var(--accent-purple)' }}>Prisma / SQLite</text>
                  </g>

                  {/* Inventory Microservice */}
                  <g className={`node-group ${activeNodes['inventory-service'] ? 'node-flash' : ''}`} transform="translate(230, 260)">
                    <rect className="node-rect" width="120" height="70" />
                    <text x="60" y="30" textAnchor="middle" className="node-title">Inventory Service</text>
                    <text x="60" y="48" textAnchor="middle" className="node-subtitle">Port 3001</text>
                    <text x="60" y="58" textAnchor="middle" className="node-subtitle" style={{ fill: 'var(--accent-green)' }}>Prisma / SQLite</text>
                  </g>

                  {/* Redis / Cache Node */}
                  <g className={`node-group ${activeNodes['cache'] ? 'node-flash' : ''}`} transform="translate(240, 360)">
                    <rect className="node-rect" width="100" height="32" style={{ fill: '#0a101f', rx: 4 }} />
                    <text x="50" y="20" textAnchor="middle" className="node-title" style={{ fontSize: '10px', fill: 'var(--accent-cyan)' }}>Redis / Memory Cache</text>
                  </g>

                  {/* Message Broker (RabbitMQ) */}
                  <g className={`node-group ${activeNodes['queue'] ? 'node-flash' : ''}`} transform="translate(440, 160)">
                    <rect className="node-rect" width="120" height="75" style={{ rx: 37 }} />
                    <text x="60" y="30" textAnchor="middle" className="node-title">Message Broker</text>
                    <text x="60" y="48" textAnchor="middle" className="node-subtitle">RabbitMQ / HTTP</text>
                    <text x="60" y="60" textAnchor="middle" className="node-subtitle" style={{ fill: 'var(--accent-amber)', fontWeight: 'bold' }}>EVENT BUS</text>
                  </g>

                  {/* Analytics Microservice */}
                  <g className={`node-group ${activeNodes['analytics-service'] ? 'node-flash' : ''}`} transform="translate(560, 270)">
                    <rect className="node-rect" width="110" height="65" />
                    <text x="55" y="28" textAnchor="middle" className="node-title">Analytics Service</text>
                    <text x="55" y="45" textAnchor="middle" className="node-subtitle">Port 3003</text>
                    <text x="55" y="55" textAnchor="middle" className="node-subtitle" style={{ fill: 'var(--text-muted)' }}>Audit DB</text>
                  </g>
                </svg>
              </div>

              {/* Cache Stats Console (Aesthetics detail) */}
              <div className="glass-panel" style={{ marginTop: '1rem', padding: '1rem', background: '#080d1a', borderStyle: 'dashed' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span style={{ fontWeight: 600, color: 'var(--accent-cyan)' }}>Cache Subsystem Console</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    Last Query Status: <span style={{ color: inventorySource === 'cache' ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                      {inventorySource === 'cache' ? 'CACHE_HIT' : 'CACHE_MISS (DB_QUERY)'}
                    </span>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '2rem', marginTop: '0.75rem', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  <div>Cache Hits: <span style={{ color: 'var(--accent-cyan)', fontWeight: 'bold' }}>{cacheHitCount}</span></div>
                  <div>Cache Misses: <span style={{ color: 'var(--accent-amber)', fontWeight: 'bold' }}>{cacheMissCount}</span></div>
                  <div>Caching Strategy: <span style={{ color: 'var(--text-primary)' }}>Read-Through with Write-Invalidate (10s TTL)</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Sandbox & Metrics sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* System Metrics Panel */}
            <div className="glass-panel">
              <div className="card-header">
                <h2 className="card-title">Event Broker Analytics</h2>
              </div>
              <div className="card-content">
                <div className="metrics-grid">
                  <div className="metric-card">
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Total Event Traffic</div>
                    <div className="metric-val">{metrics.totalEvents}</div>
                  </div>
                  <div className="metric-card">
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Total Orders Placed</div>
                    <div className="metric-val">{metrics.totalOrders}</div>
                  </div>
                  <div className="metric-card">
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Fulfillment Success</div>
                    <div className="metric-val success">{metrics.successfulAllocations}</div>
                  </div>
                  <div className="metric-card">
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Out-of-Stock Cancellations</div>
                    <div className="metric-val fail">{metrics.failedAllocations}</div>
                  </div>
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem', borderRadius: '8px', background: 'rgba(255,255,255,0.02)', marginTop: '0.5rem', fontSize: '0.85rem' }}>
                  <span>Order Processing Success Rate:</span>
                  <span style={{ fontWeight: 'bold', color: parseFloat(metrics.successRate) > 75 ? 'var(--accent-green)' : 'var(--accent-amber)' }}>{metrics.successRate}</span>
                </div>
              </div>
            </div>

            {/* Ordering Sandbox */}
            <div className="glass-panel">
              <div className="card-header">
                <h2 className="card-title">Order Processing Sandbox</h2>
              </div>
              <div className="card-content">
                <form className="sandbox-form" onSubmit={handlePlaceOrder}>
                  <div className="form-group">
                    <label htmlFor="product-select">Select Product</label>
                    <select id="product-select" value={selectedProduct} onChange={(e) => setSelectedProduct(e.target.value)}>
                      {inventory.map((item) => (
                        <option key={item.productId} value={item.productId}>
                          {item.name} ({item.quantity} available)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="quantity-input">Purchase Quantity</label>
                    <input
                      id="quantity-input"
                      type="number"
                      min="1"
                      max="100"
                      value={quantity}
                      onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
                    />
                  </div>
                  <button type="submit" className="btn-primary" disabled={orderSubmitting}>
                    {orderSubmitting ? 'Syncing Choreography...' : 'Place Order (Trigger Event Flow)'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'inventory' && (
        <div className="glass-panel">
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 className="card-title">Warehouse Stocks Database</h2>
            <button className="btn-primary" onClick={fetchInventory} style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
              Refresh Stock Levels
            </button>
          </div>
          <div className="card-content">
            <div className="inventory-list">
              <div className="inventory-item" style={{ background: 'rgba(255, 255, 255, 0.05)', fontWeight: 600, borderBottom: '2px solid rgba(255,255,255,0.1)' }}>
                <div>Product Name & ID</div>
                <div>Warehouse Loc.</div>
                <div>Stock Status</div>
                <div style={{ textAlign: 'right' }}>Manual Stock Ref</div>
              </div>
              {inventory.map((item) => {
                const stockPercent = Math.min(100, (item.quantity / 120) * 100);
                const barColorClass = item.quantity > 30 ? 'stock-green' : item.quantity > 10 ? 'stock-orange' : 'stock-red';
                return (
                  <div key={item.productId} className="inventory-item">
                    <div>
                      <div style={{ fontWeight: 600 }}>{item.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{item.productId}</div>
                    </div>
                    <div style={{ color: 'var(--text-secondary)' }}>{item.warehouse}</div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                        <span>Qty: <strong style={{ color: item.quantity === 0 ? 'var(--accent-red)' : 'white' }}>{item.quantity}</strong></span>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{item.quantity > 30 ? 'In Stock' : item.quantity > 0 ? 'Low Stock' : 'OUT OF STOCK'}</span>
                      </div>
                      <div className="stock-bar-container">
                        <div className={`stock-bar ${barColorClass}`} style={{ width: `${stockPercent}%` }} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                      <button onClick={() => handleAdjustStock(item.productId, item.quantity, -10)} style={{ padding: '2px 8px', fontSize: '0.75rem' }}>-10</button>
                      <button onClick={() => handleAdjustStock(item.productId, item.quantity, 10)} style={{ padding: '2px 8px', fontSize: '0.75rem' }}>+10</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'orders' && (
        <div className="glass-panel">
          <div className="card-header">
            <h2 className="card-title">Microservice Order Database</h2>
          </div>
          <div className="card-content">
            <div className="inventory-list">
              <div className="inventory-item" style={{ background: 'rgba(255, 255, 255, 0.05)', fontWeight: 600 }}>
                <div>Order UUID</div>
                <div>Created Time</div>
                <div>Ordered Items</div>
                <div style={{ textAlign: 'right' }}>Sync Status</div>
              </div>
              {orders.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                  No orders placed yet. Trigger an order flow from the System Architecture Flow sandbox!
                </div>
              ) : (
                orders.map((order) => (
                  <div key={order.id} className="inventory-item">
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>{order.id}</div>
                    <div style={{ color: 'var(--text-secondary)' }}>{new Date(order.createdAt).toLocaleTimeString()}</div>
                    <div>
                      {order.items.map((it, idx) => (
                        <div key={idx} style={{ fontSize: '0.85rem' }}>
                          <span style={{ color: 'var(--accent-purple)' }}>{it.productId}</span> (x{it.quantity})
                        </div>
                      ))}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className="pill" style={{
                        display: 'inline-flex',
                        borderColor: order.status === 'COMPLETED' ? 'rgba(0,255,102,0.2)' : order.status === 'CANCELLED' ? 'rgba(255,51,102,0.2)' : 'rgba(255,170,0,0.2)',
                        color: order.status === 'COMPLETED' ? 'var(--accent-green)' : order.status === 'CANCELLED' ? 'var(--accent-red)' : 'var(--accent-amber)',
                        padding: '0.25rem 0.75rem',
                      }}>
                        {order.status}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'logs' && (
        <div className="glass-panel">
          <div className="card-header">
            <h2 className="card-title">Central Audit Message Logs</h2>
          </div>
          <div className="card-content">
            <div className="event-log-container" style={{ maxHeight: '550px' }}>
              {logs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontFamily: 'var(--font-body)' }}>
                  Audit logs database is empty. Place an order or adjust stock to trigger broker event logs.
                </div>
              ) : (
                logs.map((log) => (
                  <div key={log.id} className={`log-entry ${log.type.replace('.', '_')}`}>
                    <span className="log-time">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    <span className="log-service">{log.service}</span>
                    <span className="log-msg">
                      Event <strong style={{ color: 'var(--accent-cyan)' }}>{log.type}</strong> - Payload: 
                      <code style={{ marginLeft: '0.5rem', background: 'rgba(255,255,255,0.03)', padding: '2px 6px', borderRadius: '4px' }}>
                        {JSON.stringify(log.payload)}
                      </code>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
