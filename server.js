const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// Serve static files
app.use(express.static('public'));

// In-memory storage
const users = new Map(); // socketId -> {name, status, joinedAt, notificationTimeout}
const nameToSockets = new Map(); // name (lowercase) -> Set of socketIds

// Constants
const MAX_OUTSIDE = 4;
const NOTIFICATION_TIMEOUT = 2 * 60 * 1000; // 2 minutes

// Sanitize name
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return null;
  
  // Remove potential XSS/SQL injection characters
  const sanitized = name
    .replace(/[<>'"`;()]/g, '')
    .trim();
  
  if (sanitized.length === 0 || sanitized.length > 30) return null;
  
  return sanitized;
}

// Get current state
function getState() {
  const outside = [];
  const queue = [];
  
  const processedNames = new Set();
  
  for (const [socketId, user] of users.entries()) {
    const nameLower = user.name.toLowerCase();
    
    // Skip if we've already processed this name
    if (processedNames.has(nameLower)) continue;
    processedNames.add(nameLower);
    
    if (user.status === 'outside') {
      outside.push({
        name: user.name,
        joinedAt: user.joinedAt
      });
    } else if (user.status === 'queue') {
      queue.push({
        name: user.name,
        joinedAt: user.joinedAt
      });
    }
  }
  
  // Sort by joinedAt
  outside.sort((a, b) => a.joinedAt - b.joinedAt);
  queue.sort((a, b) => a.joinedAt - b.joinedAt);
  
  return { outside, queue };
}

// Broadcast state to all clients
function broadcastState() {
  const state = getState();
  io.emit('state_update', state);
}

// Get user by name (any socket with this name)
function getUserByName(name) {
  const nameLower = name.toLowerCase();
  const sockets = nameToSockets.get(nameLower);
  if (!sockets || sockets.size === 0) return null;
  
  const socketId = Array.from(sockets)[0];
  return users.get(socketId);
}

// Get all socket IDs for a name
function getSocketsByName(name) {
  const nameLower = name.toLowerCase();
  return nameToSockets.get(nameLower) || new Set();
}

// Update user status across all their sockets
function updateUserStatus(name, status, additionalData = {}) {
  const sockets = getSocketsByName(name);
  const timestamp = Date.now();
  
  for (const socketId of sockets) {
    const user = users.get(socketId);
    if (user) {
      user.status = status;
      user.joinedAt = timestamp;
      Object.assign(user, additionalData);
    }
  }
}

// Clear notification timeout for a user
function clearUserNotificationTimeout(name) {
  const user = getUserByName(name);
  if (user && user.notificationTimeout) {
    clearTimeout(user.notificationTimeout);
    user.notificationTimeout = null;
  }
}

// Notify next in queue
function notifyNextInQueue() {
  const state = getState();
  const availableSlots = MAX_OUTSIDE - state.outside.length;
  
  if (availableSlots <= 0 || state.queue.length === 0) return;
  
  const toNotify = Math.min(availableSlots, state.queue.length);
  
  for (let i = 0; i < toNotify; i++) {
    const queuedUser = state.queue[i];
    const user = getUserByName(queuedUser.name);
    
    if (!user || user.notificationTimeout) continue;
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
      // Remove user from queue after timeout
      const currentUser = getUserByName(queuedUser.name);
      if (currentUser && currentUser.status === 'queue') {
        updateUserStatus(queuedUser.name, 'idle');
        
        // Emit to all sockets of this user
        const sockets = getSocketsByName(queuedUser.name);
        for (const sid of sockets) {
          io.to(sid).emit('queue_timeout');
        }
        
        broadcastState();
        notifyNextInQueue();
      }
    }, NOTIFICATION_TIMEOUT);
    
    user.notificationTimeout = timeoutId;
    
    // Notify all sockets of this user
    const sockets = getSocketsByName(queuedUser.name);
    for (const socketId of sockets) {
      io.to(socketId).emit('your_turn');
    }
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Login
  socket.on('login', (name) => {
    const sanitized = sanitizeName(name);
    
    if (!sanitized) {
      socket.emit('login_error', 'Invalid name');
      return;
    }
    
    const nameLower = sanitized.toLowerCase();
    
    // Check if name exists
    const existingUser = getUserByName(sanitized);
    
    if (existingUser) {
      // Name already exists, add this socket to the same user
      if (!nameToSockets.has(nameLower)) {
        nameToSockets.set(nameLower, new Set());
      }
      nameToSockets.get(nameLower).add(socket.id);
      
      users.set(socket.id, {
        name: existingUser.name,
        status: existingUser.status,
        joinedAt: existingUser.joinedAt,
        notificationTimeout: existingUser.notificationTimeout
      });
    } else {
      // New user
      if (!nameToSockets.has(nameLower)) {
        nameToSockets.set(nameLower, new Set());
      }
      nameToSockets.get(nameLower).add(socket.id);
      
      users.set(socket.id, {
        name: sanitized,
        status: 'idle',
        joinedAt: Date.now(),
        notificationTimeout: null
      });
    }
    
    socket.emit('login_success', { name: sanitized });
    broadcastState();
  });
  
  // Leave class
  socket.on('leave_class', () => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const state = getState();
    
    if (user.status === 'idle' || user.status === 'queue') {
      // Clear any existing notification timeout
      clearUserNotificationTimeout(user.name);
      
      if (state.outside.length < MAX_OUTSIDE) {
        // Go outside
        updateUserStatus(user.name, 'outside');
      } else {
        // Join queue
        updateUserStatus(user.name, 'queue');
      }
      
      broadcastState();
      notifyNextInQueue();
    }
  });
  
  // Come back
  socket.on('come_back', () => {
    const user = users.get(socket.id);
    if (!user || user.status !== 'outside') return;
    
    updateUserStatus(user.name, 'idle');
    
    broadcastState();
    notifyNextInQueue();
  });
  
  // Leave queue
  socket.on('leave_queue', () => {
    const user = users.get(socket.id);
    if (!user || user.status !== 'queue') return;
    
    clearUserNotificationTimeout(user.name);
    updateUserStatus(user.name, 'idle');
    
    broadcastState();
    notifyNextInQueue();
  });
  
  // Request current state
  socket.on('request_state', () => {
    const user = users.get(socket.id);
    if (user) {
      socket.emit('user_status', { status: user.status });
    }
    broadcastState();
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    
    const user = users.get(socket.id);
    if (!user) return;
    
    const nameLower = user.name.toLowerCase();
    const sockets = nameToSockets.get(nameLower);
    
    if (sockets) {
      sockets.delete(socket.id);
      
      // If this was the last socket for this name, clean up
      if (sockets.size === 0) {
        nameToSockets.delete(nameLower);
        clearUserNotificationTimeout(user.name);
        users.delete(socket.id);
        broadcastState();
        notifyNextInQueue();
      } else {
        users.delete(socket.id);
      }
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});