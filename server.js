const { WebSocketServer } = require('ws');

// Create WebSocket server on port 9001
const PORT = process.env.PORT || 9001;
const server = new WebSocketServer({ port: PORT });

console.log(`Signaling server running on port ${PORT}`);

// Store active rooms
const rooms = new Map();
// room_name -> { 
//   host: WebSocket, 
//   clients: Map<peer_id, WebSocket>,  // Changed to Map for ID tracking
//   password: string,
//   next_peer_id: int  // Track next available peer ID
// }

// Handle room creation
function handleCreateRoom(ws, message) {
    const { room_name, password } = message;
    
    // Check if room already exists
    if (rooms.has(room_name)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room already exists'
        }));
        return;
    }
    
    // Create new room
    rooms.set(room_name, {
        host: ws,
        clients: new Map(),  // Map of peer_id -> WebSocket
        password: password || null,
        next_peer_id: 2  // Start at 2, host is always 1
    });
    
    ws.setCurrentRoom(room_name);
    ws.setIsHost(true);
    ws.setPeerId(1);  // Host is always peer_id 1
    
    console.log(`Room created: ${room_name} (host peer_id: 1)`);
    
    ws.send(JSON.stringify({
        type: 'room_created',
        room_name: room_name,
        peer_id: 1  // Tell host they are peer_id 1
    }));
}

// Handle room joining
function handleJoinRoom(ws, message) {
    const { room_name, password } = message;
    
    // Check if room exists
    if (!rooms.has(room_name)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room not found'
        }));
        return;
    }
    
    const room = rooms.get(room_name);
    
    // Check password
    if (room.password && room.password !== password) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Wrong password'
        }));
        return;
    }
    
    // Check if room is full (max 5 players = 1 host + 4 clients)
    if (room.clients.size >= 4) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Room is full (max 5 players)'
        }));
        return;
    }
    
    // Assign peer ID to this client
    const peer_id = room.next_peer_id;
    room.next_peer_id += 1;
    
    // Add client to room with their peer_id
    room.clients.set(peer_id, ws);
    ws.setCurrentRoom(room_name);
    ws.setIsHost(false);
    ws.setPeerId(peer_id);
    
    console.log(`Client joined room: ${room_name} (assigned peer_id: ${peer_id})`);
    
    // Get list of all peer_ids in room (for client to know who else is there)
    const existing_peer_ids = Array.from(room.clients.keys()).filter(id => id !== peer_id);
    
    // Tell client they successfully joined and their peer_id
    ws.send(JSON.stringify({
        type: 'room_joined',
        room_name: room_name,
        peer_id: peer_id,
        existing_peers: existing_peer_ids  // List of other clients already in room
    }));
    
    // Tell host a new peer joined with their ID
    room.host.send(JSON.stringify({
        type: 'peer_joined',
        peer_id: peer_id
    }));
    
    // Notify other clients that a new peer joined (optional, for later features)
    room.clients.forEach((client_ws, client_peer_id) => {
        if (client_peer_id !== peer_id) {
            client_ws.send(JSON.stringify({
                type: 'peer_joined',
                peer_id: peer_id
            }));
        }
    });
}

// Handle WebRTC signaling messages
function handleSignal(ws, message) {
    const room_name = ws.getCurrentRoom();
    if (!room_name || !rooms.has(room_name)) {
        return;
    }
    
    const room = rooms.get(room_name);
    const isHost = ws.getIsHost();
    const from_peer_id = ws.getPeerId();
    
    // NEW: Signals can specify target_peer_id for directed messages
    const target_peer_id = message.target_peer_id;
    
    if (isHost) {
        // Host sending to specific client
        if (target_peer_id && room.clients.has(target_peer_id)) {
            const target_client = room.clients.get(target_peer_id);
            target_client.send(JSON.stringify({
                type: 'signal',
                data: message.data,
                from_peer_id: 1  // From host
            }));
        } else if (!target_peer_id) {
            // Broadcast to all clients (old behavior, keep for compatibility)
            room.clients.forEach(client => {
                client.send(JSON.stringify({
                    type: 'signal',
                    data: message.data,
                    from_peer_id: 1
                }));
            });
        }
    } else {
        // Client always sends to host
        room.host.send(JSON.stringify({
            type: 'signal',
            data: message.data,
            from_peer_id: from_peer_id  // Include which client this is from
        }));
    }
}

// Cleanup when connection closes
function cleanupConnection(room_name, ws, isHost, peer_id) {
    if (!rooms.has(room_name)) {
        return;
    }
    
    const room = rooms.get(room_name);
    
    if (isHost) {
        // Host disconnected - close the room
        console.log(`Host left, closing room: ${room_name}`);
        
        // Notify all clients
        room.clients.forEach(client => {
            client.send(JSON.stringify({
                type: 'host_disconnected'
            }));
            client.close();
        });
        
        rooms.delete(room_name);
    } else {
        // Client disconnected - remove from room
        console.log(`Peer ${peer_id} left room: ${room_name}`);
        room.clients.delete(peer_id);
        
        // Notify host which peer left
        if (room.host) {
            room.host.send(JSON.stringify({
                type: 'peer_left',
                peer_id: peer_id
            }));
        }
        
        // Notify other clients
        room.clients.forEach(client => {
            client.send(JSON.stringify({
                type: 'peer_left',
                peer_id: peer_id
            }));
        });
    }
}

server.on('connection', (ws) => {
    console.log('New connection established');
    
    let currentRoom = null;
    let isHost = false;
    let peerId = 0;
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log('Received message:', message.type);
            
            switch(message.type) {
                case 'create_room':
                    handleCreateRoom(ws, message);
                    break;
                case 'join_room':
                    handleJoinRoom(ws, message);
                    break;
                case 'signal':
                    handleSignal(ws, message);
                    break;
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Connection closed');
        if (currentRoom) {
            cleanupConnection(currentRoom, ws, isHost, peerId);
        }
    });
    
    // Store room info on the WebSocket itself
    ws.getCurrentRoom = () => currentRoom;
    ws.setCurrentRoom = (room) => { currentRoom = room; };
    ws.getIsHost = () => isHost;
    ws.setIsHost = (host) => { isHost = host; };
    ws.getPeerId = () => peerId;
    ws.setPeerId = (id) => { peerId = id; };
});
